import { NextResponse } from "next/server"
import type { AigcJobRecord, AigcKind, SubmitRequest } from "@/lib/aigc/types"
import { getSession } from "@/lib/session"
import { jsonError, parseJsonObject } from "@/lib/jobs/api"
import { ensureProviderConfigured, providerNameForKind, submitProvider } from "@/lib/jobs/providers"
import { attachProviderSubmission, createQueuedJob, markJobFailed } from "@/lib/jobs/store"
import { sanitizeSubmitRequest } from "@/lib/jobs/input"
import { reconcileJob } from "@/lib/jobs/reconcile"

export async function handleGeneratePost(req: Request, kind: AigcKind): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const provider = providerNameForKind(kind)
    ensureProviderConfigured(kind, provider)
    const body = await parseJsonObject(req)
    const request: SubmitRequest = sanitizeSubmitRequest(body, kind, session.userId, provider)
    const job = await createQueuedJob({
      userId: session.userId,
      kind,
      provider,
      request,
    })

    let updatedJob: AigcJobRecord
    try {
      const submission = await submitProvider(kind, request, { jobId: job.id }, provider)
      updatedJob = await attachProviderSubmission(job.id, submission)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markJobFailed(job.id, message)
      return jsonError(error, 502)
    }

    const { job: finalJob } = await reconcileJob(updatedJob)
    const publicRecord = publicJob(finalJob)
    return NextResponse.json({ ok: true, ...publicRecord, job: publicRecord }, { status: 202 })
  } catch (error) {
    return jsonError(error)
  }
}

export function publicJob(job: {
  id: string
  kind: AigcKind
  status: string
  workflow_id: string
  created_at: string
  updated_at: string
  completed_at: string | null
  error: string | null
}): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    workflow_id: job.workflow_id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
    error: job.status === "failed" ? publicJobErrorCode(job.error) : null,
  }
}

function publicJobErrorCode(error: string | null): "generation_failed" | "storage_failed" {
  const normalized = error?.toLowerCase() ?? ""
  if (
    normalized.includes("r2") ||
    normalized.includes("storage") ||
    normalized.includes("asset") ||
    normalized.includes("materialize")
  ) {
    return "storage_failed"
  }
  return "generation_failed"
}
