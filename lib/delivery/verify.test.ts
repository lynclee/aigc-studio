import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/r2", () => ({
  getR2Env: vi.fn(() => ({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" })),
  headObject: vi.fn(),
  copyObject: vi.fn(),
}))
vi.mock("@/lib/delivery/uploads", () => ({ getUpload: vi.fn() }))

import { copyObject, headObject } from "@/lib/r2"
import { getUpload } from "@/lib/delivery/uploads"
import { DeliveryVerifyError, verifyDeliveredAssets } from "@/lib/delivery/verify"
import type { AigcJobRecord } from "@/lib/aigc/types"

const job = { id: "job1", user_id: "u1", kind: "image" } as AigcJobRecord

function asset(over: Record<string, unknown> = {}) {
  return { asset_type: "image", position: 0, r2_key: "aigc/u1/job1/image-0.png", content_type: "image/png", size_bytes: 100, etag: '"e1"', ...over }
}

beforeEach(() => {
  vi.mocked(getUpload).mockReset()
  vi.mocked(headObject).mockReset()
  vi.mocked(copyObject).mockReset()
  vi.mocked(getUpload).mockResolvedValue({ r2_key: "aigc/u1/job1/image-0.png", content_type: "image/png" } as never)
  vi.mocked(headObject).mockResolvedValue({ size: 100, etag: '"e1"', contentType: "image/png" })
  vi.mocked(copyObject).mockResolvedValue({ etag: '"e1"' })
})

describe("verifyDeliveredAssets", () => {
  it("happy path: verifies then copies staging→final", async () => {
    const r = await verifyDeliveredAssets(job, [asset()])
    expect(r).toHaveLength(1)
    expect(r[0].output.r2Key).toBe("aigc/u1/job1/image-0.png")
    expect(copyObject).toHaveBeenCalledOnce()
  })

  it("rejects ETag mismatch and does not copy", async () => {
    vi.mocked(headObject).mockResolvedValue({ size: 100, etag: '"e2"', contentType: "image/png" })
    await expect(verifyDeliveredAssets(job, [asset()])).rejects.toThrow(DeliveryVerifyError)
    expect(copyObject).not.toHaveBeenCalled()
  })

  it("rejects size mismatch", async () => {
    vi.mocked(headObject).mockResolvedValue({ size: 999, etag: '"e1"', contentType: "image/png" })
    await expect(verifyDeliveredAssets(job, [asset()])).rejects.toThrow(/asset_size_mismatch/)
  })

  it("requires etag and size in manifest (H2)", async () => {
    await expect(verifyDeliveredAssets(job, [asset({ etag: undefined })])).rejects.toThrow(/etag_required/)
    await expect(verifyDeliveredAssets(job, [asset({ size_bytes: undefined })])).rejects.toThrow(/size_required/)
  })

  it("rejects asset_type not allowed for kind (H5)", async () => {
    await expect(verifyDeliveredAssets(job, [asset({ asset_type: "video" })])).rejects.toThrow(/asset_type_not_allowed/)
  })

  it("rejects duplicate (asset_type, position)", async () => {
    await expect(verifyDeliveredAssets(job, [asset(), asset()])).rejects.toThrow(/duplicate_asset/)
  })

  it("rejects when asset was never intaked", async () => {
    vi.mocked(getUpload).mockResolvedValue(null)
    await expect(verifyDeliveredAssets(job, [asset()])).rejects.toThrow(/asset_not_intaked/)
  })

  it("rejects when staging object is missing", async () => {
    vi.mocked(headObject).mockResolvedValue(null)
    await expect(verifyDeliveredAssets(job, [asset()])).rejects.toThrow(/asset_not_found/)
  })

  it("rejects manifest with only preview, no primary (M5)", async () => {
    vi.mocked(getUpload).mockResolvedValue({ r2_key: "aigc/u1/job1/preview-0.png", content_type: "image/png" } as never)
    await expect(
      verifyDeliveredAssets(job, [asset({ asset_type: "preview", r2_key: "aigc/u1/job1/preview-0.png" })]),
    ).rejects.toThrow(/no_primary_asset/)
  })

  it("two-phase: no copy at all if any asset fails verification (M8)", async () => {
    vi.mocked(getUpload)
      .mockResolvedValueOnce({ r2_key: "aigc/u1/job1/image-0.png", content_type: "image/png" } as never)
      .mockResolvedValueOnce({ r2_key: "aigc/u1/job1/image-1.png", content_type: "image/png" } as never)
    vi.mocked(headObject)
      .mockResolvedValueOnce({ size: 100, etag: '"e1"', contentType: "image/png" })
      .mockResolvedValueOnce({ size: 100, etag: '"WRONG"', contentType: "image/png" })
    await expect(
      verifyDeliveredAssets(job, [asset(), asset({ position: 1, r2_key: "aigc/u1/job1/image-1.png" })]),
    ).rejects.toThrow(DeliveryVerifyError)
    expect(copyObject).not.toHaveBeenCalled()
  })
})
