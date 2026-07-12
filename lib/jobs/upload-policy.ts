export type SupportedReferenceImageContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"

export type InlineImageInspection = {
  contentType: SupportedReferenceImageContentType
  decodedBytes: number
}

export type InlineImagePreflight = InlineImageInspection & {
  base64: string
}

export type InlineImageInspectionResult =
  | { ok: true; value: InlineImageInspection }
  | { ok: false; code: "invalid_reference_image" | "reference_image_type_mismatch" }

export type InlineImagePreflightResult =
  | { ok: true; value: InlineImagePreflight }
  | { ok: false; code: "invalid_reference_image" }

const DATA_URI_RE =
  /^data:(image\/(?:png|jpe?g|webp|gif));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=))$/i

export function inspectInlineImageDataUri(value: string): InlineImageInspectionResult {
  const preflight = preflightInlineImageDataUri(value)
  if (!preflight.ok) return preflight
  return verifyInlineImagePreflight(preflight.value)
}

export function preflightInlineImageDataUri(value: string): InlineImagePreflightResult {
  const match = value.match(DATA_URI_RE)
  if (!match) return { ok: false, code: "invalid_reference_image" }

  const declared = normalizeReferenceImageContentType(match[1])
  if (!declared) return { ok: false, code: "invalid_reference_image" }

  const base64 = match[2]
  const decodedBytes = decodedBase64Size(base64)
  if (decodedBytes <= 0) return { ok: false, code: "invalid_reference_image" }
  return { ok: true, value: { contentType: declared, base64, decodedBytes } }
}

export function verifyInlineImagePreflight(preflight: InlineImagePreflight): InlineImageInspectionResult {
  const bytes = Buffer.from(preflight.base64, "base64")
  if (bytes.length !== preflight.decodedBytes || bytes.toString("base64") !== preflight.base64) {
    return { ok: false, code: "invalid_reference_image" }
  }
  const detected = detectReferenceImageContentType(bytes)
  if (!detected) return { ok: false, code: "invalid_reference_image" }
  if (detected !== preflight.contentType) return { ok: false, code: "reference_image_type_mismatch" }

  return { ok: true, value: { contentType: detected, decodedBytes: bytes.length } }
}

export function detectReferenceImageContentType(
  bytes: Uint8Array,
): SupportedReferenceImageContentType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (bytes.length >= 6) {
    const signature = ascii(bytes, 0, 6)
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif"
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp"
  }
  return null
}

function normalizeReferenceImageContentType(value: string): SupportedReferenceImageContentType | null {
  const normalized = value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase()
  if (
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp" ||
    normalized === "image/gif"
  ) return normalized
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end))
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}
