import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface FallbackModelObject {
  providerID: string
  modelID: string
}

export type FallbackModel = string | FallbackModelObject

export interface RateLimitFallbackConfig {
  enabled: boolean
  fallbackModels: FallbackModel[]
  patterns: string[]
  logging: boolean
}

interface RawConfig {
  enabled?: boolean
  fallbackModels?: FallbackModel[]
  patterns?: string[]
  logging?: boolean
}

const DEFAULT_PATTERNS = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "cannot connect to api",
  "socket connection was closed unexpectedly",
  "socket hang up",
  "econnreset",
  "fetch failed",
  "connection refused",
  "network error",
]

const DEFAULT_CONFIG: RateLimitFallbackConfig = {
  enabled: true,
  fallbackModels: [],
  patterns: DEFAULT_PATTERNS,
  logging: false,
}

const CONFIG_FILENAME = "rate-limit-fallback-multi.json"
const SEARCH_SUBDIRS = ["config", "plugins", "plugin"]

function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    return join(appData, "opencode")
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdgConfig, "opencode")
}

function findConfigFile(): string | null {
  const configDir = getConfigDir()

  const rootPath = join(configDir, CONFIG_FILENAME)
  if (existsSync(rootPath)) {
    return rootPath
  }

  for (const subdir of SEARCH_SUBDIRS) {
    const subdirPath = join(configDir, subdir, CONFIG_FILENAME)
    if (existsSync(subdirPath)) {
      return subdirPath
    }
  }

  return null
}

function isValidFallbackModel(m: unknown): m is FallbackModel {
  if (typeof m === "string") return m.length > 0
  if (typeof m === "object" && m !== null) {
    const obj = m as Record<string, unknown>
    return typeof obj.providerID === "string" && obj.providerID.length > 0
      && typeof obj.modelID === "string" && obj.modelID.length > 0
  }
  return false
}

function validateConfig(raw: RawConfig): RateLimitFallbackConfig {
  const config: RateLimitFallbackConfig = {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    fallbackModels: DEFAULT_CONFIG.fallbackModels,
    patterns: DEFAULT_CONFIG.patterns,
    logging: raw.logging ?? DEFAULT_CONFIG.logging,
  }

  if (Array.isArray(raw.fallbackModels)) {
    config.fallbackModels = raw.fallbackModels.filter(isValidFallbackModel)
  }

  if (Array.isArray(raw.patterns)) {
    config.patterns = raw.patterns.filter(p => typeof p === "string" && p.length > 0)
  }

  return config
}

export function parseModel(model: FallbackModel): FallbackModelObject {
  if (typeof model === "object") {
    return model
  }
  const slashIndex = model.indexOf("/")
  if (slashIndex === -1) {
    return { providerID: model, modelID: model }
  }
  return {
    providerID: model.substring(0, slashIndex),
    modelID: model.substring(slashIndex + 1),
  }
}

export function loadConfig(): RateLimitFallbackConfig {
  const configPath = findConfigFile()

  if (!configPath) {
    return { ...DEFAULT_CONFIG }
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(content) as RawConfig
    return validateConfig(userConfig)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
