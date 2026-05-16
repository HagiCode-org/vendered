import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { copyPackageTemplates, createMetadataPayload, patchPrepublishScriptSource, patchResponsesWsProxySource, renderPackagedReadme, writePackagedReadme, writePlatformWrappers } from "./build-artifacts.mjs"
import { buildBlobKey } from "../../../scripts/publication.mjs"
import {
  WINDOWS_WRAPPER_EXTENSIONS,
  getCrossPlatformWrapperDefinitions,
  getManifestBinEntries,
  getNativeSmokeWrapperFile,
  getWrapperDefinitions,
} from "./wrappers.mjs"

test("createMetadataPayload emits vendored OmniRoute publication metadata", () => {
  const metadata = createMetadataPayload({
    version: "2026.0505.0001",
    upstreamVersion: "3.7.4",
    sourceRevision: "abc123",
    artifacts: [
      {
        kind: "archive",
        fileName: "omniroute-2026.0505.0001-linux-amd64.tar.gz",
        blobKey: buildBlobKey(
          {
            packageId: "omniroute",
            version: "2026.0505.0001",
            platform: "linux",
            arch: "amd64",
          },
          "omniroute-2026.0505.0001-linux-amd64.tar.gz",
        ),
        sizeBytes: 123,
        sha256: "a".repeat(64),
      },
    ],
  })

  assert.equal(metadata.packageId, "omniroute")
  assert.equal(metadata.version, "2026.0505.0001")
  assert.equal(metadata.sourceRevision, "abc123")
  assert.deepEqual(metadata.extra, {
    standaloneBundle: true,
    packagedEntrypoint: "bin/omniroute.mjs",
    upstreamVersion: "3.7.4",
  })
  assert.deepEqual(metadata.artifacts.at(-1), {
    kind: "metadata",
    fileName: "metadata.json",
    blobKey: "packages/omniroute/versions/2026.0505.0001/linux-amd64/metadata.json",
  })
})

test("getManifestBinEntries preserves every declared command and normalizes entrypaths", () => {
  const binEntries = getManifestBinEntries({
    bin: {
      "omniroute-reset-password": "bin\\reset-password.mjs",
      omniroute: "./bin/omniroute.mjs",
    },
  })

  assert.deepEqual(binEntries, [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
    {
      command: "omniroute-reset-password",
      entryPath: "bin/reset-password.mjs",
    },
  ])
})

test("getWrapperDefinitions uses platform-specific naming and native smoke targets", () => {
  const binEntries = [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
    {
      command: "omniroute-reset-password",
      entryPath: "bin/reset-password.mjs",
    },
  ]

  const windowsWrappers = getWrapperDefinitions(binEntries, "windows")
  assert.deepEqual(
    windowsWrappers.map((wrapper) => wrapper.fileName),
    [
      "omniroute.cmd",
      "omniroute-reset-password.cmd",
    ],
  )
  assert.equal(getNativeSmokeWrapperFile(binEntries, "windows"), "omniroute.cmd")

  const unixWrappers = getWrapperDefinitions(binEntries, "linux")
  assert.deepEqual(
    unixWrappers.map((wrapper) => wrapper.fileName),
    ["omniroute.sh", "omniroute-reset-password.sh"],
  )
  assert.equal(getNativeSmokeWrapperFile(binEntries, "linux"), "omniroute.sh")
})

test("getCrossPlatformWrapperDefinitions includes Unix and Windows cmd wrappers", () => {
  const binEntries = [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
  ]

  assert.deepEqual(
    getCrossPlatformWrapperDefinitions(binEntries).map((wrapper) => wrapper.fileName),
    ["omniroute.sh", "omniroute.cmd"],
  )
})

test("writePlatformWrappers emits cross-platform wrappers for every command", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-cross-platform-wrappers-"))
  const binEntries = [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
    {
      command: "omniroute-reset-password",
      entryPath: "bin/reset-password.mjs",
    },
  ]

  await writePlatformWrappers(releaseRoot, binEntries)

  for (const command of ["omniroute", "omniroute-reset-password"]) {
    await access(path.join(releaseRoot, `${command}.sh`))
  }

  for (const command of ["omniroute", "omniroute-reset-password"]) {
    for (const extension of WINDOWS_WRAPPER_EXTENSIONS) {
      await access(path.join(releaseRoot, `${command}${extension}`))
    }
  }

  const cmdWrapper = await readFile(path.join(releaseRoot, "omniroute-reset-password.cmd"), "utf8")
  assert.match(cmdWrapper, /set "SCRIPT_DIR=%~dp0"/)
  assert.match(cmdWrapper, /%SCRIPT_DIR%\.vendored\\commands\\omniroute-reset-password\.mjs/)
  assert.doesNotMatch(cmdWrapper, new RegExp(releaseRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const shellWrapper = await readFile(path.join(releaseRoot, "omniroute.sh"), "utf8")
  assert.match(shellWrapper, /exec node "\$SCRIPT_DIR\/\.vendored\/commands\/omniroute\.mjs" "\$@"/)

  const launcherRuntime = await readFile(path.join(releaseRoot, ".vendored", "launcher-runtime.mjs"), "utf8")
  assert.match(launcherRuntime, /translateOmniRouteInvocation/)

  const launcherShim = await readFile(path.join(releaseRoot, ".vendored", "commands", "omniroute.mjs"), "utf8")
  assert.match(launcherShim, /const invocation = translateOmniRouteInvocation\(process\.argv\.slice\(2\), process\.env\)/)
  assert.match(launcherShim, /path\.join\(releaseRoot, "bin", "omniroute\.mjs"\)/)
})

test("writePlatformWrappers emits executable Unix shell wrappers", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-unix-wrappers-"))
  const binEntries = [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
  ]

  await writePlatformWrappers(releaseRoot, binEntries)

  const wrapperPath = path.join(releaseRoot, "omniroute.sh")
  const wrapperContents = await readFile(wrapperPath, "utf8")
  const wrapperStats = await stat(wrapperPath)

  assert.match(wrapperContents, /exec node "\$SCRIPT_DIR\/\.vendored\/commands\/omniroute\.mjs" "\$@"/)
  assert.equal(wrapperStats.mode & 0o111, 0o111)
})

test("copyPackageTemplates stages vendored templates into the release root", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-release-templates-"))

  const copied = await copyPackageTemplates(releaseRoot)

  assert.equal(copied, true)
  const templateContents = await readFile(path.join(releaseRoot, "templates", "omniroute-config.yaml"), "utf8")
  assert.match(templateContents, /runtimeHome: \{\{RUNTIME_ROOT\}\}/)
  assert.match(templateContents, /listen: \{\{LISTEN_ADDR\}\}/)
  assert.match(templateContents, /dataDir: \{\{DATA_DIR\}\}/)
  assert.match(templateContents, /logDir: \{\{LOGS_DIR\}\}/)
})


test("patchPrepublishScriptSource copies responses proxy into app and keeps Windows command patching", () => {
  const fixture = String.raw`const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX_BIN = process.platform === "win32" ? "npx.cmd" : "npx";
const APP_DIR = join(ROOT, "app");

if (existsSync(standaloneWsSrc) && existsSync(responsesWsProxySrc)) {
  console.log("  📋 Adding Responses WebSocket standalone wrapper...");
  cpSync(standaloneWsSrc, join(APP_DIR, "server-ws.mjs"));
  writeFileSync(
    join(APP_DIR, "responses-ws-proxy.mjs"),
    'export * from "../scripts/responses-ws-proxy.mjs";\n'
  );
}

execFileSync(NPM_BIN, ["install"], { cwd: ROOT, stdio: "inherit" });
execFileSync(NPX_BIN, ["next", "build"], { cwd: ROOT, stdio: "inherit" });`;

  const linuxPatched = patchPrepublishScriptSource(fixture, "linux")
  assert.equal(linuxPatched.includes('cpSync(responsesWsProxySrc, join(APP_DIR, "responses-ws-proxy.mjs"));'), true)
  assert.equal(linuxPatched.includes('export * from "../scripts/responses-ws-proxy.mjs"'), false)
  assert.equal(linuxPatched.includes('execFileSync(NPM_BIN,'), true)

  const windowsPatched = patchPrepublishScriptSource(fixture, "windows")
  assert.equal(windowsPatched.includes('const NPM_BIN = process.env.OMNIROUTE_NPM_BIN || "npm";'), true)
  assert.equal(windowsPatched.includes('const NPX_BIN = process.env.OMNIROUTE_NPX_BIN || "npx";'), true)
  assert.equal(windowsPatched.includes('function runCommand(command: string, args: string[], options: Parameters<typeof execFileSync>[2] = {})'), true)
  assert.equal(windowsPatched.includes('runCommand(NPM_BIN,'), true)
  assert.equal(windowsPatched.includes('runCommand(NPX_BIN,'), true)
  assert.equal(windowsPatched.includes('cpSync(responsesWsProxySrc, join(APP_DIR, "responses-ws-proxy.mjs"));'), true)
})

test("patchResponsesWsProxySource switches wreq-js loading to CommonJS fallback", () => {
  const fixture = String.raw`import { createHash, randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { websocket } from "wreq-js";

export function createResponsesWsProxy({
  wsFactory = websocket,
} = {}) {
  return { wsFactory };
}`

  const patched = patchResponsesWsProxySource(fixture)

  assert.equal(patched.includes('import { websocket } from "wreq-js";'), false)
  assert.equal(patched.includes('import { createRequire } from "node:module";'), true)
  assert.equal(patched.includes('const require = createRequire(import.meta.url);'), true)
  assert.equal(
    patched.includes('const appRequire = createRequire(new URL("../app/package.json", import.meta.url));'),
    true,
  )
  assert.equal(patched.includes('const module = requireFn("wreq-js");'), true)
  assert.equal(patched.includes('throw new AggregateError(errors, "Unable to load wreq-js from the OmniRoute runtime");'), true)
  assert.equal(patched.includes('wsFactory = loadDefaultWsFactory(),'), true)
})

test("patchResponsesWsProxySource resolves wreq-js from app runtime when root node_modules is absent", async () => {
  const fixture = String.raw`import { createHash, randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { websocket } from "wreq-js";

export function createResponsesWsProxy({
  wsFactory = websocket,
} = {}) {
  return { wsFactory };
}`

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-wreq-runtime-"))
  const scriptPath = path.join(tempRoot, "scripts", "responses-ws-proxy.mjs")
  const appPackagePath = path.join(tempRoot, "app", "package.json")
  const wreqPackagePath = path.join(tempRoot, "app", "node_modules", "wreq-js", "package.json")
  const wreqEntrypointPath = path.join(tempRoot, "app", "node_modules", "wreq-js", "index.js")

  await mkdir(path.dirname(scriptPath), { recursive: true })
  await mkdir(path.dirname(appPackagePath), { recursive: true })
  await mkdir(path.dirname(wreqPackagePath), { recursive: true })
  await writeFile(scriptPath, patchResponsesWsProxySource(fixture))
  await writeFile(appPackagePath, '{"name":"omniroute-app"}\n')
  await writeFile(wreqPackagePath, '{"name":"wreq-js","main":"index.js"}\n')
  await writeFile(wreqEntrypointPath, 'module.exports = { websocket: () => "resolved-from-app" };\n')

  const module = await import(pathToFileURL(scriptPath).href)

  assert.equal(module.loadDefaultWsFactory()(), "resolved-from-app")
  assert.equal(module.createResponsesWsProxy().wsFactory(), "resolved-from-app")
})


test("renderPackagedReadme emits OmniRoute usage, dependency, and version details", () => {
  const readme = renderPackagedReadme({
    version: "2026.0505.0001",
    upstreamVersion: "3.7.9",
    sourceRevision: "abc123",
    targetPlatform: "windows",
    targetArch: "amd64",
  })

  assert.match(readme, /\.\\omniroute\.cmd --help/)
  assert.match(readme, /pm2 start cmd\.exe --interpreter none --name omniroute -- \/d \/s \/c \.\\omniroute\.cmd --config \.\\config\.yaml --no-open/)
  assert.match(readme, /## Entrypoints/)
  assert.match(readme, /Recommended PM2 startup entrypoint: `\.\\omniroute\.cmd`/)
  assert.match(readme, /Windows cmd wrapper: `\.\\omniroute\.cmd` and `\.\\omniroute-reset-password\.cmd`/)
  assert.match(readme, /Direct Node maintenance entrypoint: `node \.\\bin\\reset-password\.mjs`/)
  assert.match(readme, /Internal runtime entrypoints managed by the CLI: `app\/server\.js` and, when present, `app\/server-ws\.mjs`/)
  assert.match(readme, /Do not point PM2 at `bin\/omniroute\.mjs`, `app\/server\.js`, or `scripts\/\*\.mjs`/)
  assert.match(readme, /Template path: `templates\/omniroute-config\.yaml`/)
  assert.match(readme, /\.node-version/)
  assert.match(readme, /Upstream version: `3\.7\.9`/)
  assert.match(readme, /Packaged CLI entrypoint: `bin\/omniroute\.mjs`/)
})

test("writePackagedReadme preserves the upstream OmniRoute README before overwriting it", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-readme-"))
  await writeFile(path.join(releaseRoot, "README.md"), "upstream docs\n")

  await writePackagedReadme(releaseRoot, {
    version: "2026.0505.0001",
    upstreamVersion: "3.7.9",
    sourceRevision: "abc123",
    targetPlatform: "linux",
    targetArch: "amd64",
  })

  assert.equal(await readFile(path.join(releaseRoot, "README.upstream.md"), "utf8"), "upstream docs\n")
  const packagedReadme = await readFile(path.join(releaseRoot, "README.md"), "utf8")
  assert.match(packagedReadme, /# omniroute/)
  assert.match(packagedReadme, /\.\/omniroute\.sh --help/)
  assert.match(packagedReadme, /Recommended PM2 startup entrypoint: `\.\/omniroute\.sh`/)
  assert.match(packagedReadme, /pm2 start \.\/omniroute\.sh --interpreter none --name omniroute -- --config \.\/config\.yaml --no-open/)
  assert.match(packagedReadme, /Direct Node maintenance entrypoint: `node \.\/bin\/reset-password\.mjs`/)
})
