import test from "node:test"
import assert from "node:assert/strict"

import { quoteYamlString, renderConfigTemplate } from "./config-template.mjs"

test("renderConfigTemplate replaces YAML placeholders and preserves trailing newline", () => {
  const rendered = renderConfigTemplate("listen: {{LISTEN_ADDR}}\ndataDir: {{DATA_DIR}}", {
    LISTEN_ADDR: quoteYamlString("127.0.0.1:39001"),
    DATA_DIR: quoteYamlString("/tmp/data dir"),
  })

  assert.equal(rendered, 'listen: "127.0.0.1:39001"\ndataDir: "/tmp/data dir"\n')
})

test("renderConfigTemplate fails when a placeholder is missing", () => {
  assert.throws(
    () => renderConfigTemplate("listen: {{LISTEN_ADDR}}\ndataDir: {{DATA_DIR}}\n", { LISTEN_ADDR: '"127.0.0.1:39001"' }),
    /Missing template variable DATA_DIR/,
  )
})
