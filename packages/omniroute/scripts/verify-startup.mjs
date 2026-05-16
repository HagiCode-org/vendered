#!/usr/bin/env node

import http from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { quoteYamlString, renderConfigTemplate } from "../../../scripts/config-template.mjs"
import {
  getCrossPlatformWrapperDefinitions,
  getManifestBinEntries,
  getNativeSmokeWrapperFile,
  normalizeTargetPlatform,
  resolveReleasePath,
} from "./wrappers.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const downloadedDir = path.resolve(root, process.env.ARTIFACTS_DOWNLOAD_DIR || path.join("downloaded", "omniroute"))

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

async function main() {
  const metadataPath = await findFile(downloadedDir, (entryPath) => path.basename(entryPath) === "metadata.json")
  if (!metadataPath) {
    throw new Error(`No metadata.json found under ${downloadedDir}`)
  }

  const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
  if (metadata.packageId !== "omniroute") {
    throw new Error(`Expected omniroute metadata, received ${String(metadata.packageId)}`)
  }

  const archiveDescriptor = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.find((artifact) => artifact?.kind === "archive")
    : null
  if (!archiveDescriptor?.fileName) {
    throw new Error(`Metadata ${metadataPath} does not declare an archive artifact`)
  }

  const archivePath = path.join(path.dirname(metadataPath), archiveDescriptor.fileName)
  await access(archivePath)

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-omniroute-verify-"))

  try {
    await extractArchive(archivePath, tempDirectory)
    const releaseRoot = await findReleaseRoot(tempDirectory)
    const manifest = JSON.parse(await readFile(resolveReleasePath(releaseRoot, "package.json"), "utf8"))
    const binEntries = getManifestBinEntries(manifest)
    const targetPlatform = normalizeTargetPlatform(metadata.platform)
    const port = await getAvailablePort()
    const runtimeSetup = await createRuntimeSetup(tempDirectory)
    const configPath = await writeRuntimeConfig(releaseRoot, tempDirectory, port, runtimeSetup)

    await access(path.join(releaseRoot, "app", "server.js"))
    await assertPackagedEntrypoints(releaseRoot, binEntries)
    await assertWrapperFiles(releaseRoot, binEntries, targetPlatform)

    const version = await runAndCapture(process.execPath, [getPackagedEntrypoint(metadata), "--version"], {
      cwd: releaseRoot,
      env: runtimeSetup.env,
    })

    if (version.trim() !== metadata.version) {
      throw new Error(`Packaged OmniRoute version mismatch: expected ${metadata.version}, received ${version.trim()}`)
    }

    const nativeWrapperVersion = await runNativeWrapperVersion(releaseRoot, binEntries, targetPlatform, runtimeSetup.env)
    if (nativeWrapperVersion.trim() !== metadata.version) {
      throw new Error(
        `Native wrapper version mismatch: expected ${metadata.version}, received ${nativeWrapperVersion.trim()}`,
      )
    }

    await verifyPm2Startup(releaseRoot, binEntries, targetPlatform, runtimeSetup.env, configPath, port)

    console.log(`Verified OmniRoute package ${metadata.version} with PM2-managed wrapper startup`)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

async function createRuntimeSetup(tempDirectory) {
  const homeDir = path.join(tempDirectory, "home")
  const appDataDir = path.join(tempDirectory, "appdata")
  const localAppDataDir = path.join(tempDirectory, "localappdata")
  const dataDir = path.join(tempDirectory, "data")
  const pm2HomeDir = path.join(tempDirectory, "pm2-home")
  const logsDir = path.join(tempDirectory, "logs")
  const runtimeHomeDir = path.join(tempDirectory, "runtime-home")

  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(appDataDir, { recursive: true }),
    mkdir(localAppDataDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(pm2HomeDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(runtimeHomeDir, { recursive: true }),
  ])

  return {
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      DATA_DIR: dataDir,
      LOG_DIR: logsDir,
      PM2_HOME: pm2HomeDir,
      OMNIROUTE_MEMORY_MB: "256",
    },
    runtimeHomeDir,
    dataDir,
    logsDir,
  }
}

async function writeRuntimeConfig(releaseRoot, tempDirectory, port, runtimeSetup) {
  const configTemplatePath = resolveReleasePath(releaseRoot, "templates/omniroute-config.yaml")
  const configPath = path.join(tempDirectory, "omniroute-config.yaml")
  await access(configTemplatePath)
  await writeFile(
    configPath,
    renderConfigTemplate(await readFile(configTemplatePath, "utf8"), {
      RUNTIME_ROOT: quoteYamlString(runtimeSetup.runtimeHomeDir),
      LISTEN_ADDR: quoteYamlString(`127.0.0.1:${port}`),
      DATA_DIR: quoteYamlString(runtimeSetup.dataDir),
      LOGS_DIR: quoteYamlString(runtimeSetup.logsDir),
    }),
    "utf8",
  )

  return configPath
}

async function verifyPm2Startup(releaseRoot, binEntries, targetPlatform, env, configPath, port) {
  const processName = `vendored-omniroute-verify-${process.pid}-${Date.now()}`
  const pm2Command = getPm2Command()
  const wrapperFile = getNativeStartupWrapperFile(binEntries, targetPlatform)
  const wrapperPath = resolveReleasePath(releaseRoot, wrapperFile)
  const pm2Startup = buildPm2StartupInvocation({
    processName,
    wrapperPath,
    targetPlatform,
    configPath,
  })

  await ensurePm2Available(pm2Command, env)

  try {
    await run(pm2Command, pm2Startup, {
      cwd: releaseRoot,
      env,
    })

    await waitForOmniRouteHealth({ pm2Command, processName, port, env })
  } finally {
    await cleanupPm2(pm2Command, processName, env)
  }
}

async function ensurePm2Available(pm2Command, env) {
  try {
    await runAndCapture(pm2Command, ["--version"], { env })
  } catch (error) {
    throw new Error(
      `pm2 is required for OmniRoute verification but was not available via ${pm2Command}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function waitForOmniRouteHealth({ pm2Command, processName, port, env }) {
  const deadline = Date.now() + 90_000

  while (Date.now() < deadline) {
    try {
      const response = await requestHealth(port)
      if (response.statusCode === 200) {
        return
      }
    } catch {
      // Retry until the deadline expires.
    }

    const status = await readPm2Status(pm2Command, processName, env)
    if (status === "errored" || status === "stopped" || status === "stopping") {
      const diagnostics = await readPm2Diagnostics(pm2Command, processName, env)
      throw new Error(`OmniRoute entered PM2 status ${status} before becoming healthy.\n${diagnostics}`)
    }

    await delay(1000)
  }

  const diagnostics = await readPm2Diagnostics(pm2Command, processName, env)
  throw new Error(`Timed out waiting for OmniRoute health endpoint on port ${port}.\n${diagnostics}`)
}

async function extractArchive(archivePath, destinationDir) {
  if (archivePath.endsWith(".tar.gz")) {
    await run("tar", ["-xzf", archivePath, "-C", destinationDir])
    return
  }

  if (!archivePath.endsWith(".zip")) {
    throw new Error(`Unsupported archive format: ${archivePath}`)
  }

  await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(destinationDir.replaceAll("/", "\\"))}' -Force`,
  ])
}

async function findReleaseRoot(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const candidate = path.join(rootDir, entry.name)
    if (await exists(path.join(candidate, "bin", "omniroute.mjs"))) {
      return candidate
    }
  }

  throw new Error(`Unable to find extracted OmniRoute release root in ${rootDir}`)
}

async function assertPackagedEntrypoints(releaseRoot, binEntries) {
  for (const binEntry of binEntries) {
    await access(resolveReleasePath(releaseRoot, binEntry.entryPath))
  }
}

async function assertWrapperFiles(releaseRoot, binEntries, targetPlatform) {
  const wrapperDefinitions = getCrossPlatformWrapperDefinitions(binEntries)
  for (const wrapperDefinition of wrapperDefinitions) {
    await access(resolveReleasePath(releaseRoot, wrapperDefinition.fileName))
  }
}

async function runNativeWrapperVersion(releaseRoot, binEntries, targetPlatform, env) {
  const wrapperFile = getNativeSmokeWrapperFile(binEntries, targetPlatform)
  const wrapperPath = resolveReleasePath(releaseRoot, wrapperFile)

  return runAndCapture(wrapperPath, ["--version"], {
    cwd: releaseRoot,
    env,
  })
}

function getPackagedEntrypoint(metadata) {
  const packagedEntrypoint = metadata?.extra?.packagedEntrypoint
  return typeof packagedEntrypoint === "string" && packagedEntrypoint.length > 0
    ? packagedEntrypoint
    : path.join("bin", "omniroute.mjs")
}

function getNativeStartupWrapperFile(binEntries, targetPlatform) {
  const preferredEntry = binEntries.find((entry) => entry.command === "omniroute") ?? binEntries[0]
  if (!preferredEntry) {
    throw new Error("Expected at least one CLI command in package.json bin")
  }

  return normalizeTargetPlatform(targetPlatform) === "windows"
    ? `${preferredEntry.command}.cmd`
    : `${preferredEntry.command}.sh`
}

function getPm2Command(hostPlatform = process.platform) {
  return hostPlatform === "win32" ? "pm2.cmd" : "pm2"
}

function getPm2WrapperStartCommand(wrapperPath, targetPlatform) {
  if (normalizeTargetPlatform(targetPlatform) === "windows") {
    return {
      command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      pm2Args: ["--interpreter", "none"],
      runtimeArgs: ["/d", "/s", "/c", wrapperPath],
    }
  }

  return {
    command: wrapperPath,
    pm2Args: ["--interpreter", "none"],
    runtimeArgs: [],
  }
}

function buildPm2StartupInvocation({ processName, wrapperPath, targetPlatform, configPath }) {
  const pm2Start = getPm2WrapperStartCommand(wrapperPath, targetPlatform)

  return [
    "start",
    pm2Start.command,
    "--name",
    processName,
    ...pm2Start.pm2Args,
    "--",
    ...pm2Start.runtimeArgs,
    "--config",
    configPath,
    "--no-open",
  ]
}

async function readPm2Status(pm2Command, processName, env) {
  try {
    const output = await runAndCapture(pm2Command, ["jlist"], { env })
    const processes = JSON.parse(output)
    const processInfo = Array.isArray(processes)
      ? processes.find((entry) => entry?.name === processName)
      : null

    return typeof processInfo?.pm2_env?.status === "string" ? processInfo.pm2_env.status : null
  } catch {
    return null
  }
}

async function readPm2Diagnostics(pm2Command, processName, env) {
  const diagnostics = []

  try {
    diagnostics.push("pm2 describe:")
    diagnostics.push((await runAndCapture(pm2Command, ["describe", processName], { env })).trim())
  } catch (error) {
    diagnostics.push(`pm2 describe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    diagnostics.push("pm2 logs:")
    diagnostics.push((await runAndCapture(pm2Command, ["logs", processName, "--lines", "200", "--nostream"], { env })).trim())
  } catch (error) {
    diagnostics.push(`pm2 logs failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return diagnostics.filter(Boolean).join("\n")
}

async function cleanupPm2(pm2Command, processName, env) {
  await Promise.allSettled([
    run(pm2Command, ["delete", processName], { env }),
  ])
  await Promise.allSettled([
    run(pm2Command, ["kill"], { env }),
  ])
}

async function findFile(rootDir, predicate) {
  const entries = await readdir(rootDir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isFile() && predicate(entryPath)) {
      return entryPath
    }

    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, predicate)
      if (nested) {
        return nested
      }
    }
  }

  return null
}

async function exists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/api/monitoring/health" },
      (response) => {
        response.resume()
        resolve(response)
      },
    )
    request.on("error", reject)
  })
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve a free port")))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function resolveSpawnInvocation(command, args, hostPlatform = process.platform) {
  const resolvedCommand = resolveCommand(command, hostPlatform)

  if (hostPlatform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand)) {
    return {
      command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", resolvedCommand, ...args],
    }
  }

  if (hostPlatform === "win32" && /\.ps1$/i.test(resolvedCommand)) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...args],
    }
  }

  return { command: resolvedCommand, args }
}

function resolveCommand(command, hostPlatform = process.platform) {
  if (hostPlatform === "win32" && !path.extname(command) && ["npm", "npx", "pm2"].includes(command)) {
    return `${command}.cmd`
  }

  return command
}

function run(command, args, options = {}) {
  const invocation = resolveSpawnInvocation(command, args)

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: "inherit",
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${invocation.command} ${invocation.args.join(" ")} exited with code ${code}`))
    })
  })
}

function runAndCapture(command, args, options = {}) {
  const invocation = resolveSpawnInvocation(command, args)

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      const stderrSummary = stderr.trim().length > 0 ? `\nstderr:\n${stderr.trim()}` : ""
      reject(new Error(`${invocation.command} ${invocation.args.join(" ")} exited with code ${code}${stderrSummary}`))
    })
  })
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
}

export { buildPm2StartupInvocation, getNativeStartupWrapperFile, resolveSpawnInvocation }
