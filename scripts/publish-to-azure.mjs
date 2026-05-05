#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { createPublishResult, loadPublishInputs, parseContainerSasUrl, uploadBlobFromFile } from "./publication.mjs"

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

async function main() {
  const { values } = parseArgs({
    options: {
      "artifacts-dir": {
        type: "string",
        default: "downloaded",
      },
      "publish-result": {
        type: "string",
        default: path.join("artifacts", "publish-result.json"),
      },
    },
  })

  const { accountName, containerName, sasToken, containerUrl } = parseContainerSasUrl(
    requireEnv("AZURE_STORAGE_CONTAINER_SAS_URL"),
  )
  const artifactsDir = path.resolve(values["artifacts-dir"])
  const publishResultPath = path.resolve(values["publish-result"])

  const { metadataRecords, uploadPlans } = await loadPublishInputs(artifactsDir)
  for (const uploadPlan of uploadPlans) {
    await uploadBlobFromFile(requireEnv("AZURE_STORAGE_CONTAINER_SAS_URL"), uploadPlan.blobKey, uploadPlan.localPath, {
      contentType: uploadPlan.kind === "metadata" ? "application/json" : "application/octet-stream",
    })
  }

  const publishResult = createPublishResult(metadataRecords, {
    publishedAt: new Date().toISOString(),
  })

  await mkdir(path.dirname(publishResultPath), { recursive: true })
  await writeFile(publishResultPath, `${JSON.stringify(publishResult, null, 2)}\n`)

  console.log(`Uploaded ${uploadPlans.length} blobs to ${containerUrl}`)
  console.log(`Wrote publish result to ${publishResultPath}`)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
