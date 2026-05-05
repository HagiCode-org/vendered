import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  blobExists,
  buildBlobUrl,
  buildBlobKey,
  createEmptyVersionIndex,
  createPublishResult,
  downloadBlobText,
  loadPublishInputs,
  mergeVersionIndex,
  parseContainerSasUrl,
  uploadBlobFromFile,
} from "./publication.mjs"

test("parseContainerSasUrl extracts account container and token from one URL", () => {
  assert.deepEqual(
    parseContainerSasUrl(
      "https://hagicode.blob.core.windows.net/vendored-artifacts?sp=racwdl&st=2026-05-05T00%3A00%3A00Z&sig=testsig",
    ),
    {
      accountName: "hagicode",
      containerName: "vendored-artifacts",
      sasToken: "sp=racwdl&st=2026-05-05T00%3A00%3A00Z&sig=testsig",
      containerUrl: "https://hagicode.blob.core.windows.net/vendored-artifacts",
    },
  )
})

test("buildBlobUrl encodes blob paths and preserves SAS query", () => {
  assert.equal(
    buildBlobUrl(
      "https://hagicode.blob.core.windows.net/vendored-artifacts?sp=racwdl&sig=testsig",
      "packages/code-server/versions/1.2.3/linux amd64/metadata.json",
    ),
    "https://hagicode.blob.core.windows.net/vendored-artifacts/packages/code-server/versions/1.2.3/linux%20amd64/metadata.json?sp=racwdl&sig=testsig",
  )
})

test("createPublishResult groups package versions across platforms", () => {
  const linuxArchiveBlobKey = buildBlobKey(
    {
      packageId: "code-server",
      version: "1.2.3",
      platform: "linux",
      arch: "amd64",
    },
    "code-server-1.2.3-linux-amd64.tar.gz",
  )
  const windowsArchiveBlobKey = buildBlobKey(
    {
      packageId: "code-server",
      version: "1.2.3",
      platform: "windows",
      arch: "amd64",
    },
    "code-server-1.2.3-windows-amd64.zip",
  )

  const publishResult = createPublishResult(
    [
      {
        schemaVersion: 1,
        packageId: "code-server",
        version: "1.2.3",
        platform: "linux",
        arch: "amd64",
        sourceRevision: "abc123",
        extra: { slimArtifact: true, bundledNodeRuntime: false },
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.3-linux-amd64.tar.gz",
            blobKey: linuxArchiveBlobKey,
            sizeBytes: 128,
            sha256: "a".repeat(64),
          },
          {
            kind: "metadata",
            fileName: "metadata.json",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "linux",
                arch: "amd64",
              },
              "metadata.json",
            ),
          },
        ],
      },
      {
        schemaVersion: 1,
        packageId: "code-server",
        version: "1.2.3",
        platform: "windows",
        arch: "amd64",
        sourceRevision: "abc123",
        extra: { slimArtifact: true, bundledNodeRuntime: false },
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.3-windows-amd64.zip",
            blobKey: windowsArchiveBlobKey,
            sizeBytes: 256,
            sha256: "b".repeat(64),
          },
          {
            kind: "metadata",
            fileName: "metadata.json",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "windows",
                arch: "amd64",
              },
              "metadata.json",
            ),
          },
        ],
      },
    ],
    { publishedAt: "2026-05-05T00:00:00.000Z" },
  )

  assert.equal(publishResult.entries.length, 1)
  assert.deepEqual(publishResult.entries[0], {
    packageId: "code-server",
    version: "1.2.3",
    publishedAt: "2026-05-05T00:00:00.000Z",
    sourceRevision: "abc123",
    extra: { slimArtifact: true, bundledNodeRuntime: false },
    artifacts: [
      {
        kind: "archive",
        fileName: "code-server-1.2.3-linux-amd64.tar.gz",
        blobKey: linuxArchiveBlobKey,
        platform: "linux",
        arch: "amd64",
        sizeBytes: 128,
        sha256: "a".repeat(64),
      },
      {
        kind: "metadata",
        fileName: "metadata.json",
        blobKey: buildBlobKey(
          {
            packageId: "code-server",
            version: "1.2.3",
            platform: "linux",
            arch: "amd64",
          },
          "metadata.json",
        ),
        platform: "linux",
        arch: "amd64",
      },
      {
        kind: "archive",
        fileName: "code-server-1.2.3-windows-amd64.zip",
        blobKey: windowsArchiveBlobKey,
        platform: "windows",
        arch: "amd64",
        sizeBytes: 256,
        sha256: "b".repeat(64),
      },
      {
        kind: "metadata",
        fileName: "metadata.json",
        blobKey: buildBlobKey(
          {
            packageId: "code-server",
            version: "1.2.3",
            platform: "windows",
            arch: "amd64",
          },
          "metadata.json",
        ),
        platform: "windows",
        arch: "amd64",
      },
    ],
  })
})

test("mergeVersionIndex replaces repeated publish entries without duplicating versions", () => {
  const currentIndex = createEmptyVersionIndex("2026-05-04T00:00:00.000Z")
  currentIndex.packages["code-server"] = {
    packageId: "code-server",
    versions: {
      "1.2.3": {
        packageId: "code-server",
        version: "1.2.3",
        publishedAt: "2026-05-04T00:00:00.000Z",
        sourceRevision: "oldrev",
        extra: { slimArtifact: true },
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.3-linux-amd64.tar.gz",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "linux",
                arch: "amd64",
              },
              "code-server-1.2.3-linux-amd64.tar.gz",
            ),
            platform: "linux",
            arch: "amd64",
          },
        ],
      },
      "1.2.2": {
        packageId: "code-server",
        version: "1.2.2",
        publishedAt: "2026-05-03T00:00:00.000Z",
        sourceRevision: "olderrev",
        extra: { slimArtifact: true },
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.2-linux-amd64.tar.gz",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.2",
                platform: "linux",
                arch: "amd64",
              },
              "code-server-1.2.2-linux-amd64.tar.gz",
            ),
            platform: "linux",
            arch: "amd64",
          },
        ],
      },
    },
  }

  const publishResult = {
    schemaVersion: 1,
    generatedAt: "2026-05-05T00:00:00.000Z",
    entries: [
      {
        packageId: "code-server",
        version: "1.2.3",
        publishedAt: "2026-05-05T00:00:00.000Z",
        sourceRevision: "newrev",
        extra: { slimArtifact: true },
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.3-linux-amd64.tar.gz",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "linux",
                arch: "amd64",
              },
              "code-server-1.2.3-linux-amd64.tar.gz",
            ),
            platform: "linux",
            arch: "amd64",
          },
          {
            kind: "archive",
            fileName: "code-server-1.2.3-windows-amd64.zip",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "windows",
                arch: "amd64",
              },
              "code-server-1.2.3-windows-amd64.zip",
            ),
            platform: "windows",
            arch: "amd64",
          },
        ],
      },
    ],
  }

  const mergedIndex = mergeVersionIndex(currentIndex, publishResult, {
    generatedAt: "2026-05-05T00:00:00.000Z",
  })

  assert.equal(Object.keys(mergedIndex.packages["code-server"].versions).length, 2)
  assert.equal(mergedIndex.packages["code-server"].versions["1.2.3"].sourceRevision, "newrev")
  assert.deepEqual(
    mergedIndex.packages["code-server"].versions["1.2.3"].artifacts.map((artifact) => artifact.platform),
    ["linux", "windows"],
  )
  assert.equal(mergedIndex.packages["code-server"].versions["1.2.2"].sourceRevision, "olderrev")
})

test("loadPublishInputs fails when metadata is incomplete", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-publication-test-"))

  try {
    const artifactDirectory = path.join(tempDirectory, "code-server-linux")
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(path.join(artifactDirectory, "code-server-1.2.3-linux-amd64.tar.gz"), "archive")
    await writeFile(
      path.join(artifactDirectory, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        platform: "linux",
        arch: "amd64",
        sourceRevision: "abc123",
        extra: {},
        artifacts: [
          {
            kind: "archive",
            fileName: "code-server-1.2.3-linux-amd64.tar.gz",
            blobKey: buildBlobKey(
              {
                packageId: "code-server",
                version: "1.2.3",
                platform: "linux",
                arch: "amd64",
              },
              "code-server-1.2.3-linux-amd64.tar.gz",
            ),
          },
        ],
      }),
    )

    await assert.rejects(() => loadPublishInputs(tempDirectory), /packageId in .*metadata\.json must be a non-empty string/)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test("blobExists and downloadBlobText use fetch against blob URLs", async () => {
  const originalFetch = global.fetch
  const requests = []

  global.fetch = async (url, options) => {
    requests.push({ url, options })

    if (options.method === "HEAD") {
      return new Response(null, { status: 200 })
    }

    return new Response('{"hello":"world"}', { status: 200 })
  }

  try {
    const sasUrl = "https://hagicode.blob.core.windows.net/vendored-artifacts?sp=r&sig=testsig"
    assert.equal(await blobExists(sasUrl, "index.json"), true)
    assert.equal(await downloadBlobText(sasUrl, "index.json"), '{"hello":"world"}')
    assert.equal(requests[0].options.method, "HEAD")
    assert.equal(requests[1].options.method, "GET")
  } finally {
    global.fetch = originalFetch
  }
})

test("uploadBlobFromFile uploads via fetch with blob headers", async () => {
  const originalFetch = global.fetch
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-upload-test-"))

  try {
    const filePath = path.join(tempDirectory, "metadata.json")
    await writeFile(filePath, '{"ok":true}')

    const requests = []
    global.fetch = async (url, options) => {
      requests.push({ url, options })
      return new Response(null, { status: 201 })
    }

    await uploadBlobFromFile(
      "https://hagicode.blob.core.windows.net/vendored-artifacts?sp=racwdl&sig=testsig",
      "packages/code-server/versions/1.2.3/linux-amd64/metadata.json",
      filePath,
      { contentType: "application/json" },
    )

    assert.equal(requests.length, 1)
    assert.equal(requests[0].options.method, "PUT")
    assert.equal(requests[0].options.headers["x-ms-blob-type"], "BlockBlob")
    assert.equal(requests[0].options.headers["x-ms-blob-content-type"], "application/json")
  } finally {
    global.fetch = originalFetch
    await rm(tempDirectory, { recursive: true, force: true })
  }
})
