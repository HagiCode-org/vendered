# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `packages/omniroute/` contains the vendored OmniRoute integration.
- `packages/omniroute/upstream/` is a Git submodule pointing to `https://github.com/diegosouzapw/OmniRoute.git`.
- `.github/workflows/code-server-artifacts.yaml` builds code-server artifacts on Linux, macOS, and Windows, validates startup on each runner, uploads the outputs to GitHub Actions artifacts, and publishes successful `main` branch pushes into Azure Storage and a GitHub Release in parallel.
- `.github/workflows/omniroute-artifacts.yaml` builds OmniRoute artifacts on Linux x64, macOS x64, macOS arm64, and Windows x64, validates packaged entrypoints on each runner, and only publishes on `main` pushes or explicit manual dispatch.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.
- `packages/omniroute/scripts/build-artifacts.mjs` and `packages/omniroute/scripts/verify-startup.mjs` are the OmniRoute package-local build and packaged-entry verification entrypoints.

## Azure publication

The publication jobs in `.github/workflows/code-server-artifacts.yaml` and `.github/workflows/omniroute-artifacts.yaml` run after the per-platform build and verification jobs succeed. They publish automatically on `push` to `main`, and they can also be triggered manually with `workflow_dispatch` by setting `publish_to_azure=true`.
The OmniRoute workflow also has a daily schedule, but scheduled runs stop after build and verification so publication remains explicit.
Because the SAS publication scripts only use repository files plus downloaded build artifacts, the publish jobs use a standalone Node 22 runtime and do not need the package submodule checkout.

## Release versioning

Published builds use a UTC date-based version in `YYYY.MMDD.RRRR` form, where:

- `YYYY` is the UTC year
- `MMDD` is the UTC month and day
- `RRRR` is the zero-padded GitHub Actions run number

For example, the first qualifying workflow run on 2026-05-05 would produce `2026.0505.0001` and tag the repository as `v2026.0505.0001`.

### Required GitHub configuration

Configure the workflow with:

- Repository secrets:
  - `VENDORED_AZURE_CONTAINER_SAS_URL`

The secret must be a full container-level SAS URL, for example:

```text
https://<account>.blob.core.windows.net/<container>?sp=racwdl&st=...&se=...&spr=https&sv=...&sr=c&sig=...
```

The scripts parse the storage account, container name, and SAS token from this one URL and use it for all blob reads and writes.
Publication uses the Azure Blob REST API directly from Node.js, so the workflow does not require Azure CLI or Azure GitHub Actions.

### Storage layout

Each package publishes under a stable package/version/platform prefix:

```text
packages/<packageId>/versions/<version>/<platform>-<arch>/
  code-server-<version>-<platform>-<arch>.<ext>
  metadata.json
index.json
```

For `code-server`, the initial contract is:

- `packageId`: `code-server`
- archive blob key: `packages/code-server/versions/<version>/<platform>-<arch>/code-server-<version>-<platform>-<arch>.<ext>`
- metadata blob key: `packages/code-server/versions/<version>/<platform>-<arch>/metadata.json`

For `omniroute`, the vendored contract is:

- `packageId`: `omniroute`
- archive blob key: `packages/omniroute/versions/<version>/<platform>-<arch>/omniroute-<version>-<platform>-<arch>.<ext>`
- metadata blob key: `packages/omniroute/versions/<version>/<platform>-<arch>/metadata.json`

`packages/code-server/scripts/build-artifacts.mjs` and `packages/omniroute/scripts/build-artifacts.mjs` emit normalized `metadata.json` with:

- `schemaVersion`
- `packageId`
- `version`
- `platform`
- `arch`
- `sourceRevision`
- `extra`
- `artifacts[]` with `kind`, `fileName`, `blobKey`, and integrity fields when available

OmniRoute uses `extra.standaloneBundle = true` and `extra.packagedEntrypoint = "bin/omniroute.mjs"` so downstream publication records can identify the packaged entrypoint contract.

If required metadata is missing, or any declared artifact file does not exist, publication fails before `index.json` is updated.

`scripts/publish-to-azure.mjs` and `scripts/update-version-index.mjs` both require `AZURE_STORAGE_CONTAINER_SAS_URL` in the environment. The GitHub workflow maps that from `secrets.VENDORED_AZURE_CONTAINER_SAS_URL`.

## GitHub Release publication

When publication is enabled, each workflow creates or updates the same repository release tagged with `v<version>` and uploads its generated `.tar.gz` and `.zip` build archives. Asset names stay package-specific so OmniRoute and `code-server` can append to the same vendored release/tag without deleting one another's archives. This runs in parallel with Azure publication and uses the workflow's built-in `GITHUB_TOKEN`, so no extra secret is required beyond the Azure SAS URL.

### `index.json` semantics

The container root `index.json` is the canonical discovery entry point for all vendored packages. It uses one top-level package record per `packageId`, with versions stored as a map so repeated publication of the same package/version replaces the canonical entry instead of appending duplicates.

Example shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-05T00:00:00.000Z",
  "packages": {
    "code-server": {
      "packageId": "code-server",
      "versions": {
        "1.2.3": {
          "packageId": "code-server",
          "version": "1.2.3",
          "publishedAt": "2026-05-05T00:00:00.000Z",
          "sourceRevision": "abc123",
          "artifacts": [
            {
              "kind": "archive",
              "fileName": "code-server-1.2.3-linux-amd64.tar.gz",
              "blobKey": "packages/code-server/versions/1.2.3/linux-amd64/code-server-1.2.3-linux-amd64.tar.gz",
              "platform": "linux",
              "arch": "amd64",
              "sha256": "..."
            }
          ],
          "extra": {
            "slimArtifact": true,
            "bundledNodeRuntime": false
          }
        }
      }
    }
  }
}
```

Future vendored packages can reuse the same blob layout and index contract by emitting normalized metadata with their own `packageId`.
