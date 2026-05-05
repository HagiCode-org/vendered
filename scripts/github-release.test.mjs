import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildReleaseBody, collectReleaseAssets, publishGitHubRelease } from "./github-release.mjs"

test("collectReleaseAssets returns archives and ignores metadata", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-release-assets-"))

  try {
    const nestedDirectory = path.join(tempDirectory, "code-server-linux")
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(path.join(nestedDirectory, "code-server-2026.0505.0001-linux-amd64.tar.gz"), "archive")
    await writeFile(path.join(nestedDirectory, "metadata.json"), "{}")

    const assets = await collectReleaseAssets(tempDirectory)

    assert.deepEqual(assets.map((asset) => asset.name), ["code-server-2026.0505.0001-linux-amd64.tar.gz"])
    assert.equal(assets[0].contentType, "application/gzip")
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test("buildReleaseBody includes commit and asset names", () => {
  assert.equal(
    buildReleaseBody({
      version: "2026.0505.0001",
      targetCommitish: "abc123",
      assetNames: ["linux.tar.gz", "windows.zip"],
    }),
    ["Vendored build 2026.0505.0001", "", "Commit: abc123", "", "Assets:", "- linux.tar.gz", "- windows.zip", ""].join(
      "\n",
    ),
  )
})

test("publishGitHubRelease creates a release and uploads archives", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-release-publish-"))

  try {
    await writeFile(path.join(tempDirectory, "code-server-2026.0505.0001-linux-amd64.tar.gz"), "linux")
    await writeFile(path.join(tempDirectory, "code-server-2026.0505.0001-windows-amd64.zip"), "windows")

    const requests = []
    const fetchImpl = async (url, options) => {
      requests.push({ url, options })

      if (String(url).includes("/releases/tags/")) {
        return new Response("{}", { status: 404 })
      }

      if (String(url).endsWith("/releases")) {
        return Response.json({
          url: "https://api.github.com/repos/newbe36524/vendered/releases/1",
          upload_url: "https://uploads.github.com/repos/newbe36524/vendered/releases/1/assets{?name,label}",
          assets: [],
        })
      }

      if (String(url).startsWith("https://uploads.github.com/")) {
        return Response.json({ ok: true })
      }

      throw new Error(`Unexpected request: ${url}`)
    }

    const result = await publishGitHubRelease({
      artifactsDir: tempDirectory,
      repository: "newbe36524/vendered",
      token: "test-token",
      tagName: "v2026.0505.0001",
      releaseName: "2026.0505.0001",
      targetCommitish: "abc123",
      fetchImpl,
    })

    assert.equal(result.assets.length, 2)
    assert.deepEqual(
      requests.map((request) => request.options.method),
      ["GET", "POST", "POST", "POST"],
    )
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test("publishGitHubRelease replaces existing assets on rerun", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-release-rerun-"))

  try {
    await writeFile(path.join(tempDirectory, "code-server-2026.0505.0001-linux-amd64.tar.gz"), "linux")

    const requests = []
    const fetchImpl = async (url, options) => {
      requests.push({ url, options })

      if (String(url).includes("/releases/tags/")) {
        return Response.json({
          url: "https://api.github.com/repos/newbe36524/vendered/releases/1",
          upload_url: "https://uploads.github.com/repos/newbe36524/vendered/releases/1/assets{?name,label}",
          assets: [
            {
              name: "code-server-2026.0505.0001-linux-amd64.tar.gz",
              url: "https://api.github.com/repos/newbe36524/vendered/releases/assets/10",
            },
          ],
        })
      }

      if (String(url).endsWith("/releases/1")) {
        return Response.json({
          url: "https://api.github.com/repos/newbe36524/vendered/releases/1",
          upload_url: "https://uploads.github.com/repos/newbe36524/vendered/releases/1/assets{?name,label}",
          assets: [
            {
              name: "code-server-2026.0505.0001-linux-amd64.tar.gz",
              url: "https://api.github.com/repos/newbe36524/vendered/releases/assets/10",
            },
          ],
        })
      }

      if (String(url).includes("/releases/assets/10")) {
        return new Response(null, { status: 204 })
      }

      if (String(url).startsWith("https://uploads.github.com/")) {
        return Response.json({ ok: true })
      }

      throw new Error(`Unexpected request: ${url}`)
    }

    await publishGitHubRelease({
      artifactsDir: tempDirectory,
      repository: "newbe36524/vendered",
      token: "test-token",
      tagName: "v2026.0505.0001",
      releaseName: "2026.0505.0001",
      targetCommitish: "abc123",
      fetchImpl,
    })

    assert.deepEqual(requests.map((request) => request.options.method), ["GET", "PATCH", "DELETE", "POST"])
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})
