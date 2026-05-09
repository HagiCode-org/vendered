import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { renderPackagedReadme, writePackagedReadme } from "./build-artifacts.mjs"

test("renderPackagedReadme emits code-server usage, dependency, and version details", () => {
  const readme = renderPackagedReadme({
    version: "4.99.0",
    sourceRevision: "abc123",
    targetPlatform: "windows",
    targetArch: "amd64",
  })

  assert.match(readme, /\.\\bin\\code-server\.cmd --help/)
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
