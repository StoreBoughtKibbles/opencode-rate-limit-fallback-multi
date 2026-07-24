# opencode-rate-limit-fallback-multi

OpenCode plugin that automatically switches through a hierarchy of fallback models when rate limits are hit.

## Installation

Add to your `opencode.jsonc`:

```json
{
  "plugin": ["opencode-rate-limit-fallback-multi"]
}
```

## Configuration

Create `rate-limit-fallback-multi.json` in your OpenCode config directory:

**Recommended location (checked first):**
1. `~/.config/opencode/rate-limit-fallback-multi.json`

**Alternative locations (checked in order):**
1. `~/.config/opencode/config/rate-limit-fallback-multi.json`
2. `~/.config/opencode/plugins/rate-limit-fallback-multi.json`
3. `~/.config/opencode/plugin/rate-limit-fallback-multi.json`

**Example config:**

```json
{
  "enabled": true,
  "fallbackModels": [
    "anthropic/claude-sonnet-4-20250514",
    "openai/gpt-4o",
    "google/gemini-2.5-pro"
  ],
  "patterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded",
    "overloaded"
  ],
  "logging": true
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `fallbackModels` | array | `[]` | Ordered list of fallback models |
| `patterns` | string[] | (see below) | Custom rate limit detection patterns |
| `logging` | boolean | `false` | Enable file-based logging |

### Fallback Model Formats

**String format (recommended):**
```json
{
  "fallbackModels": ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]
}
```

**Object format:**
```json
{
  "fallbackModels": [
    { "providerID": "anthropic", "modelID": "claude-sonnet-4-20250514" },
    { "providerID": "openai", "modelID": "gpt-4o" }
  ]
}
```

### Custom Patterns

Add your own rate limit detection patterns:

```json
{
  "patterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded",
    "overloaded",
    "capacity exceeded"
  ]
}
```

Patterns are case-insensitive and matched against the retry message.

### Logging

When `logging: true`, logs are written to:
```
~/.local/share/opencode/logs/rate-limit-fallback.log
```

Log entries include timestamps and details about rate limit detection, fallback attempts, and errors.

## How It Works

1. **Detection**: Listens for `session.status` events with retry messages matching configured patterns.

2. **Fallback chain**: When a rate limit is detected, the plugin aborts the current retry, reverts the session to before the last user message, and re-sends it with the **next** model in the `fallbackModels` list.

3. **Linear progression**: Each session independently walks forward through the list. If a session hits rate limits on models 0, 1, and 2, it will try 0 → 1 → 2 → then stop (exhausted). The list is never scanned backward — each new rate limit advances to the next index.

4. **Per-session tracking**: The plugin tracks which index each session is on. A new session starts from its original model and only enters the fallback chain if it hits a rate limit. Session state is cleaned up when the session is deleted.

This approach keeps the conversation history clean — no "continue" messages or duplicates. The session seamlessly falls through the hierarchy.

## Local Development

For local development, use a `file://` URL in your config:

```json
{
  "plugin": [
    "file:///path/to/opencode-rate-limit-fallback-multi/index.ts"
  ]
}
```

## License

MIT