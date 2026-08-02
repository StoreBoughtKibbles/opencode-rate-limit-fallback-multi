import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "logs"
)
const LOG_FILE = join(LOG_DIR, "rate-limit-fallback.log")

type Level = "INFO" | "WARN" | "ERROR"

let initialized = false

async function ensureDir(): Promise<void> {
  if (initialized) return
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {})
  initialized = true
}

export async function log(
  level: Level,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await ensureDir()
  const timestamp = new Date().toISOString()
  const extraStr = extra ? " " + JSON.stringify(extra) : ""
  const line = `${timestamp} [${level}] ${message}${extraStr}\n`
  await appendFile(LOG_FILE, line).catch(() => {})
}

type LogFn = (message: string, extra?: Record<string, unknown>) => Promise<void>

const noop: LogFn = async () => {}

export function createLogger(enabled: boolean) {
  if (!enabled) {
    return { info: noop, warn: noop, error: noop }
  }
  const logAt = (level: Level): LogFn => (message, extra) => log(level, message, extra)
  return { info: logAt("INFO"), warn: logAt("WARN"), error: logAt("ERROR") }
}
