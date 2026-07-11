import { firstString, isRecord } from "@/lib/aigc/http"
import { renderTemplate } from "@/lib/workflows/render-template"
import zImageTurboTemplate from "@/lib/workflows/templates/z_image_turbo.json"
import flux2KleinTemplate from "@/lib/workflows/templates/flux2_klein.json"

export type ImageWorkflowId = "z_image_turbo" | "flux2_klein"

type ModalGpu = "L40S" | "A100" | "A100-40GB" | "A100-80GB" | "H100" | string

type ImageWorkflowConfig = {
  id: ImageWorkflowId
  aliases: string[]
  gpu?: ModalGpu
  template: unknown
}

type RenderImageWorkflowParams = {
  prompt: string
  input: Record<string, unknown>
}

export type RenderedImageWorkflow = {
  id: ImageWorkflowId
  workflow: Record<string, unknown>
  gpu?: ModalGpu
  width: number
  height: number
  seed: number
}

const DEFAULT_SIZE = 1024
const SEED_MAX = 0x100000000

const WORKFLOWS: ImageWorkflowConfig[] = [
  {
    id: "z_image_turbo",
    aliases: ["standard", "fast", "z_image_turbo"],
    template: zImageTurboTemplate,
  },
  {
    id: "flux2_klein",
    aliases: ["detail", "detailed", "quality", "flux2_klein"],
    template: flux2KleinTemplate,
  },
]

const WORKFLOW_BY_ALIAS = new Map(WORKFLOWS.flatMap((workflow) => workflow.aliases.map((alias) => [alias, workflow])))

export function renderImageWorkflow(params: RenderImageWorkflowParams): RenderedImageWorkflow {
  const config = resolveImageWorkflow(params.input)
  const { width, height } = dimensionsFromInput(params.input)
  const seed = seedFromInput(params.input)
  const rendered = renderTemplate(config.template, {
    PROMPT: params.prompt,
    WIDTH: width,
    HEIGHT: height,
    SEED: seed,
  })
  const workflow = isRecord(rendered) && isRecord(rendered.input) && isRecord(rendered.input.workflow)
    ? rendered.input.workflow
    : null
  if (!workflow) throw new Error(`image workflow '${config.id}' template missing input.workflow after render`)
  return { id: config.id, workflow, gpu: config.gpu, width, height, seed }
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
  return Math.max(64, Math.round(value / 64) * 64)
}

export class ImageWorkflowInputError extends Error {
  readonly status = 400
}
