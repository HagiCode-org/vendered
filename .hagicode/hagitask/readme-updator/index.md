---
public: true
multilingual: false
style: product
---

# README requirements

## Product focus

- Present `vendered` as the source of ready-to-run `code-server` archives for Linux, macOS and Windows, published as GitHub Release assets with a packaged wrapper and a YAML configuration template.
- Main features users get: a terminal-ready wrapper (`./bin/code-server`, `.\bin\code-server.cmd` on Windows), a supported runtime shape (`pm2` -> packaged wrapper -> Node entrypoint), a YAML config passed with `--config`, and date-based release versions.
- Address operators and developers who deploy the published archives from a terminal; this is a developer-facing artifact repository, so terminal usage is in scope.
- Lead with what a user downloads and runs, then how to configure and start it.

## Required content

- Open with a short introduction of the published archives and where to get them (GitHub Releases).
- Show terminal usage for a published archive, the runtime contract, YAML configuration and the date-based release version format.
- Archive, wrapper and config template names must match `packages/code-server/` and the `code-server-artifacts` workflow.

## Exclusions

- Exclude tokens, secret values, internal hosts, machine-specific paths and private links.
- Keep repository maintenance instructions out of the README: repository layout, submodule and build-script details, the artifact workflow and release publication mechanics, CI, build internals and contribution workflow.
