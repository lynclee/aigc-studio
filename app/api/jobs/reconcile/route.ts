import { NextResponse } from "next/server"
import { jsonError } from "@/lib/jobs/api"
import { reconcileJob } from "@/lib/jobs/reconcile"
import { listActiveJobs } from "@/lib/jobs/store"
import { cleanupOrphanDeliveries, type OrphanCleanupResult } from "@/lib/delivery/cleanup"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization")
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  try {
    const jobs = await listActiveJobs(50)
    let succeeded = 0
    let failedJobs = 0
    let reconcileErrors = 0
    let unchanged = 0
    let changed = 0
    const failureSamples: FailureSample[] = []

    for (const job of jobs) {
      try {
        const result = await reconcileJob(job)
        if (result.changed) changed += 1
        else unchanged += 1
        if (result.job.status === "succeeded") succeeded += 1
        if (result.job.status === "failed") failedJobs += 1
      } catch (error) {
        reconcileErrors += 1
        const sample = sanitizeFailureSample(job.id, error)
        console.error("job reconcile error", sample)
        if (failureSamples.length < 10) failureSamples.push(sample)
      }
    }

    // 对账后清理 aigc-r2 交付的孤儿 R2 对象(上传中 cancel / 核验失败留下的)。失败不影响对账结果。
    let orphanCleanup: OrphanCleanupResult = { scanned: 0, deleted: 0, reconciled: 0, failed: 0 }
    try {
      orphanCleanup = await cleanupOrphanDeliveries(100)
    } catch (error) {
      console.error("orphan cleanup error", { type: error instanceof Error ? error.name : typeof error })
    }

    return NextResponse.json({
      ok: true,
      checked: jobs.length,
      changed,
      unchanged,
      succeeded,
      failed: failedJobs,
      failedJobs,
      reconcileErrors,
      failureSamples,
      orphanCleanup,
    })
  } catch (error) {
    return jsonError(error)
  }
}

type FailureSample = {
  jobId: string
  errorType: string
  code: string
}

function sanitizeFailureSample(jobId: string, error: unknown): FailureSample {
  const errorRecord = isObjectRecord(error) ? error : null
  const rawType = error instanceof Error ? error.name || error.constructor.name : typeof error
  const rawCode = errorRecord && typeof errorRecord.code === "string" ? errorRecord.code : rawType

  return {
    jobId,
    errorType: sanitizeStableToken(rawType, "unknown_error"),
    code: sanitizeStableToken(rawCode, "unknown_error"),
  }
}

function sanitizeStableToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const sanitized = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)
  return sanitized || fallback
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
