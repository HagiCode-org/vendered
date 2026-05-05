#!/usr/bin/env node

import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

export function formatDateVersion({ date = new Date(), revision }) {
  const normalizedDate = normalizeDate(date)
  const normalizedRevision = normalizeRevision(revision)
  const year = normalizedDate.getUTCFullYear()
  const month = String(normalizedDate.getUTCMonth() + 1).padStart(2, "0")
  const day = String(normalizedDate.getUTCDate()).padStart(2, "0")

  return `${year}.${month}${day}.${normalizedRevision}`
}

export function buildReleaseTag(version) {
  assertNonEmptyString(version, "version")
  return `v${version}`
}

export function resolveReleaseVersion(env = process.env, now = new Date()) {
  const revision = env.RELEASE_REVISION || env.GITHUB_RUN_NUMBER
  if (!revision) {
    throw new Error("Missing release revision. Set RELEASE_REVISION or GITHUB_RUN_NUMBER.")
  }

  const dateSource = env.RELEASE_VERSION_DATE
  const date = dateSource ? normalizeDate(dateSource) : normalizeDate(now)

  return formatDateVersion({
    date,
    revision,
  })
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid release version date: ${String(value)}`)
  }
  return date
}

function normalizeRevision(value) {
  const revision = typeof value === "number" ? String(value) : String(value || "").trim()
  if (!/^[0-9]+$/.test(revision)) {
    throw new Error(`Release revision must be a positive integer, received: ${String(value)}`)
  }

  return revision.padStart(4, "0")
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
}

function main() {
  const { values } = parseArgs({
    options: {
      format: {
        type: "string",
        default: "github-output",
      },
    },
  })

  const version = resolveReleaseVersion()
  const tag = buildReleaseTag(version)

  if (values.format === "plain") {
    console.log(version)
    return
  }

  console.log(`version=${version}`)
  console.log(`tag=${tag}`)
}

if (isMainModule()) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}
