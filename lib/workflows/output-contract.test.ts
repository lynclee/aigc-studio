import { describe, expect, it } from "vitest"
import {
  validateWorkflowOutputs,
  WorkflowOutputContractError,
} from "@/lib/workflows/output-contract"

function expectCode(run: () => unknown, code: string) {
  try {
    run()
    throw new Error("expected WorkflowOutputContractError")
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowOutputContractError)
    expect((error as WorkflowOutputContractError).code).toBe(code)
  }
}

describe("workflow output completeness", () => {
  it("accepts primary outputs with optional previews", () => {
    expect(() => validateWorkflowOutputs("video", "standard", [
      { assetType: "video" },
      { assetType: "preview" },
    ])).not.toThrow()
  })

  it("accepts either model primary alias", () => {
    expect(() => validateWorkflowOutputs("model3d", "standard", [{ assetType: "model" }])).not.toThrow()
    expect(() => validateWorkflowOutputs("model3d", "standard", [{ assetType: "model3d" }])).not.toThrow()
  })

  it("rejects preview-only and undeclared output sets", () => {
    expectCode(
      () => validateWorkflowOutputs("video", "standard", [{ assetType: "preview" }]),
      "no_primary_asset",
    )
    expectCode(
      () => validateWorkflowOutputs("video", "standard", [{ assetType: "image" }]),
      "asset_type_not_allowed",
    )
  })
})
