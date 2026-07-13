import { describe, expect, it } from "vitest"
import { serializeGeneration } from "@/lib/generations/serialize"
import type { AigcGenerationWithWorkflowSnapshot } from "@/lib/aigc/types"

describe("public generation serialization", () => {
  it("exposes the public workflow identity without leaking the provider", async () => {
    const generation = {
      id: "generation-1",
      job_id: "job-1",
      user_id: "user-1",
      kind: "video",
      workflow_id: "standard",
      prompt: "clip",
      provider: "modal-bridge",
      provider_job_id: "provider-job-1",
      metadata: {},
      workflow_revision: "1",
      workflow_snapshot: {
        schemaVersion: 1,
        definitionRevision: "1",
        kind: "video",
        workflowId: "standard",
        provider: "modal-bridge",
        executionVariant: "private-variant-sentinel",
        templateVersion: "private-template-sentinel",
        referenceCount: 0,
        outputContract: [{ assetType: "video", category: "video", required: true, primary: true }],
      },
      created_at: "2026-07-12T00:00:00.000Z",
    } satisfies AigcGenerationWithWorkflowSnapshot

    const serialized = await serializeGeneration(generation, [])
    expect(serialized).toMatchObject({ workflow_id: "standard" })
    expect(serialized).not.toHaveProperty("provider")
    expect(serialized).not.toHaveProperty("provider_job_id")
    expect(JSON.stringify(serialized)).not.toContain("modal-bridge")
    expect(JSON.stringify(serialized)).not.toContain("private-variant-sentinel")
    expect(JSON.stringify(serialized)).not.toContain("private-template-sentinel")
  })
})
