const PLACEHOLDER_PATTERN = /{{([A-Z0-9_]+)}}/g

export function renderConfigTemplate(template, values) {
  const rendered = String(template).replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Missing template variable ${key}`)
    }

    return String(values[key])
  })

  const unresolved = rendered.match(PLACEHOLDER_PATTERN)
  if (unresolved) {
    throw new Error(`Unresolved template variables remain: ${unresolved.join(", ")}`)
  }

  return rendered.endsWith("\n") ? rendered : `${rendered}\n`
}

export function quoteYamlString(value) {
  return JSON.stringify(String(value))
}
