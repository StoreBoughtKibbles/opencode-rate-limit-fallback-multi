import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, parseModel } from "./config"
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

function createPatternMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
  }
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()
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
            const currentIndex = sessionIndex.get(sessionID) ?? -1
            const nextIndex = currentIndex + 1

            if (nextIndex >= fallbackModels.length) {
              await logger.info("All fallbacks exhausted, no more models to try", { sessionID })
              return
            }

            const model = fallbackModels[nextIndex]

            await logger.info("Rate limit detected, switching to next fallback", {
              sessionID,
              message: props.status.message,
              fromIndex: currentIndex,
              toIndex: nextIndex,
              model: config.fallbackModels[nextIndex],
            })

            try {
              await logger.info("Aborting session", { sessionID })
              await context.client.session.abort({ path: { id: sessionID } })
              await new Promise(resolve => setTimeout(resolve, 200))

              await logger.info("Fetching messages", { sessionID })
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

              await logger.info("Found last user message", {
                sessionID,
                messageId: lastUserMessage.info.id,
                totalMessages: messages.length,
              })

              await logger.info("Reverting session", { sessionID, messageId: lastUserMessage.info.id })
              const revertResponse = await context.client.session.revert({
                path: { id: sessionID },
                body: { messageID: lastUserMessage.info.id },
              })
              await logger.info("Revert completed", {
                sessionID,
                revertStatus: revertResponse.response?.status,
                hasRevertState: !!(revertResponse.data as any)?.revert,
              })
              await new Promise(resolve => setTimeout(resolve, 500))

              const originalParts = lastUserMessage.parts
                .filter(p => !isSyntheticPart(p))
                .map(p => convertToPromptPart(p))
                .filter((p): p is NonNullable<typeof p> => p !== null)

              if (originalParts.length === 0) {
                await logger.error("No valid parts found in user message", { sessionID })
                return
              }

              await logger.info("Sending prompt with fallback model", {
                sessionID,
                model,
                index: nextIndex,
                partsCount: originalParts.length,
              })
              await context.client.session.prompt({
                path: { id: sessionID },
                body: {
                  model,
                  agent: lastUserMessage.info.agent,
                  parts: originalParts,
                },
              })

              sessionIndex.set(sessionID, nextIndex)
              await logger.info("Fallback prompt sent successfully", { sessionID, index: nextIndex })
            } catch (err) {
              await logger.error("Failed to send fallback prompt", {
                sessionID,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          sessionIndex.delete(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
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