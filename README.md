# vendered

This repository stores vendored build inputs and CI automation.

- `packages/code-server/` contains the vendored code-server integration.
- `packages/code-server/upstream/` is a Git submodule pointing to `https://github.com/coder/code-server.git`.
- `.github/workflows/code-server-artifacts.yaml` builds code-server artifacts on Linux, macOS, and Windows, validates startup on each runner, and uploads the outputs to GitHub Actions artifacts.
- `packages/code-server/scripts/build-artifacts.mjs` and `packages/code-server/scripts/verify-startup.mjs` are the Node entrypoints for the build and post-build verification flow.
