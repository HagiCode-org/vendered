#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import {
  VERSION_INDEX_BLOB_KEY,
  blobExists,
  createEmptyVersionIndex,
  downloadBlobText,
  mergeVersionIndex,
  parseContainerSasUrl,
  uploadBlobFromFile,
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

  const containerSasUrl = requireEnv("AZURE_STORAGE_CONTAINER_SAS_URL")
  const { containerUrl } = parseContainerSasUrl(containerSasUrl)
  const publishResultPath = path.resolve(values["publish-result"])
  const publishResult = JSON.parse(await readFile(publishResultPath, "utf8"))
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vendored-index-"))
  const localIndexPath = path.join(tempDirectory, VERSION_INDEX_BLOB_KEY)

  try {
    const currentIndex = await downloadCurrentIndex({
      containerSasUrl,
      localIndexPath,
    })
    const nextIndex = mergeVersionIndex(currentIndex, publishResult, {
      generatedAt: new Date().toISOString(),
    })

    await writeFile(localIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`)
    await uploadBlobFromFile(containerSasUrl, VERSION_INDEX_BLOB_KEY, localIndexPath, {
      contentType: "application/json",
    })

    console.log(`Updated ${containerUrl}/${VERSION_INDEX_BLOB_KEY}`)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

async function downloadCurrentIndex({ containerSasUrl, localIndexPath }) {
  if (!(await blobExists(containerSasUrl, VERSION_INDEX_BLOB_KEY))) {
    return createEmptyVersionIndex()
  }

  await writeFile(localIndexPath, await downloadBlobText(containerSasUrl, VERSION_INDEX_BLOB_KEY))

  return JSON.parse(await readFile(localIndexPath, "utf8"))
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
