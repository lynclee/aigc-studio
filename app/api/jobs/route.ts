import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { jsonError } from "@/lib/jobs/api"
import { listOwnedJobs } from "@/lib/jobs/store"
import { publicJob } from "@/lib/jobs/submit-route"
import { reconcileJob } from "@/lib/jobs/reconcile"
import { serializeAsset, serializeGeneration } from "@/lib/generations/serialize"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const rows = await listOwnedJobs(session.open_id)
    const jobs = await Promise.all(
      rows.map(async (row) => {
        const reconciled = await reconcileJob(row)
        const publicRecord = publicJob(reconciled.job)
        const serializedAssets = await Promise.all(reconciled.assets.map(serializeAsset))
        return {
          ...publicRecord,
          prompt: typeof reconciled.job.request?.prompt === "string" ? reconciled.job.request.prompt : null,
          workflow: reconciled.job.workflow_id,
          resultUrl: firstAssetUrl(serializedAssets),
          generation: reconciled.generation ? await serializeGeneration(reconciled.generation, reconciled.assets) : null,
          assets: serializedAssets,
        }
      }),
    )
    return NextResponse.json({ ok: true, jobs })
  } catch (error) {
    return jsonError(error)
  }
}

function firstAssetUrl(assets: Awaited<ReturnType<typeof serializeAsset>>[]): string | null {
  for (const asset of assets) {
    if (typeof asset.url === "string" && asset.url) return asset.url
    if (typeof asset.sourceUrl === "string" && asset.sourceUrl) return asset.sourceUrl
  }
  return null
}
