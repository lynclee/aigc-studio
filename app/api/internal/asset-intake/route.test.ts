import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord } from "@/lib/aigc/types"

vi.mock("@/lib/jobs/store", () => ({
  getOwnedJob: vi.fn(),
  terminalStatus: vi.fn(() => false),
}))
vi.mock("@/lib/delivery/token", () => ({
  verifyDeliveryToken: vi.fn(() => ({ jobId: "job-1", userId: "user-1" })),
}))
vi.mock("@/lib/delivery/uploads", () => ({ getOrCreateUpload: vi.fn() }))
vi.mock("@/lib/r2", () => ({
  getR2Env: vi.fn(() => ({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" })),
  signPutUrl: vi.fn(),
}))

import { POST } from "@/app/api/internal/asset-intake/route"
import { getOrCreateUpload } from "@/lib/delivery/uploads"
import { getOwnedJob } from "@/lib/jobs/store"
import { signPutUrl } from "@/lib/r2"

const baseJob = {
  id: "job-1",
  user_id: "user-1",
  workflow_id: "standard",
  status: "running",
} as AigcJobRecord

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/internal/asset-intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: "job-1", token: "token", position: 0, size_bytes: 100, ...body }),
  })
}

beforeEach(() => {
  vi.mocked(getOwnedJob).mockReset()
  vi.mocked(getOrCreateUpload).mockReset()
  vi.mocked(signPutUrl).mockReset()
  vi.mocked(getOrCreateUpload).mockImplementation(async (value) => ({
    r2Key: value.r2Key,
    contentType: value.contentType,
  }) as never)
  vi.mocked(signPutUrl).mockResolvedValue({
    url: "https://r2.example/upload",
    requiredHeaders: { "Content-Type": "image/png" },
  })
})

describe("POST /api/internal/asset-intake", () => {
  it("accepts an image preview for a video workflow", async () => {
    vi.mocked(getOwnedJob).mockResolvedValue({ ...baseJob, kind: "video" })

    const response = await POST(request({ asset_type: "preview", content_type: "image/png", filename: "preview.png" }))
    expect(response.status).toBe(200)
    expect(getOrCreateUpload).toHaveBeenCalledWith(expect.objectContaining({
      assetType: "preview",
      r2Key: "aigc/user-1/job-1/preview-0.png",
    }))
  })

  it("rejects an image MIME for the primary video asset", async () => {
    vi.mocked(getOwnedJob).mockResolvedValue({ ...baseJob, kind: "video" })

    const response = await POST(request({ asset_type: "video", content_type: "image/png" }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "content_type_not_allowed" })
    expect(getOrCreateUpload).not.toHaveBeenCalled()
  })

  it("applies the image size limit to a model preview", async () => {
    vi.mocked(getOwnedJob).mockResolvedValue({ ...baseJob, kind: "model3d" })

    const response = await POST(request({
      asset_type: "preview",
      content_type: "image/png",
      size_bytes: 25 * 1024 * 1024 + 1,
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "size_too_large" })
    expect(getOrCreateUpload).not.toHaveBeenCalled()
  })

  it("allows a primary video larger than the image limit", async () => {
    vi.mocked(getOwnedJob).mockResolvedValue({ ...baseJob, kind: "video" })
    vi.mocked(signPutUrl).mockResolvedValue({
      url: "https://r2.example/upload",
      requiredHeaders: { "Content-Type": "video/mp4" },
    })

    const response = await POST(request({
      asset_type: "video",
      content_type: "video/mp4",
      size_bytes: 25 * 1024 * 1024 + 1,
      filename: "clip.mp4",
    }))
    expect(response.status).toBe(200)
    expect(getOrCreateUpload).toHaveBeenCalledOnce()
  })
})
