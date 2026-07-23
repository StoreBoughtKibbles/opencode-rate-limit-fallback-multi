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
  cooldownMs: number
  patterns: string[]
  logging: boolean
}

interface RawConfig {
  enabled?: boolean
  fallbackModels?: FallbackModel[]
  cooldownMs?: number
  patterns?: string[]
  logging?: boolean
}

const DEFAULT_PATTERNS = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
]

const DEFAULT_CONFIG: RateLimitFallbackConfig = {
  enabled: true,
  fallbackModels: [],
  cooldownMs: 300000,
  patterns: DEFAULT_PATTERNS,
  logging: false,
}

const CONFIG_FILENAME = "rate-limit-fallback.json"
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
    return DEFAULT_CONFIG
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(content) as RawConfig

    return {
      enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
      fallbackModels: userConfig.fallbackModels ?? DEFAULT_CONFIG.fallbackModels,
      cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      patterns: userConfig.patterns ?? DEFAULT_CONFIG.patterns,
      logging: userConfig.logging ?? DEFAULT_CONFIG.logging,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
