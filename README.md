# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `.github/workflows/code-server-artifacts.yaml` builds, validates, and publishes code-server artifacts.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.
- `packages/code-server/templates/code-server-config.yaml` is the packaged YAML config template. Deployment is expected to copy it into a runtime `config.yaml`, fill in the values, and pass it to the packaged CLI with `--config`.

## Terminal usage for published packages

The files under `packages/*/scripts/*.mjs` are maintainer build and verification entrypoints. End users should run the extracted release archives from the GitHub Release assets instead of invoking those repo-local scripts directly.

### code-server

After extracting a published `code-server-<version>-<platform>-<arch>` archive, start it from a terminal with the packaged wrapper:

```bash
./bin/code-server --help
./bin/code-server --bind-addr 0.0.0.0:8080 .
```

On Windows, use `.\bin\code-server.cmd`.

If you need the direct Node entrypoint for troubleshooting, use `node ./out/node/entry.js --help` from inside the extracted archive. Do not treat repo-local build scripts as runtime entrypoints.

## Runtime contract

The vendored terminal programs are designed to run as:

`pm2` -> packaged wrapper -> Node entrypoint

That contract applies to both package families:

- `code-server`: use `./bin/code-server` on Unix-like systems or `.\\bin\\code-server.cmd` under Windows PM2.

PM2 should not point directly at `out/node/entry.js`, `app/server.js`, or support scripts. Those internal entrypoints are still present in the archive, but the supported runtime surface is the wrapper layer because it is what the packaged verification flow exercises.

## YAML configuration

Both package families ship YAML templates inside the release archive:

- `templates/code-server-config.yaml`

The supported deployment flow is:

1. Extract the release archive.
2. Copy the package template to a writable runtime path such as `./config.yaml`.
3. Fill in the YAML values.
4. Start the packaged wrapper through PM2 and pass `--config ./config.yaml`.

The verification scripts enforce this design by materializing a config file from the packaged YAML template and then performing a real PM2-managed wrapper startup check before publication.

## Release versioning

Published builds use a UTC date-based version in `YYYY.MMDD.RRRR` form, where:

- `YYYY` is the UTC year
- `MMDD` is the UTC month and day
- `RRRR` is the zero-padded GitHub Actions run number

For example, the first qualifying workflow run on 2026-05-05 would produce `2026.0505.0001` and tag the repository as `v2026.0505.0001`.

## GitHub Release publication

After the code-server per-platform build and verification jobs finish, the shared workflow creates or updates one repository release tagged with `v<version>` and uploads the verified code-server archives. Publication still happens automatically on `push` to `main`, and it can also be triggered manually with `workflow_dispatch`. The shared workflow also has a daily schedule, but scheduled runs stop after build and verification so publication remains explicit.

The GitHub release job uses the workflow's built-in `GITHUB_TOKEN`, so no extra repository secret is required.
