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

    let out = template
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`{{${key}}}`).join(String(value))
    }
    return out
  }

  return template
}
