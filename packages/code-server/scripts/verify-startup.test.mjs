import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  findReleaseRoot,
  getNativeSmokeEntrypoint,
  resolveArchivePath,
  resolveSpawnInvocation,
} from "./verify-startup.mjs"

test("resolveArchivePath returns the archive declared in metadata", () => {
  const metadataPath = path.join("/tmp", "artifacts", "metadata.json")
  const archivePath = resolveArchivePath(
    {
      artifacts: [
        { kind: "metadata", fileName: "metadata.json" },
        { kind: "archive", fileName: "code-server-4.99.0-linux-amd64.tar.gz" },
      ],
    },
    metadataPath,
  )

  assert.equal(archivePath, path.join("/tmp", "artifacts", "code-server-4.99.0-linux-amd64.tar.gz"))
})

test("findReleaseRoot locates the extracted release by entrypoint", async () => {
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-verify-root-"))
  const releaseRoot = path.join(extractionRoot, "release")
  await mkdir(path.join(releaseRoot, "out", "node"), { recursive: true })
  await writeFile(path.join(releaseRoot, "out", "node", "entry.js"), "console.log('ok')\n")

  assert.equal(await findReleaseRoot(extractionRoot), releaseRoot)
})

test("getNativeSmokeEntrypoint selects platform-specific wrappers", () => {
  assert.equal(getNativeSmokeEntrypoint("/tmp/release", "linux"), path.join("/tmp/release", "bin", "code-server"))
  assert.equal(getNativeSmokeEntrypoint("/tmp/release", "darwin"), path.join("/tmp/release", "bin", "code-server"))
  assert.equal(getNativeSmokeEntrypoint("C:\\temp\\release", "win32"), path.join("C:\\temp\\release", "bin", "code-server.ps1"))
})

test("resolveSpawnInvocation routes Windows PowerShell wrappers through powershell.exe", () => {
  const invocation = resolveSpawnInvocation("C:\\temp\\release\\bin\\code-server.ps1", ["--help"], "win32")

  assert.equal(invocation.command, "powershell.exe")
  assert.deepEqual(invocation.args, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\temp\\release\\bin\\code-server.ps1",
    "--help",
  ])
})

test("resolveSpawnInvocation normalizes pm2 to pm2.cmd on Windows", () => {
  const invocation = resolveSpawnInvocation("pm2", ["--version"], "win32")

  assert.equal(invocation.command, process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe")
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "pm2.cmd", "--version"])
})

test("resolveSpawnInvocation keeps Unix wrappers unchanged", () => {
  const invocation = resolveSpawnInvocation("/tmp/release/bin/code-server", ["--help"], "linux")

  assert.equal(invocation.command, "/tmp/release/bin/code-server")
  assert.deepEqual(invocation.args, ["--help"])
})