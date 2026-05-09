import test from "node:test"
import assert from "node:assert/strict"

import { resolveSpawnInvocation } from "./verify-startup.mjs"
import { getManifestBinEntries, getNativeSmokeWrapperFile, getWrapperDefinitions } from "./wrappers.mjs"

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
  assert.equal(getNativeSmokeWrapperFile(binEntries, "windows"), "omniroute.cmd")
  assert.equal(getNativeSmokeWrapperFile(binEntries, "macos"), "omniroute.sh")
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
