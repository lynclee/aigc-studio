import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord } from "@/lib/aigc/types"

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => ({ userId: "user-1" })) }))
vi.mock("@/lib/jobs/providers", () => ({
  providerNameForKind: vi.fn(() => "modal-bridge"),
  ensureProviderConfigured: vi.fn(),
  submitProvider: vi.fn(),
}))
vi.mock("@/lib/jobs/store", () => ({
  createQueuedJob: vi.fn(),
  attachProviderSubmission: vi.fn(),
  markJobFailed: vi.fn(),
}))
vi.mock("@/lib/jobs/reconcile", () => ({ reconcileJob: vi.fn() }))

import { handleGeneratePost } from "@/lib/jobs/submit-route"
import { submitProvider } from "@/lib/jobs/providers"
import { attachProviderSubmission, createQueuedJob } from "@/lib/jobs/store"
import { reconcileJob } from "@/lib/jobs/reconcile"

const createQueuedJobMock = vi.mocked(createQueuedJob)
const submitProviderMock = vi.mocked(submitProvider)
const attachProviderSubmissionMock = vi.mocked(attachProviderSubmission)
const reconcileJobMock = vi.mocked(reconcileJob)

describe("generate submit workflow snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createQueuedJobMock.mockImplementation(async (params) => jobFrom(params.workflowSnapshot))
    submitProviderMock.mockResolvedValue({
      provider: "modal-bridge",
      providerJobId: "provider-1",
      status: "running",
      response: {
        catalog_workflow_id: "standard",
        execution_variant: "z_image_turbo",
        template_version: "1",
      },
    })
    attachProviderSubmissionMock.mockImplementation(async (job) => ({ ...job, provider_job_id: "provider-1" }))
    reconcileJobMock.mockImplementation(async (job) => ({
      job,
      generation: null,
      assets: [],
      changed: false,
    }))
  })

  it("persists the server-authored snapshot before provider submission and ignores forged snapshot fields", async () => {
    const response = await handleGeneratePost(new Request("http://localhost/api/generate/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "portrait",
        workflow: "standard",
        provider: "attacker-provider",
        workflow_revision: "attacker-revision",
        workflow_snapshot: { executionVariant: "attacker-variant" },
      }),
    }), "image")

    expect(response.status).toBe(202)
    const publicPayload = await response.json()
    expect(publicPayload).not.toHaveProperty("workflow_snapshot")
    expect(publicPayload).not.toHaveProperty("workflow_revision")
    expect(JSON.stringify(publicPayload)).not.toContain("modal-bridge")
    const createArgs = createQueuedJobMock.mock.calls[0][0]
    expect(createArgs.workflowSnapshot).toMatchObject({
      definitionRevision: "1",
      provider: "modal-bridge",
      executionVariant: "z_image_turbo",
      templateVersion: "1",
    })
    expect(JSON.stringify(createArgs.workflowSnapshot)).not.toContain("attacker")
    expect(createQueuedJobMock.mock.invocationCallOrder[0]).toBeLessThan(submitProviderMock.mock.invocationCallOrder[0])
    expect(submitProviderMock).toHaveBeenCalledWith(
      "image",
      expect.any(Object),
      expect.objectContaining({ workflowSnapshot: createArgs.workflowSnapshot }),
      "modal-bridge",
    )
  })
})

function jobFrom(workflowSnapshot: Parameters<typeof createQueuedJob>[0]["workflowSnapshot"]): AigcJobRecord {
  return {
    id: "job-1",
    user_id: "user-1",
    kind: "image",
    workflow_id: "standard",
    workflow_revision: workflowSnapshot.definitionRevision,
    workflow_snapshot: workflowSnapshot,
    status: "queued",
    provider: "modal-bridge",
    provider_job_id: null,
    provider_status_url: null,
    request: { prompt: "portrait" },
    provider_response: {},
    error: null,
    reconcile_token: null,
    reconcile_lease_until: null,
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    completed_at: null,
  }
}
