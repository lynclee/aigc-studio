/**
 * aigc-r2 交付的资产策略：类别 / 大小上限 / content-type 白名单 / 扩展名。
 * 与 lib/assets/r2-store.ts 的下载侧约束保持一致，供内部 endpoint 校验 Bridge 上报值。
 */

import type { AigcKind } from "@/lib/aigc/types"

export type AssetCategory = "image" | "video" | "model" | "output"

const MAX_BYTES: Record<AssetCategory, number> = {
  image: 25 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
  model: 512 * 1024 * 1024,
  output: 25 * 1024 * 1024,
}

// 与 comfyui_modal_bridge 的 classify_asset_type / detect_content_type 产出对齐:
// 视频含 mkv/avi/flv/m4v 容器,3D 含 obj/stl 及 octet-stream(fbx/ply/splat/spz/ksplat)。
const ALLOWED_CONTENT_TYPES: Record<AssetCategory, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/apng"],
  video: [
    "video/mp4", "video/webm", "video/quicktime",
    "video/x-matroska", "video/x-msvideo", "video/x-flv", "video/x-m4v",
  ],
  model: [
    "model/gltf-binary", "model/gltf+json", "model/obj", "model/stl", "application/octet-stream",
  ],
  output: ["application/octet-stream"],
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/apng": "apng",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "video/x-flv": "flv",
  "video/x-m4v": "m4v",
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "model/obj": "obj",
  "model/stl": "stl",
  "application/octet-stream": "bin",
}

const ASSET_TYPE_RE = /^[a-z0-9_-]{1,32}$/

// asset_type 按 job.kind 白名单(H5):不再接受任意串,防 namespace 乱扩、语义错乱。
const ALLOWED_ASSET_TYPES: Record<AigcKind, string[]> = {
  image: ["image", "preview"],
  video: ["video", "preview"],
  model3d: ["model3d", "model", "preview"],
}

// octet-stream 的合法扩展名(按类别),用于从 filename 保真扩展名而不是一律 .bin(M8)。
const OCTET_STREAM_EXTS: Record<AssetCategory, string[]> = {
  image: [],
  video: [],
  model: ["fbx", "ply", "splat", "spz", "ksplat"],
  output: ["bin"],
}

export function isAllowedAssetType(kind: AigcKind, assetType: string): boolean {
  return (ALLOWED_ASSET_TYPES[kind] ?? []).includes(assetType)
}

export function categoryForKind(kind: AigcKind): AssetCategory {
  if (kind === "image") return "image"
  if (kind === "video") return "video"
  if (kind === "model3d") return "model"
  return "output"
}

export function maxBytesForCategory(category: AssetCategory): number {
  return MAX_BYTES[category]
}

export function normalizeContentType(value: string | null | undefined): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null
}

export function isAllowedContentType(category: AssetCategory, contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES[category].includes(contentType)
}

export function extForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType] ?? "bin"
}

/** 优先按 content-type 定扩展名;若落到 octet-stream(bin),再看 filename 的合法扩展名保真(M8)。 */
export function extForAsset(category: AssetCategory, contentType: string, filename?: string | null): string {
  const byType = extForContentType(contentType)
  if (byType !== "bin") return byType
  const fromName = (filename ?? "").split(".").pop()?.toLowerCase() ?? ""
  if (/^[a-z0-9]{1,8}$/.test(fromName) && (OCTET_STREAM_EXTS[category] ?? []).includes(fromName)) return fromName
  return "bin"
}

/** staging key(Bridge 上传目标)↔ final key(服务端 Copy 目标,不可覆写)。 */
export function stagingKeyForFinal(finalKey: string): string {
  const idx = finalKey.lastIndexOf("/")
  if (idx < 0) return `.staging/${finalKey}`
  return `${finalKey.slice(0, idx)}/.staging/${finalKey.slice(idx + 1)}`
}

/** 归一 ETag:剥 `W/` 弱标记与首尾引号,便于严格比对(H2)。 */
export function normalizeEtag(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").replace(/^"|"$/g, "")
  return trimmed || null
}

export function isValidAssetType(value: unknown): value is string {
  return typeof value === "string" && ASSET_TYPE_RE.test(value)
}

/** 解析 position：整数 0..999，否则 null。 */
export function parsePosition(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 0 || n >= 1000) return null
  return n
}

/** 解析 size_bytes：正安全整数，否则 null。 */
export function parseSize(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}
