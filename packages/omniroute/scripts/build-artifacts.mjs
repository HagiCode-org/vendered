#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { PUBLICATION_SCHEMA_VERSION, buildBlobKey } from "../../../scripts/publication.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const upstreamRoot = path.join(packageRoot, "upstream")
const artifactsDir = path.join(root, process.env.ARTIFACTS_OUTPUT_DIR || path.join("artifacts", "omniroute"))
const releaseWorkspace = path.join(root, "release", "omniroute")
const packageId = "omniroute"
const platform = normalizePlatform(process.env.BUILD_ARTIFACTS_PLATFORM || process.platform)
const arch = normalizeArch(process.env.ARCH || process.arch)

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

async function main() {
  process.chdir(root)
  await access(upstreamRoot)

  const upstreamVersion = await readUpstreamVersion()
  const version = process.env.VERSION || upstreamVersion

  await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: root })
  await rm(artifactsDir, { recursive: true, force: true })
  await rm(releaseWorkspace, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(releaseWorkspace, { recursive: true })

  if (platform === "windows") {
    await patchWindowsPrepublishCommands()
  }

  await run("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: upstreamRoot,
    env: withBuildEnv(process.env, version),
  })
  await run("npm", ["run", "build:cli"], {
    cwd: upstreamRoot,
    env: withBuildEnv(process.env, version),
  })
  await run("npm", ["run", "check:pack-artifact"], {
    cwd: upstreamRoot,
    env: withBuildEnv(process.env, version),
  })

  const releaseRoot = await stageReleaseTree(version)
  const artifacts = await createArchive(version, releaseRoot)
  await writeMetadata(version, upstreamVersion, artifacts)
}

async function stageReleaseTree(version) {
  const releaseRoot = path.join(releaseWorkspace, `${packageId}-${version}-${platform}-${arch}`)
  await rm(releaseRoot, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })

  const manifest = JSON.parse(await readFile(path.join(upstreamRoot, "package.json"), "utf8"))
  const publishPaths = new Set([...(Array.isArray(manifest.files) ? manifest.files : []), "package.json", "package-lock.json", ".node-version"])

  for (const relativePath of [...publishPaths].sort()) {
    const sourcePath = path.join(upstreamRoot, relativePath)
    if (!(await exists(sourcePath))) {
      continue
    }

    const destinationPath = path.join(releaseRoot, relativePath)
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
    })
  }

  const stagedManifestPath = path.join(releaseRoot, "package.json")
  const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"))
  stagedManifest.version = version
  await writeFile(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`)

  await access(path.join(releaseRoot, "app", "server.js"))
  await access(path.join(releaseRoot, "bin", "omniroute.mjs"))

  return releaseRoot
}

async function createArchive(version, releaseRoot) {
  const archiveBaseName = `${packageId}-${version}-${platform}-${arch}`
  const archivePath =
    platform === "windows"
      ? path.join(artifactsDir, `${archiveBaseName}.zip`)
      : path.join(artifactsDir, `${archiveBaseName}.tar.gz`)

  if (platform === "windows") {
    await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${escapePowerShell(releaseRoot.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -Force`,
    ])
  } else {
    await run("tar", ["-czf", archivePath, "-C", path.dirname(releaseRoot), path.basename(releaseRoot)])
  }

  const archiveStats = await stat(archivePath)

  return [
    {
      kind: "archive",
      fileName: path.basename(archivePath),
      blobKey: buildBlobKey(
        {
          packageId,
          version,
          platform,
          arch,
        },
        path.basename(archivePath),
      ),
      sizeBytes: archiveStats.size,
      sha256: await calculateSha256(archivePath),
    },
  ]
}

async function writeMetadata(version, upstreamVersion, artifacts) {
  const revision = (await readGitOutput(["rev-parse", "HEAD"], upstreamRoot)).trim()
  const metadataFileName = "metadata.json"
  await writeFile(
    path.join(artifactsDir, metadataFileName),
    `${JSON.stringify(createMetadataPayload({ version, upstreamVersion, sourceRevision: revision, artifacts }), null, 2)}\n`,
  )
}

export function createMetadataPayload({ version, upstreamVersion, sourceRevision, artifacts }) {
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    packageId,
    version,
    platform,
    arch,
    sourceRevision,
    extra: {
      standaloneBundle: true,
      packagedEntrypoint: "bin/omniroute.mjs",
      upstreamVersion,
    },
    artifacts: [
      ...artifacts,
      {
        kind: "metadata",
        fileName: "metadata.json",
        blobKey: buildBlobKey(
          {
            packageId,
            version,
            platform,
            arch,
          },
          "metadata.json",
        ),
      },
    ],
  }
}

async function readUpstreamVersion() {
  const packageJson = JSON.parse(await readFile(path.join(upstreamRoot, "package.json"), "utf8"))
  return packageJson.version
}

function withBuildEnv(env, version) {
  return {
    ...env,
    CI: "true",
    npm_config_fund: "false",
    npm_config_audit: "false",
    OMNIROUTE_NPM_BIN: env.OMNIROUTE_NPM_BIN || "npm",
    OMNIROUTE_NPX_BIN: env.OMNIROUTE_NPX_BIN || "npx",
    VERSION: env.VERSION || version,
  }
}

async function patchWindowsPrepublishCommands() {
  const scriptPath = path.join(upstreamRoot, "scripts", "prepublish.ts")
  const script = await readFile(scriptPath, "utf8")
  const nextScript = script
    .replace(
      'const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";',
      'const NPM_BIN = process.env.OMNIROUTE_NPM_BIN || "npm";',
    )
    .replace(
      'const NPX_BIN = process.platform === "win32" ? "npx.cmd" : "npx";',
      'const NPX_BIN = process.env.OMNIROUTE_NPX_BIN || "npx";',
    )

  if (nextScript !== script) {
    await writeFile(scriptPath, nextScript)
  }
}

function normalizePlatform(value) {
  switch (String(value).toLowerCase()) {
    case "darwin":
    case "macos":
      return "macos"
    case "win32":
    case "windows":
    case "windows_nt":
      return "windows"
    default:
      return "linux"
  }
}

function normalizeArch(value) {
  switch (String(value).toLowerCase()) {
    case "x64":
      return "amd64"
    case "aarch64":
      return "arm64"
    default:
      return String(value).toLowerCase()
  }
}

async function exists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function getCommand(command) {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd"
  }
  return command
}

function run(command, args, options = {}) {
  const finalCommand = getCommand(command)
  return new Promise((resolve, reject) => {
    const spawnCommand =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(finalCommand)
        ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
        : finalCommand
    const spawnArgs =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(finalCommand)
        ? ["/d", "/s", "/c", finalCommand, ...args]
        : args

    const child = spawn(spawnCommand, spawnArgs, {
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
      reject(new Error(`${finalCommand} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

function readGitOutput(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
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
      reject(new Error(`git ${args.join(" ")} exited with code ${code}`))
    })
  })
}

function escapePowerShell(value) {
  return value.replaceAll("'", "''")
}

async function calculateSha256(filePath) {
  const contents = await readFile(filePath)
  return createHash("sha256").update(contents).digest("hex")
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
}
