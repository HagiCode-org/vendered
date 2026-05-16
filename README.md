# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `packages/omniroute/` contains the vendored OmniRoute integration.
- `packages/omniroute/upstream/` is a Git submodule pointing to `https://github.com/diegosouzapw/OmniRoute.git`.
- `.github/workflows/code-server-artifacts.yaml` is the shared vendored pipeline. It resolves one vendored version/tag per run, then builds `code-server` and OmniRoute in parallel, validates both package families, and publishes one shared GitHub Release result.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.
- `packages/code-server/templates/code-server-config.yaml` and `packages/omniroute/templates/omniroute-config.yaml` are the packaged YAML config templates. Deployment is expected to copy one of these templates into a runtime `config.yaml`, fill in the values, and pass it to the packaged CLI with `--config`.
- `packages/omniroute/scripts/build-artifacts.mjs` and `packages/omniroute/scripts/verify-startup.mjs` are the OmniRoute package-local build and packaged-entry verification entrypoints. The OmniRoute verify step now performs a real `pm2`-managed startup smoke test against the packaged release and waits for `/api/monitoring/health` before publication.

## Runtime contract

The vendored terminal programs are designed to run as:

`pm2` -> packaged wrapper -> Node entrypoint

That contract applies to both package families:

- `code-server`: use `./bin/code-server` on Unix-like systems or `.\\bin\\code-server.ps1` under Windows PM2.
- `omniroute`: use `./omniroute.sh` on Unix-like systems or `.\\omniroute.ps1` under Windows PM2.

PM2 should not point directly at `out/node/entry.js`, `bin/*.mjs`, `app/server.js`, or support scripts. Those internal entrypoints are still present in the archive, but the supported runtime surface is the wrapper layer because it is what the packaged verification flow exercises.

## YAML configuration

Both package families ship YAML templates inside the release archive:

- `templates/code-server-config.yaml`
- `templates/omniroute-config.yaml`

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

After both package families finish their per-platform build and verification jobs, the shared workflow creates or updates one repository release tagged with `v<version>` and uploads both the `code-server` and OmniRoute `.tar.gz` / `.zip` archives from that same run. Asset names stay package-specific so both package families share one vendored release/tag without clobbering one another's archives. Publication still happens automatically on `push` to `main`, and it can also be triggered manually with `workflow_dispatch`. The shared workflow also has a daily schedule, but scheduled runs stop after build and verification so publication remains explicit.

The GitHub release job uses the workflow's built-in `GITHUB_TOKEN`, so no extra repository secret is required.
