import { describe, expect, test, mock } from "bun:test"
import { createPlugin } from "../src/plugin"
import { type RateLimitFallbackConfig } from "../src/config"

function testConfig(overrides?: Partial<RateLimitFallbackConfig>): RateLimitFallbackConfig {
  return {
    enabled: true,
    fallbackModels: ["anthropic/claude-opus-4-5"],
    patterns: ["rate limit", "usage limit", "too many requests"],
    logging: false,
    ...overrides,
  }
}

describe("createPlugin", () => {
  const mockClient = () => {
    const abort = mock(() => Promise.resolve({} as any))
    const messages = mock(() =>
      Promise.resolve({
        data: [
          {
            info: { id: "msg1", role: "user", sessionID: "sess-1" },
            parts: [{ id: "p1", type: "text", text: "hello" }],
          },
        ],
      } as any),
    )
    const revert = mock(() =>
      Promise.resolve({ response: { status: 200 }, data: { revert: true } } as any),
    )
    const prompt = mock(() => Promise.resolve({} as any))

    return {
      session: { abort, messages, revert, prompt },
      app: { log: mock(() => Promise.resolve()) },
    } as any
  }

  const mockContext = (client: any) => ({
    client,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost:4096"),
    $: {} as any,
  })

  type Hooks = Awaited<ReturnType<typeof createPlugin>>

  function fireRetry(hooks: Hooks, sessionID: string, message: string): Promise<void> {
    return hooks.event!({
      event: {
        type: "session.status",
        properties: { sessionID, status: { type: "retry", message } },
      } as any,
    })
  }

  test("ignores non-retry status events", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-1",
          status: { type: "busy" },
        },
      } as any,
    })

    expect(client.session.abort).not.toHaveBeenCalled()
  })

  test("ignores retry messages that don't match rate limit patterns", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    await fireRetry(hooks, "sess-2", "connection timeout")

    expect(client.session.abort).not.toHaveBeenCalled()
  })

  test("advances from -1 to 0 on first rate limit", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    await fireRetry(hooks, "sess-3", "rate limit exceeded")

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "sess-3" } })
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: "sess-3" } })
    expect(client.session.revert).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "sess-3" },
      body: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        parts: [{ type: "text", text: "hello" }],
      },
    })
  })

  test("advances from 0 to exhaustion on second rate limit", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    // First rate limit → moves to index 0
    await fireRetry(hooks, "sess-4", "rate limit exceeded")

    // Second rate limit → tries index 1, but default config has 1 model → exhausted
    const promptCount = client.session.prompt.mock.calls.length
    await fireRetry(hooks, "sess-4", "rate limit exceeded again")

    expect(client.session.prompt.mock.calls.length).toBe(promptCount)
  })

  test("cleans up session state on session.deleted", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    // Trigger a fallback to set session index and display queue
    await fireRetry(hooks, "sess-5", "rate limit")

    // Delete the session
    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "sess-5" } },
      } as any,
    })

    // Stale display queue must be cleared: no completion marker
    const output: any = { text: "original response" }
    await hooks["experimental.text.complete"]!({ sessionID: "sess-5" } as any, output)
    expect(output.text).toBe("original response")

    // Stale index must be cleared: a new retry starts at index 0, not exhaustion
    await fireRetry(hooks, "sess-5", "rate limit")

    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(client.session.prompt.mock.calls[1][0].body.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  test("does not revert a user message with no replayable parts", async () => {
    const client = mockClient()
    client.session.messages.mockResolvedValueOnce({
      data: [
        {
          info: { id: "msg1", role: "user", sessionID: "sess-10" },
          parts: [{ id: "p1", type: "tool" }],
        },
      ],
    } as any)
    const hooks = await createPlugin(mockContext(client), testConfig())

    await fireRetry(hooks, "sess-10", "rate limit exceeded")

    expect(client.session.abort).toHaveBeenCalled()
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  test("failed prompt does not consume a model index", async () => {
    const client = mockClient()
    client.session.prompt.mockRejectedValueOnce(new Error("network error"))
    const hooks = await createPlugin(mockContext(client), testConfig())

    await fireRetry(hooks, "sess-11", "rate limit exceeded")
    await fireRetry(hooks, "sess-11", "rate limit exceeded")

    expect(client.session.prompt.mock.calls.length).toBe(2)
    expect(client.session.prompt.mock.calls[0][0].body.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  test("failed fallback does not leave a false completion marker", async () => {
    const client = mockClient()
    client.session.prompt.mockRejectedValueOnce(new Error("network error"))
    const hooks = await createPlugin(mockContext(client), testConfig())

    await fireRetry(hooks, "sess-12", "rate limit exceeded")

    const output: any = { text: "original response" }
    await hooks["experimental.text.complete"]!({ sessionID: "sess-12" } as any, output)

    expect(output.text).toBe("original response")
  })

  test("coalesces overlapping retry events for the same session", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client), testConfig())

    const first = fireRetry(hooks, "sess-13", "rate limit exceeded")

    await new Promise(resolve => setTimeout(resolve, 50))

    // Second matching retry arrives while the first workflow is in flight
    await fireRetry(hooks, "sess-13", "rate limit exceeded again")

    await first

    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect(client.session.messages).toHaveBeenCalledTimes(1)
    expect(client.session.revert).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
  })

  test("a retry after a completed fallback advances to the next model", async () => {
    const client = mockClient()
    const hooks = await createPlugin(
      mockContext(client),
      testConfig({
        fallbackModels: ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5"],
      }),
    )

    for (const message of ["rate limit exceeded", "rate limit exceeded again"]) {
      await fireRetry(hooks, "sess-14", message)
    }

    expect(client.session.abort).toHaveBeenCalledTimes(2)
    expect(client.session.revert).toHaveBeenCalledTimes(2)
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(client.session.prompt.mock.calls[1][0].body.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  test("empty pattern is filtered out and does not match every retry", async () => {
    const client = mockClient()
    const hooks = await createPlugin(
      mockContext(client),
      testConfig({ patterns: [""] }),
    )

    await fireRetry(hooks, "sess-6", "anything at all")

    expect(client.session.abort).not.toHaveBeenCalled()
  })

  test("invalid fallbackModels entries are filtered out", async () => {
    const client = mockClient()
    const hooks = await createPlugin(
      mockContext(client),
      testConfig({ fallbackModels: [null as any, "", "valid/model"] }),
    )

    await fireRetry(hooks, "sess-7", "rate limit")

    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "sess-7" },
      body: {
        model: { providerID: "valid", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      },
    })
  })

  test("non-array fallbackModels falls back to empty (exhaustion)", async () => {
    const client = mockClient()
    const hooks = await createPlugin(
      mockContext(client),
      testConfig({ fallbackModels: undefined as any }),
    )

    await fireRetry(hooks, "sess-8", "rate limit")

    expect(client.session.abort).not.toHaveBeenCalled()
  })
})