export function translateOmniRouteInvocation(argv, env, platform = process.platform) {
  const nextEnv = { ...env }
  const nextArgs = []
  let configPath = null
  let explicitPort = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === "--config" && index + 1 < argv.length) {
      configPath = argv[index + 1]
      nextArgs.push(argument, configPath)
      index += 1
      continue
    }

    if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length)
      nextArgs.push(argument)
      continue
    }

    if (argument === "--port" && index + 1 < argv.length) {
      explicitPort = argv[index + 1]
      index += 1
      continue
    }

    if (argument.startsWith("--port=")) {
      explicitPort = argument.slice("--port=".length)
      continue
    }

    nextArgs.push(argument)
  }

  const config = configPath ? loadVendoredConfig(configPath) : {}
  applyVendoredEnvironment(config, nextEnv, platform)

  const port = normalizePort(explicitPort) ?? extractPortFromListen(config.listen)
  if (port) {
    nextEnv.PORT = port
  }

  return {
    args: nextArgs,
    env: nextEnv,
  }
}

export function loadVendoredConfig(configPath) {
  return parseSimpleYamlFile(configPath)
}

export function parseSimpleYamlFile(configPath) {
  return parseSimpleYaml(readFileUtf8(configPath))
}

export function parseSimpleYaml(source) {
  const config = {}

  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmed.indexOf(":")
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    config[key] = parseYamlScalar(rawValue)
  }

  return config
}

export function parseYamlScalar(rawValue) {
  if (!rawValue) {
    return ""
  }

  if (rawValue.startsWith('"')) {
    return JSON.parse(rawValue)
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1).replaceAll("''", "'")
  }

  return rawValue
}

export function applyVendoredEnvironment(config, env, platform = process.platform) {
  if (typeof config.dataDir === "string" && config.dataDir.length > 0) {
    env.DATA_DIR = config.dataDir
  }

  if (typeof config.logDir === "string" && config.logDir.length > 0) {
    env.LOG_DIR = config.logDir
  }

  if (typeof config.runtimeHome === "string" && config.runtimeHome.length > 0) {
    env.HOME = config.runtimeHome
    if (platform === "win32") {
      env.USERPROFILE = config.runtimeHome
    }
  }
}

export function extractPortFromListen(listenValue) {
  if (typeof listenValue !== "string" || listenValue.length === 0) {
    return null
  }

  const normalized = listenValue.trim()
  if (/^\d+$/.test(normalized)) {
    return normalized
  }

  const match = /:(\d+)$/.exec(normalized)
  return match ? match[1] : null
}

export function normalizePort(value) {
  if (value == null) {
    return null
  }

  const normalized = String(value).trim()
  return /^\d+$/.test(normalized) ? normalized : null
}

function readFileUtf8(configPath) {
  return requireNodeFs().readFileSync(configPath, "utf8")
}

function requireNodeFs() {
  return require("node:fs")
}
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
