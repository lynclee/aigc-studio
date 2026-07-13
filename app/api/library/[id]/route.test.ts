import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/session", () => ({ getSession: vi.fn() }))
vi.mock("@/lib/assets/delete", () => ({ tombstoneGenerationAssets: vi.fn() }))

import { DELETE } from "@/app/api/library/[id]/route"
import { tombstoneGenerationAssets } from "@/lib/assets/delete"
import { BackendStoreError } from "@/lib/jobs/store"
import { getSession } from "@/lib/session"

const getSessionMock = vi.mocked(getSession)
const tombstoneMock = vi.mocked(tombstoneGenerationAssets)
const GENERATION_ID = "123e4567-e89b-42d3-a456-426614174000"

describe("DELETE /api/library/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockResolvedValue({ userId: "user-1", name: "Owner", avatar: "", provider: "github" })
    tombstoneMock.mockResolvedValue({
      found: true,
      generationId: GENERATION_ID,
      pendingAssets: 2,
      deletedAssets: 0,
      errorAssets: 0,
    })
  })

  it("rejects unauthenticated requests without touching the deletion queue", async () => {
    getSessionMock.mockResolvedValue(null)
    const response = await requestDelete(GENERATION_ID, { user_id: "attacker", r2_key: "victim/key" })
    expect(response.status).toBe(401)
    expect(tombstoneMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed UUID before the database call", async () => {
    const response = await requestDelete("not-a-uuid")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: "invalid_generation_id" })
    expect(tombstoneMock).not.toHaveBeenCalled()
  })

  it("uses only the session owner and path id, then asynchronously queues deletion", async () => {
    const response = await requestDelete(GENERATION_ID, { user_id: "attacker", r2_key: "victim/key" })
    expect(response.status).toBe(202)
    expect(tombstoneMock).toHaveBeenCalledWith(GENERATION_ID, "user-1")
    expect(await response.json()).toMatchObject({ ok: true, status: "pending_delete", pendingAssets: 2 })
  })

  it("does not distinguish a cross-owner id from a missing id", async () => {
    tombstoneMock.mockResolvedValue({
      found: false,
      generationId: GENERATION_ID,
      pendingAssets: 0,
      deletedAssets: 0,
      errorAssets: 0,
    })
    const first = await requestDelete(GENERATION_ID)
    const second = await requestDelete(GENERATION_ID)
    expect(first.status).toBe(404)
    expect(await first.json()).toEqual({ ok: false, error: "not_found" })
    expect(await second.json()).toEqual({ ok: false, error: "not_found" })
  })

  it("keeps repeated deletion successful after all assets are already deleted", async () => {
    tombstoneMock.mockResolvedValue({
      found: true,
      generationId: GENERATION_ID,
      pendingAssets: 0,
      deletedAssets: 2,
      errorAssets: 0,
    })
    const first = await requestDelete(GENERATION_ID)
    const second = await requestDelete(GENERATION_ID)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ ok: true, status: "deleted", deletedAssets: 2 })
    expect(tombstoneMock).toHaveBeenCalledTimes(2)
  })

  it("maps backend failures without leaking SQL details", async () => {
    tombstoneMock.mockRejectedValue(new BackendStoreError("delete failed: secret SQL"))
    const response = await requestDelete(GENERATION_ID)
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(body).toContain("Service temporarily unavailable")
    expect(body).not.toContain("secret SQL")
  })
})

function requestDelete(id: string, body?: Record<string, unknown>) {
  return DELETE(
    new Request(`http://localhost/api/library/${id}`, {
      method: "DELETE",
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }),
    { params: Promise.resolve({ id }) },
  )
}
