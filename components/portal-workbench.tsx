"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Box,
  CheckCircle2,
  Download,
  Film,
  ImageIcon,
  Loader2,
  PlayCircle,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react"

type MediaType = "image" | "model3d" | "video"
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

type WorkflowOption = {
  value: string
  label: string
  hint: string
}

type MediaConfig = {
  type: MediaType
  title: string
  subtitle: string
  route: string
  icon: typeof ImageIcon
  accent: string
  workflows: WorkflowOption[]
  placeholder: string
}

type SubmittedJob = {
  id: string
  mediaType: MediaType
  prompt: string
  workflow: string
  status: JobStatus
  createdAt: string
  resultUrl?: string | null
  error?: string | null
}

type LibraryItem = {
  id: string
  mediaType: MediaType
  title: string
  prompt?: string | null
  createdAt?: string | null
  imageUrl?: string | null
  thumbnailUrl?: string | null
  videoUrl?: string | null
  downloadUrl?: string | null
}

type RawRecord = Record<string, unknown>

const MEDIA_CONFIGS: MediaConfig[] = [
  {
    type: "image",
    title: "图片",
    subtitle: "概念图、角色、场景与素材草图",
    route: "/api/generate/image",
    icon: ImageIcon,
    accent: "from-fuchsia-500/25 to-indigo-500/10 text-fuchsia-200",
    workflows: [
      { value: "standard", label: "标准出图", hint: "适合快速探索画面方向" },
      { value: "detail", label: "细节增强", hint: "适合更完整的美术描述" },
    ],
    placeholder: "描述你想要的画面、风格、主体、构图和用途……",
  },
  {
    type: "model3d",
    title: "3D",
    subtitle: "用一句提示词生成道具、角色或场景资产",
    route: "/api/generate/model3d",
    icon: Box,
    accent: "from-cyan-500/25 to-blue-500/10 text-cyan-200",
    workflows: [
      { value: "standard", label: "标准模型", hint: "只需填写提示词，适合常规 3D 资产" },
      { value: "game-asset", label: "游戏资产", hint: "只需填写提示词，更偏向可下载资产" },
    ],
    placeholder: "描述模型外观、材质、比例、用途和需要强调的细节……",
  },
  {
    type: "video",
    title: "视频",
    subtitle: "短动画、镜头草案与动态概念",
    route: "/api/generate/video",
    icon: Film,
    accent: "from-amber-500/25 to-orange-500/10 text-amber-200",
    workflows: [
      { value: "standard", label: "标准视频", hint: "适合短镜头概念" },
    ],
    placeholder: "描述镜头内容、运动方式、氛围和画面风格……",
  },
]

// 图片生成的可选参数控件(尺寸/宽高比/参考图)。只对 image 类型渲染。
const ASPECT_RATIOS = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
]

const IMAGE_SIZES = [
  { value: "standard", label: "标准", base: 1024 },
  { value: "hd", label: "高清", base: 1536 },
]

const MAX_REFERENCE_IMAGES = 4
const MAX_REFERENCE_BYTES = 3 * 1024 * 1024
// 只有「标准出图」(z_image_turbo)有图生图变体;detail 是文生图,不接受参考图。
const I2I_WORKFLOW = "standard"
// 后端 input.ts 只接受 png/jpeg/webp/gif 的 base64 data-uri;这里同步限制,避免选了别的类型被 400。
const ACCEPTED_REFERENCE_TYPES = "image/png,image/jpeg,image/webp,image/gif"

type ReferenceImage = { name: string; image: string }

type WorkbenchFormState = {
  workflow: string
  prompt: string
  aspectRatio: string
  size: string
  referenceImages: ReferenceImage[]
}

function createFormState(workflow: string): WorkbenchFormState {
  return { workflow, prompt: "", aspectRatio: "1:1", size: "standard", referenceImages: [] }
}

function roundTo64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64)
}

// 由宽高比 + 尺寸档在客户端算出 width/height 直接发给后端(后端 round64 + 上钳 4096 再兜底)。
function computeImageDimensions(aspectRatio: string, size: string): { width: number; height: number } | null {
  const sizeDef = IMAGE_SIZES.find((item) => item.value === size) ?? IMAGE_SIZES[0]
  const [rw, rh] = aspectRatio.split(":").map(Number)
  if (!rw || !rh) return null
  const ratio = rw / rh
  const width = ratio >= 1 ? sizeDef.base : Math.round(sizeDef.base * ratio)
  const height = ratio >= 1 ? Math.round(sizeDef.base / ratio) : sizeDef.base
  return { width: roundTo64(width), height: roundTo64(height) }
}

function buildSubmitBody(config: MediaConfig, form: WorkbenchFormState, prompt: string): RawRecord {
  const body: RawRecord = { prompt, workflow: form.workflow, mediaType: config.type }
  if (config.type === "image") {
    const dimensions = computeImageDimensions(form.aspectRatio, form.size)
    if (dimensions) {
      body.width = dimensions.width
      body.height = dimensions.height
    }
    if (form.workflow === I2I_WORKFLOW && form.referenceImages.length > 0) {
      body.images = form.referenceImages
    }
  }
  return body
}

function readFileAsDataUri(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function optionSegClass(active: boolean): string {
  return `rounded-lg border px-3 py-1.5 text-xs transition ${
    active
      ? "border-indigo-400/70 bg-indigo-500/20 text-white"
      : "border-white/10 bg-neutral-950 text-neutral-400 hover:text-white"
  }`
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

const STATUS_CLASS: Record<JobStatus, string> = {
  queued: "border-sky-400/20 bg-sky-400/10 text-sky-200",
  running: "border-violet-400/20 bg-violet-400/10 text-violet-200",
  completed: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
  failed: "border-red-400/20 bg-red-400/10 text-red-200",
  cancelled: "border-neutral-400/20 bg-neutral-400/10 text-neutral-300",
}

const USER_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "登录已失效，请重新登录",
  missing_provider_env: "生成服务尚未配置，请联系部署同学",
  invalid_provider_config: "生成服务配置有误，请联系部署同学",
  backend_store_error: "任务服务暂时不可用，请稍后重试",
  provider_http_error: "云端生成服务暂时不可用，请稍后重试",
  provider_contract_error: "云端生成服务返回异常，请稍后重试",
  invalid_provider_input: "提交内容不符合要求，请检查后重试",
  prompt_required: "请先填写提示词",
  prompt_too_long: "提示词过长，请精简后重试",
  unsupported_workflow: "所选工作流暂不可用，请重新选择",
  generation_failed: "本次生成失败，请调整描述后重试",
  storage_failed: "作品保存失败，请稍后重试",
  job_cancel_conflict: "任务状态刚刚变化，请刷新后重试",
  unsupported_cancel: "当前任务不支持取消",
  not_found: "没有找到这个任务",
  internal_error: "服务暂时不可用，请稍后重试",
}

function normalizeStatus(value: unknown): JobStatus {
  const raw = String(value ?? "").toLowerCase()
  if (["queued", "pending", "created", "waiting"].includes(raw)) return "queued"
  if (["running", "processing", "generating", "in_progress", "active"].includes(raw)) {
    return "running"
  }
  if (["completed", "complete", "succeeded", "success", "done", "finished"].includes(raw)) {
    return "completed"
  }
  if (["cancelled", "canceled", "abort", "aborted"].includes(raw)) return "cancelled"
  if (["failed", "failure", "error"].includes(raw)) return "failed"
  return "queued"
}

function normalizeMediaType(value: unknown): MediaType {
  const raw = String(value ?? "").toLowerCase()
  if (["video", "movie"].includes(raw)) return "video"
  if (["model3d", "3d", "model", "mesh"].includes(raw)) return "model3d"
  return "image"
}

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function firstString(record: RawRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return null
}

function userFacingError(value: unknown, fallback: string): string {
  const raw = asString(value)
  if (!raw) return fallback
  if (/[一-鿿]/.test(raw)) return raw
  return USER_ERROR_MESSAGES[raw] ?? fallback
}

function pickArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const record = asRecord(payload)
  if (!record) return []
  for (const key of ["items", "data", "library", "works", "results", "assets"]) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function normalizeLibraryItems(payload: unknown): LibraryItem[] {
  const record = asRecord(payload)
  if (record && Array.isArray(record.items)) {
    return record.items.map(normalizeLibraryItem).filter(Boolean) as LibraryItem[]
  }

  if (record && Array.isArray(record.generations)) {
    const topLevelAssets = Array.isArray(record.assets) ? record.assets : []
    return record.generations
      .map((generation, index) => normalizeGenerationItem(generation, index, topLevelAssets))
      .filter(Boolean) as LibraryItem[]
  }

  return pickArray(payload).map(normalizeLibraryItem).filter(Boolean) as LibraryItem[]
}

function normalizeLibraryItem(value: unknown, index: number): LibraryItem | null {
  const record = asRecord(value)
  if (!record) return null

  const nestedAssets = Array.isArray(record.assets) ? record.assets : []
  if (nestedAssets.length > 0) {
    return normalizeGenerationItem(record, index, nestedAssets)
  }

  const id = firstString(record, ["id", "jobId", "job_id", "assetId", "asset_id", "r2_key"]) ?? `library-${index}`
  const mediaType = normalizeMediaType(
    record.mediaType ?? record.media_type ?? record.asset_type ?? record.type ?? record.kind ?? record.category,
  )
  const url = firstString(record, [
    "url",
    "assetUrl",
    "asset_url",
    "resultUrl",
    "result_url",
    "downloadUrl",
    "download_url",
    "signedUrl",
    "signed_url",
    "sourceUrl",
    "source_url",
  ])
  const thumbnailUrl = firstString(record, [
    "thumbnailUrl",
    "thumbnail_url",
    "thumbUrl",
    "thumb_url",
    "previewUrl",
    "preview_url",
    "coverUrl",
    "cover_url",
  ])

  return {
    id,
    mediaType,
    title: firstString(record, ["title", "name"]) ?? `${mediaLabel(mediaType)}作品`,
    prompt: firstString(record, ["prompt", "description"]),
    createdAt: firstString(record, ["createdAt", "created_at", "updatedAt", "updated_at"]),
    imageUrl: mediaType === "image" ? (url ?? thumbnailUrl) : null,
    thumbnailUrl,
    videoUrl: mediaType === "video" ? url : null,
    downloadUrl: mediaType === "model3d" ? url : firstString(record, ["downloadUrl", "download_url"]),
  }
}

function normalizeGenerationItem(
  value: unknown,
  index: number,
  fallbackAssets: unknown[] = [],
): LibraryItem | null {
  const generation = asRecord(value)
  if (!generation) return null

  const id = firstString(generation, ["id", "jobId", "job_id", "generationId", "generation_id"]) ?? `generation-${index}`
  const directAssets = Array.isArray(generation.assets) ? generation.assets : []
  const assets = directAssets.length > 0 ? directAssets : matchingAssetsForGeneration(id, fallbackAssets)
  const mediaType = inferMediaType(generation, assets)
  const modelAsset = assets.find(isModelAsset)
  const videoAsset = assets.find(isVideoAsset)
  const imageAsset = assets.find(isImageAsset)
  const previewAsset = assets.find(isPreviewAsset) ?? imageAsset
  const directUrl = firstString(generation, [
    "url",
    "assetUrl",
    "asset_url",
    "resultUrl",
    "result_url",
    "downloadUrl",
    "download_url",
    "signedUrl",
    "signed_url",
    "sourceUrl",
    "source_url",
  ])
  const directThumbnail = firstString(generation, [
    "thumbnailUrl",
    "thumbnail_url",
    "thumbUrl",
    "thumb_url",
    "previewUrl",
    "preview_url",
    "coverUrl",
    "cover_url",
  ])

  const imageUrl = getAssetUrl(imageAsset) ?? (mediaType === "image" ? directUrl : null)
  const videoUrl = getAssetUrl(videoAsset) ?? (mediaType === "video" ? directUrl : null)
  const modelUrl = getAssetUrl(modelAsset) ?? (mediaType === "model3d" ? directUrl : null)
  const thumbnailUrl = directThumbnail ?? getAssetUrl(previewAsset) ?? (mediaType === "model3d" ? imageUrl : null)

  return {
    id,
    mediaType,
    title: firstString(generation, ["title", "name"]) ?? `${mediaLabel(mediaType)}作品`,
    prompt: firstString(generation, ["prompt", "description"]),
    createdAt: firstString(generation, ["createdAt", "created_at", "updatedAt", "updated_at"]),
    imageUrl,
    thumbnailUrl,
    videoUrl,
    downloadUrl: modelUrl ?? (mediaType === "model3d" ? directUrl : null),
  }
}

function matchingAssetsForGeneration(generationId: string, assets: unknown[]): unknown[] {
  return assets.filter((asset) => {
    const record = asRecord(asset)
    if (!record) return false
    return firstString(record, ["generationId", "generation_id", "jobId", "job_id"]) === generationId
  })
}

function inferMediaType(record: RawRecord, assets: unknown[]): MediaType {
  const explicit = record.mediaType ?? record.media_type ?? record.asset_type ?? record.type ?? record.kind ?? record.category
  if (explicit) return normalizeMediaType(explicit)
  if (assets.some(isModelAsset)) return "model3d"
  if (assets.some(isVideoAsset)) return "video"
  return "image"
}

function assetKind(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ""
  return String(
    record.asset_type ?? record.assetType ?? record.media_type ?? record.mediaType ?? record.kind ?? record.type ?? record.mime_type ?? "",
  ).toLowerCase()
}

function assetUrl(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ""
  return (
    firstString(record, [
      "signedUrl",
      "signed_url",
      "sourceUrl",
      "source_url",
      "url",
      "assetUrl",
      "asset_url",
      "downloadUrl",
      "download_url",
      "previewUrl",
      "preview_url",
      "thumbnailUrl",
      "thumbnail_url",
    ]) ?? ""
  )
}

function getAssetUrl(value: unknown): string | null {
  return assetUrl(value) || null
}

function hasExtension(value: unknown, extensions: string[]): boolean {
  const url = assetUrl(value).toLowerCase().split("?")[0] ?? ""
  return extensions.some((extension) => url.endsWith(extension))
}

function isImageAsset(value: unknown): boolean {
  const kind = assetKind(value)
  return (
    kind.includes("image") ||
    kind.includes("thumbnail") ||
    kind.includes("preview") ||
    hasExtension(value, [".png", ".jpg", ".jpeg", ".webp", ".gif"])
  )
}

function isVideoAsset(value: unknown): boolean {
  const kind = assetKind(value)
  return kind.includes("video") || hasExtension(value, [".mp4", ".mov", ".webm", ".m4v"])
}

function isModelAsset(value: unknown): boolean {
  const kind = assetKind(value)
  return (
    kind.includes("model") ||
    kind.includes("3d") ||
    kind.includes("mesh") ||
    hasExtension(value, [".glb", ".gltf", ".obj", ".fbx", ".stl", ".usdz", ".zip"])
  )
}

function isPreviewAsset(value: unknown): boolean {
  const kind = assetKind(value)
  return kind.includes("thumbnail") || kind.includes("preview") || kind.includes("cover")
}

function mediaLabel(type: MediaType): string {
  if (type === "model3d") return "3D"
  if (type === "video") return "视频"
  return "图片"
}

function relativeTime(iso?: string | null): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return "刚刚"
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

function isActiveJob(job: SubmittedJob): boolean {
  return job.status === "queued" || job.status === "running"
}

function getJobId(payload: unknown): string | null {
  const record = asRecord(payload)
  if (!record) return null
  return firstString(record, ["id", "jobId", "job_id"])
}

function getResultUrl(payload: unknown): string | null {
  const record = asRecord(payload)
  if (!record) return null
  return firstString(record, ["resultUrl", "url", "assetUrl", "downloadUrl", "signedUrl"])
}

function normalizeSubmittedJobs(payload: unknown): SubmittedJob[] {
  const record = asRecord(payload)
  const source = record && Array.isArray(record.jobs) ? record.jobs : pickArray(payload)
  return source.map(normalizeSubmittedJob).filter(Boolean) as SubmittedJob[]
}

function normalizeSubmittedJob(value: unknown, index: number): SubmittedJob | null {
  const record = asRecord(value)
  if (!record) return null
  const id = getJobId(record) ?? `job-${index}`
  const request = asRecord(record.request)
  const prompt = firstString(record, ["prompt"]) ?? firstString(request ?? {}, ["prompt"]) ?? ""
  const workflow =
    firstString(record, ["workflow", "workflow_id", "workflowId"]) ??
    firstString(request ?? {}, ["workflow", "workflow_id", "workflowId"]) ??
    "standard"
  return {
    id,
    mediaType: normalizeMediaType(record.kind ?? record.mediaType ?? record.media_type),
    prompt,
    workflow,
    status: normalizeStatus(record.status),
    createdAt: firstString(record, ["createdAt", "created_at", "updatedAt", "updated_at"]) ?? new Date().toISOString(),
    resultUrl: getResultUrl(record),
    error: (() => {
      const rawError = firstString(record, ["error", "message"])
      return rawError ? userFacingError(rawError, "任务暂时无法完成，请稍后重试") : null
    })(),
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function PortalWorkbench({
  userName,
  userAvatar,
}: {
  userName: string
  userAvatar: string
}) {
  const [forms, setForms] = useState(() =>
    Object.fromEntries(
      MEDIA_CONFIGS.map((config) => [
        config.type,
        createFormState(config.workflows[0]?.value ?? "standard"),
      ]),
    ) as Record<MediaType, WorkbenchFormState>,
  )
  const [submitting, setSubmitting] = useState<MediaType | null>(null)
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<SubmittedJob[]>([])
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const initial = (userName || "?").trim().charAt(0).toUpperCase()

  const activeJobCount = useMemo(() => jobs.filter(isActiveJob).length, [jobs])

  async function refreshLibrary() {
    setLibraryLoading(true)
    setLibraryError(null)
    try {
      const response = await fetch("/api/library", { cache: "no-store" })
      const payload = await readJsonSafely(response)
      if (!response.ok) {
        throw new Error(`作品库暂时无法读取（${response.status}）`)
      }
      setLibrary(normalizeLibraryItems(payload))
    } catch (error) {
      setLibrary([])
      setLibraryError(userFacingError(error instanceof Error ? error.message : null, "作品库暂时无法读取"))
    } finally {
      setLibraryLoading(false)
    }
  }

  async function refreshJobs() {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" })
      const payload = await readJsonSafely(response)
      if (!response.ok) throw new Error(`任务列表暂时无法读取（${response.status}）`)
      setJobs(normalizeSubmittedJobs(payload))
    } catch {
      // Keep locally submitted jobs visible if restoration fails.
    }
  }

  useEffect(() => {
    void refreshJobs()
    void refreshLibrary()
  }, [])

  useEffect(() => {
    if (activeJobCount === 0) return

    const timer = window.setInterval(async () => {
      const activeJobs = jobs.filter(isActiveJob)
      await Promise.all(
        activeJobs.map(async (job) => {
          try {
            const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
              cache: "no-store",
            })
            const payload = await readJsonSafely(response)
            if (!response.ok) throw new Error(`查询失败（${response.status}）`)
            const record = asRecord(payload)
            const nextStatus = normalizeStatus(record?.status)
            setJobs((current) =>
              current.map((item) =>
                item.id === job.id
                  ? {
                      ...item,
                      status: nextStatus,
                      resultUrl: getResultUrl(payload) ?? item.resultUrl,
                      error: userFacingError(
                        firstString(record ?? {}, ["error", "message"]),
                        item.error ?? "任务状态暂时无法读取",
                      ),
                    }
                  : item,
              ),
            )
            if (nextStatus === "completed") void refreshLibrary()
          } catch (error) {
            setJobs((current) =>
              current.map((item) =>
                item.id === job.id
                  ? {
                      ...item,
                      error: userFacingError(error instanceof Error ? error.message : null, "状态查询失败"),
                    }
                  : item,
              ),
            )
          }
        }),
      )
    }, 3500)

    return () => window.clearInterval(timer)
  }, [activeJobCount, jobs])

  async function submitJob(config: MediaConfig) {
    const form = forms[config.type]
    const prompt = form.prompt.trim()
    if (!prompt) return

    setSubmitting(config.type)
    try {
      const response = await fetch(config.route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSubmitBody(config, form, prompt)),
      })
      const payload = await readJsonSafely(response)
      if (!response.ok) {
        const message = firstString(asRecord(payload) ?? {}, ["error", "message"])
        throw new Error(userFacingError(message, `提交失败（${response.status}）`))
      }
      const jobId = getJobId(payload)
      if (!jobId) throw new Error("提交成功但没有返回任务 ID")

      setJobs((current) => [
        {
          id: jobId,
          mediaType: config.type,
          prompt,
          workflow: form.workflow,
          status: normalizeStatus(asRecord(payload)?.status),
          createdAt: new Date().toISOString(),
          resultUrl: getResultUrl(payload),
        },
        ...current,
      ])
      setForms((current) => ({
        ...current,
        [config.type]: { ...current[config.type], prompt: "", referenceImages: [] },
      }))
    } catch (error) {
      const tempId = `local-${config.type}-${Date.now()}`
      setJobs((current) => [
        {
          id: tempId,
          mediaType: config.type,
          prompt,
          workflow: form.workflow,
          status: "failed",
          createdAt: new Date().toISOString(),
          error: userFacingError(error instanceof Error ? error.message : null, "提交失败"),
        },
        ...current,
      ])
    } finally {
      setSubmitting(null)
    }
  }

  async function cancelJob(job: SubmittedJob) {
    if (!isActiveJob(job) || job.id.startsWith("local-")) return

    setCancellingJobId(job.id)
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: "POST",
        cache: "no-store",
      })
      const payload = await readJsonSafely(response)
      if (!response.ok) {
        const message = firstString(asRecord(payload) ?? {}, ["error", "message"])
        throw new Error(userFacingError(message, "取消失败，请稍后重试"))
      }

      const record = asRecord(payload)
      const cancelled = asRecord(record?.job) ?? record
      const status = normalizeStatus(cancelled?.status)
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? { ...item, status, error: status === "cancelled" ? null : item.error }
            : item,
        ),
      )
    } catch (error) {
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? { ...item, error: userFacingError(error instanceof Error ? error.message : null, "取消失败，请稍后重试") }
            : item,
        ),
      )
    } finally {
      setCancellingJobId(null)
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.16),transparent_32rem),#0a0a0a]">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-neutral-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white">
              A
            </div>
            <span className="text-sm font-semibold tracking-tight text-white">AIGC Studio</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              {userAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={userAvatar}
                  alt={userName}
                  className="h-8 w-8 rounded-full border border-white/10 object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/30 text-sm font-medium text-indigo-200">
                  {initial}
                </div>
              )}
              <span className="hidden text-sm text-neutral-200 sm:inline">
                {userName || "创作同学"}
              </span>
            </div>
            <form action="/api/auth/logout" method="post">
              <button className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/[0.07] hover:text-white">
                登出
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="mb-8 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/20 sm:p-8">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-neutral-300">
                <Sparkles className="h-3.5 w-3.5 text-indigo-300" />
                美术创作工作台
              </div>
              <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                选择类型，写下想法，提交生成
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-400">
                这里只保留常用创作入口和个人作品库。任务提交后会自动追踪状态，完成的作品会显示在下方。
              </p>
            </div>
            {activeJobCount > 0 && (
              <div className="rounded-2xl border border-violet-400/20 bg-violet-400/10 px-4 py-3 text-sm text-violet-100">
                {activeJobCount} 个任务正在生成
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          {MEDIA_CONFIGS.map((config) => (
            <EntryCard
              key={config.type}
              config={config}
              form={forms[config.type]}
              isSubmitting={submitting === config.type}
              onChange={(next) =>
                setForms((current) => ({ ...current, [config.type]: { ...current[config.type], ...next } }))
              }
              onSubmit={() => void submitJob(config)}
            />
          ))}
        </section>

        <section className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
          <JobPanel jobs={jobs} cancellingJobId={cancellingJobId} onCancel={(job) => void cancelJob(job)} />
          <LibraryPanel
            items={library}
            loading={libraryLoading}
            error={libraryError}
            onRefresh={() => void refreshLibrary()}
          />
        </section>
      </main>
    </div>
  )
}

function EntryCard({
  config,
  form,
  isSubmitting,
  onChange,
  onSubmit,
}: {
  config: MediaConfig
  form: WorkbenchFormState
  isSubmitting: boolean
  onChange: (next: Partial<WorkbenchFormState>) => void
  onSubmit: () => void
}) {
  const Icon = config.icon
  const selectedWorkflow = config.workflows.find((item) => item.value === form.workflow)
  const canSubmit = form.prompt.trim().length > 0 && !isSubmitting

  async function handleReferenceFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const remaining = MAX_REFERENCE_IMAGES - form.referenceImages.length
    if (remaining <= 0) return
    const loaded: ReferenceImage[] = []
    for (const file of Array.from(files).slice(0, remaining)) {
      if (!file.type.startsWith("image/") || file.size > MAX_REFERENCE_BYTES) continue
      const dataUri = await readFileAsDataUri(file)
      if (dataUri) loaded.push({ name: file.name, image: dataUri })
    }
    if (loaded.length > 0) onChange({ referenceImages: [...form.referenceImages, ...loaded] })
  }

  return (
    <article className="flex min-h-[25rem] flex-col rounded-3xl border border-white/10 bg-neutral-900/70 p-5 shadow-xl shadow-black/10">
      <div className="mb-5 flex items-start gap-3">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${config.accent}`}>
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">{config.title}</h2>
          <p className="mt-1 text-sm leading-5 text-neutral-400">{config.subtitle}</p>
        </div>
      </div>

      <label className="text-xs font-medium text-neutral-300" htmlFor={`${config.type}-workflow`}>
        工作流
      </label>
      <select
        id={`${config.type}-workflow`}
        value={form.workflow}
        onChange={(event) => onChange({ workflow: event.target.value })}
        className="mt-2 rounded-xl border border-white/10 bg-neutral-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-indigo-400/70"
      >
        {config.workflows.map((workflow) => (
          <option key={workflow.value} value={workflow.value}>
            {workflow.label}
          </option>
        ))}
      </select>
      {selectedWorkflow && <p className="mt-2 text-xs text-neutral-500">{selectedWorkflow.hint}</p>}

      {config.type === "image" && (
        <div className="mt-5 space-y-4">
          <div>
            <span className="text-xs font-medium text-neutral-300">宽高比</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  type="button"
                  onClick={() => onChange({ aspectRatio: ratio.value })}
                  className={optionSegClass(form.aspectRatio === ratio.value)}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-xs font-medium text-neutral-300">尺寸</span>
            <div className="mt-2 flex gap-2">
              {IMAGE_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  onClick={() => onChange({ size: size.value })}
                  className={optionSegClass(form.size === size.value)}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>
          {form.workflow === I2I_WORKFLOW && (
          <div>
            <span className="text-xs font-medium text-neutral-300">参考图（可选，图生图）</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {form.referenceImages.map((image, index) => (
                <div
                  key={index}
                  className="relative h-14 w-14 overflow-hidden rounded-lg border border-white/10"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.image} alt={image.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ referenceImages: form.referenceImages.filter((_, i) => i !== index) })
                    }
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] text-white"
                    aria-label="移除参考图"
                  >
                    ×
                  </button>
                </div>
              ))}
              {form.referenceImages.length < MAX_REFERENCE_IMAGES && (
                <label className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-lg border border-dashed border-white/15 text-lg text-neutral-500 transition hover:border-indigo-400/60 hover:text-neutral-300">
                  +
                  <input
                    type="file"
                    accept={ACCEPTED_REFERENCE_TYPES}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void handleReferenceFiles(event.target.files)
                      event.target.value = ""
                    }}
                  />
                </label>
              )}
            </div>
            <p className="mt-1.5 text-xs text-neutral-500">
              上传后按图生图出图 · 最多 {MAX_REFERENCE_IMAGES} 张 · 单张 ≤3MB
            </p>
          </div>
          )}
        </div>
      )}

      <label className="mt-5 text-xs font-medium text-neutral-300" htmlFor={`${config.type}-prompt`}>
        提示词
      </label>
      <textarea
        id={`${config.type}-prompt`}
        value={form.prompt}
        onChange={(event) => onChange({ prompt: event.target.value })}
        placeholder={config.placeholder}
        className="mt-2 min-h-36 flex-1 resize-none rounded-xl border border-white/10 bg-neutral-950 px-3 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-neutral-600 focus:border-indigo-400/70"
      />

      <button
        type="button"
        disabled={!canSubmit}
        onClick={onSubmit}
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        提交{config.title}任务
      </button>
    </article>
  )
}

function JobPanel({
  jobs,
  cancellingJobId,
  onCancel,
}: {
  jobs: SubmittedJob[]
  cancellingJobId: string | null
  onCancel: (job: SubmittedJob) => void
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-neutral-900/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">生成任务</h2>
          <p className="mt-1 text-sm text-neutral-500">提交后自动更新状态</p>
        </div>
        <PlayCircle className="h-5 w-5 text-neutral-500" />
      </div>
      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-neutral-500">
          还没有提交任务
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.slice(0, 8).map((job) => (
            <article key={job.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-white">{mediaLabel(job.mediaType)}任务</span>
                <StatusBadge status={job.status} />
              </div>
              <p className="line-clamp-2 text-sm leading-5 text-neutral-400">{job.prompt}</p>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-neutral-600">
                <span>{relativeTime(job.createdAt)}</span>
                <span className="truncate">#{job.id}</span>
              </div>
              {job.error && <p className="mt-2 text-xs text-red-300">{job.error}</p>}
              {isActiveJob(job) && !job.id.startsWith("local-") && (
                <button
                  type="button"
                  onClick={() => onCancel(job)}
                  disabled={cancellingJobId === job.id}
                  className="mt-3 inline-flex text-xs text-neutral-400 transition hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
                >
                  {cancellingJobId === job.id ? "正在取消…" : "取消任务"}
                </button>
              )}
              {job.resultUrl && (
                <a
                  href={job.resultUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex text-xs text-indigo-300 hover:text-indigo-200"
                >
                  查看结果
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function StatusBadge({ status }: { status: JobStatus }) {
  const Icon = statusIcon(status)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${STATUS_CLASS[status]}`}>
      <Icon className={`h-3.5 w-3.5 ${status === "running" || status === "queued" ? "animate-spin" : ""}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function statusIcon(status: JobStatus): typeof Loader2 {
  if (status === "completed") return CheckCircle2
  if (status === "failed") return XCircle
  return Loader2
}

function LibraryPanel({
  items,
  loading,
  error,
  onRefresh,
}: {
  items: LibraryItem[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-neutral-900/70 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">个人作品库</h2>
          <p className="mt-1 text-sm text-neutral-500">图片、视频和 3D 资产会按类型展示</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-300 transition hover:bg-white/[0.07] hover:text-white"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </button>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="aspect-square animate-pulse rounded-2xl bg-white/[0.04]" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-6 text-sm leading-6 text-amber-100">
          {error}。如果后端作品库接口尚未启用，页面会保持可提交任务，作品区稍后刷新即可。
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
            <Sparkles className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-medium text-neutral-200">还没有作品</h3>
          <p className="mt-2 text-sm text-neutral-500">提交并完成生成后，作品会出现在这里。</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <LibraryCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  )
}

function LibraryCard({ item }: { item: LibraryItem }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="aspect-square bg-neutral-950">
        {item.mediaType === "image" ? (
          item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.imageUrl} alt={item.prompt ?? item.title} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <MediaFallback icon={ImageIcon} label="图片预览暂不可用" />
          )
        ) : item.mediaType === "video" ? (
          item.videoUrl ? (
            <video src={item.videoUrl} poster={item.thumbnailUrl ?? undefined} controls className="h-full w-full object-cover" />
          ) : item.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.thumbnailUrl} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <MediaFallback icon={Film} label="视频预览暂不可用" />
          )
        ) : item.thumbnailUrl ? (
          <div className="relative h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.thumbnailUrl} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-4 pt-16">
              <p className="text-sm font-medium text-white">3D 模型文件</p>
              {item.downloadUrl && (
                <a
                  href={item.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"
                >
                  <Download className="h-3.5 w-3.5" />
                  下载模型
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-cyan-400/10 text-cyan-200">
              <Box className="h-8 w-8" />
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-200">3D 模型文件</p>
              <p className="mt-1 text-xs text-neutral-500">无需在线预览，可直接下载使用</p>
            </div>
            {item.downloadUrl && (
              <a
                href={item.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"
              >
                <Download className="h-3.5 w-3.5" />
                下载模型
              </a>
            )}
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-neutral-400">
            {mediaLabel(item.mediaType)}
          </span>
          <span className="text-xs text-neutral-600">{relativeTime(item.createdAt)}</span>
        </div>
        <h3 className="line-clamp-1 text-sm font-medium text-white">{item.title}</h3>
        {item.prompt && <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{item.prompt}</p>}
      </div>
    </article>
  )
}

function MediaFallback({ icon: Icon, label }: { icon: typeof ImageIcon; label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-neutral-600">
      <Icon className="h-8 w-8" />
      <span className="text-xs">{label}</span>
    </div>
  )
}
