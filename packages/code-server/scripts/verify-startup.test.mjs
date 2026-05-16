import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { quoteYamlString, renderConfigTemplate } from "../../../scripts/config-template.mjs"
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
  assert.equal(getNativeSmokeEntrypoint("C:\\temp\\release", "win32"), path.join("C:\\temp\\release", "bin", "code-server.cmd"))
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

test("renderConfigTemplate materializes the packaged code-server YAML template", () => {
  const rendered = renderConfigTemplate(
    "bind-addr: {{BIND_ADDR}}\nauth: none\nuser-data-dir: {{DATA_DIR}}\nextensions-dir: {{EXTENSIONS_DIR}}\n",
    {
      BIND_ADDR: quoteYamlString("127.0.0.1:8080"),
      DATA_DIR: quoteYamlString("/tmp/data"),
      EXTENSIONS_DIR: quoteYamlString("/tmp/data/extensions"),
    },
  )

  assert.equal(
    rendered,
    'bind-addr: "127.0.0.1:8080"\nauth: none\nuser-data-dir: "/tmp/data"\nextensions-dir: "/tmp/data/extensions"\n',
  )
})
