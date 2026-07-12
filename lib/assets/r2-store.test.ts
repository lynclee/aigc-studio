import { describe, expect, it } from "vitest"
import { providerAssetKey } from "@/lib/assets/r2-store"

describe("provider asset keys", () => {
  it("versions URL-provider objects by reconcile token", () => {
    const common = { userId: "u", jobId: "j", assetType: "image", position: 0, ext: "png" }
    const first = providerAssetKey({ ...common, keyVersion: "claim-a" })
    const second = providerAssetKey({ ...common, keyVersion: "claim-b" })

    expect(first).toBe("u/j/image-0-claim-a.png")
    expect(second).toBe("u/j/image-0-claim-b.png")
    expect(first).not.toBe(second)
  })

  it("sanitizes a version before placing it in an R2 key", () => {
    expect(providerAssetKey({
      userId: "u", jobId: "j", assetType: "video", position: 1, ext: "mp4", keyVersion: "../claim token",
    })).toBe("u/j/video-1-claimtoken.mp4")
  })
})
