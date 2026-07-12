import { firstString, isRecord } from "@/lib/aigc/http"
import { renderTemplate } from "@/lib/workflows/render-template"
import zImageTurboTemplate from "@/lib/workflows/templates/z_image_turbo.json"
import zImageTurboI2iTemplate from "@/lib/workflows/templates/z_image_turbo_i2i.json"
import flux2KleinTemplate from "@/lib/workflows/templates/flux2_klein.json"

export type ImageWorkflowId = "z_image_turbo" | "z_image_turbo_i2i" | "flux2_klein"

type ModalGpu = "L40S" | "A100" | "A100-40GB" | "A100-80GB" | "H100" | string

// modal-bridge 交付用:是否需要 GPU + 档位(cpu/cheap/primary/top)。普通用户不可覆盖。
// 无法判定的一律 needs_gpu=true / primary(稳但略贵)。
type GpuClass = "cpu" | "cheap" | "primary" | "top"

type ImageWorkflowConfig = {
  id: ImageWorkflowId
  templateVersion: string
  aliases: string[]
  gpu?: ModalGpu
  needsGpu?: boolean
  gpuClass?: GpuClass
  template: unknown
  // 有参考图时用的图生图变体(同一模型 + 核心节点 LoadImage/VAEEncode)。没有则该工作流不支持图生图。
  i2iTemplate?: unknown
  i2iId?: ImageWorkflowId
}

type RenderImageWorkflowParams = {
  prompt: string
  input: Record<string, unknown>
}

export type RenderedImageWorkflow = {
  id: ImageWorkflowId
  templateVersion: string
  workflow: Record<string, unknown>
  gpu?: ModalGpu
  needsGpu?: boolean
  gpuClass?: GpuClass
  width: number
  height: number
  seed: number
}

const DEFAULT_SIZE = 1024
const DEFAULT_DENOISE = 0.7 // 图生图去噪强度:越低越贴近参考图,越高越自由;部署同学可按模型调
const SEED_MAX = 0x100000000

const WORKFLOWS: ImageWorkflowConfig[] = [
  {
    id: "z_image_turbo",
    templateVersion: "1",
    aliases: ["standard", "fast", "z_image_turbo"],
    needsGpu: true,
    gpuClass: "primary",
    template: zImageTurboTemplate,
    i2iTemplate: zImageTurboI2iTemplate,
    i2iId: "z_image_turbo_i2i",
  },
  {
    id: "flux2_klein",
    templateVersion: "1",
    aliases: ["detail", "detailed", "quality", "flux2_klein"],
    needsGpu: true,
    gpuClass: "primary",
    template: flux2KleinTemplate,
  },
]

const WORKFLOW_BY_ALIAS = new Map(WORKFLOWS.flatMap((workflow) => workflow.aliases.map((alias) => [alias, workflow])))

export function renderImageWorkflow(params: RenderImageWorkflowParams): RenderedImageWorkflow {
  const config = resolveImageWorkflow(params.input)
  const { width, height } = dimensionsFromInput(params.input)
  const seed = seedFromInput(params.input)
  const referenceName = firstReferenceName(params.input)
  // 有参考图且该工作流有 i2i 变体 → 走图生图(LoadImage→VAEEncode);否则文生图。
  const template = config.i2iTemplate && referenceName ? config.i2iTemplate : config.template
  const rendered = renderTemplate(template, {
    PROMPT: params.prompt,
    WIDTH: width,
    HEIGHT: height,
    SEED: seed,
    REFERENCE_IMAGE: referenceName ?? "",
    DENOISE: DEFAULT_DENOISE,
  })
  const workflow = isRecord(rendered) && isRecord(rendered.input) && isRecord(rendered.input.workflow)
    ? rendered.input.workflow
    : null
  if (!workflow) throw new Error(`image workflow '${config.id}' template missing input.workflow after render`)
  return {
    id: config.i2iTemplate && config.i2iId && referenceName ? config.i2iId : config.id,
    templateVersion: config.templateVersion,
    workflow,
    gpu: config.gpu,
    needsGpu: config.needsGpu,
    gpuClass: config.gpuClass,
    width,
    height,
    seed,
  }
}

function resolveImageWorkflow(input: Record<string, unknown>): ImageWorkflowConfig {
  const requested = firstString(input.workflowId, input.workflow_id, input.workflow, input.mode)?.toLowerCase()
  if (!requested) return WORKFLOW_BY_ALIAS.get("standard") as ImageWorkflowConfig
  const config = WORKFLOW_BY_ALIAS.get(requested)
  if (!config) {
    const supported = [...new Set(WORKFLOWS.flatMap((workflow) => workflow.aliases))].join(", ")
    throw new ImageWorkflowInputError(`unsupported image workflow '${requested}'. Supported workflows: ${supported}`)
  }
  return config
}

function firstReferenceName(input: Record<string, unknown>): string | undefined {
  const images = input.images
  if (Array.isArray(images) && images.length > 0 && isRecord(images[0]) && typeof images[0].name === "string") {
    return images[0].name
  }
  return undefined
}

function seedFromInput(input: Record<string, unknown>): number {
  const raw = input.seed
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN
  if (Number.isFinite(n) && n >= 0 && n < SEED_MAX) return Math.floor(n)
  return Math.floor(Math.random() * SEED_MAX)
}

function dimensionsFromInput(input: Record<string, unknown>): { width: number; height: number } {
  const explicitWidth = positiveInt(input.width)
  const explicitHeight = positiveInt(input.height)
  if (explicitWidth && explicitHeight) return { width: round64(explicitWidth), height: round64(explicitHeight) }

  const baseSize = positiveInt(input.baseSize) ?? positiveInt(input.size) ?? DEFAULT_SIZE
  const aspectRatio = firstString(input.aspectRatio, input.aspect_ratio, input.ratio) ?? "1:1"
  const [rw, rh] = aspectRatioMap(aspectRatio).split(":").map(Number)
  if (!rw || !rh) return { width: baseSize, height: baseSize }
  const area = baseSize * baseSize
  return {
    width: round64(Math.sqrt(area * (rw / rh))),
    height: round64(Math.sqrt(area * (rh / rw))),
  }
}

function aspectRatioMap(value: string): string {
  return ({ square: "1:1", portrait: "9:16", landscape: "16:9", wide: "21:9" } as Record<string, string>)[value] ?? value
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function round64(value: number): number {
  // 上钳 4096:兜底任何来源(含 aspectRatio 推导)的尺寸,不让它绕过 input.ts 的上限放大显存。
  return Math.min(4096, Math.max(64, Math.round(value / 64) * 64))
}

export class ImageWorkflowInputError extends Error {
  readonly status = 400
}
