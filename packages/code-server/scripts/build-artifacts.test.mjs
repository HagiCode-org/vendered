import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { copyPackageTemplates, patchBuildVscodeScript, renderPackagedReadme, writePackagedReadme } from "./build-artifacts.mjs"

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

test("copyPackageTemplates stages vendored templates into the release root", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "code-server-release-templates-"))

  const copied = await copyPackageTemplates(releaseRoot)

  assert.equal(copied, true)
  const templateContents = await readFile(
    path.join(releaseRoot, "templates", "code-server-config.yaml"),
    "utf8",
  )

  assert.match(templateContents, /bind-addr: 127\.0\.0\.1:8080/)
  assert.match(templateContents, /user-data-dir: \{\{DATA_DIR\}\}/)
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
