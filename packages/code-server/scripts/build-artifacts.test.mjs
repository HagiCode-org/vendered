import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  copyPackageTemplates,
  patchBuildVscodeScript,
  pruneSourceNativeArtifacts,
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

test("pruneWindowsNativeArtifacts removes non-Windows prebuilds across multiple packages", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-win-native-prune-"))

  // Simulate audio-capture prebuilds (old-style vendor dir)
  const audioCapturePrebuilds = path.join(
    runtimeRoot,
    "extensions",
    "copilot",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "vendor",
    "audio-capture",
  )

  // Simulate copilot/sdk prebuilds (the actual failing case)
  const copilotSdkPrebuilds = path.join(
    runtimeRoot,
    "extensions",
    "copilot",
    "node_modules",
    "@github",
    "copilot",
    "sdk",
    "prebuilds",
  )

  await mkdir(path.join(audioCapturePrebuilds, "arm64-linux"), { recursive: true })
  await mkdir(path.join(audioCapturePrebuilds, "darwin-arm64"), { recursive: true })
  await mkdir(path.join(audioCapturePrebuilds, "win32-x64"), { recursive: true })
  await writeFile(path.join(audioCapturePrebuilds, "arm64-linux", "capture.node"), "linux\n")
  await writeFile(path.join(audioCapturePrebuilds, "darwin-arm64", "capture.node"), "darwin\n")
  await writeFile(path.join(audioCapturePrebuilds, "win32-x64", "capture.node"), "windows\n")

  await mkdir(path.join(copilotSdkPrebuilds, "darwin-arm64"), { recursive: true })
  await mkdir(path.join(copilotSdkPrebuilds, "linux-x64"), { recursive: true })
  await mkdir(path.join(copilotSdkPrebuilds, "win32-x64"), { recursive: true })
  await writeFile(path.join(copilotSdkPrebuilds, "darwin-arm64", "computer.node"), "darwin\n")
  await writeFile(path.join(copilotSdkPrebuilds, "linux-x64", "computer.node"), "linux\n")
  await writeFile(path.join(copilotSdkPrebuilds, "win32-x64", "computer.node"), "windows\n")

  const changed = await pruneWindowsNativeArtifacts(runtimeRoot)

  assert.equal(changed, true)

  // audio-capture: Windows kept, others removed
  await access(path.join(audioCapturePrebuilds, "win32-x64", "capture.node"))
  await assert.rejects(access(path.join(audioCapturePrebuilds, "arm64-linux", "capture.node")))
  await assert.rejects(access(path.join(audioCapturePrebuilds, "darwin-arm64", "capture.node")))

  // copilot/sdk: Windows kept, others removed
  await access(path.join(copilotSdkPrebuilds, "win32-x64", "computer.node"))
  await assert.rejects(access(path.join(copilotSdkPrebuilds, "darwin-arm64", "computer.node")))
  await assert.rejects(access(path.join(copilotSdkPrebuilds, "linux-x64", "computer.node")))
})

test("pruneSourceNativeArtifacts removes non-Windows prebuilds from source tree and skips vscode-reh-web output dirs", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-source-prune-"))
  const libDir = path.join(sourceRoot, "lib")

  // Source node_modules that SHOULD be pruned
  const sourcePrebuilds = path.join(
    sourceRoot,
    "lib",
    "vscode",
    "extensions",
    "copilot",
    "node_modules",
    "@github",
    "copilot",
    "sdk",
    "prebuilds",
  )
  await mkdir(path.join(sourcePrebuilds, "darwin-x64"), { recursive: true })
  await mkdir(path.join(sourcePrebuilds, "darwin-arm64"), { recursive: true })
  await mkdir(path.join(sourcePrebuilds, "linux-x64"), { recursive: true })
  await mkdir(path.join(sourcePrebuilds, "win32-x64"), { recursive: true })
  for (const plat of ["darwin-x64", "darwin-arm64", "linux-x64", "win32-x64"]) {
    await writeFile(path.join(sourcePrebuilds, plat, "computer.node"), `${plat}\n`)
  }

  // Output dir that should NOT be touched
  const outputPrebuilds = path.join(
    libDir,
    "vscode-reh-web-win32-x64",
    "extensions",
    "copilot",
    "node_modules",
    "@github",
    "copilot",
    "sdk",
    "prebuilds",
  )
  await mkdir(path.join(outputPrebuilds, "darwin-x64"), { recursive: true })
  await mkdir(path.join(outputPrebuilds, "win32-x64"), { recursive: true })
  await writeFile(path.join(outputPrebuilds, "darwin-x64", "computer.node"), "darwin\n")
  await writeFile(path.join(outputPrebuilds, "win32-x64", "computer.node"), "windows\n")

  const changed = await pruneSourceNativeArtifacts(sourceRoot)

  assert.equal(changed, true)

  // Source: Windows kept, non-Windows removed
  await access(path.join(sourcePrebuilds, "win32-x64", "computer.node"))
  await assert.rejects(access(path.join(sourcePrebuilds, "darwin-x64", "computer.node")))
  await assert.rejects(access(path.join(sourcePrebuilds, "darwin-arm64", "computer.node")))
  await assert.rejects(access(path.join(sourcePrebuilds, "linux-x64", "computer.node")))

  // Output dir: untouched (skipped)
  await access(path.join(outputPrebuilds, "darwin-x64", "computer.node"))
  await access(path.join(outputPrebuilds, "win32-x64", "computer.node"))
})

