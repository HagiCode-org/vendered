import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  copyPackageTemplates,
  patchBuildVscodeScript,
  pruneWindowsNativeArtifacts,
  renderPackagedReadme,
  shouldKeepWindowsNativeArtifact,
  writePackagedReadme,
} from "./build-artifacts.mjs"

test("renderPackagedReadme emits code-server usage, dependency, and version details", () => {
  const readme = renderPackagedReadme({
    version: "4.99.0",
    sourceRevision: "abc123",
    targetPlatform: "windows",
    targetArch: "amd64",
  })

  assert.match(readme, /\.\\bin\\code-server\.cmd --help/)
  assert.match(readme, /pm2 start \.\\bin\\code-server\.ps1 --interpreter powershell\.exe --name code-server -- --config \.\\config\.yaml/)
  assert.match(readme, /Template path: `templates\/code-server-config\.yaml`/)
  assert.match(readme, /PM2 should target these wrappers instead of `out\/node\/entry\.js` directly/)
  assert.match(readme, /Node\.js 22 must be available on PATH/)
  assert.match(readme, /Packaged version: `4\.99\.0`/)
  assert.match(readme, /Source revision: `abc123`/)
})

test("writePackagedReadme preserves the upstream README before overwriting it", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-readme-"))
  await writeFile(path.join(releaseRoot, "README.md"), "upstream docs\n")

  await writePackagedReadme(releaseRoot, {
    version: "4.99.0",
    sourceRevision: "abc123",
    targetPlatform: "linux",
    targetArch: "amd64",
  })

  assert.equal(await readFile(path.join(releaseRoot, "README.upstream.md"), "utf8"), "upstream docs\n")
  const packagedReadme = await readFile(path.join(releaseRoot, "README.md"), "utf8")
  assert.match(packagedReadme, /# code-server/)
  assert.match(packagedReadme, /\.\/bin\/code-server --help/)
})

test("copyPackageTemplates stages vendored templates into the release root", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-release-templates-"))

  const copied = await copyPackageTemplates(releaseRoot)

  assert.equal(copied, true)
  const templateContents = await readFile(
    path.join(releaseRoot, "templates", "code-server-config.yaml"),
    "utf8",
  )

  assert.match(templateContents, /bind-addr: \{\{BIND_ADDR\}\}/)
  assert.match(templateContents, /user-data-dir: \{\{DATA_DIR\}\}/)
  assert.match(templateContents, /extensions-dir: \{\{EXTENSIONS_DIR\}\}/)
})

test("code-server packaged guidance documents Unix, cmd, and PowerShell wrappers", () => {
  const readme = renderPackagedReadme({
    version: "4.99.0",
    sourceRevision: "abc123",
    targetPlatform: "linux",
    targetArch: "amd64",
  })

  assert.match(readme, /Unix shell: `\.\/bin\/code-server`/)
  assert.match(readme, /Windows Command Prompt: `\.\\bin\\code-server\.cmd`/)
  assert.match(readme, /Windows PowerShell: `\.\\bin\\code-server\.ps1`/)
  assert.match(readme, /pm2 start \.\/bin\/code-server --interpreter none --name code-server -- --config \.\/config\.yaml/)
})

test("code-server wrapper filenames cover Unix, cmd, and PowerShell entrypoints", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-wrappers-"))
  const binDir = path.join(releaseRoot, "bin")
  await mkdir(binDir, { recursive: true })

  await writeFile(path.join(binDir, "code-server"), "#!/usr/bin/env sh\n")
  await writeFile(path.join(binDir, "code-server.cmd"), "@echo off\n")
  await writeFile(path.join(binDir, "code-server.ps1"), "$RootDir = $PSScriptRoot\n")

  await access(path.join(binDir, "code-server"))
  await access(path.join(binDir, "code-server.cmd"))
  await access(path.join(binDir, "code-server.ps1"))
})

test("patchBuildVscodeScript rewrites the stale copilot build task name", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-build-vscode-"))
  const scriptPath = path.join(tempRoot, "build-vscode.sh")

  await writeFile(
    scriptPath,
    "VSCODE_QUALITY=stable npm run gulp compile-copilot-extension-full-build\n",
  )

  const changed = await patchBuildVscodeScript(scriptPath)

  assert.equal(changed, true)
  assert.match(await readFile(scriptPath, "utf8"), /compile-copilot-extension-build/)
  assert.doesNotMatch(await readFile(scriptPath, "utf8"), /compile-copilot-extension-full-build/)
})

test("shouldKeepWindowsNativeArtifact keeps Windows native directories only", () => {
  assert.equal(shouldKeepWindowsNativeArtifact("win32-x64"), true)
  assert.equal(shouldKeepWindowsNativeArtifact("windows-arm64"), true)
  assert.equal(shouldKeepWindowsNativeArtifact("arm64-linux"), false)
  assert.equal(shouldKeepWindowsNativeArtifact("darwin-arm64"), false)
})

test("pruneWindowsNativeArtifacts removes non-Windows Claude audio-capture vendors", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-win-native-prune-"))
  const audioCaptureRoot = path.join(
    runtimeRoot,
    "extensions",
    "copilot",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "vendor",
    "audio-capture",
  )

  await mkdir(path.join(audioCaptureRoot, "arm64-linux"), { recursive: true })
  await mkdir(path.join(audioCaptureRoot, "darwin-arm64"), { recursive: true })
  await mkdir(path.join(audioCaptureRoot, "win32-x64"), { recursive: true })
  await writeFile(path.join(audioCaptureRoot, "arm64-linux", "audio-capture.node"), "linux\n")
  await writeFile(path.join(audioCaptureRoot, "darwin-arm64", "audio-capture.node"), "darwin\n")
  await writeFile(path.join(audioCaptureRoot, "win32-x64", "audio-capture.node"), "windows\n")

  const changed = await pruneWindowsNativeArtifacts(runtimeRoot)

  assert.equal(changed, true)
  await access(path.join(audioCaptureRoot, "win32-x64", "audio-capture.node"))
  await assert.rejects(access(path.join(audioCaptureRoot, "arm64-linux", "audio-capture.node")))
  await assert.rejects(access(path.join(audioCaptureRoot, "darwin-arm64", "audio-capture.node")))
})
