import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, parseModel, validateConfig, type RateLimitFallbackConfig } from "./config"
import { createLogger } from "./log"

interface MessageInfo {
  id: string
  role: "user" | "assistant"
  sessionID: string
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

interface MessagePart {
  id: string
  type: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
}

interface MessageWithParts {
  info: MessageInfo
  parts: MessagePart[]
}

const sessionIndex = new Map<string, number>()
const sessionFallback = new Map<string, { queue: number[]; start: number }>()
const sessionInflight = new Map<string, object>()

function createPatternMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function createPlugin(context: PluginInput, configOverride?: RateLimitFallbackConfig): Promise<Hooks> {
  const config = validateConfig(configOverride ?? loadConfig())
  const logger = createLogger(config.logging)
  const isRateLimitMessage = createPatternMatcher(config.patterns)
  const fallbackModels = config.fallbackModels.map(parseModel)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    fallbackModels: config.fallbackModels,
    patterns: config.patterns,
  })

  if (!config.enabled) {
    await logger.info("Plugin disabled via config")
    return {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = event.properties as {
          sessionID: string
          status: {
            type: "idle" | "retry" | "busy"
            attempt?: number
            message?: string
            next?: number
          }
        }

        if (props.status.type === "retry" && props.status.message) {
          if (isRateLimitMessage(props.status.message)) {
            const sessionID = props.sessionID

            if (sessionInflight.has(sessionID)) {
              await logger.info("Fallback already in progress, ignoring retry", { sessionID })
              return
            }

            const currentIndex = sessionIndex.get(sessionID) ?? -1
            const nextIndex = currentIndex + 1

            if (nextIndex >= fallbackModels.length) {
              await logger.info("All fallbacks exhausted, no more models to try", { sessionID })
              try {
                await context.client.tui.showToast({
                  body: { message: "All fallback models exhausted — no more models to try", variant: "error" },
                })
              } catch {}
              return
            }

            const model = fallbackModels[nextIndex]
            const token = {}
            sessionInflight.set(sessionID, token)

            const reason = props.status.message.split("\n")[0].split(".")[0].substring(0, 80)
            const fromLabel = currentIndex < 0 ? "?" : config.fallbackModels[currentIndex]
            await logger.info(
              `Rate limit hit: ${fromLabel} → ${config.fallbackModels[nextIndex]}`,
              { sessionID, reason }
            )

            try {
              await context.client.session.abort({ path: { id: sessionID } })
              await sleep(200)
              const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
              const messages = messagesResponse.data as MessageWithParts[] | undefined

              if (!messages || messages.length === 0) {
                await logger.error("No messages found in session", { sessionID })
                return
              }

              const lastUserMessage = [...messages].reverse().find(m => m.info.role === "user")
              if (!lastUserMessage) {
                await logger.error("No user message found in session", { sessionID })
                return
              }

              const originalParts = lastUserMessage.parts
                .filter(p => !isSyntheticPart(p))
                .map(p => convertToPromptPart(p))
                .filter((p): p is NonNullable<typeof p> => p !== null)

              if (originalParts.length === 0) {
                await logger.error("No valid parts found in user message", { sessionID })
                return
              }

              await context.client.session.revert({
                path: { id: sessionID },
                body: { messageID: lastUserMessage.info.id },
              })
              await sleep(500)

              await context.client.session.prompt({
                path: { id: sessionID },
                body: {
                  model,
                  agent: lastUserMessage.info.agent,
                  parts: originalParts,
                },
              })

              sessionIndex.set(sessionID, nextIndex)
              let state = sessionFallback.get(sessionID)
              if (!state) {
                state = { queue: [], start: Date.now() }
                sessionFallback.set(sessionID, state)
              }
              state.queue.push(nextIndex)

              await logger.info("Fallback prompt sent successfully", { sessionID, index: nextIndex })

              // Multi-channel notification
              try {
                await context.client.tui.showToast({
                  body: {
                    message: `Rate limit hit — switched to ${config.fallbackModels[nextIndex]}`,
                    variant: "error",
                  },
                })
              } catch {}

              try {
                await context.client.app.log({
                  body: {
                    service: "rate-limit-fallback",
                    level: "warn",
                    message: `Rate limit detected — switched to ${config.fallbackModels[nextIndex]}`,
                    extra: { sessionID, fromIndex: currentIndex, toIndex: nextIndex },
                  },
                })
              } catch {}

            } catch (err) {
              await logger.error("Failed to send fallback prompt", {
                sessionID,
                error: err instanceof Error ? err.message : String(err),
              })
            } finally {
              if (sessionInflight.get(sessionID) === token) {
                sessionInflight.delete(sessionID)
              }
            }
          }
        }
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          sessionIndex.delete(props.info.id)
          sessionFallback.delete(props.info.id)
          sessionInflight.delete(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
      }
    },
    "experimental.text.complete": async (input, output) => {
      const state = sessionFallback.get(input.sessionID)
      if (state && state.queue.length > 0) {
        const lines = state.queue.map(i => `[← Rate limit hit: switched to ${config.fallbackModels[i]}]`)
        output.text = lines.join("\n") + "\n" + output.text
        const elapsed = Date.now() - state.start
        await logger.info(
          `Fallback settled: ${config.fallbackModels[state.queue[state.queue.length - 1]]} (${state.queue.length} fallbacks in ${elapsed}ms)`,
          { sessionID: input.sessionID }
        )
        sessionFallback.delete(input.sessionID)
      }
    },
  }
}

function isSyntheticPart(part: MessagePart): boolean {
  return (part as any).synthetic === true
}

function convertToPromptPart(part: MessagePart): { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string } | null {
  switch (part.type) {
    case "text":
      if (part.text) {
        return { type: "text", text: part.text }
      }
      return null
    case "file":
      if (part.url && part.mime) {
        return { type: "file", mime: part.mime, filename: part.filename, url: part.url }
      }
      return null
    case "agent":
      if (part.name) {
        return { type: "agent", name: part.name }
      }
      return null
    default:
      return null
  }
}