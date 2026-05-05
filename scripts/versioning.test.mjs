import test from "node:test"
import assert from "node:assert/strict"

import { buildReleaseTag, formatDateVersion, resolveReleaseVersion } from "./versioning.mjs"

test("formatDateVersion uses UTC date and zero-padded revision", () => {
  assert.equal(
    formatDateVersion({
      date: "2026-05-05T23:59:59-07:00",
      revision: 1,
    }),
    "2026.0506.0001",
  )
})

test("resolveReleaseVersion prefers explicit env values", () => {
  assert.equal(
    resolveReleaseVersion(
      {
        RELEASE_VERSION_DATE: "2026-05-05T00:00:00Z",
        RELEASE_REVISION: "42",
      },
      new Date("2026-01-01T00:00:00Z"),
    ),
    "2026.0505.0042",
  )
})

test("resolveReleaseVersion falls back to GitHub run number", () => {
  assert.equal(
    resolveReleaseVersion(
      {
        GITHUB_RUN_NUMBER: "123",
      },
      new Date("2026-05-05T08:00:00Z"),
    ),
    "2026.0505.0123",
  )
})

test("buildReleaseTag prefixes the version with v", () => {
  assert.equal(buildReleaseTag("2026.0505.0001"), "v2026.0505.0001")
})

test("resolveReleaseVersion rejects missing revisions", () => {
  assert.throws(
    () => resolveReleaseVersion({}, new Date("2026-05-05T00:00:00Z")),
    /Missing release revision/,
  )
})
