# vendered

[![last commit](https://img.shields.io/github/last-commit/HagiCode-org/vendered)](https://github.com/HagiCode-org/vendered/commits/main)

`vendered` is the source of ready-to-run `code-server` archives for Linux, macOS and Windows. Each archive ships a packaged wrapper and a YAML configuration template, and is published as an asset of a [GitHub Release](https://github.com/HagiCode-org/vendered/releases).

## Terminal usage for published packages

Download a release archive from the GitHub Release assets, extract it and run it from a terminal.

### code-server

After extracting a published `code-server-<version>-<platform>-<arch>` archive, start it from a terminal with the packaged wrapper:

```bash
./bin/code-server --help
./bin/code-server --bind-addr 0.0.0.0:8080 .
```

On Windows, use `.\bin\code-server.cmd`.

If you need the direct Node entrypoint for troubleshooting, use `node ./out/node/entry.js --help` from inside the extracted archive.

## Runtime contract

The vendored terminal programs are designed to run as:

`pm2` -> packaged wrapper -> Node entrypoint

The wrapper to use is:

- `code-server`: use `./bin/code-server` on Unix-like systems or `.\\bin\\code-server.cmd` under Windows PM2.

PM2 should not point directly at `out/node/entry.js`, `app/server.js`, or support scripts. Those internal entrypoints are still present in the archive, but the supported runtime surface is the wrapper layer because it is what the packaged verification flow exercises.

## YAML configuration

The release archive ships a YAML template:

- `templates/code-server-config.yaml`

The supported deployment flow is:

1. Extract the release archive.
2. Copy the package template to a writable runtime path such as `./config.yaml`.
3. Fill in the YAML values.
4. Start the packaged wrapper through PM2 and pass `--config ./config.yaml`.

## Release versioning

Published builds use a UTC date-based version in `YYYY.MMDD.RRRR` form, where:

- `YYYY` is the UTC year
- `MMDD` is the UTC month and day
- `RRRR` is the zero-padded GitHub Actions run number

For example, the first qualifying workflow run on 2026-05-05 would produce `2026.0505.0001` and tag the repository as `v2026.0505.0001`.
