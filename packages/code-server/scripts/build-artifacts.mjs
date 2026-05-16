#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { access, chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PUBLICATION_SCHEMA_VERSION, buildBlobKey } from "../../../scripts/publication.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const codeServerRoot = path.join(packageRoot, "upstream")
const releaseDir = path.join(codeServerRoot, process.env.RELEASE_PATH || "release")
const artifactsDir = path.join(root, process.env.ARTIFACTS_OUTPUT_DIR || path.join("artifacts", "code-server"))
const packageId = "code-server"
const platform = normalizePlatform(process.env.BUILD_ARTIFACTS_PLATFORM || process.platform)
const arch = normalizeArch(process.env.ARCH || process.arch)
const upstreamArch = normalizeUpstreamArch(process.env.ARCH || process.arch)

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

async function main() {
  process.chdir(root)
  await access(codeServerRoot)

  const version = await resolveVersion()

  await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: root })
  const sourceRevision = (await readGitOutput(["rev-parse", "HEAD"], codeServerRoot)).trim()

  await rm(artifactsDir, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })

  await runBuildPipeline(version)
  await slimRelease()
  await copyPackageTemplates(releaseDir)
  await writePackagedReadme(releaseDir, { version, sourceRevision, targetPlatform: platform, targetArch: arch })

  const artifacts = await collectArtifacts(version)
  await writeMetadata(version, sourceRevision, artifacts)
}

export async function copyPackageTemplates(releaseRoot) {
  const templatesRoot = path.join(packageRoot, "templates")
  if (!(await exists(templatesRoot))) {
    return false
  }

  await cp(templatesRoot, path.join(releaseRoot, "templates"), {
    recursive: true,
    force: true,
  })
  return true
}

async function runBuildPipeline(version) {
  const baseEnv = withCodeServerEnv({
    ...process.env,
    VERSION: process.env.VERSION || version,
    npm_config_build_from_source: process.env.npm_config_build_from_source || "true",
  })

  await patchBuildVscodeScript()

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
    await patchWindowsBuildVscodeScript()
    // Build without vscode first so we can prune non-Windows native prebuilds from
    // source node_modules before rcedit runs inside build:vscode.
    await runBash("npm ci && npm run build", {
      cwd: codeServerRoot,
      env: baseEnv,
    })
    await pruneSourceNativeArtifacts()
    await runBash("npm run build:vscode", {
      cwd: codeServerRoot,
      env: baseEnv,
    })
    await pruneWindowsNativeArtifacts()
    await runBash("KEEP_MODULES=1 npm run release", {
      cwd: codeServerRoot,
      env: baseEnv,
    })
    return
  }

  await runBash(
    [
      getQuiltPushCommand(),
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
    await runMsys2(`patch -p1 --forward -i "${toPosixPath(`patches/${patchFile}`)}"`, {
      cwd: codeServerRoot,
      env,
    })
  }
}

async function patchWindowsBuildVscodeScript() {
  const scriptPath = path.join(codeServerRoot, "ci", "build", "build-vscode.sh")
  const script = await readFile(scriptPath, "utf8")
  const lineEnding = script.includes("\r\n") ? "\r\n" : "\n"
  const guard = `  [ -f "$script" ] || return 0${lineEnding}`
  const needle = /(  local script="lib\/vscode-reh-web-\$VSCODE_TARGET\/bin\/\$1"\r?\n)/

  if (script.includes(guard)) {
    return
  }

  if (!needle.test(script)) {
    throw new Error(`Unable to patch ${scriptPath}: expected fix-bin-script block not found`)
  }

  await writeFile(scriptPath, script.replace(needle, `$1${guard}`))
}

export async function pruneSourceNativeArtifacts(sourceRoot = codeServerRoot) {
  const libDir = path.join(sourceRoot, "lib")
  let removedAny = false

  async function walkSource(dirPath) {
    let entries
    try {
      entries = await readdir(dirPath)
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry)

      // Skip vscode-reh-web output directories at lib/ level
      if (dirPath === libDir && entry.startsWith("vscode-reh-web-")) {
        continue
      }

      const entryStat = await stat(entryPath).catch(() => null)
      if (!entryStat?.isDirectory()) continue

      if (entry === "prebuilds") {
        // Prune non-Windows platform subdirs from this prebuilds directory
        const platformDirs = await readdir(entryPath).catch(() => [])
        for (const platformDir of platformDirs) {
          if (!shouldKeepWindowsNativeArtifact(platformDir)) {
            await rm(path.join(entryPath, platformDir), { recursive: true, force: true })
            removedAny = true
          }
        }
        // Don't recurse into prebuilds
        continue
      }

      await walkSource(entryPath)
    }
  }

  await walkSource(sourceRoot)
  return removedAny
}

export async function pruneWindowsNativeArtifacts(
  runtimeRoot = path.join(codeServerRoot, `lib/vscode-reh-web-win32-${upstreamArch}`),
) {
  if (!(await exists(runtimeRoot))) {
    return false
  }

  const prebuildsDirs = await findPrebuildsDirectories(runtimeRoot)
  let removedAny = false

  for (const prebuildsDir of prebuildsDirs) {
    const entries = await readdir(prebuildsDir)

    for (const entry of entries) {
      if (shouldKeepWindowsNativeArtifact(entry)) {
        continue
      }

      await rm(path.join(prebuildsDir, entry), { recursive: true, force: true })
      removedAny = true
    }
  }

  return removedAny
}

async function findPrebuildsDirectories(root) {
  const nativeFileDirs = new Set()

  await walkDirectory(root, async (dirPath, entries) => {
    if (entries.some((e) => e.endsWith(".node"))) {
      nativeFileDirs.add(path.dirname(dirPath))
    }
  })

  return [...nativeFileDirs]
}

async function walkDirectory(dirPath, visitor) {
  let entries
  try {
    entries = await readdir(dirPath)
  } catch {
    return
  }

  await visitor(dirPath, entries)

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry)
    const entryStat = await stat(entryPath).catch(() => null)
    if (entryStat?.isDirectory()) {
      await walkDirectory(entryPath, visitor)
    }
  }
}

export async function patchBuildVscodeScript(scriptPath = path.join(codeServerRoot, "ci", "build", "build-vscode.sh")) {
  const script = await readFile(scriptPath, "utf8")
  const patchedScript = script.replace(
    "VSCODE_QUALITY=stable npm run gulp compile-copilot-extension-full-build",
    "VSCODE_QUALITY=stable npm run gulp compile-copilot-extension-build",
  )

  if (patchedScript === script) {
    return false
  }

  await writeFile(scriptPath, patchedScript)
  return true
}

export function shouldKeepWindowsNativeArtifact(entryName) {
  return /(^|[-_])(win32|windows|win)([-_]|$)/i.test(entryName)
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

export async function writePackagedReadme(releaseRoot, details) {
  const readmePath = path.join(releaseRoot, "README.md")
  const upstreamReadmePath = path.join(releaseRoot, "README.upstream.md")

  if ((await exists(readmePath)) && !(await exists(upstreamReadmePath))) {
    await writeFile(upstreamReadmePath, await readFile(readmePath, "utf8"))
  }

  await writeFile(readmePath, renderPackagedReadme(details))
}

export function renderPackagedReadme({ version, sourceRevision, targetPlatform = platform, targetArch = arch }) {
  const wrapperBlock =
    targetPlatform === "windows"
      ? [
          "```powershell",
          ".\\bin\\code-server.cmd --help",
          ".\\bin\\code-server.ps1 --help",
          "```",
        ].join("\n")
      : [
          "```bash",
          "./bin/code-server --help",
          "```",
        ].join("\n")

  const pm2Block =
    targetPlatform === "windows"
      ? [
          "```powershell",
          "Copy-Item .\\templates\\code-server-config.yaml .\\config.yaml",
          'pm2 start .\\bin\\code-server.ps1 --interpreter powershell.exe --name code-server -- --config .\\config.yaml',
          "```",
        ].join("\n")
      : [
          "```bash",
          "cp ./templates/code-server-config.yaml ./config.yaml",
          "pm2 start ./bin/code-server --interpreter none --name code-server -- --config ./config.yaml",
          "```",
        ].join("\n")

  const directEntrypointBlock =
    targetPlatform === "windows"
      ? [
          "Direct Node entrypoint:",
          "",
          "```powershell",
          "node .\\out\\node\\entry.js --help",
          "```",
        ].join("\n")
      : [
          "Direct Node entrypoint:",
          "",
          "```bash",
          "node ./out/node/entry.js --help",
          "```",
        ].join("\n")

  return [
    "# code-server",
    "",
    "This archive is the HagiCode vendored slim build of code-server. Extract it and run it under PM2 through the packaged wrapper entrypoints.",
    "",
    "## Usage",
    "",
    "1. Extract the archive and change into the extracted directory.",
    "2. Copy `templates/code-server-config.yaml` to `./config.yaml` and fill in the YAML settings you need.",
    "3. Start code-server with PM2 and the packaged wrapper below.",
    "",
    "Wrapper entrypoints:",
    "",
    wrapperBlock,
    "",
    "PM2-managed startup with YAML config:",
    "",
    pm2Block,
    directEntrypointBlock,
    "",
    "## Included wrappers",
    "",
    "Every packaged archive includes startup wrappers for Linux/macOS shell and Windows shells. PM2 should target these wrappers instead of `out/node/entry.js` directly:",
    "",
    "- Unix shell: `./bin/code-server`",
    "- Windows Command Prompt: `.\\bin\\code-server.cmd`",
    "- Windows PowerShell: `.\\bin\\code-server.ps1`",
    "",
    "## YAML configuration",
    "",
    "- Template path: `templates/code-server-config.yaml`",
    "- Supported deployment flow: copy the template, edit the YAML values, then start with `pm2 ... -- --config ./config.yaml`.",
    "- The verification step exercises the packaged release with PM2, the native wrapper, and a YAML config file before publication.",
    "",
    "## Dependencies",
    "",
    "- Node.js 22 must be available on PATH. This archive does not bundle a Node runtime.",
    "- A modern web browser is required to use the UI after the server starts.",
    "",
    "## Version",
    "",
    `- Package: \`${packageId}\``,
    `- Packaged version: \`${version}\``,
    `- Target: \`${targetPlatform}/${targetArch}\``,
    `- Source revision: \`${sourceRevision}\``,
    "",
    "## Notes",
    "",
    "- The original upstream README is preserved as `README.upstream.md` when it exists in the release tree.",
    "",
  ].join("\n")
}

async function writeMetadata(version, sourceRevision, artifacts) {
  const metadataFileName = "metadata.json"
  await writeFile(
    path.join(artifactsDir, metadataFileName),
    JSON.stringify(
      {
        schemaVersion: PUBLICATION_SCHEMA_VERSION,
        packageId,
        version,
        platform,
        arch,
        sourceRevision,
        extra: {
          slimArtifact: true,
          bundledNodeRuntime: false,
        },
        artifacts: [
          ...artifacts,
          {
            kind: "metadata",
            fileName: metadataFileName,
            blobKey: buildBlobKey(
              {
                packageId,
                version,
                platform,
                arch,
              },
              metadataFileName,
            ),
          },
        ],
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
    env.NPM_CONFIG_SCRIPT_SHELL || env.npm_config_script_shell || (platform === "windows" ? "/usr/bin/bash" : env.BASH_PATH || "bash")

  return {
    ...env,
    OS: platform,
    ARCH: arch,
    VSCODE_ARCH: env.VSCODE_ARCH || upstreamArch,
    npm_config_arch: env.npm_config_arch || upstreamArch,
    NPM_CONFIG_ARCH: env.NPM_CONFIG_ARCH || upstreamArch,
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

function normalizeUpstreamArch(value) {
  switch (value) {
    case "amd64":
      return "x64"
    case "aarch64":
      return "arm64"
    case "armhf":
      return "arm"
    default:
      return value
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
  return "bash"
}

function getMsys2Command() {
  return process.env.MSYS2_CMD || path.join(process.env.RUNNER_TEMP || "C:\\Users\\runneradmin\\AppData\\Local\\Temp", "setup-msys2", "msys2.cmd")
}

function getQuiltPushCommand() {
  return "quilt push -a || [[ $? -eq 2 ]]"
}

function runBash(script, options = {}) {
  if (process.platform === "win32") {
    return runMsys2(script, options)
  }
  return run(getBashCommand(), ["-lc", script], options)
}

function runMsys2(script, options = {}) {
  if (process.platform !== "win32") {
    return runBash(script, options)
  }

  return run(
    "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/s", "/c", getMsys2Command(), "-c", script],
    options,
  )
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

async function calculateSha256(filePath) {
  const contents = await readFile(filePath)
  return createHash("sha256").update(contents).digest("hex")
}

function isMainModule() {
  return process.argv[1] != null && path.resolve(process.argv[1]) === __filename
}
