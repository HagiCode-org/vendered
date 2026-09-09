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
const vendoredPatchesRoot = path.join(packageRoot, "patches")
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
      // The committed code-server lockfiles are generated on Linux and omit
      // argon2's darwin-only optional dependency `cpu-features`. npm 10+ enforces
      // lockfile sync even for `npm install`, failing on macOS with
      // "Missing: cpu-features@ from lock file". Only the root and lib/vscode
      // locks carry that defect, so remove just those two and let `npm install`
      // regenerate platform-correct locks. Keep `test/package-lock.json`: the
      // postinstall script runs `npm ci` inside `test/`, which would otherwise
      // fail with "npm ci can only install with an existing package-lock.json".
      "rm -f package-lock.json lib/vscode/package-lock.json",
      "npm install",
      "npm run build",
      "npm run build:vscode",
      "KEEP_MODULES=1 npm run release",
    ].join(" && "),
    { cwd: codeServerRoot, env: baseEnv },
  )
}

async function applyPatchesWithPatch(env) {
  const patchPlans = [
    ...(await collectPatchFilesFromSeries(path.join(codeServerRoot, "patches", "series"))),
    ...(await collectPatchFilesFromSeries(path.join(vendoredPatchesRoot, "series"))),
  ]

  for (const { patchFile, patchPath } of patchPlans) {
    if (!(await exists(patchPath))) {
      throw new Error(`Patch file not found: ${patchPath}`)
    }

    await runMsys2(`patch -p1 --forward -i "${toPosixPath(patchPath)}"`, {
      cwd: codeServerRoot,
      env,
    })
  }
}

export function parsePatchSeries(series) {
  return series
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

export async function collectPatchFilesFromSeries(seriesPath) {
  if (!(await exists(seriesPath))) {
    return []
  }

  const patchRoot = path.dirname(seriesPath)
  return parsePatchSeries(await readFile(seriesPath, "utf8")).map((patchFile) => ({
    patchFile,
    patchPath: path.join(patchRoot, patchFile),
  }))
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
    let dirents
    try {
      dirents = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    const subDirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name)

    // Skip vscode-reh-web output directories at lib/ level — those are handled separately
    const toVisit = subDirNames.filter(
      (name) => !(dirPath === libDir && name.startsWith("vscode-reh-web-")),
    )

    // A directory is a "platform container" when ALL its subdirectories have compound
    // platform-arch names (e.g. darwin-arm64, linux-x64, win32-x64, arm64-linux).
    // Require at least 2 to avoid false-positives on single-platform optional deps.
    if (toVisit.length >= 2 && toVisit.every(looksLikeNativePlatformDir)) {
      for (const name of toVisit) {
        if (!shouldKeepWindowsNativeArtifact(name)) {
          await rm(path.join(dirPath, name), { recursive: true, force: true })
          removedAny = true
        }
      }
      return
    }

    for (const name of toVisit) {
      await walkSource(path.join(dirPath, name))
    }
  }

  await walkSource(sourceRoot)
  return removedAny
}

// Returns true for compound platform-arch directory names used by prebuild-install,
// node-pre-gyp, and similar tools (e.g. darwin-arm64, linux-x64, arm64-linux, win32-x64).
// Requires both a platform and an arch component to avoid false-positives on names like
// 'x64' or 'arm64' which are used by packages that are NOT native prebuilds containers.
export function looksLikeNativePlatformDir(name) {
  return (
    /^(darwin|linux|android|freebsd|openbsd|sunos|win32|windows)[-_](arm64|arm|x64|ia32|x86|s390x|ppc64|riscv64|loong64)/.test(
      name,
    ) ||
    /^(arm64|arm|x64|ia32|x86)[-_](linux|darwin|win32|windows|musl)/.test(name)
  )
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
    const entries = await readdir(prebuildsDir, { withFileTypes: true })
    const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

    if (!isWindowsNativePlatformContainer(directoryNames)) {
      continue
    }

    for (const entry of directoryNames) {
      if (shouldKeepWindowsNativeArtifact(entry)) {
        continue
      }

      await rm(path.join(prebuildsDir, entry), { recursive: true, force: true })
      removedAny = true
    }
  }

  return removedAny
}

export function isWindowsNativePlatformContainer(entryNames) {
  return entryNames.length >= 2 && entryNames.every(looksLikeNativePlatformDir)
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
}

async function collectArtifacts(version) {
  const archiveBaseName = `code-server-${version}-${platform}-${arch}`
  const archivePaths = [
    path.join(artifactsDir, `${archiveBaseName}.zip`),
    path.join(artifactsDir, `${archiveBaseName}.tar.gz`),
    path.join(artifactsDir, `${archiveBaseName}.7z`),
  ]

  await createZipArchive(releaseDir, archivePaths[0])
  await createTarArchive(releaseDir, archivePaths[1])
  await createSevenZipArchive(releaseDir, archivePaths[2])

  const artifacts = []
  for (const archivePath of archivePaths) {
    const archiveStats = await stat(archivePath)

    artifacts.push({
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
    })
  }

  return artifacts
}

async function createZipArchive(sourceRoot, archivePath) {
  if (platform === "windows") {
    await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${escapePowerShell(sourceRoot.replaceAll("/", "\\"))}' -DestinationPath '${escapePowerShell(archivePath.replaceAll("/", "\\"))}' -Force`,
    ])
    return
  }

  await run("zip", ["-qr", archivePath, path.basename(sourceRoot)], {
    cwd: path.dirname(sourceRoot),
  })
}

async function createTarArchive(sourceRoot, archivePath) {
  await run("tar", ["-czf", archivePath, "-C", path.dirname(sourceRoot), path.basename(sourceRoot)])
}

async function createSevenZipArchive(sourceRoot, archivePath) {
  await run(await resolveSevenZipCommand(), ["a", "-t7z", archivePath, path.basename(sourceRoot)], {
    cwd: path.dirname(sourceRoot),
  })
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
          'pm2 start cmd.exe --interpreter none --name code-server -- /d /s /c .\\bin\\code-server.cmd --config .\\config.yaml',
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
    "Every packaged archive includes startup wrappers for Linux/macOS shell and a Windows cmd wrapper. PM2 should target these wrappers instead of `out/node/entry.js` directly:",
    "",
    "- Unix shell: `./bin/code-server`",
    "- Windows cmd wrapper: `.\\bin\\code-server.cmd`",
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

async function resolveSevenZipCommand() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.SEVEN_ZIP_CMD,
          "C:\\Program Files\\7-Zip\\7z.exe",
          "C:\\Program Files (x86)\\7-Zip\\7z.exe",
          "7z.exe",
          "7z",
        ]
      : [process.env.SEVEN_ZIP_CMD, "7z", "7zz"]

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      continue
    }

    if (candidate.includes(path.sep) || candidate.includes("/")) {
      if (await exists(candidate)) {
        return candidate
      }
      continue
    }

    return candidate
  }

  throw new Error("Unable to resolve a 7z command for archive generation")
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
