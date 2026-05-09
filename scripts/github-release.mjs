#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

export async function collectReleaseAssets(artifactsDir) {
  const resolvedArtifactsDir = path.resolve(artifactsDir)
  const assets = []

  await walkDirectory(resolvedArtifactsDir, async (entryPath, dirent) => {
    if (!dirent.isFile() || !isReleaseArchive(entryPath)) {
      return
    }

    assets.push({
      name: path.basename(entryPath),
      filePath: entryPath,
      contentType: getContentType(entryPath),
    })
  })

  if (assets.length === 0) {
    throw new Error(`No release archives were found under ${resolvedArtifactsDir}`)
  }

  assets.sort((left, right) => left.name.localeCompare(right.name))

  const seenNames = new Set()
  for (const asset of assets) {
    if (seenNames.has(asset.name)) {
      throw new Error(`Duplicate release asset name detected: ${asset.name}`)
    }
    seenNames.add(asset.name)
  }

  return assets
}

export function buildReleaseBody({ version, targetCommitish, assetNames }) {
  const names = Array.isArray(assetNames) ? assetNames : []
  return [
    `Vendored build ${version}`,
    "",
    `Commit: ${targetCommitish}`,
    "",
    ...(names.length > 0
      ? ["Assets:", ...names.map((name) => `- ${name}`)]
      : ["Assets are published incrementally as verified builds complete."]),
    "",
  ].join("\n")
}

export async function ensureGitHubRelease({
  repository,
  token,
  tagName,
  releaseName,
  targetCommitish,
  body,
  updateExisting = true,
  apiBaseUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const { owner, repo } = parseRepository(repository)
  const releaseBody =
    body ||
    buildReleaseBody({
      version: releaseName,
      targetCommitish,
      assetNames: [],
    })

  const existingRelease = await getReleaseByTag({
    owner,
    repo,
    tagName,
    token,
    apiBaseUrl,
    fetchImpl,
  })

  if (!existingRelease) {
    return createRelease({
      owner,
      repo,
      token,
      tagName,
      releaseName,
      targetCommitish,
      body: releaseBody,
      apiBaseUrl,
      fetchImpl,
    })
  }

  if (!updateExisting) {
    return existingRelease
  }

  return updateRelease({
    releaseUrl: existingRelease.url,
    token,
    releaseName,
    targetCommitish,
    body: releaseBody,
    fetchImpl,
  })
}

export async function publishGitHubRelease({
  artifactsDir,
  repository,
  token,
  tagName,
  releaseName,
  targetCommitish,
  body,
  syncReleaseMetadata = true,
  apiBaseUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const assets = await collectReleaseAssets(artifactsDir)
  const releaseBody =
    body ||
    buildReleaseBody({
      version: releaseName,
      targetCommitish,
      assetNames: assets.map((asset) => asset.name),
    })

  const release = await ensureGitHubRelease({
    repository,
    token,
    tagName,
    releaseName,
    targetCommitish,
    body: releaseBody,
    updateExisting: syncReleaseMetadata,
    apiBaseUrl,
    fetchImpl,
  })

  for (const asset of assets) {
    const existingAsset = Array.isArray(release.assets) ? release.assets.find((candidate) => candidate.name === asset.name) : null
    if (existingAsset) {
      await githubRequest(existingAsset.url, {
        method: "DELETE",
        token,
        fetchImpl,
        allowEmpty: true,
      })
    }

    await uploadReleaseAsset({
      uploadUrl: release.upload_url,
      token,
      asset,
      fetchImpl,
    })

    if (Array.isArray(release.assets)) {
      release.assets = release.assets.filter((candidate) => candidate.name !== asset.name)
      release.assets.push({ name: asset.name })
    }
  }

  return {
    release,
    assets,
  }
}

async function getReleaseByTag({ owner, repo, tagName, token, apiBaseUrl, fetchImpl }) {
  return githubRequest(`${apiBaseUrl}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagName)}`, {
    method: "GET",
    token,
    fetchImpl,
    allow404: true,
  })
}

async function createRelease({ owner, repo, token, tagName, releaseName, targetCommitish, body, apiBaseUrl, fetchImpl }) {
  return githubRequest(`${apiBaseUrl}/repos/${owner}/${repo}/releases`, {
    method: "POST",
    token,
    fetchImpl,
    body: JSON.stringify({
      tag_name: tagName,
      target_commitish: targetCommitish,
      name: releaseName,
      body,
      draft: false,
      prerelease: false,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  })
}

async function updateRelease({ releaseUrl, token, releaseName, targetCommitish, body, fetchImpl }) {
  return githubRequest(releaseUrl, {
    method: "PATCH",
    token,
    fetchImpl,
    body: JSON.stringify({
      name: releaseName,
      body,
      target_commitish: targetCommitish,
      draft: false,
      prerelease: false,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  })
}

async function uploadReleaseAsset({ uploadUrl, token, asset, fetchImpl }) {
  const assetContents = await readFile(asset.filePath)
  const url = new URL(stripUrlTemplate(uploadUrl))
  url.searchParams.set("name", asset.name)

  return githubRequest(url.toString(), {
    method: "POST",
    token,
    fetchImpl,
    body: assetContents,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(assetContents.length),
    },
  })
}

function parseRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/]+)\/([^/]+)$/)
  if (!match) {
    throw new Error(`Invalid GitHub repository: ${String(repository)}`)
  }

  return {
    owner: match[1],
    repo: match[2],
  }
}

function stripUrlTemplate(url) {
  return url.replace(/\{.*$/, "")
}

function isReleaseArchive(filePath) {
  return filePath.endsWith(".zip") || filePath.endsWith(".tar.gz")
}

function getContentType(filePath) {
  return filePath.endsWith(".zip") ? "application/zip" : "application/gzip"
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

async function githubRequest(url, options) {
  const response = await options.fetchImpl(url, {
    method: options.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
    body: options.body,
  })

  if (options.allow404 && response.status === 404) {
    return null
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`GitHub API request failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`)
  }

  if (options.allowEmpty || response.status === 204) {
    return null
  }

  return response.json()
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
}

async function main() {
  const { values } = parseArgs({
    options: {
      "artifacts-dir": {
        type: "string",
        default: "downloaded",
      },
      "create-only": {
        type: "boolean",
        default: false,
      },
      tag: {
        type: "string",
      },
      name: {
        type: "string",
      },
      "preserve-release-metadata": {
        type: "boolean",
        default: false,
      },
      "target-commitish": {
        type: "string",
        default: process.env.GITHUB_SHA,
      },
    },
  })

  if (!values.tag) {
    throw new Error("Missing required --tag argument")
  }

  if (!values.name) {
    throw new Error("Missing required --name argument")
  }

  const repository = requireEnv("GITHUB_REPOSITORY")
  const token = requireEnv("GITHUB_TOKEN")
  const targetCommitish = values["target-commitish"]

  if (!targetCommitish) {
    throw new Error("Missing target commitish. Set --target-commitish or GITHUB_SHA.")
  }

  if (values["create-only"]) {
    await ensureGitHubRelease({
      repository,
      token,
      tagName: values.tag,
      releaseName: values.name,
      targetCommitish,
    })

    console.log(`Ensured release ${values.tag}`)
    return
  }

  const result = await publishGitHubRelease({
    artifactsDir: values["artifacts-dir"],
    repository,
    token,
    tagName: values.tag,
    releaseName: values.name,
    targetCommitish,
    syncReleaseMetadata: !values["preserve-release-metadata"],
  })

  console.log(`Published release ${values.tag} with ${result.assets.length} asset(s)`)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
