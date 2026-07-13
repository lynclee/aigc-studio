import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcAssetRecord } from "@/lib/aigc/types"

const rpc = vi.fn()
const from = vi.fn()

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => ({ rpc, from })) }))
vi.mock("@/lib/r2", () => ({ deleteObject: vi.fn() }))
vi.mock("@/lib/assets/r2-store", () => ({ storeProviderAssetsInR2: vi.fn() }))

import {
  assetKeyBelongsToRecord,
  deletionKeysForAsset,
  processPendingAssetDeletes,
  tombstoneGenerationAssets,
} from "@/lib/assets/delete"
import { deleteObject } from "@/lib/r2"

const deleteObjectMock = vi.mocked(deleteObject)

describe("asset deletion queue", () => {
  let claimed: AigcAssetRecord[]
  let deadlettered: number
  let referenceCount: number
  let authority: Record<string, unknown> | null

  beforeEach(() => {
    vi.clearAllMocks()
    claimed = [asset()]
    deadlettered = 0
    referenceCount = 0
    authority = authorityRow()
    deleteObjectMock.mockResolvedValue(true)
    from.mockImplementation((table: string) => tableQuery(table, () => referenceCount, () => authority))
    rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "deadletter_expired_asset_deletes") return { data: deadlettered, error: null }
      if (name === "claim_pending_asset_deletes") return { data: claimed, error: null }
      if (name === "complete_asset_delete") {
        const row = claimed.find((item) => item.id === params.p_asset_id)
        const succeeded = params.p_succeeded === true
        return {
          data: {
            completed: true,
            state: succeeded ? "deleted" : (row?.delete_attempts ?? 1) >= 5 ? "error" : "pending_delete",
            attempts: row?.delete_attempts ?? 1,
          },
          error: null,
        }
      }
      if (name === "tombstone_generation_assets") {
        return {
          data: {
            found: true,
            generation_id: params.p_generation_id,
            pending_assets: 2,
            deleted_assets: 0,
            error_assets: 0,
          },
          error: null,
        }
      }
      throw new Error(`unexpected RPC ${name}`)
    })
  })

  it("passes only server-owned identity into the atomic tombstone RPC", async () => {
    const result = await tombstoneGenerationAssets("generation-1", "user-1")
    expect(rpc).toHaveBeenCalledWith("tombstone_generation_assets", {
      p_generation_id: "generation-1",
      p_user_id: "user-1",
    })
    expect(result).toEqual({
      found: true,
      generationId: "generation-1",
      pendingAssets: 2,
      deletedAssets: 0,
      errorAssets: 0,
    })
  })

  it("deletes the final and staging objects then fences the success completion", async () => {
    const result = await processPendingAssetDeletes(10)
    expect(rpc).toHaveBeenCalledWith("claim_pending_asset_deletes", {
      p_limit: 10,
      p_lease_seconds: 300,
    })
    expect(deleteObjectMock).toHaveBeenCalledWith("aigc/user-1/job-1/image-0.png")
    expect(deleteObjectMock).toHaveBeenCalledWith("aigc/user-1/job-1/.staging/image-0.png")
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_asset_id: "asset-1",
      p_claim_token: "claim-1",
      p_succeeded: true,
    }))
    expect(result).toEqual({
      scanned: 1,
      deadlettered: 0,
      deleted: 1,
      retained: 0,
      failed: 0,
      exhausted: 0,
      conflicted: 0,
    })
  })

  it("keeps a partially removed asset retryable when any physical key fails", async () => {
    deleteObjectMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const result = await processPendingAssetDeletes()
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_succeeded: false,
      p_error_code: "r2_delete_failed",
    }))
    expect(result.failed).toBe(1)
    expect(result.deleted).toBe(0)
  })

  it("marks the fifth failed claim as exhausted without resetting attempts", async () => {
    claimed = [asset({ delete_attempts: 5 })]
    deleteObjectMock.mockResolvedValue(false)
    const result = await processPendingAssetDeletes()
    expect(result.exhausted).toBe(1)
    expect(result.failed).toBe(0)
  })

  it("reports expired fifth-claim dead letters separately from the claimed batch", async () => {
    deadlettered = 2
    claimed = []
    const result = await processPendingAssetDeletes(10)
    expect(rpc).toHaveBeenCalledWith("deadletter_expired_asset_deletes", { p_limit: 10 })
    expect(result).toMatchObject({ scanned: 0, deadlettered: 2, exhausted: 0 })
  })

  it("isolates one R2 failure and continues the rest of the claimed batch", async () => {
    claimed = [
      asset({ id: "asset-fail", r2_key: "aigc/user-1/job-1/fail-0.png", delete_claim_token: "claim-fail" }),
      asset({ id: "asset-ok", r2_key: "aigc/user-1/job-1/image-1.png", delete_claim_token: "claim-ok" }),
    ]
    deleteObjectMock.mockImplementation(async (key) => !key.includes("fail"))
    const result = await processPendingAssetDeletes()
    expect(result).toMatchObject({ scanned: 2, deleted: 1, failed: 1 })
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_asset_id: "asset-ok",
      p_succeeded: true,
    }))
  })

  it("turns a thrown R2 error into a stable retry and still completes another row", async () => {
    claimed = [
      asset({ id: "asset-throw", r2_key: "aigc/user-1/job-1/throw-0.png", delete_claim_token: "claim-throw" }),
      asset({ id: "asset-ok", r2_key: "aigc/user-1/job-1/image-1.png", delete_claim_token: "claim-ok" }),
    ]
    deleteObjectMock.mockImplementation(async (key) => {
      if (key.includes("throw")) throw new Error("credential-shaped provider failure")
      return true
    })
    const result = await processPendingAssetDeletes()
    expect(result).toMatchObject({ scanned: 2, deleted: 1, failed: 1 })
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_asset_id: "asset-throw",
      p_succeeded: false,
      p_error_code: "asset_delete_exception",
    }))
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("credential-shaped")
  })

  it("retains a shared physical object when any other active user still references it", async () => {
    referenceCount = 1
    const result = await processPendingAssetDeletes()
    expect(deleteObjectMock).not.toHaveBeenCalled()
    expect(result.retained).toBe(1)
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({ p_succeeded: true }))
  })

  it("fails closed when the generation is not tombstoned or ownership is inconsistent", async () => {
    authority = { ...authorityRow(), deleted_at: null }
    const result = await processPendingAssetDeletes()
    expect(deleteObjectMock).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_succeeded: false,
      p_error_code: "asset_delete_authority_mismatch",
    }))
  })

  it("never deletes a key outside the claimed asset owner/job namespace", async () => {
    claimed = [asset({ r2_key: "aigc/victim/job-9/image.png" })]
    const result = await processPendingAssetDeletes()
    expect(deleteObjectMock).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(rpc).toHaveBeenCalledWith("complete_asset_delete", expect.objectContaining({
      p_error_code: "asset_delete_key_ownership_mismatch",
    }))
  })

  it("deletes legacy direct assets whose key was based on the stored provider job id", async () => {
    claimed = [asset({ r2_key: "user-1/provider-1/image-0.png" })]
    const result = await processPendingAssetDeletes()
    expect(result.deleted).toBe(1)
    expect(deleteObjectMock).toHaveBeenCalledWith("user-1/provider-1/image-0.png")
  })

  it("treats a stale completion token as a conflict rather than overwriting newer state", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "deadletter_expired_asset_deletes") return { data: 0, error: null }
      if (name === "claim_pending_asset_deletes") return { data: claimed, error: null }
      if (name === "complete_asset_delete") return { data: { completed: false }, error: null }
      throw new Error(`unexpected RPC ${name}`)
    })
    const result = await processPendingAssetDeletes()
    expect(result.conflicted).toBe(1)
    expect(result.deleted).toBe(0)
  })
})

describe("asset deletion key policy", () => {
  it("covers the final key and its delivery staging sibling", () => {
    expect(deletionKeysForAsset("aigc/user-1/job-1/model-0.glb")).toEqual([
      "aigc/user-1/job-1/model-0.glb",
      "aigc/user-1/job-1/.staging/model-0.glb",
    ])
  })

  it("accepts both server key layouts and rejects another owner's namespace", () => {
    const owner = { user_id: "user-1", job_id: "job-1" }
    expect(assetKeyBelongsToRecord(owner, "aigc/user-1/job-1/image.png")).toBe(true)
    expect(assetKeyBelongsToRecord(owner, "user-1/job-1/image.png")).toBe(true)
    expect(assetKeyBelongsToRecord(owner, "user-1/provider_job_legacy/image.png", "provider/job legacy")).toBe(true)
    expect(assetKeyBelongsToRecord(owner, "aigc/user-2/job-1/image.png")).toBe(false)
    expect(assetKeyBelongsToRecord(owner, "user-1/provider_job_other/image.png", "provider/job legacy")).toBe(false)
  })
})

function asset(overrides: Partial<AigcAssetRecord> = {}): AigcAssetRecord {
  return {
    id: "asset-1",
    generation_id: "generation-1",
    job_id: "job-1",
    user_id: "user-1",
    kind: "image",
    asset_type: "image",
    position: 0,
    r2_key: "aigc/user-1/job-1/image-0.png",
    source_url: null,
    content_type: "image/png",
    metadata: {},
    created_at: "2026-07-13T00:00:00.000Z",
    state: "pending_delete",
    delete_requested_at: "2026-07-13T00:00:00.000Z",
    delete_attempts: 1,
    delete_error: null,
    delete_retry_after: null,
    delete_claim_token: "claim-1",
    delete_lease_until: "2026-07-13T00:05:00.000Z",
    deleted_at: null,
    ...overrides,
  }
}

function authorityRow() {
  return {
    id: "generation-1",
    job_id: "job-1",
    user_id: "user-1",
    provider_job_id: "provider-1",
    deleted_at: "2026-07-13T00:00:00.000Z",
    aigc_jobs: { user_id: "user-1" },
  }
}

function tableQuery(
  table: string,
  getReferenceCount: () => number,
  getAuthority: () => Record<string, unknown> | null,
) {
  const chain: Record<string, unknown> = { error: null }
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.neq = vi.fn(() => chain)
  chain.is = vi.fn(() => {
    if (table === "aigc_assets") chain.count = getReferenceCount()
    return chain
  })
  chain.maybeSingle = vi.fn(async () => ({ data: getAuthority(), error: null }))
  return chain
}
