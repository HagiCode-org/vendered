#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const codeServerRoot = path.join(packageRoot, "upstream")
const releaseDir = path.join(codeServerRoot, process.env.RELEASE_PATH || "release")
const artifactsDir = path.join(root, process.env.ARTIFACTS_OUTPUT_DIR || path.join("artifacts", "code-server"))
const platform = normalizePlatform(process.env.BUILD_ARTIFACTS_PLATFORM || process.platform)
const arch = normalizeArch(process.env.ARCH || process.arch)

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

async function main() {
  process.chdir(root)
  await access(codeServerRoot)

  const version = await resolveVersion()

  await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: root })

  await rm(artifactsDir, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })

  await runBuildPipeline(version)
  await slimRelease()

  const artifacts = await collectArtifacts(version)
  await writeMetadata(version, artifacts)
}

async function runBuildPipeline(version) {
  const baseEnv = withCodeServerEnv({
    ...process.env,
    VERSION: process.env.VERSION || version,
    npm_config_build_from_source: process.env.npm_config_build_from_source || "true",
  })

  if (platform === "linux") {
    await runBash(
      [
        getQuiltPushCommand(),
        "cd lib/vscode/build",
        "npm ci",
        "cd ..",
        "source ./build/azure-pipelines/linux/setup-env.sh",
        "node build/npm/preinstall.ts",
        "cd ../..",
        "npm ci",
        "npm run build",
        "npm run build:vscode",
        "KEEP_MODULES=1 npm run release",
      ].join(" && "),
      { cwd: codeServerRoot, env: baseEnv },
    )
    return
  }

  if (platform === "windows") {
    await applyPatchesWithPatch(baseEnv)
  }

  await runBash(
    [
      platform === "windows" ? ":" : getQuiltPushCommand(),
      "npm ci",
      "npm run build",
      "npm run build:vscode",
      "KEEP_MODULES=1 npm run release",
    ].join(" && "),
    { cwd: codeServerRoot, env: baseEnv },
  )
}

async function applyPatchesWithPatch(env) {
  const series = await readFile(path.join(codeServerRoot, "patches", "series"), "utf8")
  const patchFiles = series
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))

  for (const patchFile of patchFiles) {
    await runBash(`patch -p1 --forward -i "${toPosixPath(`patches/${patchFile}`)}"`, {
      cwd: codeServerRoot,
      env,
    })
  }
}

async function slimRelease() {
  await access(releaseDir)
  await rm(path.join(releaseDir, "lib", "node"), { recursive: true, force: true })
  await rm(path.join(releaseDir, "lib", "node.exe"), { recursive: true, force: true })
  await rm(path.join(codeServerRoot, "release-packages"), { recursive: true, force: true })

  const binDir = path.join(releaseDir, "bin")
  await mkdir(binDir, { recursive: true })

  await writeFile(
    path.join(binDir, "code-server"),
    `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
exec node "$ROOT_DIR/out/node/entry.js" "$@"
`,
  )
  await chmod(path.join(binDir, "code-server"), 0o755)

  await writeFile(
    path.join(binDir, "code-server.cmd"),
    `@echo off
setlocal
set ROOT_DIR=%~dp0..
node "%ROOT_DIR%\\out\\node\\entry.js" %*
`,
  )

  await writeFile(
    path.join(binDir, "code-server.ps1"),
    `$RootDir = Split-Path -Parent $PSScriptRoot
node "$RootDir\\out\\node\\entry.js" @args
`,
  )
}

async function collectArtifacts(version) {
  const archiveBaseName = `code-server-${version}-${platform}-${arch}`
  const archivePath =
    platform === "windows"
      ? path.join(artifactsDir, `${archiveBaseName}.zip`)
      : path.join(artifactsDir, `${archiveBaseName}.tar.gz`)

  if (platform === "windows") {
    await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${escapePowerShell(releaseDir.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -Force`,
    ])
  } else {
    await run("tar", ["-czf", archivePath, "-C", codeServerRoot, path.basename(releaseDir)])
  }

  return [path.basename(archivePath)]
}

async function writeMetadata(version, artifacts) {
  const revision = await readGitOutput(["rev-parse", "HEAD"], codeServerRoot)
  await writeFile(
    path.join(artifactsDir, "metadata.json"),
    JSON.stringify(
      {
        version,
        platform,
        arch,
        slimArtifact: true,
        bundledNodeRuntime: false,
        codeServerRevision: revision.trim(),
        artifacts,
      },
      null,
      2,
    ),
  )
}

async function resolveVersion() {
  if (process.env.VERSION) {
    return process.env.VERSION
  }

  const packageJson = JSON.parse(await readFile(path.join(codeServerRoot, "package.json"), "utf8"))
  return packageJson.version
}

function withCodeServerEnv(env) {
  const scriptShell =
    env.NPM_CONFIG_SCRIPT_SHELL || env.npm_config_script_shell || env.BASH_PATH || "C:\\msys64\\usr\\bin\\bash.exe"

  return {
    ...env,
    OS: platform,
    ARCH: arch,
    NPM_CONFIG_SCRIPT_SHELL: platform === "windows" ? scriptShell : env.NPM_CONFIG_SCRIPT_SHELL,
    npm_config_script_shell: platform === "windows" ? scriptShell : env.npm_config_script_shell,
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
  switch (value) {
    case "x64":
      return "amd64"
    case "aarch64":
      return "arm64"
    default:
      return value
  }
}

function toPosixPath(value) {
  return value.replaceAll("\\", "/")
}

function getCommand(command) {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd"
  }
  return command
}

function getBashCommand() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\cmd.exe"
  }
  return "bash"
}

function getQuiltPushCommand() {
  return "quilt push -a"
}

function runBash(script, options = {}) {
  if (process.platform === "win32") {
    return run(
      getBashCommand(),
      [
        "/d",
        "/s",
        "/c",
        "C:\\msys64\\msys2_shell.cmd",
        "-defterm",
        "-no-start",
        "-msys",
        "-shell",
        "bash",
        "-lc",
        script,
      ],
      options,
    )
  }
  return run(getBashCommand(), ["-lc", script], options)
}

function run(command, args, options = {}) {
  const finalCommand = getCommand(command)
  return new Promise((resolve, reject) => {
    const child = spawn(finalCommand, args, {
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
