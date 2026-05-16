#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { access, chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { PUBLICATION_SCHEMA_VERSION, buildBlobKey } from "../../../scripts/publication.mjs"
import { getCrossPlatformWrapperDefinitions, getManifestBinEntries, normalizeTargetPlatform, renderWrapperContent, resolveReleasePath } from "./wrappers.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const upstreamRoot = path.join(packageRoot, "upstream")
const artifactsDir = path.join(root, process.env.ARTIFACTS_OUTPUT_DIR || path.join("artifacts", "omniroute"))
const releaseWorkspace = path.join(root, "release", "omniroute")
const windowsHomeRoot = path.join(root, ".tmp", "omniroute-windows-home")
const packageId = "omniroute"
const platform = normalizeTargetPlatform(process.env.BUILD_ARTIFACTS_PLATFORM || process.platform)
const arch = normalizeArch(process.env.ARCH || process.arch)
const vendoredLauncherRuntimeSourcePath = fileURLToPath(new URL("./launcher-runtime.mjs", import.meta.url))

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
  const sourceRevision = (await readGitOutput(["rev-parse", "HEAD"], upstreamRoot)).trim()
  await rm(artifactsDir, { recursive: true, force: true })
  await rm(releaseWorkspace, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(releaseWorkspace, { recursive: true })

  if (platform === "windows") {
    await ensureWindowsBuildHomes()
  }

  await patchPrepublishScript()
  await patchResponsesWsProxyScript()

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

  const releaseRoot = await stageReleaseTree({ version, upstreamVersion, sourceRevision })
  const artifacts = await createArchive(version, releaseRoot)
  await writeMetadata(version, upstreamVersion, sourceRevision, artifacts)
}

async function stageReleaseTree({ version, upstreamVersion, sourceRevision }) {
  const releaseRoot = path.join(releaseWorkspace, `${packageId}-${version}-${platform}-${arch}`)
  await rm(releaseRoot, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })

  const manifest = JSON.parse(await readFile(path.join(upstreamRoot, "package.json"), "utf8"))
  const binEntries = getManifestBinEntries(manifest)
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
  await writeFile(path.join(releaseRoot, ".node-version"), "22\n")

  await access(path.join(releaseRoot, "app", "server.js"))
  await copyPackageTemplates(releaseRoot)
  await assertPackagedEntrypoints(releaseRoot, binEntries)
  await writePlatformWrappers(releaseRoot, binEntries)
  await writePackagedReadme(releaseRoot, { version, upstreamVersion, sourceRevision, targetPlatform: platform, targetArch: arch })

  return releaseRoot
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

async function writeMetadata(version, upstreamVersion, sourceRevision, artifacts) {
  const metadataFileName = "metadata.json"
  await writeFile(
    path.join(artifactsDir, metadataFileName),
    `${JSON.stringify(createMetadataPayload({ version, upstreamVersion, sourceRevision, artifacts }), null, 2)}\n`,
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

export async function writePackagedReadme(releaseRoot, details) {
  const readmePath = path.join(releaseRoot, "README.md")
  const upstreamReadmePath = path.join(releaseRoot, "README.upstream.md")

  if ((await exists(readmePath)) && !(await exists(upstreamReadmePath))) {
    await writeFile(upstreamReadmePath, await readFile(readmePath, "utf8"))
  }

  await writeFile(readmePath, renderPackagedReadme(details))
}

export function renderPackagedReadme({ version, upstreamVersion, sourceRevision, targetPlatform = platform, targetArch = arch }) {
  const wrapperBlock =
    targetPlatform === "windows"
      ? [
          "```powershell",
          ".\\omniroute.cmd --help",
          ".\\omniroute.ps1 --help",
          ".\\omniroute-reset-password.cmd --help",
          "```",
        ].join("\n")
      : [
          "```bash",
          "./omniroute.sh --help",
          "./omniroute-reset-password.sh --help",
          "```",
        ].join("\n")

  const pm2Block =
    targetPlatform === "windows"
      ? [
          "```powershell",
          "Copy-Item .\\templates\\omniroute-config.yaml .\\config.yaml",
          'pm2 start .\\omniroute.ps1 --interpreter powershell.exe --name omniroute -- --config .\\config.yaml --no-open',
          "```",
        ].join("\n")
      : [
          "```bash",
          "cp ./templates/omniroute-config.yaml ./config.yaml",
          "pm2 start ./omniroute.sh --interpreter none --name omniroute -- --config ./config.yaml --no-open",
          "```",
        ].join("\n")

  const directEntrypointBlock =
    targetPlatform === "windows"
      ? [
          "Direct Node entrypoint:",
          "",
          "```powershell",
          "node .\\bin\\omniroute.mjs --help",
          "```",
        ].join("\n")
      : [
          "Direct Node entrypoint:",
          "",
          "```bash",
          "node ./bin/omniroute.mjs --help",
          "```",
        ].join("\n")

  const entrypointSection =
    targetPlatform === "windows"
      ? [
          "## Entrypoints",
          "",
          "Use these entrypoints in the extracted archive:",
          "",
          "- Recommended PM2 startup entrypoint: `.\\omniroute.ps1`",
          "- Recommended maintenance entrypoint: `.\\omniroute-reset-password.cmd`",
          "- Direct Node CLI entrypoint: `node .\\bin\\omniroute.mjs`",
          "- Direct Node maintenance entrypoint: `node .\\bin\\reset-password.mjs`",
          "- Internal runtime entrypoints managed by the CLI: `app/server.js` and, when present, `app/server-ws.mjs`",
          "- Do not point PM2 at `bin/omniroute.mjs`, `app/server.js`, or `scripts/*.mjs`; use the packaged wrapper entrypoint instead.",
          "",
        ].join("\n")
      : [
          "## Entrypoints",
          "",
          "Use these entrypoints in the extracted archive:",
          "",
          "- Recommended PM2 startup entrypoint: `./omniroute.sh`",
          "- Recommended maintenance entrypoint: `./omniroute-reset-password.sh`",
          "- Direct Node CLI entrypoint: `node ./bin/omniroute.mjs`",
          "- Direct Node maintenance entrypoint: `node ./bin/reset-password.mjs`",
          "- Internal runtime entrypoints managed by the CLI: `app/server.js` and, when present, `app/server-ws.mjs`",
          "- Do not point PM2 at `bin/omniroute.mjs`, `app/server.js`, or `scripts/*.mjs`; use the packaged wrapper entrypoint instead.",
          "",
        ].join("\n")

  return [
    "# omniroute",
    "",
    "This archive is the HagiCode vendored standalone OmniRoute bundle. Extract it and run it under PM2 through the packaged wrapper entrypoints.",
    "",
    "## Usage",
    "",
    "1. Extract the archive and change into the extracted directory.",
    "2. If you need provider credentials or other runtime settings, start from `.env.example`.",
    "3. Copy `templates/omniroute-config.yaml` to `./config.yaml` and fill in the YAML settings you need.",
    "4. Start OmniRoute with PM2 and the packaged wrapper below.",
    "",
    "Wrapper entrypoints:",
    "",
    wrapperBlock,
    "",
    "PM2-managed startup with YAML config:",
    "",
    pm2Block,
    "",
    directEntrypointBlock,
    "",
    "## Included wrappers",
    "",
    "Every packaged archive includes startup wrappers for Linux/macOS shell and Windows shells. PM2 should target these wrappers instead of the raw Node entrypoints:",
    "",
    "- Unix shell: `./omniroute.sh` and `./omniroute-reset-password.sh`",
    "- Windows Command Prompt: `.\\omniroute.cmd` and `.\\omniroute-reset-password.cmd`",
    "- Windows PowerShell: `.\\omniroute.ps1` and `.\\omniroute-reset-password.ps1`",
    "",
    entrypointSection,
    "## YAML configuration",
    "",
    "- Template path: `templates/omniroute-config.yaml`",
    "- Supported deployment flow: copy the template, edit the YAML values, then start with `pm2 ... -- --config ./config.yaml`.",
    "- The verification step exercises the packaged release with PM2, the native wrapper, and a YAML config file before publication.",
    "",
    "## Dependencies",
    "",
    "- Run this vendored build with Node.js 22. The archive includes `.node-version` with `22`.",
    "- No Node runtime is bundled. The wrapper scripts call `node` from PATH.",
    "- Provider credentials, network access, and any route-specific configuration remain external dependencies.",
    "",
    "## Version",
    "",
    `- Package: \`${packageId}\``,
    `- Packaged version: \`${version}\``,
    `- Upstream version: \`${upstreamVersion}\``,
    `- Target: \`${targetPlatform}/${targetArch}\``,
    `- Source revision: \`${sourceRevision}\``,
    "",
    "## Notes",
    "",
    "- Packaged CLI entrypoint: `bin/omniroute.mjs`",
    "- The original upstream README is preserved as `README.upstream.md` when it exists in the release tree.",
    "",
  ].join("\n")
}

async function readUpstreamVersion() {
  const packageJson = JSON.parse(await readFile(path.join(upstreamRoot, "package.json"), "utf8"))
  return packageJson.version
}

function withBuildEnv(env, version) {
  const windowsEnv =
    platform === "windows"
      ? {
          HOME: windowsHomeRoot,
          USERPROFILE: windowsHomeRoot,
          APPDATA: path.join(windowsHomeRoot, "AppData", "Roaming"),
          LOCALAPPDATA: path.join(windowsHomeRoot, "AppData", "Local"),
          TEMP: path.join(windowsHomeRoot, "Temp"),
          TMP: path.join(windowsHomeRoot, "Temp"),
        }
      : {}

  return {
    ...env,
    ...windowsEnv,
    CI: "true",
    npm_config_fund: "false",
    npm_config_audit: "false",
    OMNIROUTE_NPM_BIN: env.OMNIROUTE_NPM_BIN || "npm",
    OMNIROUTE_NPX_BIN: env.OMNIROUTE_NPX_BIN || "npx",
    VERSION: env.VERSION || version,
  }
}

async function assertPackagedEntrypoints(releaseRoot, binEntries) {
  for (const binEntry of binEntries) {
    await access(resolveReleasePath(releaseRoot, binEntry.entryPath))
  }
}

export async function writePlatformWrappers(releaseRoot, binEntries) {
  const shimEntries = getVendoredLauncherEntries(binEntries)
  await stageVendoredLauncherRuntime(releaseRoot)
  await writeVendoredCommandShims(releaseRoot, binEntries, shimEntries)
  const wrapperDefinitions = getCrossPlatformWrapperDefinitions(shimEntries)

  for (const wrapperDefinition of wrapperDefinitions) {
    const wrapperPath = resolveReleasePath(releaseRoot, wrapperDefinition.fileName)
    await mkdir(path.dirname(wrapperPath), { recursive: true })
    await writeFile(wrapperPath, renderWrapperContent(wrapperDefinition))
    if (wrapperDefinition.executable) {
      await chmod(wrapperPath, 0o755)
    }
  }
}

async function stageVendoredLauncherRuntime(releaseRoot) {
  const destinationPath = resolveReleasePath(releaseRoot, ".vendored/launcher-runtime.mjs")
  await mkdir(path.dirname(destinationPath), { recursive: true })
  await writeFile(destinationPath, await readFile(vendoredLauncherRuntimeSourcePath, "utf8"))
}

async function writeVendoredCommandShims(releaseRoot, binEntries, shimEntries) {
  for (const [index, binEntry] of binEntries.entries()) {
    const shimEntry = shimEntries[index]
    const shimPath = resolveReleasePath(releaseRoot, shimEntry.entryPath)
    await mkdir(path.dirname(shimPath), { recursive: true })
    await writeFile(shimPath, renderVendoredCommandShim(binEntry.entryPath))
  }
}

function getVendoredLauncherEntries(binEntries) {
  return binEntries.map((binEntry) => ({
    ...binEntry,
    entryPath: `.vendored/commands/${binEntry.command}.mjs`,
  }))
}

function renderVendoredCommandShim(entryPath) {
  const pathSegments = entryPath.split("/")
  return `#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { translateOmniRouteInvocation } from "../launcher-runtime.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const releaseRoot = path.resolve(__dirname, "..", "..")
const entrypoint = path.join(releaseRoot, ${pathSegments.map((segment) => JSON.stringify(segment)).join(", ")})
const invocation = translateOmniRouteInvocation(process.argv.slice(2), process.env)
const child = spawn(process.execPath, [entrypoint, ...invocation.args], {
  env: invocation.env,
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exitCode = code ?? 1
})
`
}

async function ensureWindowsBuildHomes() {
  const directories = [
    windowsHomeRoot,
    path.join(windowsHomeRoot, "AppData"),
    path.join(windowsHomeRoot, "AppData", "Roaming"),
    path.join(windowsHomeRoot, "AppData", "Local"),
    path.join(windowsHomeRoot, "Temp"),
  ]

  for (const directory of directories) {
    await mkdir(directory, { recursive: true })
  }
}

export function patchPrepublishScriptSource(script, targetPlatform = platform) {
  let nextScript = script.replace(
    /\n\s*writeFileSync\(\n\s*join\(APP_DIR, "responses-ws-proxy\.mjs"\),\n\s*'export \* from "\.\.\/scripts\/responses-ws-proxy\.mjs";\\n'\n\s*\);/,
    '\n  cpSync(responsesWsProxySrc, join(APP_DIR, "responses-ws-proxy.mjs"));',
  )

  if (targetPlatform === "windows") {
    nextScript = nextScript
      .replace(
        'const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";',
        'const NPM_BIN = process.env.OMNIROUTE_NPM_BIN || "npm";',
      )
      .replace(
        'const NPX_BIN = process.platform === "win32" ? "npx.cmd" : "npx";',
        'const NPX_BIN = process.env.OMNIROUTE_NPX_BIN || "npx";',
      )
      .replace(
        'const APP_DIR = join(ROOT, "app");',
        `const APP_DIR = join(ROOT, "app");

function runCommand(command: string, args: string[], options: Parameters<typeof execFileSync>[2] = {}) {
  if (process.platform !== "win32") {
    return execFileSync(command, args, options);
  }

  return execFileSync(process.env.ComSpec || "C:\\\\Windows\\\\System32\\\\cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}`,
      )
      .replaceAll("execFileSync(NPM_BIN,", "runCommand(NPM_BIN,")
      .replaceAll("execFileSync(NPX_BIN,", "runCommand(NPX_BIN,")
  }

  return nextScript
}

export function patchResponsesWsProxySource(script) {
  const nextScript = script
    .replace(
      'import { websocket } from "wreq-js";',
      'import { createRequire } from "node:module";\n\nconst require = createRequire(import.meta.url);\nconst appRequire = createRequire(new URL("../app/package.json", import.meta.url));\n\nfunction resolveWsFactory(module) {\n  return typeof module?.websocket === "function"\n    ? module.websocket\n    : typeof module?.default?.websocket === "function"\n      ? module.default.websocket\n      : typeof module?.default === "function"\n        ? module.default\n        : null;\n}\n\nexport function loadDefaultWsFactory(requireFns = [require, appRequire]) {\n  const errors = [];\n\n  for (const requireFn of requireFns) {\n    try {\n      const module = requireFn("wreq-js");\n      const wsFactory = resolveWsFactory(module);\n\n      if (wsFactory) {\n        return wsFactory;\n      }\n\n      errors.push(new Error("wreq-js did not expose a websocket() factory"));\n    } catch (error) {\n      errors.push(error);\n    }\n  }\n\n  throw new AggregateError(errors, "Unable to load wreq-js from the OmniRoute runtime");\n}',
    )
    .replace('  wsFactory = websocket,', '  wsFactory = loadDefaultWsFactory(),')

  return nextScript
}

async function patchPrepublishScript() {
  const scriptPath = path.join(upstreamRoot, "scripts", "prepublish.ts")
  const script = await readFile(scriptPath, "utf8")
  const nextScript = patchPrepublishScriptSource(script)

  if (nextScript !== script) {
    await writeFile(scriptPath, nextScript)
  }
}

async function patchResponsesWsProxyScript() {
  const scriptPath = path.join(upstreamRoot, "scripts", "responses-ws-proxy.mjs")
  const script = await readFile(scriptPath, "utf8")
  const nextScript = patchResponsesWsProxySource(script)

  if (nextScript !== script) {
    await writeFile(scriptPath, nextScript)
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
