import { describe, expect, it } from "vitest"
import {
  extForAsset,
  isAllowedAssetType,
  isAllowedContentType,
  normalizeEtag,
  parsePosition,
  parseSize,
  stagingKeyForFinal,
} from "@/lib/delivery/asset-policy"

describe("asset-policy", () => {
  it("content-type allowlist per category", () => {
    expect(isAllowedContentType("image", "image/png")).toBe(true)
    expect(isAllowedContentType("image", "video/mp4")).toBe(false)
    expect(isAllowedContentType("video", "video/x-matroska")).toBe(true)
    expect(isAllowedContentType("model", "model/gltf-binary")).toBe(true)
    expect(isAllowedContentType("model", "model/obj")).toBe(true)
    expect(isAllowedContentType("model", "image/png")).toBe(false)
  })

  it("asset_type is bound to kind (H5)", () => {
    expect(isAllowedAssetType("image", "image")).toBe(true)
    expect(isAllowedAssetType("image", "video")).toBe(false)
    expect(isAllowedAssetType("video", "video")).toBe(true)
    expect(isAllowedAssetType("model3d", "model3d")).toBe(true)
    expect(isAllowedAssetType("image", "whatever")).toBe(false)
  })

  it("keeps real ext for octet-stream via filename (M8)", () => {
    expect(extForAsset("image", "image/png")).toBe("png")
    expect(extForAsset("model", "model/gltf-binary")).toBe("glb")
    expect(extForAsset("model", "application/octet-stream", "mesh.fbx")).toBe("fbx")
    expect(extForAsset("model", "application/octet-stream", "x.exe")).toBe("bin")
    expect(extForAsset("model", "application/octet-stream", null)).toBe("bin")
  })

  it("derives staging key from final key", () => {
    expect(stagingKeyForFinal("aigc/u/j/image-0.png")).toBe("aigc/u/j/.staging/image-0.png")
  })

  it("normalizes ETag (strips quotes + weak prefix)", () => {
    expect(normalizeEtag('"abc"')).toBe("abc")
    expect(normalizeEtag('W/"abc"')).toBe("abc")
    expect(normalizeEtag("abc")).toBe("abc")
    expect(normalizeEtag(null)).toBe(null)
    expect(normalizeEtag(123)).toBe(null)
  })

  it("bounds position and size", () => {
    expect(parsePosition(0)).toBe(0)
    expect(parsePosition(999)).toBe(999)
    expect(parsePosition(1000)).toBe(null)
    expect(parsePosition(-1)).toBe(null)
    expect(parseSize(100)).toBe(100)
    expect(parseSize(0)).toBe(null)
    expect(parseSize(-5)).toBe(null)
  })
})
