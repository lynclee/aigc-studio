import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord } from "@/lib/aigc/types"

vi.mock("@/lib/jobs/store", () => ({ listActiveJobs: vi.fn() }))
vi.mock("@/lib/jobs/reconcile", () => ({ reconcileJob: vi.fn() }))
vi.mock("@/lib/delivery/cleanup", () => ({ cleanupOrphanDeliveries: vi.fn() }))
vi.mock("@/lib/assets/delete", () => ({ processPendingAssetDeletes: vi.fn() }))

import { GET } from "@/app/api/jobs/reconcile/route"
import { processPendingAssetDeletes } from "@/lib/assets/delete"
import { cleanupOrphanDeliveries } from "@/lib/delivery/cleanup"
import { reconcileJob } from "@/lib/jobs/reconcile"
import { listActiveJobs } from "@/lib/jobs/store"

const listActiveJobsMock = vi.mocked(listActiveJobs)
const reconcileJobMock = vi.mocked(reconcileJob)
const orphanCleanupMock = vi.mocked(cleanupOrphanDeliveries)
const assetDeleteMock = vi.mocked(processPendingAssetDeletes)
const originalSecret = process.env.CRON_SECRET

describe("GET /api/jobs/reconcile cleanup orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "cron-secret"
    listActiveJobsMock.mockResolvedValue([])
    orphanCleanupMock.mockResolvedValue({ scanned: 0, deleted: 0, reconciled: 0, failed: 0 })
    assetDeleteMock.mockResolvedValue({
      scanned: 0,
      deadlettered: 0,
      deleted: 0,
      retained: 0,
      failed: 0,
      exhausted: 0,
      conflicted: 0,
    })
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
    vi.restoreAllMocks()
  })

  it("has zero side effects when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET
    const response = await call("Bearer undefined")
    expect(response.status).toBe(401)
    expect(listActiveJobsMock).not.toHaveBeenCalled()
    expect(orphanCleanupMock).not.toHaveBeenCalled()
    expect(assetDeleteMock).not.toHaveBeenCalled()
  })

  it("accepts only the exact Bearer credential", async () => {
    for (const auth of [undefined, "cron-secret", "Basic cron-secret", "Bearer wrong", "Bearer  cron-secret"]) {
      const response = await call(auth)
      expect(response.status).toBe(401)
    }
    expect(listActiveJobsMock).not.toHaveBeenCalled()
  })

  it("runs the bounded deletion processor and returns only aggregate counters", async () => {
    assetDeleteMock.mockResolvedValue({
      scanned: 3,
      deadlettered: 0,
      deleted: 2,
      retained: 0,
      failed: 1,
      exhausted: 0,
      conflicted: 0,
    })
    const response = await call("Bearer cron-secret")
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(assetDeleteMock).toHaveBeenCalledWith(25)
    expect(body.assetDeleteCleanup).toEqual({
      scanned: 3,
      deadlettered: 0,
      deleted: 2,
      retained: 0,
      failed: 1,
      exhausted: 0,
      conflicted: 0,
    })
    expect(JSON.stringify(body)).not.toContain("r2_key")
  })

  it("continues cleanup after an individual Job reconcile failure", async () => {
    const job = activeJob()
    listActiveJobsMock.mockResolvedValue([job])
    reconcileJobMock.mockRejectedValue(Object.assign(new Error("provider secret"), { code: "poll_failed" }))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await call("Bearer cron-secret")
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.reconcileErrors).toBe(1)
    expect(assetDeleteMock).toHaveBeenCalledWith(25)
    expect(JSON.stringify(body)).not.toContain("provider secret")
  })

  it("keeps the cron successful when the deletion processor itself fails", async () => {
    assetDeleteMock.mockRejectedValue(new Error("secret r2 key"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await call("Bearer cron-secret")
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.assetDeleteCleanup).toEqual({
      scanned: 0,
      deadlettered: 0,
      deleted: 0,
      retained: 0,
      failed: 0,
      exhausted: 0,
      conflicted: 0,
    })
    expect(JSON.stringify(body)).not.toContain("secret r2 key")
  })
})

function call(authorization?: string) {
  return GET(new Request("http://localhost/api/jobs/reconcile", {
    headers: authorization ? { authorization } : undefined,
  }))
}

function activeJob(): AigcJobRecord {
  return {
    id: "job-1",
    user_id: "user-1",
    kind: "image",
    workflow_id: "standard",
    workflow_revision: "1",
    workflow_snapshot: {},
    status: "running",
    provider: "fal-image",
    provider_job_id: "provider-1",
    provider_status_url: null,
    request: {},
    provider_response: {},
    error: null,
    reconcile_token: null,
    reconcile_lease_until: null,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    completed_at: null,
  }
}
