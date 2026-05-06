import path from "node:path"

export const WINDOWS_WRAPPER_EXTENSIONS = Object.freeze([".cmd", ".bat", ".ps1"])
export const UNIX_WRAPPER_EXTENSION = ".sh"

export function getManifestBinEntries(manifest) {
  const binMap = manifest?.bin
  if (!binMap || Array.isArray(binMap) || typeof binMap !== "object") {
    throw new Error("Expected package.json bin to be an object of command-to-entrypoint mappings")
  }

  return Object.entries(binMap)
    .map(([command, entryPath]) => {
      if (!command || typeof command !== "string") {
        throw new Error("Expected every package.json bin command name to be a non-empty string")
      }
      if (!entryPath || typeof entryPath !== "string") {
        throw new Error(`Expected package.json bin.${command} to be a non-empty string`)
      }

      return {
        command,
        entryPath: normalizeReleaseRelativePath(entryPath, `bin.${command}`),
      }
    })
    .sort((left, right) => left.command.localeCompare(right.command))
}

export function getWrapperDefinitions(binEntries, targetPlatform) {
  const normalizedPlatform = normalizeTargetPlatform(targetPlatform)

  return binEntries.flatMap((binEntry) => {
    if (normalizedPlatform === "windows") {
      return WINDOWS_WRAPPER_EXTENSIONS.map((extension) =>
        createWrapperDefinition(binEntry.command, `${binEntry.command}${extension}`, binEntry.entryPath),
      )
    }

    return [createWrapperDefinition(binEntry.command, `${binEntry.command}${UNIX_WRAPPER_EXTENSION}`, binEntry.entryPath)]
  })
}

export function getNativeSmokeWrapperFile(binEntries, targetPlatform) {
  const preferredEntry = binEntries.find((entry) => entry.command === "omniroute") ?? binEntries[0]
  if (!preferredEntry) {
    throw new Error("Expected at least one CLI command in package.json bin")
  }

  return normalizeTargetPlatform(targetPlatform) === "windows"
    ? `${preferredEntry.command}.ps1`
    : `${preferredEntry.command}${UNIX_WRAPPER_EXTENSION}`
}

export function renderWrapperContent(wrapperDefinition) {
  const windowsRelativeEntrypoint = wrapperDefinition.relativeEntrypoint.replaceAll("/", "\\")

  switch (path.extname(wrapperDefinition.fileName).toLowerCase()) {
    case ".cmd":
    case ".bat":
      return `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%${windowsRelativeEntrypoint}" %*
exit /b %ERRORLEVEL%
`
    case ".ps1":
      return `$scriptDir = Split-Path -LiteralPath $MyInvocation.MyCommand.Path -Parent
$target = Join-Path $scriptDir '${escapePowerShellLiteral(windowsRelativeEntrypoint)}'
& node $target @args
exit $LASTEXITCODE
`
    case UNIX_WRAPPER_EXTENSION:
      return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/${wrapperDefinition.relativeEntrypoint}" "$@"
`
    default:
      throw new Error(`Unsupported wrapper extension for ${wrapperDefinition.fileName}`)
  }
}

export function resolveReleasePath(releaseRoot, relativePath) {
  const normalizedPath = normalizeReleaseRelativePath(relativePath, "release-relative path")
  return path.join(releaseRoot, ...normalizedPath.split("/"))
}

export function normalizeTargetPlatform(value) {
  switch (String(value).toLowerCase()) {
    case "darwin":
    case "macos":
      return "macos"
    case "win32":
    case "windows":
    case "windows_nt":
      return "windows"
    default:
      return "linux"
  }
}

function createWrapperDefinition(command, fileName, entryPath) {
  return {
    command,
    fileName,
    entryPath,
    relativeEntrypoint: normalizeRelativeWrapperEntrypoint(fileName, entryPath),
    executable: path.extname(fileName).toLowerCase() === UNIX_WRAPPER_EXTENSION,
  }
}

function normalizeRelativeWrapperEntrypoint(wrapperFileName, entryPath) {
  const wrapperDirectory = path.posix.dirname(wrapperFileName.replaceAll("\\", "/"))
  const relativePath = path.posix.relative(wrapperDirectory === "." ? "" : wrapperDirectory, entryPath)
  return relativePath || path.posix.basename(entryPath)
}

function normalizeReleaseRelativePath(value, label) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"))
  if (!normalized || normalized === "." || normalized === ".." || path.posix.isAbsolute(normalized) || normalized.startsWith("../")) {
    throw new Error(`Expected ${label} to stay within the packaged release root, received ${String(value)}`)
  }

  return normalized
}

function escapePowerShellLiteral(value) {
  return value.replaceAll("'", "''")
}
