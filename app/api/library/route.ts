import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { jsonError } from "@/lib/jobs/api"
import { listUserLibrary } from "@/lib/jobs/store"
import { serializeAsset, serializeGeneration } from "@/lib/generations/serialize"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const { generations, assets } = await listUserLibrary(session.open_id)
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

function flattenLibraryItem(generation: Record<string, unknown>): Record<string, unknown> {
  const assets = Array.isArray(generation.assets)
    ? generation.assets.filter((asset): asset is Record<string, unknown> => typeof asset === "object" && asset !== null && !Array.isArray(asset))
    : []
  const primary = pickPrimaryAsset(assets, String(generation.kind ?? ""))
  const thumbnail = assets.find((asset) => asset.asset_type === "image")
  const video = assets.find((asset) => asset.asset_type === "video")
  const url = stringFrom(primary?.url) ?? stringFrom(thumbnail?.url) ?? stringFrom(video?.url)

  return {
    id: generation.id,
    mediaType: generation.kind,
    title: titleFrom(generation),
    prompt: generation.prompt,
    createdAt: generation.created_at,
    url,
    downloadUrl: url,
    thumbnailUrl: stringFrom(thumbnail?.url) ?? url,
    videoUrl: stringFrom(video?.url) ?? (generation.kind === "video" ? url : undefined),
  }
}

function pickPrimaryAsset(assets: Record<string, unknown>[], kind: string): Record<string, unknown> | undefined {
  let preferred = "image"
  if (kind === "video") preferred = "video"
  if (kind === "model3d") preferred = "model"
  return assets.find((asset) => asset.asset_type === preferred) ?? assets[0]
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
