import type { AigcKind, SubmitRequest } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import { referenceCapabilityFor, type WorkflowProvider } from "@/lib/workflows/capabilities"

export class JobInputError extends Error {
  readonly status = 400
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.code = code
  }
}

const ALLOWED_WORKFLOWS: Record<AigcKind, readonly string[]> = {
  image: ["standard", "detail"],
  model3d: ["standard", "game-asset"],
  video: ["standard"],
}

const DIMENSION_MIN = 64
const DIMENSION_MAX = 4096
const SEED_MAX = 0x100000000 // 2^32,与 lib/workflows/image-registry.ts 一致
const ASPECT_KEYWORDS = new Set(["square", "portrait", "landscape", "wide"])
const ASPECT_RATIO_RE = /^\d{1,2}:\d{1,2}$/
const MAX_ASPECT_RATIO = 4 // 拒绝极端长宽比(如 99:1),避免绕过尺寸上限放大显存;关键字都在此界内
const MAX_REFERENCE_IMAGE_BYTES = 3 * 1024 * 1024
// Vercel 请求体约 4.5MB；data-uri base64 还会膨胀约 33%。先把原始图片合计压在 3MiB 内，
// 为 JSON/prompt 留余量。正式方案是输入图先直传 R2 staging，任务只携带短期资产引用。
export const MAX_REFERENCE_TOTAL_BYTES = 3 * 1024 * 1024
// 只接受 base64 data-uri:杜绝 SSRF(输入 URL 被 provider 拉取的风险),且匹配 Bridge 的 base64 预期。
const REFERENCE_DATA_URI_RE =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/

export function sanitizeSubmitRequest(
  body: Record<string, unknown>,
  kind: AigcKind,
  userId: string,
  provider: WorkflowProvider,
): SubmitRequest {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (prompt.length < 1) throw new JobInputError("prompt_required")
  if (prompt.length > 4000) throw new JobInputError("prompt_too_long")

  const workflow = typeof body.workflow === "string" ? body.workflow.trim() : "standard"
  if (!ALLOWED_WORKFLOWS[kind].includes(workflow)) {
    throw new JobInputError("unsupported_workflow", `${kind} accepts ${ALLOWED_WORKFLOWS[kind].join(", ")}`)
  }

  // 透传经校验的生成参数;缺省则不设(下游按各自默认处理)。之前这里只留 { workflow },
  // 把 UI/API 传来的尺寸/宽高比/seed/参考图全丢了,自定义尺寸与图生图走不通。
  const input: Record<string, unknown> = { workflow }
  const width = optionalDimension(body.width, "width")
  const height = optionalDimension(body.height, "height")
  if (width !== undefined) input.width = width
  if (height !== undefined) input.height = height
  const aspectRatio = optionalAspectRatio(body)
  if (aspectRatio !== undefined) input.aspectRatio = aspectRatio
  const seed = optionalSeed(body.seed)
  if (seed !== undefined) input.seed = seed
  const images = optionalReferenceImages(body, kind, workflow, provider)
  if (images !== undefined) input.images = images

  return {
    prompt,
    workflowId: workflow,
    input,
    userId,
  }
}

function optionalDimension(value: unknown, label: "width" | "height"): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isInteger(n) || n < DIMENSION_MIN || n > DIMENSION_MAX) {
    throw new JobInputError(`invalid_${label}`)
  }
  return n
}

function optionalAspectRatio(body: Record<string, unknown>): string | undefined {
  const raw = firstNonEmptyString(body.aspectRatio, body.aspect_ratio, body.ratio)
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (ASPECT_KEYWORDS.has(value)) return value
  if (!ASPECT_RATIO_RE.test(value)) throw new JobInputError("invalid_aspect_ratio")
  const [rw, rh] = value.split(":").map(Number)
  if (!rw || !rh || Math.max(rw, rh) / Math.min(rw, rh) > MAX_ASPECT_RATIO) {
    throw new JobInputError("invalid_aspect_ratio")
  }
  return value
}

function optionalSeed(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 0 || n >= SEED_MAX) throw new JobInputError("invalid_seed")
  return n
}

function optionalReferenceImages(
  body: Record<string, unknown>,
  kind: AigcKind,
  workflowId: string,
  provider: WorkflowProvider,
): { name: string; image: string }[] | undefined {
  const raw = body.images ?? body.image
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return undefined
  const capability = referenceCapabilityFor(kind, workflowId, provider)
  if (!capability.enabled) throw new JobInputError("reference_images_not_supported")
  if (list.length > capability.maxImages) throw new JobInputError("too_many_reference_images")
  if (list.length < capability.minImages) throw new JobInputError("invalid_reference_image_count")
  const seen = new Set<string>()
  let totalBytes = 0
  return list.map((item, index) => {
    const sanitized = sanitizeReferenceImage(item, index, seen)
    totalBytes += sanitized.decodedBytes
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) throw new JobInputError("reference_images_total_too_large")
    return { name: sanitized.name, image: sanitized.image }
  })
}

function sanitizeReferenceImage(
  item: unknown,
  index: number,
  seen: Set<string>,
): { name: string; image: string; decodedBytes: number } {
  const image = typeof item === "string" ? item : isRecord(item) && typeof item.image === "string" ? item.image : ""
  const trimmed = image.trim()
  if (!REFERENCE_DATA_URI_RE.test(trimmed)) throw new JobInputError("invalid_reference_image")
  const base64 = trimmed.slice(trimmed.indexOf(",") + 1)
  const decodedBytes = decodedBase64Size(base64)
  if (decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
    throw new JobInputError("reference_image_too_large")
  }
  return { name: uniqueReferenceName(item, index, seen), image: trimmed, decodedBytes }
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

// 文件名会作为上传名传给 Bridge → ComfyUI。剥掉前导点、拒 `.`/`..`(防路径/隐藏文件),并保证唯一
// (重名会让下游按 name 归档时相互覆盖)。
function uniqueReferenceName(item: unknown, index: number, seen: Set<string>): string {
  const rawName = isRecord(item) && typeof item.name === "string" ? item.name : ""
  let base = rawName.replace(/[^\w.\-]/g, "_").replace(/^\.+/, "").slice(0, 64)
  if (!base) base = `image${index + 1}`
  let name = base
  let suffix = 1
  while (seen.has(name)) name = `${base}_${suffix++}`
  seen.add(name)
  return name
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}
