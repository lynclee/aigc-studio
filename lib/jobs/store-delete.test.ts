import { beforeEach, describe, expect, it, vi } from "vitest"

const from = vi.fn()
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => ({ from, rpc: vi.fn() })) }))
vi.mock("@/lib/assets/r2-store", () => ({ storeProviderAssetsInR2: vi.fn() }))
vi.mock("@/lib/r2", () => ({ deleteObject: vi.fn() }))

import { assetExistsForKey, getGenerationForJob, listUserLibrary } from "@/lib/jobs/store"

describe("deleted generation read gates", () => {
  const queries = new Map<string, ReturnType<typeof queryFor>>()

  beforeEach(() => {
    vi.clearAllMocks()
    queries.clear()
    from.mockImplementation((table: string) => {
      const query = queryFor(table)
      queries.set(table, query)
      return query
    })
  })

  it("hides tombstoned generations and non-active assets from Job reads", async () => {
    await getGenerationForJob("job-1", "user-1")
    expect(queries.get("aigc_generations")?.is).toHaveBeenCalledWith("deleted_at", null)
    expect(queries.get("aigc_assets")?.eq).toHaveBeenCalledWith("state", "active")
    expect(queries.get("aigc_assets")?.is).toHaveBeenCalledWith("deleted_at", null)
  })

  it("applies the same visibility gates to the Library query", async () => {
    await listUserLibrary("user-1")
    expect(queries.get("aigc_generations")?.is).toHaveBeenCalledWith("deleted_at", null)
    expect(queries.get("aigc_assets")?.eq).toHaveBeenCalledWith("state", "active")
    expect(queries.get("aigc_assets")?.is).toHaveBeenCalledWith("deleted_at", null)
  })

  it("treats only active, non-deleted rows as live references for orphan cleanup", async () => {
    await assetExistsForKey("aigc/user-1/job-1/image.png")
    expect(queries.get("aigc_assets")?.eq).toHaveBeenCalledWith("state", "active")
    expect(queries.get("aigc_assets")?.is).toHaveBeenCalledWith("deleted_at", null)
  })
})

function queryFor(table: string) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (value: unknown) => unknown) => unknown
  } = {}
  for (const method of ["select", "eq", "is", "not", "in", "order", "limit"]) {
    query[method] = vi.fn(() => query)
  }
  query.maybeSingle = vi.fn(async () => ({
    data: table === "aigc_generations" ? generationRow() : null,
    error: null,
  }))
  query.then = (resolve) => resolve({
    data: table === "aigc_generations" ? [generationRow()] : table === "aigc_assets" ? [assetRow()] : [],
    count: table === "aigc_assets" ? 1 : null,
    error: null,
  })
  return query
}

function generationRow() {
  return {
    id: "generation-1",
    job_id: "job-1",
    user_id: "user-1",
    kind: "image",
    workflow_id: "standard",
    prompt: "test",
    provider: "fal-image",
    provider_job_id: "provider-1",
    metadata: {},
    created_at: "2026-07-13T00:00:00.000Z",
    deleted_at: null,
    aigc_jobs: { workflow_revision: "1", workflow_snapshot: {} },
  }
}

function assetRow() {
  return {
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
    created_at: "2026-07-13T00:00:00.000Z",
    state: "active",
    delete_requested_at: null,
    delete_attempts: 0,
    delete_error: null,
    delete_retry_after: null,
    delete_claim_token: null,
    delete_lease_until: null,
    deleted_at: null,
  }
}
