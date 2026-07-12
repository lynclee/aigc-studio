import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { jsonError } from "@/lib/jobs/api"
import { listUserLibrary } from "@/lib/jobs/store"
import { serializeAsset, serializeGeneration } from "@/lib/generations/serialize"
import { assetRuleForWorkflow } from "@/lib/workflows/definitions"
import type { AigcKind } from "@/lib/aigc/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const { generations, assets } = await listUserLibrary(session.userId)
    const assetsByGeneration = new Map<string, typeof assets>()
    for (const asset of assets) {
      const list = assetsByGeneration.get(asset.generation_id) ?? []
      list.push(asset)
      assetsByGeneration.set(asset.generation_id, list)
    }

    const serializedGenerations = await Promise.all(
      generations.map((generation) => serializeGeneration(generation, assetsByGeneration.get(generation.id) ?? [])),
    )
    const serializedAssets = await Promise.all(assets.map(serializeAsset))
    const items = serializedGenerations.map(flattenLibraryItem)

    return NextResponse.json({
      ok: true,
      items,
      generations: serializedGenerations,
      assets: serializedAssets,
    })
  } catch (error) {
    return jsonError(error)
  }
}

export function flattenLibraryItem(generation: Record<string, unknown>): Record<string, unknown> {
  const assets = Array.isArray(generation.assets)
    ? generation.assets.filter((asset): asset is Record<string, unknown> => typeof asset === "object" && asset !== null && !Array.isArray(asset))
    : []
  const kind = kindFrom(generation.kind)
  const workflowId = stringFrom(generation.workflow_id) ?? "standard"
  const primary = pickPrimaryAsset(assets, kind, workflowId)
  const thumbnail = assets.find((asset) => asset.asset_type === "preview")
    ?? assets.find((asset) => asset.asset_type === "image")
  const video = assets.find((asset) => asset.asset_type === "video")
  const url = stringFrom(primary?.url) ?? stringFrom(thumbnail?.url) ?? stringFrom(video?.url)
  const thumbnailUrl = stringFrom(thumbnail?.url)
    ?? (kind === "image" ? stringFrom(primary?.url) : undefined)

  return {
    id: generation.id,
    mediaType: generation.kind,
    title: titleFrom(generation),
    prompt: generation.prompt,
    createdAt: generation.created_at,
    url,
    downloadUrl: url,
    thumbnailUrl,
    videoUrl: stringFrom(video?.url) ?? (generation.kind === "video" ? url : undefined),
  }
}

function pickPrimaryAsset(
  assets: Record<string, unknown>[],
  kind: AigcKind,
  workflowId: string,
): Record<string, unknown> | undefined {
  const declared = assets.find((asset) => {
    const assetType = stringFrom(asset.asset_type)
    return assetType ? assetRuleForWorkflow(kind, workflowId, assetType)?.primary === true : false
  })
  if (declared) return declared

  // Legacy rows may predate the workflow output contract or use the old thumbnail name.
  const fallbackTypes = kind === "image" ? ["image"] : kind === "video" ? ["video"] : ["model", "model3d"]
  return assets.find((asset) => fallbackTypes.includes(String(asset.asset_type))) ?? assets[0]
}

function kindFrom(value: unknown): AigcKind {
  return value === "video" || value === "model3d" ? value : "image"
}

function titleFrom(generation: Record<string, unknown>): string {
  const prompt = stringFrom(generation.prompt)
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt
  const kind = stringFrom(generation.kind) ?? "AIGC"
  return `${kind} generation`
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
