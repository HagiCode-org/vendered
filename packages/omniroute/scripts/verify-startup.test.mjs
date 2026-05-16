import test from "node:test"
import assert from "node:assert/strict"

import { quoteYamlString, renderConfigTemplate } from "../../../scripts/config-template.mjs"
import { buildPm2StartupInvocation, getNativeStartupWrapperFile, resolveSpawnInvocation } from "./verify-startup.mjs"
import { getCrossPlatformWrapperDefinitions, getManifestBinEntries, getNativeSmokeWrapperFile, getWrapperDefinitions } from "./wrappers.mjs"

test("verification wrapper expectations stay aligned with the manifest command surface", () => {
  const binEntries = getManifestBinEntries({
    bin: {
      omniroute: "bin/omniroute.mjs",
      "omniroute-reset-password": "bin/reset-password.mjs",
    },
  })

  assert.deepEqual(
    getWrapperDefinitions(binEntries, "windows").map((wrapper) => wrapper.fileName),
    [
      "omniroute.cmd",
      "omniroute.bat",
      "omniroute.ps1",
      "omniroute-reset-password.cmd",
      "omniroute-reset-password.bat",
      "omniroute-reset-password.ps1",
    ],
  )
  assert.deepEqual(
    getWrapperDefinitions(binEntries, "macos").map((wrapper) => wrapper.fileName),
    ["omniroute.sh", "omniroute-reset-password.sh"],
  )
  assert.deepEqual(
    getCrossPlatformWrapperDefinitions(binEntries).map((wrapper) => wrapper.fileName),
    [
      "omniroute.sh",
      "omniroute.cmd",
      "omniroute.bat",
      "omniroute.ps1",
      "omniroute-reset-password.sh",
      "omniroute-reset-password.cmd",
      "omniroute-reset-password.bat",
      "omniroute-reset-password.ps1",
    ],
  )
  assert.equal(getNativeSmokeWrapperFile(binEntries, "windows"), "omniroute.cmd")
  assert.equal(getNativeSmokeWrapperFile(binEntries, "macos"), "omniroute.sh")
  assert.equal(getNativeStartupWrapperFile(binEntries, "windows"), "omniroute.cmd")
  assert.equal(getNativeStartupWrapperFile(binEntries, "macos"), "omniroute.sh")
})


test("resolveSpawnInvocation routes Windows script wrappers through cmd.exe", () => {
  const invocation = resolveSpawnInvocation("C:\\temp\\omniroute.cmd", ["--version"], "win32")

  assert.equal(invocation.command, process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe")
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "C:\\temp\\omniroute.cmd", "--version"])
})

test("resolveSpawnInvocation keeps non-wrapper commands unchanged", () => {
  const invocation = resolveSpawnInvocation(process.execPath, ["bin/omniroute.mjs", "--version"], "win32")

  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, ["bin/omniroute.mjs", "--version"])
})

test("resolveSpawnInvocation routes Windows PowerShell wrappers through powershell.exe", () => {
  const invocation = resolveSpawnInvocation("C:\\temp\\omniroute.ps1", ["--version"], "win32")

  assert.equal(invocation.command, "powershell.exe")
  assert.deepEqual(invocation.args, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\temp\\omniroute.ps1",
    "--version",
  ])
})

test("resolveSpawnInvocation normalizes pm2 to pm2.cmd on Windows", () => {
  const invocation = resolveSpawnInvocation("pm2", ["--version"], "win32")

  assert.equal(invocation.command, process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe")
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "pm2.cmd", "--version"])
})

test("renderConfigTemplate materializes the packaged OmniRoute YAML template", () => {
  const rendered = renderConfigTemplate(
    "runtimeHome: {{RUNTIME_ROOT}}\nlisten: {{LISTEN_ADDR}}\ndataDir: {{DATA_DIR}}\nlogDir: {{LOGS_DIR}}\n",
    {
      RUNTIME_ROOT: quoteYamlString("/tmp/runtime-home"),
      LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
      DATA_DIR: quoteYamlString("/tmp/data"),
      LOGS_DIR: quoteYamlString("/tmp/logs"),
    },
  )

  assert.equal(
    rendered,
    'runtimeHome: "/tmp/runtime-home"\nlisten: "127.0.0.1:39001"\ndataDir: "/tmp/data"\nlogDir: "/tmp/logs"\n',
  )
})

test("buildPm2StartupInvocation uses the wrapper and YAML config without a CLI port override", () => {
  assert.deepEqual(
    buildPm2StartupInvocation({
      processName: "vendored-omniroute-verify-123",
      wrapperPath: "C:\\temp\\omniroute.cmd",
      targetPlatform: "windows",
      configPath: "C:\\temp\\omniroute-config.yaml",
    }),
    [
      "start",
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      "--name",
      "vendored-omniroute-verify-123",
      "--interpreter",
      "none",
      "--",
      "/d",
      "/s",
      "/c",
      "C:\\temp\\omniroute.cmd",
      "--config",
      "C:\\temp\\omniroute-config.yaml",
      "--no-open",
    ],
  )

  assert.deepEqual(
    buildPm2StartupInvocation({
      processName: "vendored-omniroute-verify-123",
      wrapperPath: "/tmp/omniroute.sh",
      targetPlatform: "linux",
      configPath: "/tmp/omniroute-config.yaml",
    }),
    [
      "start",
      "/tmp/omniroute.sh",
      "--name",
      "vendored-omniroute-verify-123",
      "--interpreter",
      "none",
      "--",
      "--config",
      "/tmp/omniroute-config.yaml",
      "--no-open",
    ],
  )
})
