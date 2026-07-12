export type TemplateVars = Record<string, string | number | boolean | null>

export function renderTemplate(template: unknown, vars: TemplateVars): unknown {
  if (template === null) return template

  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, vars))

  if (typeof template === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      result[key] = renderTemplate(value, vars)
    }
    return result
  }

  if (typeof template === "string") {
    const exact = template.match(/^\{\{([A-Z0-9_]+)\}\}$/)
    if (exact) {
      const key = exact[1]
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : template
    }

    // One pass over the original template: replacement values may legitimately contain
    // `{{TOKEN}}` text (for example a user prompt) and must never be expanded a second time.
    return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : token,
    )
  }

  return template
}
