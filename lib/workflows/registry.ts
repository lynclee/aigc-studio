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
 * 上传参考图时切到 referenceTemplate:LoadImage 用 {{REFERENCE_IMAGE_K}} 占位,按上传数量裁剪多余槽
 * (删空槽节点 + 断开引用它的输入键),支持 1~N 张可变。
 */

import type { AigcKind } from "@/lib/aigc/types"
import { firstString, isRecord } from "@/lib/aigc/http"
import { renderTemplate, type TemplateVars } from "@/lib/workflows/render-template"
import { renderImageWorkflow } from "@/lib/workflows/image-registry"
import seedanceTextToVideo from "@/lib/workflows/templates/api_seedance2_0_mini_t2v.json"
import seedanceReferenceToVideo from "@/lib/workflows/templates/api_seedance2_0_r2v.json"
import tripoTextToModel from "@/lib/workflows/templates/api_tripo3_0_text_to_model.json"
import tripoImageToModel from "@/lib/workflows/templates/api_tripo3_0_image_to_model.json"

export class WorkflowNotConfiguredError extends Error {
  readonly status = 503
  readonly code = "workflow_not_configured"
  constructor(kind: AigcKind) {
    super(`no ${kind} workflow is configured for Modal Bridge yet`)
  }
}

export class UnknownWorkflowError extends Error {
  readonly status = 400
  readonly code = "unknown_workflow"
  constructor(kind: AigcKind, requested: string) {
    super(`unknown ${kind} workflow '${requested}'`)
  }
}

export type RenderedWorkflow = {
  id: string
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
}

// video / model3d 的 Bridge 工作流(原始 API JSON)。加新工作流:导出 API JSON → 放 templates/ →
// 在这里加一条。aliases 对应 job 的 workflow_id(video: "standard";model3d: "standard"/"game-asset")。
type BridgeWorkflowConfig = {
  id: string
  aliases: string[]
  needsGpu?: boolean
  gpuClass?: string
  template: unknown
  // 上传了参考图时用的多图变体(LoadImage 槽 + 参考/批量节点)。没有则该工作流不支持参考图,
  // 传了图也走文生模板。与图片侧 i2iTemplate 同思路。
  referenceTemplate?: unknown
}

const SEED_MAX = 0x100000000
// LoadImage.image 用 {{REFERENCE_IMAGE_K}}(K 从 1 起)标记第 K 个参考图槽,渲染时按上传数量裁剪。
const REFERENCE_SLOT_RE = /^\{\{REFERENCE_IMAGE_(\d+)\}\}$/

const VIDEO_WORKFLOWS: BridgeWorkflowConfig[] = [
  {
    id: "seedance2_t2v",
    aliases: ["standard"],
    needsGpu: false,
    template: seedanceTextToVideo,
    referenceTemplate: seedanceReferenceToVideo,
  },
]

const MODEL3D_WORKFLOWS: BridgeWorkflowConfig[] = [
  {
    id: "tripo3_t2model",
    aliases: ["standard", "game-asset"],
    needsGpu: false,
    template: tripoTextToModel,
    referenceTemplate: tripoImageToModel,
  },
]

export function renderWorkflow(kind: AigcKind, params: RenderWorkflowParams): RenderedWorkflow {
  if (kind === "image") return renderImageWorkflow(params)
  const configs = kind === "video" ? VIDEO_WORKFLOWS : MODEL3D_WORKFLOWS
  return renderBridgeWorkflow(kind, configs, params)
}

function renderBridgeWorkflow(
  kind: AigcKind,
  configs: BridgeWorkflowConfig[],
  params: RenderWorkflowParams,
): RenderedWorkflow {
  if (configs.length === 0) throw new WorkflowNotConfiguredError(kind)
  const config = resolveBridgeWorkflow(kind, configs, params.input)
  const seed = seedFromInput(params.input)
  const referenceNames = referenceNamesFrom(params.input)
  // 有参考图变体 + 至少传了 1 张图 → 走多图变体(按上传数量裁剪);否则文生模板。与图片侧一致。
  const rendered =
    config.referenceTemplate && referenceNames.length > 0
      ? renderReferenceWorkflow(config.referenceTemplate, { PROMPT: params.prompt, SEED: seed }, referenceNames)
      : renderTemplate(config.template, { PROMPT: params.prompt, SEED: seed })
  if (!isRecord(rendered)) throw new Error(`${kind} workflow '${config.id}' rendered to a non-object`)
  return {
    id: config.id,
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

// 渲染多图变体:LoadImage 的 {{REFERENCE_IMAGE_K}} 按上传数量填名;超出上传数的槽整节点删除,
// 并删掉任何仍引用被删节点的输入键(靠 ComfyUI 的 [nodeId, idx] 引用格式结构通用地裁,不硬编码节点名)。
// 这样参考/批量节点上的多余图槽随之断开,支持 1~N 张可变(满槽时与本地验证过的图完全一致)。
function renderReferenceWorkflow(template: unknown, vars: TemplateVars, referenceNames: string[]): unknown {
  if (!isRecord(template)) throw new Error("reference workflow template must be an object")
  const workflow = JSON.parse(JSON.stringify(template)) as Record<string, unknown>

  const deleted = new Set<string>()
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!isRecord(node) || !isRecord(node.inputs)) continue
    const image = node.inputs.image
    if (typeof image !== "string") continue
    const match = image.match(REFERENCE_SLOT_RE)
    if (!match) continue
    const slot = Number(match[1]) // 1-based
    if (slot >= 1 && slot <= referenceNames.length) {
      node.inputs.image = referenceNames[slot - 1]
    } else {
      delete workflow[nodeId]
      deleted.add(nodeId)
    }
  }

  if (deleted.size > 0) {
    for (const node of Object.values(workflow)) {
      if (!isRecord(node) || !isRecord(node.inputs)) continue
      for (const [key, value] of Object.entries(node.inputs)) {
        // ComfyUI 连接严格是 [nodeId, outputIndex] 二元组;收紧判断避免误删恰好首元素等于被删
        // 节点 id 的数组型 widget 值(当前模板无此情况,防御未来模板)。
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          typeof value[1] === "number" &&
          deleted.has(String(value[0]))
        ) {
          delete (node.inputs as Record<string, unknown>)[key]
        }
      }
    }
  }

  return renderTemplate(workflow, vars)
}

function resolveBridgeWorkflow(
  kind: AigcKind,
  configs: BridgeWorkflowConfig[],
  input: Record<string, unknown>,
): BridgeWorkflowConfig {
  const requested = firstString(input.workflowId, input.workflow_id, input.workflow, input.mode)?.toLowerCase()
  if (!requested) return configs[0]
  const found = configs.find((c) => c.id === requested || c.aliases.includes(requested))
  // 未知工作流 → 明确拒绝(M9),不静默回退默认,避免错扣费/错产物。与图片 registry 一致。
  if (!found) throw new UnknownWorkflowError(kind, requested)
  return found
}

function seedFromInput(input: Record<string, unknown>): number {
  const raw = input.seed
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN
  if (Number.isFinite(n) && n >= 0 && n < SEED_MAX) return Math.floor(n)
  return Math.floor(Math.random() * SEED_MAX)
}
