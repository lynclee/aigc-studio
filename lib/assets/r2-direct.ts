import { PutObjectCommand } from "@aws-sdk/client-s3"
import type { ProviderOutputAsset } from "@/lib/aigc/types"
import { getR2Client } from "@/lib/r2"

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024

export async function storeImageBytesInR2(params: {
  userId: string
  providerJobId: string
  position: number
  bytes: Uint8Array
  contentType: string
  metadata?: Record<string, unknown>
}): Promise<ProviderOutputAsset> {
  const normalizedContentType = params.contentType.toLowerCase()
  if (!isSupportedImageContentType(normalizedContentType)) {
    throw new Error(`Unsupported image content type '${params.contentType}'`)
  }
  if (params.bytes.length === 0 || params.bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error("Image output exceeded the supported file-size limit")
  }

  const r2 = getR2Client()
  if (!r2) throw new Error("R2 asset persistence is required but R2 is not configured")

  const key = `${safeR2Segment(params.userId)}/${safeR2Segment(params.providerJobId)}/image-${params.position}.${extensionForContentType(normalizedContentType)}`
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: params.bytes,
      ContentLength: params.bytes.length,
      ContentType: normalizedContentType,
    }),
  )

  return {
    assetType: "image",
    position: params.position,
    r2Key: key,
    contentType: normalizedContentType,
    metadata: params.metadata,
  }
}

export function isSupportedImageContentType(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXT_BY_CONTENT_TYPE, value.toLowerCase())
}

function extensionForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType] ?? "png"
}

function safeR2Segment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || "item"
}
