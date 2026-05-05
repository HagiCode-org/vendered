#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"

import {
  VERSION_INDEX_BLOB_KEY,
  createEmptyVersionIndex,
  mergeVersionIndex,
  parseContainerSasUrl,
} from "./publication.mjs"

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

async function main() {
  const { values } = parseArgs({
    options: {
      "publish-result": {
        type: "string",
        default: path.join("artifacts", "publish-result.json"),
      },
    },
  })

  const { accountName, containerName, sasToken, containerUrl } = parseContainerSasUrl(
    requireEnv("AZURE_STORAGE_CONTAINER_SAS_URL"),
  )
  const publishResultPath = path.resolve(values["publish-result"])
  const publishResult = JSON.parse(await readFile(publishResultPath, "utf8"))
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-index-"))
  const localIndexPath = path.join(tempDirectory, VERSION_INDEX_BLOB_KEY)

  try {
    const currentIndex = await downloadCurrentIndex({
      accountName,
      containerName,
      sasToken,
      localIndexPath,
    })
    const nextIndex = mergeVersionIndex(currentIndex, publishResult, {
      generatedAt: new Date().toISOString(),
    })

    await writeFile(localIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`)
    await runAz([
      "storage",
      "blob",
      "upload",
      "--account-name",
      accountName,
      "--container-name",
      containerName,
      "--sas-token",
      sasToken,
      "--name",
      VERSION_INDEX_BLOB_KEY,
      "--file",
      localIndexPath,
      "--overwrite",
      "true",
      "--content-type",
      "application/json",
      "--only-show-errors",
      "--output",
      "none",
    ])

    console.log(`Updated ${containerUrl}/${VERSION_INDEX_BLOB_KEY}`)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

async function downloadCurrentIndex({ accountName, containerName, sasToken, localIndexPath }) {
  const blobExists = await runAzJson([
    "storage",
    "blob",
    "exists",
    "--account-name",
    accountName,
    "--container-name",
    containerName,
    "--sas-token",
    sasToken,
    "--name",
    VERSION_INDEX_BLOB_KEY,
    "--output",
    "json",
    "--only-show-errors",
  ])

  if (!blobExists.exists) {
    return createEmptyVersionIndex()
  }

  await runAz([
    "storage",
    "blob",
    "download",
    "--account-name",
    accountName,
    "--container-name",
    containerName,
    "--sas-token",
    sasToken,
    "--name",
    VERSION_INDEX_BLOB_KEY,
    "--file",
    localIndexPath,
    "--overwrite",
    "true",
    "--only-show-errors",
    "--output",
    "none",
  ])

  return JSON.parse(await readFile(localIndexPath, "utf8"))
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function runAz(args) {
  return run("az", args)
}

async function runAzJson(args) {
  const output = await run("az", args, { captureStdout: true })
  return JSON.parse(output)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = []
    const child = spawn(command, args, {
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
      env: process.env,
    })

    if (options.captureStdout) {
      child.stdout.on("data", (chunk) => {
        stdout.push(chunk)
      })
    }

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(options.captureStdout ? Buffer.concat(stdout).toString("utf8") : undefined)
        return
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    })
  })
}
