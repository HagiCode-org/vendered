import test from "node:test"
import assert from "node:assert/strict"

import { getNativeStartupWrapperFile, resolveSpawnInvocation } from "./verify-startup.mjs"
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
  assert.equal(getNativeStartupWrapperFile(binEntries, "windows"), "omniroute.ps1")
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
