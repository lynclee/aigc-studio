/**
 * Modal Bridge 工作流分发:按 kind 渲染对应的 ComfyUI 工作流。
 *
 * 交付/核验/R2/落库/兜底/清理那半程本来就是 kind 无关的(按 job.kind 取类别),已就绪。
 * 这里是「提交侧」按 kind 选工作流:
 *   - image  → image-registry(文生图 + 图生图)
 *   - video  → Seedance(API 节点,CPU worker;文生视频已接,参考图生视频待多图 UI)
 *   - model3d→ Tripo(API 节点,CPU worker;文生 3D 已接,图生 3D 待多图 UI)
 *
 * video/model3d 模板是**原始 ComfyUI API 格式**(节点id→{inputs,class_type}),整个对象即 workflow;
 * 只做 {{PROMPT}}/{{SEED}} 占位替换。API 节点款需 Modal Secret 里有 COMFY_API_KEY_COMFY_ORG。
 */

import type { AigcKind } from "@/lib/aigc/types"
import { firstString, isRecord } from "@/lib/aigc/http"
import { renderTemplate } from "@/lib/workflows/render-template"
import { renderImageWorkflow } from "@/lib/workflows/image-registry"
import seedanceTextToVideo from "@/lib/workflows/templates/api_seedance2_0_mini_t2v.json"
import tripoTextToModel from "@/lib/workflows/templates/api_tripo3_0_text_to_model.json"

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
}

const SEED_MAX = 0x100000000

const VIDEO_WORKFLOWS: BridgeWorkflowConfig[] = [
  { id: "seedance2_t2v", aliases: ["standard"], needsGpu: false, template: seedanceTextToVideo },
]

const MODEL3D_WORKFLOWS: BridgeWorkflowConfig[] = [
  { id: "tripo3_t2model", aliases: ["standard", "game-asset"], needsGpu: false, template: tripoTextToModel },
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
  const rendered = renderTemplate(config.template, { PROMPT: params.prompt, SEED: seed })
  if (!isRecord(rendered)) throw new Error(`${kind} workflow '${config.id}' rendered to a non-object`)
  return {
    id: config.id,
    workflow: rendered,
    needsGpu: config.needsGpu,
    gpuClass: config.gpuClass,
    seed,
  }
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
