import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createMetadataPayload, writePlatformWrappers } from "./build-artifacts.mjs"
import { buildBlobKey } from "../../../scripts/publication.mjs"
import { WINDOWS_WRAPPER_EXTENSIONS, getManifestBinEntries, getNativeSmokeWrapperFile, getWrapperDefinitions } from "./wrappers.mjs"

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
      "omniroute.bat",
      "omniroute.ps1",
      "omniroute-reset-password.cmd",
      "omniroute-reset-password.bat",
      "omniroute-reset-password.ps1",
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

test("writePlatformWrappers emits archive-relative Windows wrappers for every command", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-windows-wrappers-"))
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

  await writePlatformWrappers(releaseRoot, binEntries, "windows")

  for (const command of ["omniroute", "omniroute-reset-password"]) {
    for (const extension of WINDOWS_WRAPPER_EXTENSIONS) {
      await access(path.join(releaseRoot, `${command}${extension}`))
    }
  }

  const cmdWrapper = await readFile(path.join(releaseRoot, "omniroute-reset-password.cmd"), "utf8")
  assert.match(cmdWrapper, /set "SCRIPT_DIR=%~dp0"/)
  assert.match(cmdWrapper, /%SCRIPT_DIR%bin\\reset-password\.mjs/)
  assert.doesNotMatch(cmdWrapper, new RegExp(releaseRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const ps1Wrapper = await readFile(path.join(releaseRoot, "omniroute.ps1"), "utf8")
  assert.match(ps1Wrapper, /\$scriptDir = \$PSScriptRoot/)
  assert.match(ps1Wrapper, /\$target = Join-Path \$scriptDir 'bin\\omniroute\.mjs'/)
  assert.doesNotMatch(ps1Wrapper, /Split-Path -LiteralPath/)
})

test("writePlatformWrappers emits executable Unix shell wrappers", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "omniroute-unix-wrappers-"))
  const binEntries = [
    {
      command: "omniroute",
      entryPath: "bin/omniroute.mjs",
    },
  ]

  await writePlatformWrappers(releaseRoot, binEntries, "linux")

  const wrapperPath = path.join(releaseRoot, "omniroute.sh")
  const wrapperContents = await readFile(wrapperPath, "utf8")
  const wrapperStats = await stat(wrapperPath)

  assert.match(wrapperContents, /exec node "\$SCRIPT_DIR\/bin\/omniroute\.mjs" "\$@"/)
  assert.equal(wrapperStats.mode & 0o111, 0o111)
})
