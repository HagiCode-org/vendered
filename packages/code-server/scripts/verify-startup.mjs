#!/usr/bin/env node

import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const downloadedDir = path.resolve(root, process.env.ARTIFACTS_DOWNLOAD_DIR || path.join("artifacts", "code-server"))

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

async function main() {
  process.chdir(root)
  const metadataPath = await findFile(downloadedDir, (entryPath) => path.basename(entryPath) === "metadata.json")
  if (!metadataPath) {
    throw new Error(`No metadata.json found under ${downloadedDir}`)
  }

  const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
  if (metadata.packageId !== "code-server") {
    throw new Error(`Expected code-server metadata, received ${String(metadata.packageId)}`)
  }

  const archivePath = resolveArchivePath(metadata, metadataPath)
  await access(archivePath)

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "vendored-code-server-verify-"))
  await extractArchive(archivePath, extractionRoot)
  const runtimeRoot = await findReleaseRoot(extractionRoot)
  const entryPath = path.join(runtimeRoot, "out", "node", "entry.js")
  await access(entryPath)
  await assertPackagedEntrypoints(runtimeRoot)

  const port = await getAvailablePort()
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "code-server-user-data-"))
  const extensionsDir = await mkdtemp(path.join(os.tmpdir(), "code-server-extensions-"))
  const configDir = await mkdtemp(path.join(os.tmpdir(), "code-server-config-"))
  const pm2HomeDir = await mkdtemp(path.join(os.tmpdir(), "code-server-pm2-home-"))
  const configPath = path.join(configDir, "config.yaml")

  await writeFile(
    configPath,
    [
      `bind-addr: 127.0.0.1:${port}`,
      "auth: none",
      `user-data-dir: ${JSON.stringify(userDataDir)}`,
      `extensions-dir: ${JSON.stringify(extensionsDir)}`,
      "disable-telemetry: true",
      "disable-update-check: true",
    ].join("\n") + "\n",
    "utf8",
  )

  try {
    const runtimeEnv = {
      ...process.env,
      PASSWORD: "",
      PM2_HOME: pm2HomeDir,
    }

    await verifyPm2Startup(runtimeRoot, configPath, port, runtimeEnv)
  } finally {
    await Promise.allSettled([
      rm(userDataDir, { recursive: true, force: true }),
      rm(extensionsDir, { recursive: true, force: true }),
      rm(configDir, { recursive: true, force: true }),
      rm(pm2HomeDir, { recursive: true, force: true }),
      rm(extractionRoot, { recursive: true, force: true }),
    ])
  }
}

async function verifyPm2Startup(runtimeRoot, configPath, port, env) {
  const processName = `vendored-code-server-verify-${process.pid}-${Date.now()}`
  const pm2Command = getPm2Command()
  const wrapperPath = getNativeSmokeEntrypoint(runtimeRoot)
  const pm2Start = getPm2WrapperStartCommand(wrapperPath)

  await ensurePm2Available(pm2Command, env)

  try {
    await run(pm2Command, [
      "start",
      pm2Start.command,
      "--name",
      processName,
      ...pm2Start.pm2Args,
      "--",
      ...pm2Start.runtimeArgs,
      "--config",
      configPath,
      "--disable-telemetry",
      "--disable-update-check",
    ], {
      cwd: runtimeRoot,
      env,
    })

    await waitForHealth({ port, pm2Command, processName, env })
  } finally {
    await cleanupPm2(pm2Command, processName, env)
  }
}

export function resolveArchivePath(metadata, metadataPath) {
  const archiveDescriptor = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.find((artifact) => artifact?.kind === "archive")
    : null

  if (!archiveDescriptor?.fileName) {
    throw new Error(`Metadata ${metadataPath} does not declare an archive artifact`)
  }

  return path.join(path.dirname(metadataPath), archiveDescriptor.fileName)
}

export async function extractArchive(archivePath, destinationDir) {
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

export async function findReleaseRoot(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const candidate = path.join(rootDir, entry.name)
    if (await exists(path.join(candidate, "out", "node", "entry.js"))) {
      return candidate
    }
  }

  throw new Error(`Unable to find extracted code-server release root in ${rootDir}`)
}

async function assertPackagedEntrypoints(runtimeRoot) {
  await Promise.all([
    access(path.join(runtimeRoot, "out", "node", "entry.js")),
    access(path.join(runtimeRoot, "bin", "code-server")),
    access(path.join(runtimeRoot, "bin", "code-server.cmd")),
    access(path.join(runtimeRoot, "bin", "code-server.ps1")),
  ])
}

export function getNativeSmokeEntrypoint(runtimeRoot, hostPlatform = process.platform) {
  return path.join(runtimeRoot, "bin", hostPlatform === "win32" ? "code-server.ps1" : "code-server")
}

function getPm2Command(hostPlatform = process.platform) {
  return hostPlatform === "win32" ? "pm2.cmd" : "pm2"
}

function getPm2WrapperStartCommand(wrapperPath, hostPlatform = process.platform) {
  if (hostPlatform === "win32") {
    return {
      command: wrapperPath,
      pm2Args: ["--interpreter", "powershell.exe"],
      runtimeArgs: [],
    }
  }

  return {
    command: wrapperPath,
    pm2Args: ["--interpreter", "none"],
    runtimeArgs: [],
  }
}

export function resolveSpawnInvocation(command, args, hostPlatform = process.platform) {
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

async function waitForHealth({ port, pm2Command, processName, env }) {
  const deadline = Date.now() + 60_000
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
      throw new Error(`code-server entered PM2 status ${status} before becoming healthy.\n${diagnostics}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  const diagnostics = await readPm2Diagnostics(pm2Command, processName, env)
  throw new Error(`Timed out waiting for code-server to become healthy on port ${port}.\n${diagnostics}`)
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/healthz" },
      (response) => {
        response.resume()
        resolve(response)
      },
    )
    request.on("error", reject)
  })
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

async function ensurePm2Available(pm2Command, env) {
  try {
    await runAndCapture(pm2Command, ["--version"], { env })
  } catch (error) {
    throw new Error(
      `pm2 is required for code-server verification but was not available via ${pm2Command}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
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

function resolveCommand(command, hostPlatform = process.platform) {
  if (hostPlatform === "win32" && !path.extname(command) && ["pm2"].includes(command)) {
    return `${command}.cmd`
  }

  return command
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}
