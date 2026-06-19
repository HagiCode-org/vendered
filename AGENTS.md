# Vendered - Agent Configuration

## Root Configuration

Inherits all behavior from `/AGENTS.md` at the monorepo root. Local rules extend or override the root file for this repository.

## Project Context

This repository stores vendored build inputs and CI automation for `code-server` and `OmniRoute` integrations. Each package pins an upstream git submodule and includes build scripts, verification scripts, and YAML config templates.

## Working Directory

Run commands from `repos/vendered/`.

## Key Paths

- `packages/code-server/`: vendored code-server integration (submodule + build/verify scripts + config template)
- `packages/omniroute/`: vendored OmniRoute integration (submodule + build/verify scripts + config template)
- `.github/workflows/code-server-artifacts.yaml`: shared vendored CI pipeline

## Agent Guidelines

- Upstream submodules live under `packages/*/upstream/`; do not edit submodule content directly.
- Build and verification scripts under `packages/*/scripts/` are maintainer entrypoints.
- End users should use published GitHub Release archives, not repo-local scripts.
- Keep config templates (`*-config.yaml`) aligned with the packaged CLI `--config` contract.
- The OmniRoute verify step performs real `pm2`-managed startup smoke tests.

## References

- `README.md`
