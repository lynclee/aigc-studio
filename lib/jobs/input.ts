import type { AigcKind, SubmitRequest } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import {
  listWorkflowDefinitions,
  workflowDefinition,
  workflowExecutionFor,
  workflowInputSchemaFor,
  type ReferenceCapability,
  type WorkflowInputSchema,
  type WorkflowProvider,
} from "@/lib/workflows/definitions"
import {
  preflightInlineImageDataUri,
  verifyInlineImagePreflight,
  type InlineImagePreflight,
} from "@/lib/jobs/upload-policy"

export class JobInputError extends Error {
  readonly status = 400
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.code = code
  }
}

const MAX_REFERENCE_IMAGE_BYTES = 3 * 1024 * 1024
// Vercel 请求体约 4.5MB；data-uri base64 还会膨胀约 33%。先把原始图片合计压在 3MiB 内，
// 为 JSON/prompt 留余量。正式方案是输入图先直传 R2 staging，任务只携带短期资产引用。
export const MAX_REFERENCE_TOTAL_BYTES = 3 * 1024 * 1024
export function sanitizeSubmitRequest(
  body: Record<string, unknown>,
  kind: AigcKind,
  userId: string,
  provider: WorkflowProvider,
): SubmitRequest {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  const configured = listWorkflowDefinitions(kind).filter((definition) => definition.executions[provider])
  const workflow = typeof body.workflow === "string" ? body.workflow.trim() : configured[0]?.id ?? ""
  const definition = workflowDefinition(kind, workflow)
  const execution = workflowExecutionFor(kind, workflow, provider)
  const inputSchema = workflowInputSchemaFor(kind, workflow, provider)
  if (!definition || !execution || !inputSchema) {
    throw new JobInputError("unsupported_workflow", `${kind} accepts ${configured.map((item) => item.id).join(", ")}`)
  }
  if (prompt.length < inputSchema.prompt.minLength) throw new JobInputError("prompt_required")
  if (prompt.length > inputSchema.prompt.maxLength) throw new JobInputError("prompt_too_long")

  // 透传经校验的生成参数;缺省则不设(下游按各自默认处理)。之前这里只留 { workflow },
  // 把 UI/API 传来的尺寸/宽高比/seed/参考图全丢了,自定义尺寸与图生图走不通。
  const input: Record<string, unknown> = { workflow }
  assertSupportedParameters(body, inputSchema)
  const width = inputSchema.dimensions
    ? optionalDimension(body.width, "width", inputSchema.dimensions)
    : undefined
  const height = inputSchema.dimensions
    ? optionalDimension(body.height, "height", inputSchema.dimensions)
    : undefined
  if (width !== undefined) input.width = width
  if (height !== undefined) input.height = height
  const aspectRatio = inputSchema.aspectRatio
    ? optionalAspectRatio(body, inputSchema.aspectRatio)
    : undefined
  if (aspectRatio !== undefined) input.aspectRatio = aspectRatio
  const seed = inputSchema.seed ? optionalSeed(body.seed, inputSchema.seed) : undefined
  if (seed !== undefined) input.seed = seed
  const images = optionalReferenceImages(body, execution.reference)
  if (images !== undefined) input.images = images

  return {
    prompt,
    workflowId: workflow,
    input,
    userId,
  }
}

function assertSupportedParameters(body: Record<string, unknown>, schema: WorkflowInputSchema): void {
  if (!schema.supportsDimensions && (hasValue(body.width) || hasValue(body.height))) {
    throw new JobInputError("unsupported_workflow_parameter", "workflow does not support dimensions")
  }
  if (
    !schema.supportsAspectRatio &&
    (hasValue(body.aspectRatio) || hasValue(body.aspect_ratio) || hasValue(body.ratio))
  ) {
    throw new JobInputError("unsupported_workflow_parameter", "workflow does not support aspect ratio")
  }
  if (!schema.supportsSeed && hasValue(body.seed)) {
    throw new JobInputError("unsupported_workflow_parameter", "workflow does not support seed")
  }
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  return value !== undefined && value !== null
}

function optionalDimension(
  value: unknown,
  label: "width" | "height",
  bounds: Readonly<{ min: number; max: number }>,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    throw new JobInputError(`invalid_${label}`)
  }
  return n
}

function optionalAspectRatio(
  body: Record<string, unknown>,
  rule: Readonly<{ keywords: readonly string[]; pattern: string; maxRatio: number }>,
): string | undefined {
  const raw = firstNonEmptyString(body.aspectRatio, body.aspect_ratio, body.ratio)
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (rule.keywords.includes(value)) return value
  if (!new RegExp(rule.pattern).test(value)) throw new JobInputError("invalid_aspect_ratio")
  const [rw, rh] = value.split(":").map(Number)
  if (!rw || !rh || Math.max(rw, rh) / Math.min(rw, rh) > rule.maxRatio) {
    throw new JobInputError("invalid_aspect_ratio")
  }
  return value
}

function optionalSeed(value: unknown, bounds: Readonly<{ min: number; maxExclusive: number }>): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isInteger(n) || n < bounds.min || n >= bounds.maxExclusive) throw new JobInputError("invalid_seed")
  return n
}

function optionalReferenceImages(
  body: Record<string, unknown>,
  capability: ReferenceCapability | undefined,
): { name: string; image: string }[] | undefined {
  const raw = body.images ?? body.image
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return undefined
  if (!capability?.enabled) throw new JobInputError("reference_images_not_supported")
  if (list.length > capability.maxImages) throw new JobInputError("too_many_reference_images")
  if (list.length < capability.minImages) throw new JobInputError("invalid_reference_image_count")
  let totalBytes = 0
  const preflighted = list.map((item, index) => {
    const image = typeof item === "string" ? item : isRecord(item) && typeof item.image === "string" ? item.image : ""
    const trimmed = image.trim()
    const preflight = preflightInlineImageDataUri(trimmed)
    if (!preflight.ok) throw new JobInputError(preflight.code)
    if (preflight.value.decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
      throw new JobInputError("reference_image_too_large")
    }
    totalBytes += preflight.value.decodedBytes
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) throw new JobInputError("reference_images_total_too_large")
    return { item, index, image: trimmed, preflight: preflight.value }
  })
  const seen = new Set<string>()
  return preflighted.map(({ item, index, image, preflight }) => {
    verifyReferenceImage(preflight)
    return { name: uniqueReferenceName(item, index, seen), image }
  })
}

function verifyReferenceImage(preflight: InlineImagePreflight): void {
  const verified = verifyInlineImagePreflight(preflight)
  if (!verified.ok) throw new JobInputError(verified.code)
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
