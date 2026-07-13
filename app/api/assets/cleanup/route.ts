import { NextResponse } from "next/server"
import {
  getAssetDeleteBacklog,
  processPendingAssetDeletes,
  type AssetDeleteBacklog,
  type AssetDeleteCleanupResult,
} from "@/lib/assets/delete"
import { jsonError } from "@/lib/jobs/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const BATCH_SIZE = 25
const MAX_BATCHES = 4
const WORK_BUDGET_MS = 45_000

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization")
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  try {
    const startedAt = Date.now()
    const assetDeleteCleanup = emptyCleanupResult()
    let batches = 0
    while (batches < MAX_BATCHES && Date.now() - startedAt < WORK_BUDGET_MS) {
      const batch = await processPendingAssetDeletes(BATCH_SIZE)
      addCleanupResult(assetDeleteCleanup, batch)
      batches += 1
      if (batch.scanned < BATCH_SIZE && batch.deadlettered < BATCH_SIZE) break
    }
    let assetDeleteBacklog: AssetDeleteBacklog | null = null
    try {
      assetDeleteBacklog = await getAssetDeleteBacklog()
      if (assetDeleteBacklog.errorTotal > 0) {
        console.error("asset delete dead letters present", { errorTotal: assetDeleteBacklog.errorTotal })
      }
    } catch (error) {
      // Queue work has already committed. Monitoring degradation must remain
      // visible without misreporting the successful destructive batch as 500.
      console.error("asset delete backlog monitor error", {
        type: error instanceof Error ? error.name : typeof error,
      })
    }
    return NextResponse.json({ ok: true, batches, assetDeleteCleanup, assetDeleteBacklog })
  } catch (error) {
    console.error("asset delete cleanup cron error", {
      type: error instanceof Error ? error.name : typeof error,
    })
    return jsonError(error)
  }
}

function emptyCleanupResult(): AssetDeleteCleanupResult {
  return {
    scanned: 0,
    deadlettered: 0,
    deleted: 0,
    retained: 0,
    failed: 0,
    exhausted: 0,
    conflicted: 0,
  }
}

function addCleanupResult(total: AssetDeleteCleanupResult, batch: AssetDeleteCleanupResult): void {
  for (const key of Object.keys(total) as Array<keyof AssetDeleteCleanupResult>) {
    total[key] += batch[key]
  }
}
