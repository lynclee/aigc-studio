import { describe, expect, it } from "vitest"
import {
  providerAssetCategoryForContract,
  providerAssetKey,
} from "@/lib/assets/r2-store"
import {
  isAllowedContentType,
  maxBytesForCategory,
} from "@/lib/delivery/asset-policy"
import { workflowDefinition } from "@/lib/workflows/definitions"

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
    const category = providerAssetCategoryForContract(
      workflowDefinition(kind, workflowId)?.outputContract ?? [],
      "preview",
    )

    expect(category).toBe("image")
    expect(isAllowedContentType(category, "image/png")).toBe(true)
    expect(isAllowedContentType(category, "video/mp4")).toBe(false)
    expect(maxBytesForCategory(category)).toBe(25 * 1024 * 1024)
  })

  it("keeps primary assets on their workflow-declared policies", () => {
    const video = workflowDefinition("video", "standard")?.outputContract ?? []
    const model = workflowDefinition("model3d", "standard")?.outputContract ?? []
    expect(providerAssetCategoryForContract(video, "video")).toBe("video")
    expect(providerAssetCategoryForContract(model, "model")).toBe("model")
    expect(providerAssetCategoryForContract(model, "model3d")).toBe("model")
  })

  it("rejects provider asset types outside the workflow output contract", () => {
    const video = workflowDefinition("video", "standard")?.outputContract ?? []
    expect(() => providerAssetCategoryForContract(video, "image")).toThrow(/pinned workflow contract/)
    expect(() => providerAssetCategoryForContract([], "image")).toThrow(/pinned workflow contract/)
  })

  it("classifies retired outputs from an explicit pinned contract", () => {
    expect(providerAssetCategoryForContract([
      { assetType: "legacy-render", category: "image", required: true, primary: true },
    ], "legacy-render")).toBe("image")
    expect(() => providerAssetCategoryForContract([], "legacy-render")).toThrow(/pinned workflow contract/)
  })
})
