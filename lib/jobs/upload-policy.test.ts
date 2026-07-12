import { describe, expect, it } from "vitest"
import {
  detectReferenceImageContentType,
  inspectInlineImageDataUri,
} from "@/lib/jobs/upload-policy"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF87 = Buffer.from("GIF87a", "ascii")
const GIF89 = Buffer.from("GIF89a", "ascii")
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")])

function uri(contentType: string, bytes: Buffer): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`
}

describe("reference image upload policy", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/jpg", JPEG],
    ["image/gif", GIF87],
    ["image/gif", GIF89],
    ["image/webp", WEBP],
  ])("accepts a real %s signature", (contentType, bytes) => {
    expect(inspectInlineImageDataUri(uri(contentType, bytes))).toMatchObject({
      ok: true,
      value: { decodedBytes: bytes.length },
    })
  })

  it("rejects a declared MIME that does not match the decoded file", () => {
    expect(inspectInlineImageDataUri(uri("image/jpeg", PNG))).toEqual({
      ok: false,
      code: "reference_image_type_mismatch",
    })
  })

  it.each([
    "data:image/png;base64,A",
    "data:image/png;base64,AB==",
    "data:image/png;base64,AAAA",
    "data:text/html;base64,PGgxPng8L2gxPg==",
    "https://example.com/image.png",
  ])("rejects malformed or unsupported input: %s", (value) => {
    expect(inspectInlineImageDataUri(value).ok).toBe(false)
  })

  it("sniffs signatures independently of the data-uri parser", () => {
    expect(detectReferenceImageContentType(PNG)).toBe("image/png")
    expect(detectReferenceImageContentType(JPEG)).toBe("image/jpeg")
    expect(detectReferenceImageContentType(GIF89)).toBe("image/gif")
    expect(detectReferenceImageContentType(WEBP)).toBe("image/webp")
    expect(detectReferenceImageContentType(Buffer.from("not an image"))).toBeNull()
  })
})
