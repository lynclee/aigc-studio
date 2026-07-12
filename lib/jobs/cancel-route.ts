import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { jsonError } from "@/lib/jobs/api"
import { cancelProviderJob } from "@/lib/jobs/providers"
import { getOwnedJob, markJobCancelled, terminalStatus } from "@/lib/jobs/store"
import { publicJob } from "@/lib/jobs/submit-route"

class ReconcileLeaseActiveError extends Error {
  readonly status = 409
  readonly code = "retry_later"
  readonly exposeMessage = true

  constructor() {
    super("Job is currently being reconciled. Retry cancellation later.")
  }
}

export async function handleCancelJob(jobId: string): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  try {
    const job = await getOwnedJob(jobId, session.userId)
    if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 })
    if (terminalStatus(job.status)) {
      return NextResponse.json({ ok: false, error: "job_already_terminal", job: publicJob(job) }, { status: 409 })
    }
    if (hasActiveReconcileLease(job)) {
      throw new ReconcileLeaseActiveError()
    }

    const providerResponse = await cancelProviderJob(job)
    const cancelled = await markJobCancelled(job, providerResponse)
    return NextResponse.json({ ok: true, job: publicJob(cancelled) })
  } catch (error) {
    return jsonError(error)
  }
}

function hasActiveReconcileLease(job: object): boolean {
  const leasedJob = job as { reconcile_token?: unknown; reconcile_lease_until?: unknown }
  if (typeof leasedJob.reconcile_token !== "string" || !leasedJob.reconcile_token) return false
  if (typeof leasedJob.reconcile_lease_until !== "string") return false
  const leaseUntil = Date.parse(leasedJob.reconcile_lease_until)
  return Number.isFinite(leaseUntil) && leaseUntil > Date.now()
}
