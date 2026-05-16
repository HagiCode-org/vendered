import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  applyVendoredEnvironment,
  extractPortFromListen,
  parseSimpleYaml,
  translateOmniRouteInvocation,
} from "./launcher-runtime.mjs"

test("parseSimpleYaml reads vendored scalar config values", () => {
  assert.deepEqual(
    parseSimpleYaml('runtimeHome: "/tmp/runtime-home"\nlisten: "127.0.0.1:39001"\ndataDir: "/tmp/data"\nlogDir: "/tmp/logs"\n'),
    {
      runtimeHome: "/tmp/runtime-home",
      listen: "127.0.0.1:39001",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
    },
  )
})

test("extractPortFromListen supports host:port and raw port values", () => {
  assert.equal(extractPortFromListen("127.0.0.1:39001"), "39001")
  assert.equal(extractPortFromListen("39001"), "39001")
  assert.equal(extractPortFromListen("not-a-port"), null)
})

test("applyVendoredEnvironment maps vendored YAML keys to runtime env", () => {
  const env = {}
  applyVendoredEnvironment(
    {
      runtimeHome: "/tmp/runtime-home",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
    },
    env,
    "linux",
  )

  assert.deepEqual(env, {
    HOME: "/tmp/runtime-home",
    DATA_DIR: "/tmp/data",
    LOG_DIR: "/tmp/logs",
  })
})

test("translateOmniRouteInvocation converts YAML listen and CLI port into PORT env", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-launcher-runtime-"))
  const configPath = path.join(tempDir, "config.yaml")
  await writeFile(
    configPath,
    'runtimeHome: "/tmp/runtime-home"\nlisten: "127.0.0.1:39001"\ndataDir: "/tmp/data"\nlogDir: "/tmp/logs"\n',
  )

  const fromConfig = translateOmniRouteInvocation(["--config", configPath, "--no-open"], {}, "linux")
  assert.deepEqual(fromConfig.args, ["--config", configPath, "--no-open"])
  assert.equal(fromConfig.env.PORT, "39001")
  assert.equal(fromConfig.env.DATA_DIR, "/tmp/data")
  assert.equal(fromConfig.env.LOG_DIR, "/tmp/logs")
  assert.equal(fromConfig.env.HOME, "/tmp/runtime-home")

  const fromCli = translateOmniRouteInvocation(["--config", configPath, "--port", "42000", "--no-open"], {}, "win32")
  assert.deepEqual(fromCli.args, ["--config", configPath, "--no-open"])
  assert.equal(fromCli.env.PORT, "42000")
  assert.equal(fromCli.env.USERPROFILE, "/tmp/runtime-home")
})
