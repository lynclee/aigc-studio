import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { jsonError } from "@/lib/jobs/api"
import { getOwnedJob } from "@/lib/jobs/store"
import { publicJob } from "@/lib/jobs/submit-route"
import { serializeAsset, serializeGeneration } from "@/lib/generations/serialize"
import { handleCancelJob } from "@/lib/jobs/cancel-route"
import { reconcileJob } from "@/lib/jobs/reconcile"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_req: Request, context: RouteContext) {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const { id } = await context.params
    let job = await getOwnedJob(id, session.open_id)
    if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 })

    const reconciled = await reconcileJob(job)
    job = reconciled.job
    const { generation, assets } = reconciled

    const publicRecord = publicJob(job)
    const serializedAssets = await Promise.all(assets.map(serializeAsset))
    return NextResponse.json({
      ok: true,
      ...publicRecord,
      resultUrl: firstAssetUrl(serializedAssets),
      job: publicRecord,
      generation: generation ? await serializeGeneration(generation, assets) : null,
      assets: serializedAssets,
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params
  return handleCancelJob(id)
}


function firstAssetUrl(assets: Awaited<ReturnType<typeof serializeAsset>>[]): string | null {
  for (const asset of assets) {
    if (typeof asset.url === "string" && asset.url) return asset.url
    if (typeof asset.sourceUrl === "string" && asset.sourceUrl) return asset.sourceUrl
  }
  return null
}
