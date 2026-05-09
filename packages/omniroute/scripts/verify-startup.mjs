#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { getManifestBinEntries, getNativeSmokeWrapperFile, getWrapperDefinitions, normalizeTargetPlatform, resolveReleasePath } from "./wrappers.mjs"

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
    const runtimeEnv = {
      ...process.env,
      HOME: path.join(tempDirectory, "home"),
      USERPROFILE: path.join(tempDirectory, "home"),
      APPDATA: path.join(tempDirectory, "appdata"),
      DATA_DIR: path.join(tempDirectory, "data"),
      OMNIROUTE_MEMORY_MB: "256",
    }

    await access(path.join(releaseRoot, "app", "server.js"))
    await assertPackagedEntrypoints(releaseRoot, binEntries)
    await assertWrapperFiles(releaseRoot, binEntries, targetPlatform)

    const version = await runAndCapture(
      process.execPath,
      [getPackagedEntrypoint(metadata), "--version"],
      {
        cwd: releaseRoot,
        env: runtimeEnv,
      },
    )

    if (version.trim() !== metadata.version) {
      throw new Error(`Packaged OmniRoute version mismatch: expected ${metadata.version}, received ${version.trim()}`)
    }

    const nativeWrapperVersion = await runNativeWrapperVersion(releaseRoot, binEntries, targetPlatform, runtimeEnv)
    if (nativeWrapperVersion.trim() !== metadata.version) {
      throw new Error(
        `Native wrapper version mismatch: expected ${metadata.version}, received ${nativeWrapperVersion.trim()}`,
      )
    }

    console.log(`Verified OmniRoute package ${metadata.version}`)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
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
  const wrapperDefinitions = getWrapperDefinitions(binEntries, targetPlatform)
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

export function resolveSpawnInvocation(command, args, hostPlatform = process.platform) {
  if (hostPlatform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    }
  }

  return { command, args }
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
      stdio: ["ignore", "pipe", "inherit"],
    })

    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output)
        return
      }
      reject(new Error(`${invocation.command} ${invocation.args.join(" ")} exited with code ${code}`))
    })
  })
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
}
