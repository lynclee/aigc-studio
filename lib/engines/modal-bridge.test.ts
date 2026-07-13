import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord, SubmitRequest } from "@/lib/aigc/types"

vi.mock("@/lib/aigc/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aigc/http")>()
  return { ...actual, fetchJson: vi.fn() }
})
vi.mock("@/lib/workflows/registry", () => ({ renderWorkflow: vi.fn() }))
vi.mock("@/lib/delivery/token", () => ({ signDeliveryToken: vi.fn() }))
vi.mock("@/lib/delivery/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/delivery/verify")>()
  return { ...actual, verifyDeliveredAssets: vi.fn() }
})

import { fetchJson } from "@/lib/aigc/http"
import { signDeliveryToken } from "@/lib/delivery/token"
import { verifyDeliveredAssets } from "@/lib/delivery/verify"
import { getModalBridgeStatus, submitModalBridge } from "@/lib/engines/modal-bridge"
import { renderWorkflow } from "@/lib/workflows/registry"
import { createWorkflowJobSnapshot } from "@/lib/workflows/revision"

const fetchJsonMock = vi.mocked(fetchJson)
const renderWorkflowMock = vi.mocked(renderWorkflow)
const signDeliveryTokenMock = vi.mocked(signDeliveryToken)
const verifyDeliveredAssetsMock = vi.mocked(verifyDeliveredAssets)

const request: SubmitRequest = {
  prompt: "a studio portrait",
  workflowId: "standard",
  input: {
    workflow: "standard",
    images: [{ name: "reference.png", image: "data:image/png;base64,AAAA" }],
  },
  userId: "user-1",
}

const workflowSnapshot = {
  ...createWorkflowJobSnapshot({
    kind: "image", workflowId: "standard", provider: "modal-bridge", referenceCount: 1,
  }),
  executionVariant: "workflow-v1",
  templateVersion: "3",
}

const job: AigcJobRecord = {
  id: "job-1",
  user_id: "user-1",
  kind: "image",
  workflow_id: "standard",
  workflow_revision: workflowSnapshot.definitionRevision,
  workflow_snapshot: workflowSnapshot,
  status: "running",
  provider: "modal-bridge",
  provider_job_id: "bridge-job-1",
  provider_status_url: null,
  request: {},
  provider_response: {},
  error: null,
  reconcile_token: null,
  reconcile_lease_until: null,
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
  completed_at: null,
}

describe("Modal Bridge contract", () => {
  beforeEach(() => {
    process.env.MODAL_BRIDGE_ENDPOINT_BASE = "https://bridge.example/endpoint/"
    process.env.MODAL_BRIDGE_API_KEY = "bridge-secret"
    renderWorkflowMock.mockReturnValue({
      id: "workflow-v1",
      templateVersion: "3",
      workflow: { "1": { class_type: "SaveImage" } },
      needsGpu: false,
      gpuClass: "cheap",
      width: 1024,
      height: 768,
      seed: 42,
    })
    signDeliveryTokenMock.mockReturnValue("delivery-secret")
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.MODAL_BRIDGE_ENDPOINT_BASE
    delete process.env.MODAL_BRIDGE_API_KEY
  })

  it("submits the versioned workflow with an aigc-r2 delivery grant without persisting secrets", async () => {
    fetchJsonMock.mockResolvedValue({ id: "bridge-job-1", status: "queued", gpu: "cpu" })

    const result = await submitModalBridge("image", request, { jobId: "job-1", workflowSnapshot })

    expect(signDeliveryTokenMock).toHaveBeenCalledWith({ jobId: "job-1", userId: "user-1" })
    expect(renderWorkflowMock).toHaveBeenCalledWith("image", expect.objectContaining({ workflowSnapshot }))
    expect(fetchJsonMock).toHaveBeenCalledOnce()
    const [url, init] = fetchJsonMock.mock.calls[0]
    expect(url).toBe("https://bridge.example/endpoint-run.modal.run")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({
      workflow: { "1": { class_type: "SaveImage" } },
      auth_key: "bridge-secret",
      needs_gpu: false,
      gpu_class: "cheap",
      images: request.input.images,
      delivery: { mode: "aigc-r2", job_id: "job-1", token: "delivery-secret" },
    })
    expect(result).toEqual({
      provider: "modal-bridge",
      providerJobId: "bridge-job-1",
      status: "running",
      response: {
        id: "bridge-job-1",
        catalog_workflow_id: "standard",
        execution_variant: "workflow-v1",
        template_version: "3",
        gpu: "cpu",
        settings: { width: 1024, height: 768, seed: 42 },
      },
    })
    expect(JSON.stringify(result)).not.toContain("bridge-secret")
    expect(JSON.stringify(result)).not.toContain("delivery-secret")
  })

  it.each(["queued", "running", "delivering"])("maps %s to the platform running state", async (status) => {
    fetchJsonMock.mockResolvedValue({ status })

    const result = await getModalBridgeStatus(job)

    expect(result.status).toBe("running")
    expect(result.assets).toEqual([])
  })

  it("recovers a completed push from the status delivery manifest", async () => {
    const manifest = [{
      asset_type: "image",
      position: 0,
      r2_key: "aigc/user-1/job-1/image-0.png",
      content_type: "image/png",
      size_bytes: 123,
      etag: "etag-1",
    }]
    const beforeCopy = vi.fn(async () => undefined)
    fetchJsonMock.mockResolvedValue({
      status: "completed",
      delivery: { mode: "aigc-r2", status: "callback_failed", assets: manifest },
    })
    verifyDeliveredAssetsMock.mockResolvedValue([{
      output: { assetType: "image", position: 0, r2Key: "aigc/user-1/job-1/image-0.png" },
      etag: "etag-1",
      sizeBytes: 123,
      stagingKey: "aigc/user-1/job-1/.staging/image-0.png",
    }])

    const result = await getModalBridgeStatus(job, beforeCopy)

    expect(verifyDeliveredAssetsMock).toHaveBeenCalledWith(job, manifest, { beforeCopy })
    expect(result.status).toBe("succeeded")
    expect(result.assets).toEqual([
      { assetType: "image", position: 0, r2Key: "aigc/user-1/job-1/image-0.png" },
    ])
  })

  it("does not accept completed without an asset manifest", async () => {
    fetchJsonMock.mockResolvedValue({ status: "completed", delivery: { mode: "aigc-r2", assets: [] } })

    const result = await getModalBridgeStatus(job)

    expect(result.status).toBe("failed")
    expect(result.error).toBe("Modal Bridge completed without a delivery manifest")
    expect(verifyDeliveredAssetsMock).not.toHaveBeenCalled()
  })
})
