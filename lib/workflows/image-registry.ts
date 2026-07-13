import { firstString, isRecord } from "@/lib/aigc/http"
import { renderTemplate } from "@/lib/workflows/render-template"
import zImageTurboTemplate from "@/lib/workflows/templates/z_image_turbo.json"
import zImageTurboI2iTemplate from "@/lib/workflows/templates/z_image_turbo_i2i.json"
import flux2KleinTemplate from "@/lib/workflows/templates/flux2_klein.json"
import { validateWorkflowTemplate } from "@/lib/workflows/validate-template"
import {
  listWorkflowDefinitions,
  resolveExecutionVariant,
  workflowExecutionFor,
  type WorkflowProvider,
} from "@/lib/workflows/definitions"
import type { WorkflowJobSnapshot } from "@/lib/workflows/revision"

export type ImageWorkflowId = "z_image_turbo" | "z_image_turbo_i2i" | "flux2_klein"

type ModalGpu = "L40S" | "A100" | "A100-40GB" | "A100-80GB" | "H100" | string

// modal-bridge 交付用:是否需要 GPU + 档位(cpu/cheap/primary/top)。普通用户不可覆盖。
// 无法判定的一律 needs_gpu=true / primary(稳但略贵)。
type GpuClass = "cpu" | "cheap" | "primary" | "top"

type ImageWorkflowConfig = {
  id: ImageWorkflowId
  gpu?: ModalGpu
  needsGpu?: boolean
  gpuClass?: GpuClass
  template: unknown
}

type RenderImageWorkflowParams = {
  prompt: string
  input: Record<string, unknown>
  workflowId: string
  provider: WorkflowProvider
  workflowSnapshot?: WorkflowJobSnapshot
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
    needsGpu: true,
    gpuClass: "primary",
    template: zImageTurboTemplate,
  },
  {
    id: "z_image_turbo_i2i",
    needsGpu: true,
    gpuClass: "primary",
    template: zImageTurboI2iTemplate,
  },
  {
    id: "flux2_klein",
    needsGpu: true,
    gpuClass: "primary",
    template: flux2KleinTemplate,
  },
]

validateWorkflowTemplate(zImageTurboTemplate, {
  id: "z_image_turbo",
  kind: "image",
  format: "wrapped",
  placeholders: ["PROMPT", "WIDTH", "HEIGHT", "SEED"],
  primaryOutputs: [{ classType: "SaveImage", input: "images" }],
})
validateWorkflowTemplate(zImageTurboI2iTemplate, {
  id: "z_image_turbo_i2i",
  kind: "image",
  format: "wrapped",
  placeholders: ["PROMPT", "REFERENCE_IMAGE", "SEED", "DENOISE"],
  referencePlaceholders: ["REFERENCE_IMAGE"],
  primaryOutputs: [{ classType: "SaveImage", input: "images" }],
})
validateWorkflowTemplate(flux2KleinTemplate, {
  id: "flux2_klein",
  kind: "image",
  format: "wrapped",
  placeholders: ["PROMPT", "WIDTH", "HEIGHT", "SEED"],
  primaryOutputs: [{ classType: "SaveImage", input: "images" }],
})

const WORKFLOW_BY_ID = new Map(WORKFLOWS.map((workflow) => [workflow.id, workflow]))

for (const definition of listWorkflowDefinitions("image")) {
  for (const provider of ["modal-image", "modal-bridge", "comfyui-image"] as const) {
    const execution = definition.executions[provider]
    if (!execution) continue
    for (const variant of executionVariants(execution)) {
      if (!WORKFLOW_BY_ID.has(variant as ImageWorkflowId)) {
        throw new Error(`image execution variant '${variant}' has no registered template`)
      }
    }
  }
}

export function renderImageWorkflow(params: RenderImageWorkflowParams): RenderedImageWorkflow {
  const { width, height } = dimensionsFromInput(params.input)
  const seed = seedFromInput(params.input)
  const referenceNames = referenceNamesFrom(params.input)
  const usesReference = referenceNames.length > 0
  let variant: string
  let templateVersion: string
  if (params.workflowSnapshot) {
    const snapshot = params.workflowSnapshot
    if (
      snapshot.kind !== "image" ||
      snapshot.workflowId !== params.workflowId ||
      snapshot.provider !== params.provider ||
      snapshot.referenceCount !== referenceNames.length
    ) {
      throw new ImageWorkflowInputError("invalid_workflow_snapshot")
    }
    variant = snapshot.executionVariant
    templateVersion = snapshot.templateVersion
  } else {
    const execution = workflowExecutionFor("image", params.workflowId, params.provider)
    if (!execution) {
      throw new ImageWorkflowInputError(`image workflow '${params.workflowId}' is unavailable for '${params.provider}'`)
    }
    if (usesReference) {
      const capability = execution.reference
      if (!capability?.enabled) throw new ImageWorkflowInputError("reference_images_not_supported")
      if (referenceNames.length < capability.minImages || referenceNames.length > capability.maxImages) {
        throw new ImageWorkflowInputError("invalid_reference_image_count")
      }
    }
    const resolved = resolveExecutionVariant("image", params.workflowId, params.provider, referenceNames.length)
    if (!resolved) throw new ImageWorkflowInputError("invalid_reference_image_count")
    variant = resolved.variant
    templateVersion = resolved.execution.templateVersion
  }
  const config = WORKFLOW_BY_ID.get(variant as ImageWorkflowId)
  if (!config) throw new Error(`image execution variant '${variant}' has no registered template`)
  const rendered = renderTemplate(config.template, {
    PROMPT: params.prompt,
    WIDTH: width,
    HEIGHT: height,
    SEED: seed,
    REFERENCE_IMAGE: referenceNames[0] ?? "",
    DENOISE: DEFAULT_DENOISE,
  })
  const workflow = isRecord(rendered) && isRecord(rendered.input) && isRecord(rendered.input.workflow)
    ? rendered.input.workflow
    : null
  if (!workflow) throw new Error(`image workflow '${config.id}' template missing input.workflow after render`)
  return {
    id: config.id,
    templateVersion,
    workflow,
    gpu: config.gpu,
    needsGpu: config.needsGpu,
    gpuClass: config.gpuClass,
    width,
    height,
    seed,
  }
}

function referenceNamesFrom(input: Record<string, unknown>): string[] {
  const images = input.images
  if (!Array.isArray(images)) return []
  return images
    .map((image) => isRecord(image) && typeof image.name === "string" ? image.name : null)
    .filter((name): name is string => Boolean(name))
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

function executionVariants(execution: {
  baseVariant: string
  referenceVariant?: string
  referenceVariants?: readonly { variant: string }[]
}): string[] {
  return [
    execution.baseVariant,
    ...(execution.referenceVariant ? [execution.referenceVariant] : []),
    ...(execution.referenceVariants?.map((item) => item.variant) ?? []),
  ]
}
