import { describe, expect, it } from "vitest"
import {
  validateWorkflowTemplate,
  WorkflowTemplateValidationError,
  type WorkflowTemplateSpec,
} from "@/lib/workflows/validate-template"

const spec: WorkflowTemplateSpec = {
  id: "test-image",
  kind: "image",
  format: "graph",
  placeholders: ["PROMPT", "REFERENCE_IMAGE"],
  referencePlaceholders: ["REFERENCE_IMAGE"],
  primaryOutputs: [{ classType: "SaveImage", input: "images" }],
}

function validGraph(): Record<string, unknown> {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "{{REFERENCE_IMAGE}}" } },
    "2": { class_type: "Transform", inputs: { image: ["1", 0], prompt: "{{PROMPT}}" } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
  }
}

describe("workflow template validation", () => {
  it("accepts a complete graph", () => {
    expect(() => validateWorkflowTemplate(validGraph(), spec)).not.toThrow()
  })

  it("supports the explicit wrapped template format", () => {
    expect(() => validateWorkflowTemplate({ input: { workflow: validGraph() } }, { ...spec, format: "wrapped" }))
      .not.toThrow()
  })

  it.each([
    ["dangling connection", () => {
      const graph = validGraph() as any
      graph["2"].inputs.image = ["missing", 0]
      return graph
    }],
    ["unknown placeholder", () => {
      const graph = validGraph() as any
      graph["2"].inputs.extra = "{{UNKNOWN}}"
      return graph
    }],
    ["missing output", () => {
      const graph = validGraph()
      delete graph["3"]
      return graph
    }],
    ["unconsumed reference", () => {
      const graph = validGraph() as any
      graph["2"].inputs.image = "literal"
      return graph
    }],
    ["missing class", () => {
      const graph = validGraph() as any
      delete graph["2"].class_type
      return graph
    }],
    ["malformed primary output connection", () => {
      const graph = validGraph() as any
      graph["3"].inputs.images = ["2", "0"]
      return graph
    }],
    ["reference placeholder outside LoadImage", () => {
      const graph = validGraph() as any
      graph["1"].inputs.image = "literal.png"
      graph["2"].inputs.reference = "{{REFERENCE_IMAGE}}"
      return graph
    }],
    ["duplicate reference slot", () => {
      const graph = validGraph() as any
      graph["4"] = { class_type: "LoadImage", inputs: { image: "{{REFERENCE_IMAGE}}" } }
      return graph
    }],
    ["reference token reused outside LoadImage", () => {
      const graph = validGraph() as any
      graph["2"].inputs.extra = "also {{REFERENCE_IMAGE}}"
      return graph
    }],
  ])("rejects %s", (_label, makeGraph) => {
    expect(() => validateWorkflowTemplate(makeGraph(), spec)).toThrow(WorkflowTemplateValidationError)
  })
})
