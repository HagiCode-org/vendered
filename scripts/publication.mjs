import { access, readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"

export const PUBLICATION_SCHEMA_VERSION = 1
export const VERSION_INDEX_SCHEMA_VERSION = 1
export const VERSION_INDEX_BLOB_KEY = "index.json"
const AZURE_BLOB_API_VERSION = "2023-11-03"

export function parseContainerSasUrl(rawValue) {
  assertNonEmptyString(rawValue, "container SAS URL")

  const url = new URL(rawValue)
  const containerName = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!containerName) {
    throw new Error("Container SAS URL must include a container path")
  }

  const accountName = url.hostname.split(".")[0]
  if (!accountName) {
    throw new Error("Container SAS URL must include a storage account host")
  }

  const sasToken = url.search.startsWith("?") ? url.search.slice(1) : url.search
  if (!sasToken) {
    throw new Error("Container SAS URL must include a SAS token")
  }

  return {
    accountName,
    containerName,
    sasToken,
    containerUrl: `${url.origin}/${containerName}`,
  }
}

export function buildBlobUrl(containerSasUrl, blobKey) {
  const { containerUrl, sasToken } = parseContainerSasUrl(containerSasUrl)
  assertNonEmptyString(blobKey, "blobKey")

  const url = new URL(containerUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeBlobKey(blobKey)}`
  url.search = sasToken
  return url.toString()
}

export async function uploadBlobFromFile(containerSasUrl, blobKey, localPath, options = {}) {
  const fileBuffer = await readFile(localPath)
  const fileStats = await stat(localPath)

  await azureBlobRequest(buildBlobUrl(containerSasUrl, blobKey), {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": AZURE_BLOB_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
      "x-ms-blob-content-type": options.contentType || "application/octet-stream",
      "Content-Length": String(fileStats.size),
    },
    body: fileBuffer,
  })
}

export async function blobExists(containerSasUrl, blobKey) {
  const response = await azureBlobRequest(buildBlobUrl(containerSasUrl, blobKey), {
    method: "HEAD",
    headers: {
      "x-ms-version": AZURE_BLOB_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
    },
    allow404: true,
  })

  return response.status !== 404
}

export async function downloadBlobText(containerSasUrl, blobKey) {
  const response = await azureBlobRequest(buildBlobUrl(containerSasUrl, blobKey), {
    method: "GET",
    headers: {
      "x-ms-version": AZURE_BLOB_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
    },
  })

  return response.text()
}

export function buildBlobPrefix({ packageId, version, platform, arch }) {
  assertNonEmptyString(packageId, "packageId")
  assertNonEmptyString(version, "version")
  assertNonEmptyString(platform, "platform")
  assertNonEmptyString(arch, "arch")

  return path.posix.join("packages", packageId, "versions", version, `${platform}-${arch}`)
}

export function buildBlobKey(descriptor, fileName) {
  assertNonEmptyString(fileName, "fileName")
  return `${buildBlobPrefix(descriptor)}/${fileName}`
}

export function createEmptyVersionIndex(generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: VERSION_INDEX_SCHEMA_VERSION,
    generatedAt,
    packages: {},
  }
}

export function normalizePublishMetadata(rawMetadata, options = {}) {
  const sourcePath = options.sourcePath || "<memory>"
  const metadata = ensureObject(rawMetadata, `Publish metadata in ${sourcePath} must be a JSON object`)

  const packageId = requireString(metadata.packageId, "packageId", sourcePath)
  const version = requireString(metadata.version, "version", sourcePath)
  const platform = requireString(metadata.platform, "platform", sourcePath)
  const arch = requireString(metadata.arch, "arch", sourcePath)
  const sourceRevision = requireString(metadata.sourceRevision, "sourceRevision", sourcePath)
  const schemaVersion = metadata.schemaVersion ?? PUBLICATION_SCHEMA_VERSION

  if (schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    throw new Error(
      `Publish metadata in ${sourcePath} uses unsupported schemaVersion ${schemaVersion}; expected ${PUBLICATION_SCHEMA_VERSION}`,
    )
  }

  const artifactDescriptors = Array.isArray(metadata.artifacts) ? metadata.artifacts : null
  if (!artifactDescriptors || artifactDescriptors.length === 0) {
    throw new Error(`Publish metadata in ${sourcePath} must include at least one artifact`)
  }

  const extra = metadata.extra == null ? {} : ensureObject(metadata.extra, `extra in ${sourcePath} must be an object`)

  const artifacts = artifactDescriptors.map((artifact, index) =>
    normalizeArtifact(artifact, {
      sourcePath,
      index,
      packageId,
      version,
      platform,
      arch,
    }),
  )

  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    packageId,
    version,
    platform,
    arch,
    sourceRevision,
    extra,
    artifacts,
  }
}

export async function collectMetadataFiles(artifactsDir) {
  const resolvedArtifactsDir = path.resolve(artifactsDir)
  const metadataFiles = []

  await walkDirectory(resolvedArtifactsDir, async (entryPath, dirent) => {
    if (dirent.isFile() && dirent.name === "metadata.json") {
      metadataFiles.push(entryPath)
    }
  })

  metadataFiles.sort((left, right) => left.localeCompare(right))
  return metadataFiles
}

export async function loadPublishInputs(artifactsDir) {
  const metadataFiles = await collectMetadataFiles(artifactsDir)
  if (metadataFiles.length === 0) {
    throw new Error(`No metadata.json files were found under ${path.resolve(artifactsDir)}`)
  }

  const uploadPlans = []
  const seenBlobKeys = new Map()
  const metadataRecords = []

  for (const metadataPath of metadataFiles) {
    const metadata = normalizePublishMetadata(JSON.parse(await readFile(metadataPath, "utf8")), { sourcePath: metadataPath })
    const artifactDirectory = path.dirname(metadataPath)

    for (const artifact of metadata.artifacts) {
      const localPath = path.join(artifactDirectory, artifact.fileName)
      await access(localPath)

      if (seenBlobKeys.has(artifact.blobKey)) {
        throw new Error(
          `Duplicate blobKey "${artifact.blobKey}" in ${metadataPath} and ${seenBlobKeys.get(artifact.blobKey)}`,
        )
      }

      seenBlobKeys.set(artifact.blobKey, metadataPath)
      uploadPlans.push({
        localPath,
        blobKey: artifact.blobKey,
        kind: artifact.kind,
      })
    }

    metadataRecords.push(metadata)
  }

  uploadPlans.sort((left, right) => left.blobKey.localeCompare(right.blobKey))

  return {
    metadataRecords,
    uploadPlans,
  }
}

export function createPublishResult(metadataRecords, options = {}) {
  const publishedAt = options.publishedAt || new Date().toISOString()
  const records = Array.isArray(metadataRecords) ? metadataRecords : []
  if (records.length === 0) {
    throw new Error("At least one metadata record is required to create a publish result")
  }

  const groups = new Map()
  for (const rawRecord of records) {
    const record = normalizePublishMetadata(rawRecord, {
      sourcePath: options.sourcePath || "<publish-result>",
    })
    const key = `${record.packageId}@@${record.version}`
    const existing = groups.get(key) || []
    existing.push(record)
    groups.set(key, existing)
  }

  const entries = [...groups.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, groupedRecords]) => createVersionEntry(groupedRecords, publishedAt))

  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    generatedAt: publishedAt,
    entries,
  }
}

export function mergeVersionIndex(currentIndex, publishResult, options = {}) {
  const normalizedIndex = normalizeVersionIndex(currentIndex)
  const normalizedPublishResult = normalizePublishResult(publishResult)
  const generatedAt = options.generatedAt || new Date().toISOString()

  const nextPackages = { ...normalizedIndex.packages }

  for (const entry of normalizedPublishResult.entries) {
    const existingPackage = nextPackages[entry.packageId] || {
      packageId: entry.packageId,
      versions: {},
    }

    nextPackages[entry.packageId] = {
      packageId: entry.packageId,
      versions: {
        ...ensureObject(existingPackage.versions, `versions for package ${entry.packageId} must be an object`),
        [entry.version]: entry,
      },
    }
  }

  return {
    schemaVersion: VERSION_INDEX_SCHEMA_VERSION,
    generatedAt,
    packages: sortObjectByKey(nextPackages),
  }
}

function createVersionEntry(metadataRecords, publishedAt) {
  const [firstRecord, ...remainingRecords] = metadataRecords
  const extraSnapshot = JSON.stringify(firstRecord.extra)
  const sourceRevision = firstRecord.sourceRevision

  for (const record of remainingRecords) {
    if (record.sourceRevision !== sourceRevision) {
      throw new Error(
        `Cannot merge publish metadata for ${firstRecord.packageId}@${firstRecord.version}: sourceRevision values do not match`,
      )
    }

    if (JSON.stringify(record.extra) !== extraSnapshot) {
      throw new Error(
        `Cannot merge publish metadata for ${firstRecord.packageId}@${firstRecord.version}: extra metadata differs between platforms`,
      )
    }
  }

  const artifacts = metadataRecords
    .flatMap((record) => record.artifacts)
    .sort(compareArtifacts)
    .map((artifact) => ({ ...artifact }))

  return {
    packageId: firstRecord.packageId,
    version: firstRecord.version,
    publishedAt,
    sourceRevision,
    artifacts,
    extra: firstRecord.extra,
  }
}

function normalizeArtifact(rawArtifact, context) {
  const artifact = ensureObject(
    rawArtifact,
    `Artifact ${context.index + 1} in ${context.sourcePath} must be a JSON object`,
  )
  const kind = requireString(artifact.kind, `artifacts[${context.index}].kind`, context.sourcePath)
  const fileName = requireString(artifact.fileName, `artifacts[${context.index}].fileName`, context.sourcePath)
  const blobKey = requireString(artifact.blobKey, `artifacts[${context.index}].blobKey`, context.sourcePath)

  const expectedPrefix = buildBlobPrefix(context)
  if (!blobKey.startsWith(`${expectedPrefix}/`)) {
    throw new Error(
      `Artifact ${fileName} in ${context.sourcePath} must use the package-scoped prefix ${expectedPrefix}/`,
    )
  }

  const normalizedArtifact = {
    kind,
    fileName,
    blobKey,
    platform: context.platform,
    arch: context.arch,
  }

  if (artifact.sizeBytes != null) {
    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      throw new Error(`artifacts[${context.index}].sizeBytes in ${context.sourcePath} must be a non-negative integer`)
    }
    normalizedArtifact.sizeBytes = artifact.sizeBytes
  }

  if (artifact.sha256 != null) {
    const sha256 = requireString(artifact.sha256, `artifacts[${context.index}].sha256`, context.sourcePath)
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`artifacts[${context.index}].sha256 in ${context.sourcePath} must be a 64-character hex string`)
    }
    normalizedArtifact.sha256 = sha256.toLowerCase()
  }

  return normalizedArtifact
}

function normalizePublishResult(rawPublishResult) {
  const publishResult = ensureObject(rawPublishResult, "Publish result must be a JSON object")
  const entries = Array.isArray(publishResult.entries) ? publishResult.entries : null
  if (!entries || entries.length === 0) {
    throw new Error("Publish result must include at least one entry")
  }

  return {
    schemaVersion: publishResult.schemaVersion ?? PUBLICATION_SCHEMA_VERSION,
    generatedAt: publishResult.generatedAt,
    entries: entries.map((entry, index) => normalizeVersionEntry(entry, `entries[${index}]`)),
  }
}

function normalizeVersionIndex(rawIndex) {
  if (rawIndex == null) {
    return createEmptyVersionIndex()
  }

  const index = ensureObject(rawIndex, "Version index must be a JSON object")
  const packages = index.packages == null ? {} : ensureObject(index.packages, "packages must be an object")

  const normalizedPackages = {}
  for (const [packageId, packageRecord] of Object.entries(packages)) {
    const record = ensureObject(packageRecord, `Package record for ${packageId} must be an object`)
    const versions = record.versions == null ? {} : ensureObject(record.versions, `versions for ${packageId} must be an object`)
    const normalizedVersions = {}

    for (const [version, entry] of Object.entries(versions)) {
      normalizedVersions[version] = normalizeVersionEntry(entry, `${packageId}.versions.${version}`)
    }

    normalizedPackages[packageId] = {
      packageId,
      versions: sortObjectByKey(normalizedVersions),
    }
  }

  return {
    schemaVersion: index.schemaVersion ?? VERSION_INDEX_SCHEMA_VERSION,
    generatedAt: index.generatedAt,
    packages: sortObjectByKey(normalizedPackages),
  }
}

function normalizeVersionEntry(rawEntry, sourcePath) {
  const entry = ensureObject(rawEntry, `${sourcePath} must be an object`)
  const packageId = requireString(entry.packageId, `${sourcePath}.packageId`, sourcePath)
  const version = requireString(entry.version, `${sourcePath}.version`, sourcePath)
  const publishedAt = requireString(entry.publishedAt, `${sourcePath}.publishedAt`, sourcePath)
  const sourceRevision = requireString(entry.sourceRevision, `${sourcePath}.sourceRevision`, sourcePath)
  const extra = entry.extra == null ? {} : ensureObject(entry.extra, `${sourcePath}.extra must be an object`)
  const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : null

  if (!artifacts || artifacts.length === 0) {
    throw new Error(`${sourcePath}.artifacts must include at least one artifact`)
  }

  return {
    packageId,
    version,
    publishedAt,
    sourceRevision,
    extra,
    artifacts: artifacts.map((artifact, index) =>
      normalizeArtifact(artifact, {
        sourcePath,
        index,
        packageId,
        version,
        platform: requireString(artifact.platform, `${sourcePath}.artifacts[${index}].platform`, sourcePath),
        arch: requireString(artifact.arch, `${sourcePath}.artifacts[${index}].arch`, sourcePath),
      }),
    ),
  }
}

async function walkDirectory(rootDir, visitor) {
  const entries = await readdir(rootDir, { withFileTypes: true })

  for (const dirent of entries) {
    const entryPath = path.join(rootDir, dirent.name)
    await visitor(entryPath, dirent)

    if (dirent.isDirectory()) {
      await walkDirectory(entryPath, visitor)
    }
  }
}

function ensureObject(value, errorMessage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage)
  }
  return value
}

function requireString(value, fieldName, sourcePath) {
  assertNonEmptyString(value, `${fieldName} in ${sourcePath}`)
  return value.trim()
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
}

function sortObjectByKey(value) {
  return Object.fromEntries(Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)))
}

function compareArtifacts(left, right) {
  return (
    left.platform.localeCompare(right.platform) ||
    left.arch.localeCompare(right.arch) ||
    left.kind.localeCompare(right.kind) ||
    left.fileName.localeCompare(right.fileName)
  )
}

function encodeBlobKey(blobKey) {
  return blobKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

async function azureBlobRequest(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  })

  if (options.allow404 && response.status === 404) {
    return response
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `Azure Blob request failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
    )
  }

  return response
}
