import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord } from "@/lib/aigc/types"

const rpc = vi.fn()
const from = vi.fn()

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(() => ({ rpc, from })),
}))
vi.mock("@/lib/assets/r2-store", () => ({ storeProviderAssetsInR2: vi.fn() }))
vi.mock("@/lib/r2", () => ({ deleteObject: vi.fn() }))

import { storeProviderAssetsInR2 } from "@/lib/assets/r2-store"
import { attachProviderSubmission, finalizeJobWithAssets, type ClaimedAigcJobRecord } from "@/lib/jobs/store"

const storeProviderAssetsInR2Mock = vi.mocked(storeProviderAssetsInR2)

describe("finalizeJobWithAssets workflow revision pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ data: "generation-1", error: null })
    from.mockImplementation((table: string) => queryFor(table))
    storeProviderAssetsInR2Mock.mockResolvedValue([{
      assetType: "legacy-render",
      position: 0,
      r2Key: "user-1/job-1/legacy-render-0-claim-1.png",
      contentType: "image/png",
    }])
  })

  it("persists a retired workflow with the pinned contract and reads authority back from the Job join", async () => {
    const job = retiredJob()
    const result = await finalizeJobWithAssets(job, [{
      assetType: "legacy-render",
      position: 0,
      url: "https://fal.media/legacy.png",
    }])

    expect(result?.generation.id).toBe("generation-1")
    expect(result?.generation.workflow_revision).toBe("7")
    expect(result?.generation.workflow_snapshot).toMatchObject({ executionVariant: "retired-image-v7" })
    expect(storeProviderAssetsInR2Mock).toHaveBeenCalledWith(expect.objectContaining({
      outputContract: [{ assetType: "legacy-render", category: "image", required: true, primary: true }],
    }))
    expect(rpc).toHaveBeenCalledWith("finalize_job_assets", expect.objectContaining({
      p_workflow_id: "retired-v1",
      p_generation_metadata: { provider_response: {} },
    }))
    expect(JSON.stringify(rpc.mock.calls[0]?.[1]?.p_generation_metadata)).not.toContain("workflow_snapshot")
  })

  it("fails before URL persistence when the stored snapshot identity is corrupt", async () => {
    const job = {
      ...retiredJob(),
      workflow_snapshot: { ...retiredJob().workflow_snapshot as Record<string, unknown>, kind: "video" },
    }
    await expect(finalizeJobWithAssets(job, [{
      assetType: "legacy-render", position: 0, url: "https://fal.media/legacy.png",
    }])).rejects.toThrow(/snapshot identity/)
    expect(storeProviderAssetsInR2Mock).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it("rejects adapter audit metadata that differs from the pinned execution before updating the Job", async () => {
    await expect(attachProviderSubmission(retiredJob(), {
      provider: "fal-image",
      providerJobId: "provider-1",
      status: "queued",
      response: {
        catalog_workflow_id: "retired-v1",
        execution_variant: "wrong-variant",
        template_version: "7",
      },
    })).rejects.toThrow(/does not match the pinned workflow snapshot/)
    expect(from).not.toHaveBeenCalled()
  })
})

function retiredJob(): ClaimedAigcJobRecord {
  const workflowSnapshot = {
    schemaVersion: 1,
    definitionRevision: "7",
    kind: "image",
    workflowId: "retired-v1",
    provider: "fal-image",
    executionVariant: "retired-image-v7",
    templateVersion: "7",
    referenceCount: 0,
    outputContract: [{ assetType: "legacy-render", category: "image", required: true, primary: true }],
  }
  return {
    id: "job-1",
    user_id: "user-1",
    kind: "image",
    workflow_id: "retired-v1",
    workflow_revision: "7",
    workflow_snapshot: workflowSnapshot,
    status: "running",
    provider: "fal-image",
    provider_job_id: "provider-1",
    provider_status_url: null,
    request: { prompt: "legacy" },
    provider_response: {},
    error: null,
    reconcile_token: "claim-1",
    reconcile_lease_until: "2099-01-01T00:00:00.000Z",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    completed_at: null,
  } satisfies AigcJobRecord as ClaimedAigcJobRecord
}

function queryFor(table: string) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.not = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({
    data: table === "aigc_generations"
      ? {
          id: "generation-1",
          job_id: "job-1",
          user_id: "user-1",
          kind: "image",
          workflow_id: "retired-v1",
          prompt: "legacy",
          provider: "fal-image",
          provider_job_id: "provider-1",
          metadata: {
            workflow_revision: "forged-metadata-revision",
            workflow_snapshot: { executionVariant: "forged-metadata-variant" },
          },
          created_at: "2026-07-12T00:00:00.000Z",
          aigc_jobs: {
            workflow_revision: "7",
            workflow_snapshot: retiredJob().workflow_snapshot,
          },
        }
      : null,
    error: null,
  }))
  chain.order = vi.fn(async () => ({
    data: table === "aigc_assets"
      ? [{
          id: "asset-1",
          generation_id: "generation-1",
          job_id: "job-1",
          user_id: "user-1",
          kind: "image",
          asset_type: "legacy-render",
          position: 0,
          r2_key: "user-1/job-1/legacy-render-0-claim-1.png",
          source_url: null,
          content_type: "image/png",
          metadata: {},
          created_at: "2026-07-12T00:00:00.000Z",
        }]
      : [],
    error: null,
  }))
  return chain
}
