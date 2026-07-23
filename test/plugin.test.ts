import { describe, expect, test, mock } from "bun:test"
import { createPlugin } from "../src/plugin"

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

  test("ignores non-retry status events", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client))

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
    const hooks = await createPlugin(mockContext(client))

    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-2",
          status: { type: "retry", message: "connection timeout" },
        },
      } as any,
    })

    expect(client.session.abort).not.toHaveBeenCalled()
  })

  test("advances from -1 to 0 on first rate limit", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client))

    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-3",
          status: { type: "retry", message: "rate limit exceeded" },
        },
      } as any,
    })

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "sess-3" } })
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: "sess-3" } })
    expect(client.session.revert).toHaveBeenCalled()
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
    const hooks = await createPlugin(mockContext(client))

    // First rate limit → moves to index 0
    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-4",
          status: { type: "retry", message: "rate limit exceeded" },
        },
      } as any,
    })

    // Second rate limit → tries index 1, but default config has 1 model → exhausted
    const promptCount = client.session.prompt.mock.calls.length
    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-4",
          status: { type: "retry", message: "rate limit exceeded again" },
        },
      } as any,
    })

    expect(client.session.prompt.mock.calls.length).toBe(promptCount)
  })

  test("cleans up session state on session.deleted", async () => {
    const client = mockClient()
    const hooks = await createPlugin(mockContext(client))

    // Trigger a fallback to set session index
    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "sess-5",
          status: { type: "retry", message: "rate limit" },
        },
      } as any,
    })

    // Delete the session
    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "sess-5" } },
      } as any,
    })

    // Session should be able to start fresh after deletion (no crash)
  })
})