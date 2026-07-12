import { describe, expect, it } from "vitest"
import { JobInputError, sanitizeSubmitRequest } from "@/lib/jobs/input"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const base = { prompt: "p", workflow: "standard" }

describe("sanitizeSubmitRequest", () => {
  it("requires a non-empty, bounded prompt", () => {
    expect(() => sanitizeSubmitRequest({ workflow: "standard" }, "image", "u")).toThrow(JobInputError)
    expect(() => sanitizeSubmitRequest({ prompt: "x".repeat(4001), workflow: "standard" }, "image", "u")).toThrow(JobInputError)
  })

  it("enforces the workflow allowlist", () => {
    expect(() => sanitizeSubmitRequest({ prompt: "p", workflow: "evil" }, "image", "u")).toThrow(JobInputError)
  })

  it("passes valid dimensions, rejects out-of-range", () => {
    const r = sanitizeSubmitRequest({ ...base, width: 1024, height: 768 }, "image", "u")
    expect(r.input.width).toBe(1024)
    expect(r.input.height).toBe(768)
    expect(() => sanitizeSubmitRequest({ ...base, width: 99999 }, "image", "u")).toThrow(JobInputError)
    expect(() => sanitizeSubmitRequest({ ...base, width: 10 }, "image", "u")).toThrow(JobInputError)
    expect(() => sanitizeSubmitRequest({ ...base, width: "1e9" }, "image", "u")).toThrow(JobInputError)
  })

  it("rejects extreme / zero aspect ratios, accepts sane ones", () => {
    expect(() => sanitizeSubmitRequest({ ...base, aspectRatio: "99:1" }, "image", "u")).toThrow(JobInputError)
    expect(() => sanitizeSubmitRequest({ ...base, aspectRatio: "0:0" }, "image", "u")).toThrow(JobInputError)
    expect(sanitizeSubmitRequest({ ...base, aspectRatio: "16:9" }, "image", "u").input.aspectRatio).toBe("16:9")
    expect(sanitizeSubmitRequest({ ...base, aspectRatio: "square" }, "image", "u").input.aspectRatio).toBe("square")
  })

  it("validates seed range", () => {
    expect(() => sanitizeSubmitRequest({ ...base, seed: -1 }, "image", "u")).toThrow(JobInputError)
    expect(sanitizeSubmitRequest({ ...base, seed: 42 }, "image", "u").input.seed).toBe(42)
  })

  it("accepts base64 reference images, rejects URLs and control chars", () => {
    const r = sanitizeSubmitRequest({ ...base, images: [PNG] }, "image", "u")
    expect(Array.isArray(r.input.images)).toBe(true)
    expect(() => sanitizeSubmitRequest({ ...base, images: ["https://evil.example/x.png"] }, "image", "u")).toThrow(JobInputError)
    // 错误 MIME(非 image)拒绝;含内部非法字符的 data-uri 拒绝。
    expect(() => sanitizeSubmitRequest({ ...base, images: ["data:text/html;base64,aGVsbG8="] }, "image", "u")).toThrow(JobInputError)
    expect(() => sanitizeSubmitRequest({ ...base, images: ["data:image/png;base64,not valid!!"] }, "image", "u")).toThrow(JobInputError)
  })

  it("caps reference image count", () => {
    expect(() => sanitizeSubmitRequest({ ...base, images: [PNG, PNG, PNG, PNG, PNG] }, "image", "u")).toThrow(JobInputError)
  })

  it("sanitizes and de-dups reference filenames (no `..` / leading dot)", () => {
    const r = sanitizeSubmitRequest(
      { ...base, images: [{ name: "../etc", image: PNG }, { name: "../etc", image: PNG }] },
      "image",
      "u",
    )
    const imgs = r.input.images as { name: string }[]
    expect(imgs[0].name).not.toContain("..")
    expect(imgs[0].name.startsWith(".")).toBe(false)
    expect(imgs[0].name).not.toBe(imgs[1].name)
  })

  it("omits absent fields (downstream defaults apply)", () => {
    const r = sanitizeSubmitRequest(base, "image", "u")
    expect(r.input.width).toBeUndefined()
    expect(r.input.seed).toBeUndefined()
    expect(r.input.images).toBeUndefined()
    expect(r.input.workflow).toBe("standard")
  })
})
