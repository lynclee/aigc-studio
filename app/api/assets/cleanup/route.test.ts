import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/assets/delete", () => ({
  getAssetDeleteBacklog: vi.fn(),
  processPendingAssetDeletes: vi.fn(),
}))

import { GET } from "@/app/api/assets/cleanup/route"
import { getAssetDeleteBacklog, processPendingAssetDeletes } from "@/lib/assets/delete"
import { BackendStoreError } from "@/lib/jobs/store"

const processPendingMock = vi.mocked(processPendingAssetDeletes)
const getBacklogMock = vi.mocked(getAssetDeleteBacklog)
const originalSecret = process.env.CRON_SECRET

describe("GET /api/assets/cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "cron-secret"
    processPendingMock.mockResolvedValue({
      scanned: 1,
      deadlettered: 0,
      deleted: 1,
      retained: 0,
      failed: 0,
      exhausted: 0,
      conflicted: 0,
    })
    getBacklogMock.mockResolvedValue({
      observedAt: "2026-07-13T00:00:00.000Z",
      pendingTotal: 0,
      pendingDue: 0,
      pendingLeased: 0,
      retryWait: 0,
      deadletterDue: 0,
      errorTotal: 0,
      oldestPendingAt: null,
      oldestErrorAt: null,
    })
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
    vi.restoreAllMocks()
  })

  it("rejects missing or inexact cron credentials without side effects", async () => {
    for (const auth of [undefined, "Basic cron-secret", "Bearer wrong", "Bearer  cron-secret"]) {
      const response = await call(auth)
      expect(response.status).toBe(401)
    }
    expect(processPendingMock).not.toHaveBeenCalled()
    expect(getBacklogMock).not.toHaveBeenCalled()
  })

  it("also rejects Bearer undefined when CRON_SECRET is absent", async () => {
    delete process.env.CRON_SECRET
    const response = await call("Bearer undefined")
    expect(response.status).toBe(401)
    expect(processPendingMock).not.toHaveBeenCalled()
    expect(getBacklogMock).not.toHaveBeenCalled()
  })

  it("runs a bounded batch independently from provider reconciliation", async () => {
    const response = await call("Bearer cron-secret")
    expect(response.status).toBe(200)
    expect(processPendingMock).toHaveBeenCalledWith(25)
    expect(await response.json()).toEqual({
      ok: true,
      batches: 1,
      assetDeleteCleanup: {
        scanned: 1,
        deadlettered: 0,
        deleted: 1,
        retained: 0,
        failed: 0,
        exhausted: 0,
        conflicted: 0,
      },
      assetDeleteBacklog: {
        observedAt: "2026-07-13T00:00:00.000Z",
        pendingTotal: 0,
        pendingDue: 0,
        pendingLeased: 0,
        retryWait: 0,
        deadletterDue: 0,
        errorTotal: 0,
        oldestPendingAt: null,
        oldestErrorAt: null,
      },
    })
  })

  it("drains additional bounded batches when the previous batch was full", async () => {
    processPendingMock
      .mockResolvedValueOnce({
        scanned: 25,
        deadlettered: 0,
        deleted: 24,
        retained: 0,
        failed: 1,
        exhausted: 0,
        conflicted: 0,
      })
      .mockResolvedValueOnce({
        scanned: 2,
        deadlettered: 0,
        deleted: 2,
        retained: 0,
        failed: 0,
        exhausted: 0,
        conflicted: 0,
      })
    const response = await call("Bearer cron-secret")
    const body = await response.json()
    expect(processPendingMock).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({
      ok: true,
      batches: 2,
      assetDeleteCleanup: { scanned: 27, deleted: 26, failed: 1 },
    })
  })

  it("returns a safe 5xx so the scheduler can observe whole-batch failures", async () => {
    processPendingMock.mockRejectedValue(new BackendStoreError("secret SQL and r2/key"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await call("Bearer cron-secret")
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(body).toContain("Service temporarily unavailable")
    expect(body).not.toContain("secret SQL")
    expect(body).not.toContain("r2/key")
    expect(getBacklogMock).not.toHaveBeenCalled()
  })

  it("keeps successful cleanup visible when aggregate backlog monitoring fails", async () => {
    getBacklogMock.mockRejectedValue(new BackendStoreError("secret SQL and asset identity"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await call("Bearer cron-secret")
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(processPendingMock).toHaveBeenCalledWith(25)
    expect(body).toMatchObject({
      ok: true,
      batches: 1,
      assetDeleteCleanup: { scanned: 1, deleted: 1 },
      assetDeleteBacklog: null,
    })
    expect(JSON.stringify(body)).not.toContain("secret SQL")
    expect(JSON.stringify(body)).not.toContain("asset identity")
    expect(errorSpy).toHaveBeenCalledWith("asset delete backlog monitor error", { type: "Error" })
  })

  it("logs only the aggregate dead-letter count", async () => {
    getBacklogMock.mockResolvedValue({
      observedAt: "2026-07-13T00:00:00.000Z",
      pendingTotal: 2,
      pendingDue: 1,
      pendingLeased: 1,
      retryWait: 0,
      deadletterDue: 0,
      errorTotal: 3,
      oldestPendingAt: "2026-07-12T00:00:00.000Z",
      oldestErrorAt: "2026-07-11T00:00:00.000Z",
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await call("Bearer cron-secret")
    expect(response.status).toBe(200)
    expect(errorSpy).toHaveBeenCalledWith("asset delete dead letters present", { errorTotal: 3 })
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/asset-|user-|job-|r2_key|delete_error|actor|reason/)
  })
})

function call(authorization?: string) {
  return GET(new Request("http://localhost/api/assets/cleanup", {
    headers: authorization ? { authorization } : undefined,
  }))
}
