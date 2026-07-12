/**
 * Modal Bridge 工作流分发:按 kind 渲染对应的 ComfyUI 工作流。
 *
 * 交付/核验/R2/落库/兜底/清理那半程本来就是 kind 无关的(按 job.kind 取类别),已就绪。
 * 这里是「提交侧」按 kind 选工作流:
 *   - image  → image-registry(文生图 + 图生图)
 *   - video  → Seedance(API 节点,CPU worker;文生视频 t2v + 参考图生视频 r2v)
 *   - model3d→ Tripo(API 节点,CPU worker;文生 3D t2model + 多视图图生 3D i2model)
 *
 * video/model3d 模板是**原始 ComfyUI API 格式**(节点id→{inputs,class_type}),整个对象即 workflow;
 * 只做 {{PROMPT}}/{{SEED}} 占位替换。API 节点款需 Modal Secret 里有 COMFY_API_KEY_COMFY_ORG。
 * 上传参考图时切到 referenceTemplate:LoadImage 用 {{REFERENCE_IMAGE_K}} 占位。API 节点欠槽
 * optionality 尚未真机验证,当前只接受 capability 声明的完整槽位。
 */

import type { AigcKind } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import { renderTemplate, type TemplateVars } from "@/lib/workflows/render-template"
import { renderImageWorkflow } from "@/lib/workflows/image-registry"
import seedanceTextToVideo from "@/lib/workflows/templates/api_seedance2_0_mini_t2v.json"
import seedanceReferenceToVideo from "@/lib/workflows/templates/api_seedance2_0_r2v.json"
import tripoTextToModel from "@/lib/workflows/templates/api_tripo3_0_text_to_model.json"
import tripoImageToModel from "@/lib/workflows/templates/api_tripo3_0_image_to_model.json"
import { validateWorkflowTemplate } from "@/lib/workflows/validate-template"
import {
  listWorkflowDefinitions,
  resolveExecutionVariant,
  workflowExecutionFor,
  type WorkflowProvider,
} from "@/lib/workflows/definitions"

export class UnknownWorkflowError extends Error {
  readonly status = 400
  readonly code = "unknown_workflow"
  constructor(kind: AigcKind, requested: string) {
    super(`unknown ${kind} workflow '${requested}'`)
  }
}

export type RenderedWorkflow = {
  id: string
  templateVersion: string
  workflow: Record<string, unknown>
  needsGpu?: boolean
  gpuClass?: string
  width?: number
  height?: number
  seed?: number
}

export type RenderWorkflowParams = {
  prompt: string
  input: Record<string, unknown>
  workflowId: string
  provider: WorkflowProvider
}

// video / model3d 的 Bridge 模板注册表(原始 API JSON)。公开工作流、provider 映射、版本和
// 参考图契约统一来自 definitions.ts；这里仅保存执行变体对应的静态模板与资源档位。
type BridgeWorkflowConfig = {
  id: string
  needsGpu?: boolean
  gpuClass?: string
  template: unknown
}

const SEED_MAX = 0x100000000
// LoadImage.image 用 {{REFERENCE_IMAGE_K}}(K 从 1 起)标记第 K 个参考图槽；当前只渲染完整槽位。
const REFERENCE_SLOT_RE = /^\{\{REFERENCE_IMAGE_(\d+)\}\}$/

const BRIDGE_WORKFLOWS: BridgeWorkflowConfig[] = [
  {
    id: "seedance2_t2v",
    needsGpu: false,
    template: seedanceTextToVideo,
  },
  {
    id: "seedance2_r2v",
    needsGpu: false,
    template: seedanceReferenceToVideo,
  },
  {
    id: "tripo3_t2model",
    needsGpu: false,
    template: tripoTextToModel,
  },
  {
    id: "tripo3_i2model",
    needsGpu: false,
    template: tripoImageToModel,
  },
]

const BRIDGE_WORKFLOW_BY_ID = new Map(BRIDGE_WORKFLOWS.map((workflow) => [workflow.id, workflow]))

validateWorkflowTemplate(seedanceTextToVideo, {
  id: "seedance2_t2v",
  kind: "video",
  format: "graph",
  placeholders: ["PROMPT", "SEED"],
  primaryOutputs: [{ classType: "SaveVideo", input: "video" }],
})
validateWorkflowTemplate(seedanceReferenceToVideo, {
  id: "seedance2_r2v",
  kind: "video",
  format: "graph",
  placeholders: ["PROMPT", "SEED", "REFERENCE_IMAGE_1", "REFERENCE_IMAGE_2", "REFERENCE_IMAGE_3", "REFERENCE_IMAGE_4"],
  referencePlaceholders: ["REFERENCE_IMAGE_1", "REFERENCE_IMAGE_2", "REFERENCE_IMAGE_3", "REFERENCE_IMAGE_4"],
  primaryOutputs: [{ classType: "SaveVideo", input: "video" }],
})
validateWorkflowTemplate(tripoTextToModel, {
  id: "tripo3_t2model",
  kind: "model3d",
  format: "graph",
  placeholders: ["PROMPT", "SEED"],
  primaryOutputs: [{ classType: "SaveGLB", input: "mesh" }],
})
validateWorkflowTemplate(tripoImageToModel, {
  id: "tripo3_i2model",
  kind: "model3d",
  format: "graph",
  placeholders: ["SEED", "REFERENCE_IMAGE_1", "REFERENCE_IMAGE_2", "REFERENCE_IMAGE_3"],
  referencePlaceholders: ["REFERENCE_IMAGE_1", "REFERENCE_IMAGE_2", "REFERENCE_IMAGE_3"],
  primaryOutputs: [{ classType: "SaveGLB", input: "mesh" }],
})

for (const kind of ["video", "model3d"] as const) {
  for (const definition of listWorkflowDefinitions(kind)) {
    const execution = definition.executions["modal-bridge"]
    if (!execution) continue
    const variants = [
      execution.baseVariant,
      ...(execution.referenceVariant ? [execution.referenceVariant] : []),
      ...(execution.referenceVariants?.map((item) => item.variant) ?? []),
    ]
    for (const variant of variants) {
      if (!BRIDGE_WORKFLOW_BY_ID.has(variant)) {
        throw new Error(`${kind} execution variant '${variant}' has no registered template`)
      }
    }
  }
}

export function renderWorkflow(kind: AigcKind, params: RenderWorkflowParams): RenderedWorkflow {
  if (kind === "image") return renderImageWorkflow(params)
  return renderBridgeWorkflow(kind, params)
}

function renderBridgeWorkflow(
  kind: AigcKind,
  params: RenderWorkflowParams,
): RenderedWorkflow {
  const execution = workflowExecutionFor(kind, params.workflowId, params.provider)
  if (!execution) throw new UnknownWorkflowError(kind, params.workflowId)
  const seed = seedFromInput(params.input)
  const referenceNames = referenceNamesFrom(params.input)
  const usesReference = referenceNames.length > 0
  if (usesReference && !execution.reference?.enabled) {
    throw new WorkflowReferenceInputError("reference_images_not_supported")
  }
  // 欠槽的 API-node 输入是否 optional 尚未真机验证。v1 只接受导出图的完整槽位，避免向
  // ComfyUI 提交靠猜测裁剪出的图；验证后可在 capability + 这里一起放宽。
  if (
    usesReference &&
    execution.reference &&
    (referenceNames.length < execution.reference.minImages || referenceNames.length > execution.reference.maxImages)
  ) {
    throw new WorkflowReferenceInputError("invalid_reference_image_count")
  }
  const resolved = resolveExecutionVariant(kind, params.workflowId, params.provider, referenceNames.length)
  if (!resolved) throw new WorkflowReferenceInputError("invalid_reference_image_count")
  const variant = resolved.variant
  const config = BRIDGE_WORKFLOW_BY_ID.get(variant)
  if (!config) throw new Error(`${kind} execution variant '${variant}' has no registered template`)
  const rendered = usesReference
    ? renderReferenceWorkflow(config.template, { PROMPT: params.prompt, SEED: seed }, referenceNames)
    : renderTemplate(config.template, { PROMPT: params.prompt, SEED: seed })
  if (!isRecord(rendered)) throw new Error(`${kind} workflow '${config.id}' rendered to a non-object`)
  return {
    id: config.id,
    templateVersion: execution.templateVersion,
    workflow: rendered,
    needsGpu: config.needsGpu,
    gpuClass: config.gpuClass,
    seed,
  }
}

// 上传的参考图 name 列表(按提交顺序);input.ts 已保证 name 唯一、已 sanitize。
function referenceNamesFrom(input: Record<string, unknown>): string[] {
  const images = input.images
  if (!Array.isArray(images)) return []
  return images
    .map((img) => (isRecord(img) && typeof img.name === "string" ? img.name : null))
    .filter((name): name is string => Boolean(name))
}

// 渲染已验证形状的满槽多图变体。所有占位槽必须有对应图片；不再猜测 API 节点能否接受
// 缺失动态输入。这样提交给 Bridge 的 graph 与导出的完整 ComfyUI API graph 保持同构。
function renderReferenceWorkflow(template: unknown, vars: TemplateVars, referenceNames: string[]): unknown {
  if (!isRecord(template)) throw new Error("reference workflow template must be an object")
  const workflow = JSON.parse(JSON.stringify(template)) as Record<string, unknown>

  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || !isRecord(node.inputs)) continue
    const image = node.inputs.image
    if (typeof image !== "string") continue
    const match = image.match(REFERENCE_SLOT_RE)
    if (!match) continue
    const slot = Number(match[1]) // 1-based
    const referenceName = referenceNames[slot - 1]
    if (!referenceName) throw new WorkflowReferenceInputError("invalid_reference_image_count")
    node.inputs.image = referenceName
  }

  return renderTemplate(workflow, vars)
}

export class WorkflowReferenceInputError extends Error {
  readonly status = 400
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

function seedFromInput(input: Record<string, unknown>): number {
  const raw = input.seed
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN
  if (Number.isFinite(n) && n >= 0 && n < SEED_MAX) return Math.floor(n)
  return Math.floor(Math.random() * SEED_MAX)
}
