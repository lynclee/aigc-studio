import { describe, expect, it } from "vitest"
import { renderTemplate } from "@/lib/workflows/render-template"

describe("renderTemplate", () => {
  it("preserves primitive types for exact placeholders", () => {
    expect(renderTemplate("{{SEED}}", { SEED: 7 })).toBe(7)
    expect(renderTemplate("{{ENABLED}}", { ENABLED: false })).toBe(false)
  })

  it("stringifies embedded placeholders", () => {
    expect(renderTemplate("seed={{SEED}}", { SEED: 7 })).toBe("seed=7")
  })

  it("does not recursively expand tokens injected by a replacement value", () => {
    expect(renderTemplate("draw {{PROMPT}}", { PROMPT: "{{SEED}}", SEED: 7 })).toBe("draw {{SEED}}")
  })

  it("leaves unknown placeholders intact for static template validation to catch", () => {
    expect(renderTemplate("{{UNKNOWN}}", {})).toBe("{{UNKNOWN}}")
  })
})
