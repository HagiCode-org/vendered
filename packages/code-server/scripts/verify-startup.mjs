#!/usr/bin/env node

import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const root = path.resolve(packageRoot, "../..")
const codeServerRoot = path.join(packageRoot, "upstream")

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

async function main() {
  process.chdir(root)
  const runtimeRoot = process.env.CODE_SERVER_ROOT || path.join(codeServerRoot, process.env.RELEASE_PATH || "release")
  const entryPath = path.join(runtimeRoot, "out", "node", "entry.js")
  await access(entryPath)

  const port = await getAvailablePort()
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "code-server-user-data-"))
  const extensionsDir = await mkdtemp(path.join(os.tmpdir(), "code-server-extensions-"))

  let child
  let exited = false

  try {
    child = spawn(getNodeCommand(), [
      entryPath,
      "--bind-addr",
      `127.0.0.1:${port}`,
      "--auth",
      "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
    ], {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => {
        exited = true
        reject(new Error(`code-server exited early with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    })

    await Promise.race([waitForHealth(port), exitPromise])
  } finally {
    if (child && !exited) {
      child.kill("SIGTERM")
      await waitForExit(child, 5000)
      if (!exited) {
        child.kill("SIGKILL")
      }
    }
    await Promise.allSettled([rm(userDataDir, { recursive: true, force: true }), rm(extensionsDir, { recursive: true, force: true })])
  }
}

function getNodeCommand() {
  return process.platform === "win32" ? "node.exe" : "node"
}

async function waitForHealth(port) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await requestHealth(port)
      if (response.statusCode === 200) {
        return
      }
    } catch {
      // Retry until the deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for code-server to become healthy on port ${port}`)
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/healthz" },
      (response) => {
        response.resume()
        resolve(response)
      },
    )
    request.on("error", reject)
  })
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve a free port")))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, timeoutMs)

    child.once("exit", () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}
