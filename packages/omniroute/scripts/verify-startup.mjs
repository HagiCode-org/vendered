#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const downloadedDir = path.resolve(root, process.env.ARTIFACTS_DOWNLOAD_DIR || path.join("downloaded", "omniroute"))

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

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
    await access(path.join(releaseRoot, "app", "server.js"))
    await access(path.join(releaseRoot, "bin", "omniroute.mjs"))

    const version = await runAndCapture(
      process.execPath,
      [path.join("bin", "omniroute.mjs"), "--version"],
      {
        cwd: releaseRoot,
        env: {
          ...process.env,
          HOME: path.join(tempDirectory, "home"),
          USERPROFILE: path.join(tempDirectory, "home"),
          APPDATA: path.join(tempDirectory, "appdata"),
          DATA_DIR: path.join(tempDirectory, "data"),
          OMNIROUTE_MEMORY_MB: "256",
        },
      },
    )

    if (version.trim() !== metadata.version) {
      throw new Error(`Packaged OmniRoute version mismatch: expected ${metadata.version}, received ${version.trim()}`)
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

function runAndCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}
