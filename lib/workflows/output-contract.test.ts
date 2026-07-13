import { describe, expect, it } from "vitest"
import {
  validateWorkflowOutputs,
  validateJobWorkflowOutputs,
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

  it("validates retired Jobs against their pinned contract instead of the live catalog", () => {
    const job = {
      kind: "image" as const,
      workflow_id: "retired-v1",
      provider: "modal-bridge",
      workflow_revision: "7",
      workflow_snapshot: {
        schemaVersion: 1,
        definitionRevision: "7",
        kind: "image",
        workflowId: "retired-v1",
        provider: "modal-bridge",
        executionVariant: "retired-image-v7",
        templateVersion: "7",
        referenceCount: 0,
        outputContract: [{ assetType: "legacy-render", category: "image", required: true, primary: true }],
      },
    }

    expect(() => validateJobWorkflowOutputs(job, [{ assetType: "legacy-render" }])).not.toThrow()
    expectCode(() => validateJobWorkflowOutputs(job, [{ assetType: "image" }]), "asset_type_not_allowed")
  })
})
