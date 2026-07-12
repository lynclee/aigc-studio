import { describe, expect, it } from "vitest"
import { flattenLibraryItem } from "@/app/api/library/route"

function generation(kind: "image" | "video" | "model3d", assets: Record<string, unknown>[]) {
  return {
    id: "generation-1",
    kind,
    workflow_id: "standard",
    prompt: "asset",
    created_at: "2026-07-12T00:00:00.000Z",
    assets,
  }
}

describe("library item output selection", () => {
  it("uses preview as a video thumbnail without falling back to the video URL", () => {
    const item = flattenLibraryItem(generation("video", [
      { asset_type: "video", url: "https://cdn.example/video.mp4" },
      { asset_type: "preview", url: "https://cdn.example/preview.png" },
    ]))
    expect(item.videoUrl).toBe("https://cdn.example/video.mp4")
    expect(item.thumbnailUrl).toBe("https://cdn.example/preview.png")
  })

  it("recognizes both model primary aliases and does not use a GLB as an image thumbnail", () => {
    for (const assetType of ["model", "model3d"]) {
      const item = flattenLibraryItem(generation("model3d", [
        { asset_type: assetType, url: "https://cdn.example/model.glb" },
      ]))
      expect(item.downloadUrl).toBe("https://cdn.example/model.glb")
      expect(item.thumbnailUrl).toBeUndefined()
    }
  })
})
