# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `.github/workflows/code-server-artifacts.yaml` builds code-server artifacts on Linux, macOS, and Windows, validates startup on each runner, uploads the outputs to GitHub Actions artifacts, and publishes successful `main` branch pushes into Azure Storage.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.

## Azure publication

The `publish` job in `.github/workflows/code-server-artifacts.yaml` runs after the per-platform build and verification jobs succeed. It publishes automatically on `push` to `main`, and it can also be triggered manually with `workflow_dispatch` by setting `publish_to_azure=true`.

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

`packages/code-server/scripts/build-artifacts.mjs` emits normalized `metadata.json` with:

- `schemaVersion`
- `packageId`
- `version`
- `platform`
- `arch`
- `sourceRevision`
- `extra`
- `artifacts[]` with `kind`, `fileName`, `blobKey`, and integrity fields when available

If required metadata is missing, or any declared artifact file does not exist, publication fails before `index.json` is updated.

`scripts/publish-to-azure.mjs` and `scripts/update-version-index.mjs` both require `AZURE_STORAGE_CONTAINER_SAS_URL` in the environment. The GitHub workflow maps that from `secrets.VENDORED_AZURE_CONTAINER_SAS_URL`.

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
