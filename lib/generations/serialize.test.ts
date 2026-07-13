import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/r2", () => ({ signGetUrl: vi.fn() }))

import { serializeAsset, serializeGeneration } from "@/lib/generations/serialize"
import type { AigcAssetRecord, AigcGenerationWithWorkflowSnapshot } from "@/lib/aigc/types"
import { signGetUrl } from "@/lib/r2"

beforeEach(() => vi.clearAllMocks())

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
      deleted_at: null,
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

describe("public asset serialization", () => {
  it("never signs a pending-delete asset even when a caller passes it directly", async () => {
    const asset = {
      id: "asset-1",
      generation_id: "generation-1",
      job_id: "job-1",
      user_id: "user-1",
      kind: "image",
      asset_type: "image",
      position: 0,
      r2_key: "aigc/user-1/job-1/image.png",
      source_url: null,
      content_type: "image/png",
      metadata: {},
      created_at: "2026-07-12T00:00:00.000Z",
      state: "pending_delete",
      delete_requested_at: "2026-07-13T00:00:00.000Z",
      delete_attempts: 1,
      delete_error: null,
      delete_retry_after: null,
      delete_claim_token: null,
      delete_lease_until: null,
      deleted_at: null,
    } satisfies AigcAssetRecord

    const serialized = await serializeAsset(asset)
    expect(signGetUrl).not.toHaveBeenCalled()
    expect(serialized.url).toBeNull()
  })
})
