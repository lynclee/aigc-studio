import { describe, expect, it } from "vitest"
import {
  providerAssetCategoryForWorkflow,
  providerAssetKey,
} from "@/lib/assets/r2-store"
import {
  isAllowedContentType,
  maxBytesForCategory,
} from "@/lib/delivery/asset-policy"

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

describe("provider asset workflow policy", () => {
  it.each([
    ["video", "standard"],
    ["model3d", "standard"],
    ["model3d", "game-asset"],
  ] as const)("classifies %s/%s previews as images", (kind, workflowId) => {
    const category = providerAssetCategoryForWorkflow(kind, workflowId, "preview")

    expect(category).toBe("image")
    expect(isAllowedContentType(category, "image/png")).toBe(true)
    expect(isAllowedContentType(category, "video/mp4")).toBe(false)
    expect(maxBytesForCategory(category)).toBe(25 * 1024 * 1024)
  })

  it("keeps primary assets on their workflow-declared policies", () => {
    expect(providerAssetCategoryForWorkflow("video", "standard", "video")).toBe("video")
    expect(providerAssetCategoryForWorkflow("model3d", "standard", "model")).toBe("model")
    expect(providerAssetCategoryForWorkflow("model3d", "standard", "model3d")).toBe("model")
  })

  it("rejects provider asset types outside the workflow output contract", () => {
    expect(() => providerAssetCategoryForWorkflow("video", "standard", "image")).toThrow(
      "Provider asset type is not allowed for workflow video/standard: image",
    )
    expect(() => providerAssetCategoryForWorkflow("image", "missing", "image")).toThrow(
      "Provider asset type is not allowed for workflow image/missing: image",
    )
  })
})
