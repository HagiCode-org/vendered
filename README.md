# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `packages/omniroute/` contains the vendored OmniRoute integration.
- `packages/omniroute/upstream/` is a Git submodule pointing to `https://github.com/diegosouzapw/OmniRoute.git`.
- `.github/workflows/code-server-artifacts.yaml` is the shared vendored pipeline. It resolves one vendored version/tag per run, then builds `code-server` and OmniRoute in parallel, validates both package families, and publishes one shared GitHub Release result.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.
- `packages/omniroute/scripts/build-artifacts.mjs` and `packages/omniroute/scripts/verify-startup.mjs` are the OmniRoute package-local build and packaged-entry verification entrypoints.

## Release versioning

Published builds use a UTC date-based version in `YYYY.MMDD.RRRR` form, where:

- `YYYY` is the UTC year
- `MMDD` is the UTC month and day
- `RRRR` is the zero-padded GitHub Actions run number

For example, the first qualifying workflow run on 2026-05-05 would produce `2026.0505.0001` and tag the repository as `v2026.0505.0001`.

## GitHub Release publication

After both package families finish their per-platform build and verification jobs, the shared workflow creates or updates one repository release tagged with `v<version>` and uploads both the `code-server` and OmniRoute `.tar.gz` / `.zip` archives from that same run. Asset names stay package-specific so both package families share one vendored release/tag without clobbering one another's archives. Publication still happens automatically on `push` to `main`, and it can also be triggered manually with `workflow_dispatch`. The shared workflow also has a daily schedule, but scheduled runs stop after build and verification so publication remains explicit.

The GitHub release job uses the workflow's built-in `GITHUB_TOKEN`, so no extra repository secret is required.
