import { describe, expect, it } from "vitest"
import { referenceCapabilityFor } from "@/lib/workflows/capabilities"

describe("workflow reference capabilities", () => {
  it("does not expose reference inputs that the selected provider ignores", () => {
    expect(referenceCapabilityFor("video", "standard", "fal-video").enabled).toBe(false)
    expect(referenceCapabilityFor("image", "standard", "fal-image").enabled).toBe(false)
    expect(referenceCapabilityFor("image", "standard", "openrouter-image").enabled).toBe(false)
    expect(referenceCapabilityFor("image", "standard", "comfyui-image").enabled).toBe(false)
  })

  it("keeps unverified Modal API-node cardinalities fixed to full exported graphs", () => {
    expect(referenceCapabilityFor("video", "standard", "modal-bridge")).toMatchObject({
      enabled: true,
      minImages: 4,
      maxImages: 4,
    })
    expect(referenceCapabilityFor("model3d", "standard", "modal-bridge")).toMatchObject({
      enabled: true,
      minImages: 3,
      maxImages: 3,
    })
  })

  it("preserves fal model3d's existing fourth-view capability", () => {
    expect(referenceCapabilityFor("model3d", "game-asset", "fal-model3d")).toMatchObject({
      enabled: true,
      minImages: 1,
      maxImages: 4,
    })
  })

  it("advertises one image only for the renderers that consume only the first reference", () => {
    expect(referenceCapabilityFor("image", "standard", "modal-image").maxImages).toBe(1)
    expect(referenceCapabilityFor("image", "standard", "modal-bridge").maxImages).toBe(1)
    expect(referenceCapabilityFor("image", "detail", "modal-bridge").enabled).toBe(false)
  })
})
