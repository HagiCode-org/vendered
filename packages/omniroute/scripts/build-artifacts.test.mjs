import test from "node:test"
import assert from "node:assert/strict"

import { createMetadataPayload } from "./build-artifacts.mjs"
import { buildBlobKey } from "../../../scripts/publication.mjs"

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
