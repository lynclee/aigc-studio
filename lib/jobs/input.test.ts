import { describe, expect, it } from "vitest"
import { JobInputError, sanitizeSubmitRequest } from "@/lib/jobs/input"
import type { AigcKind } from "@/lib/aigc/types"
import type { WorkflowProvider } from "@/lib/workflows/definitions"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const base = { prompt: "p", workflow: "standard" }

function pngDataUri(size: number): string {
  const bytes = Buffer.alloc(Math.max(size, 8))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

function sanitize(
  body: Record<string, unknown>,
  kind: AigcKind = "image",
  provider: WorkflowProvider = "modal-bridge",
) {
  return sanitizeSubmitRequest(body, kind, "u", provider)
}

function expectCode(run: () => unknown, code: string) {
  try {
    run()
    throw new Error("expected JobInputError")
  } catch (error) {
    expect(error).toBeInstanceOf(JobInputError)
    expect((error as JobInputError).code).toBe(code)
  }
}

describe("sanitizeSubmitRequest", () => {
  it("requires a non-empty, bounded prompt", () => {
    expect(() => sanitize({ workflow: "standard" })).toThrow(JobInputError)
    expect(() => sanitize({ prompt: "x".repeat(4001), workflow: "standard" })).toThrow(JobInputError)
  })

  it("enforces the workflow allowlist", () => {
    expect(() => sanitize({ prompt: "p", workflow: "evil" })).toThrow(JobInputError)
    expectCode(() => sanitize({ prompt: "p", workflow: "standard" }, "image", "fal-video"), "unsupported_workflow")
  })

  it("passes valid dimensions, rejects out-of-range", () => {
    const r = sanitize({ ...base, width: 1024, height: 768 })
    expect(r.input.width).toBe(1024)
    expect(r.input.height).toBe(768)
    expect(() => sanitize({ ...base, width: 99999 })).toThrow(JobInputError)
    expect(() => sanitize({ ...base, width: 10 })).toThrow(JobInputError)
    expect(() => sanitize({ ...base, width: "1e9" })).toThrow(JobInputError)
  })

  it("rejects extreme / zero aspect ratios, accepts sane ones", () => {
    expect(() => sanitize({ ...base, aspectRatio: "99:1" })).toThrow(JobInputError)
    expect(() => sanitize({ ...base, aspectRatio: "0:0" })).toThrow(JobInputError)
    expect(sanitize({ ...base, aspectRatio: "16:9" }).input.aspectRatio).toBe("16:9")
    expect(sanitize({ ...base, aspectRatio: "square" }).input.aspectRatio).toBe("square")
  })

  it("validates seed range", () => {
    expect(() => sanitize({ ...base, seed: -1 })).toThrow(JobInputError)
    expect(sanitize({ ...base, seed: 42 }).input.seed).toBe(42)
  })

  it("rejects parameters that are absent from the selected workflow schema", () => {
    expectCode(() => sanitize({ ...base, width: 1024 }, "video"), "unsupported_workflow_parameter")
    expectCode(() => sanitize({ ...base, aspectRatio: "16:9" }, "model3d"), "unsupported_workflow_parameter")
    expect(sanitize({ ...base, seed: 42 }, "video").input.seed).toBe(42)
    for (const provider of ["fal-image", "openrouter-image"] as const) {
      expectCode(() => sanitize({ ...base, width: 1024 }, "image", provider), "unsupported_workflow_parameter")
      expectCode(() => sanitize({ ...base, aspectRatio: "16:9" }, "image", provider), "unsupported_workflow_parameter")
      expectCode(() => sanitize({ ...base, seed: 42 }, "image", provider), "unsupported_workflow_parameter")
    }
  })

  it("accepts base64 reference images, rejects URLs and control chars", () => {
    const r = sanitize({ ...base, images: [PNG] })
    expect(Array.isArray(r.input.images)).toBe(true)
    expect(() => sanitize({ ...base, images: ["https://evil.example/x.png"] })).toThrow(JobInputError)
    // 错误 MIME(非 image)拒绝;含内部非法字符的 data-uri 拒绝。
    expect(() => sanitize({ ...base, images: ["data:text/html;base64,aGVsbG8="] })).toThrow(JobInputError)
    expect(() => sanitize({ ...base, images: ["data:image/png;base64,not valid!!"] })).toThrow(JobInputError)
    expect(() => sanitize({ ...base, images: ["data:image/png;base64,A"] })).toThrow(JobInputError)
    expectCode(
      () => sanitize({ ...base, images: [PNG.replace("image/png", "image/jpeg")] }),
      "reference_image_type_mismatch",
    )
  })

  it("enforces reference capability by workflow and provider", () => {
    expectCode(() => sanitize({ ...base, images: [PNG] }, "video", "fal-video"), "reference_images_not_supported")
    expectCode(() => sanitize({ ...base, images: [PNG, PNG] }, "video"), "invalid_reference_image_count")
    expect(sanitize({ ...base, images: [PNG, PNG, PNG, PNG] }, "video").input.images).toHaveLength(4)
    expectCode(() => sanitize({ ...base, images: [PNG, PNG, PNG, PNG] }, "model3d"), "too_many_reference_images")
    expect(sanitize({ ...base, images: [PNG, PNG, PNG] }, "model3d").input.images).toHaveLength(3)
    expect(sanitize({ ...base, images: [PNG, PNG, PNG, PNG] }, "model3d", "fal-model3d").input.images).toHaveLength(4)
  })

  it("rejects an aggregate inline-image payload that cannot fit the deployment request boundary", () => {
    const large = pngDataUri(1_700_000) // individually valid, two copies exceed the 3MiB total.
    expectCode(
      () => sanitize({ ...base, images: [large, large, PNG, PNG] }, "video"),
      "reference_images_total_too_large",
    )
  })

  it("sanitizes and de-dups reference filenames (no `..` / leading dot)", () => {
    const r = sanitize(
      { ...base, images: [{ name: "../etc", image: PNG }, { name: "../etc", image: PNG }] },
      "model3d",
      "fal-model3d",
    )
    const imgs = r.input.images as { name: string }[]
    expect(imgs[0].name).not.toContain("..")
    expect(imgs[0].name.startsWith(".")).toBe(false)
    expect(imgs[0].name).not.toBe(imgs[1].name)
  })

  it("omits absent fields (downstream defaults apply)", () => {
    const r = sanitize(base)
    expect(r.input.width).toBeUndefined()
    expect(r.input.seed).toBeUndefined()
    expect(r.input.images).toBeUndefined()
    expect(r.input.workflow).toBe("standard")
  })
})
