import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AigcJobRecord, SubmitRequest } from "@/lib/aigc/types"

vi.mock("@/lib/aigc/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aigc/http")>()
  return { ...actual, fetchJson: vi.fn() }
})

import { fetchJson } from "@/lib/aigc/http"
import { getFalStyleStatus, ProviderInputError, submitFalStyle } from "@/lib/engines/fal-http"
import { createWorkflowJobSnapshot } from "@/lib/workflows/revision"

const fetchJsonMock = vi.mocked(fetchJson)

function request(workflowId: string, images: string[] = []): SubmitRequest {
  return {
    prompt: "asset",
    workflowId,
    input: {
      workflow: workflowId,
      ...(images.length > 0 ? { images: images.map((image, index) => ({ name: `${index}.png`, image })) } : {}),
    },
    userId: "user-1",
  }
}

function snapshot(kind: "video" | "model3d", workflowId: string, referenceCount = 0) {
  const provider = kind === "video" ? "fal-video" : "fal-model3d"
  return createWorkflowJobSnapshot({ kind, workflowId, provider, referenceCount })
}

describe("fal reference-image contracts", () => {
  beforeEach(() => {
    process.env.FAL_KEY = "fal-secret"
    fetchJsonMock.mockResolvedValue({
      request_id: "request-1",
      status_url: "https://queue.fal.run/status/1",
      response_url: "https://queue.fal.run/result/1",
    })
  })

  afterEach(() => {
    delete process.env.FAL_KEY
    vi.clearAllMocks()
  })

  it("rejects reference images before calling the configured text-to-video endpoint", async () => {
    const invalid = { ...snapshot("video", "standard"), referenceCount: 1 }
    await expect(submitFalStyle("video", request("standard", ["one"]), invalid)).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })

  it("preserves four ordered Hunyuan views", async () => {
    const result = await submitFalStyle("model3d", request("standard", ["front", "back", "left", "right"]), snapshot("model3d", "standard", 4))

    const [url, init] = fetchJsonMock.mock.calls[0]
    expect(url).toContain("hunyuan-3d")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input_image_url: "front",
      back_image_url: "back",
      left_image_url: "left",
      right_image_url: "right",
    })
    expect(result.response).toMatchObject({
      catalog_workflow_id: "standard",
      execution_variant: "hunyuan3d-image",
      template_version: "1",
    })
  })

  it("uses the Tripo multiview endpoint and its required view ordering", async () => {
    const result = await submitFalStyle("model3d", request("game-asset", ["front", "back", "left", "right"]), snapshot("model3d", "game-asset", 4))

    const [url, init] = fetchJsonMock.mock.calls[0]
    expect(url).toContain("multiview-to-3d")
    expect(JSON.parse(String(init?.body)).image_urls).toEqual(["front", "left", "back", "right"])
    expect(result.response.execution_variant).toBe("tripo3d-multiview")
  })

  it("selects and records the single-image Tripo execution separately", async () => {
    const result = await submitFalStyle("model3d", request("game-asset", ["front"]), snapshot("model3d", "game-asset", 1))

    const [url] = fetchJsonMock.mock.calls[0]
    expect(url).toContain("image-to-3d")
    expect(url).not.toContain("multiview-to-3d")
    expect(result.response.execution_variant).toBe("tripo3d-image")
  })

  it("records the catalog identity for Fal text-to-video", async () => {
    const result = await submitFalStyle("video", request("standard"), snapshot("video", "standard"))
    expect(result.response).toMatchObject({
      catalog_workflow_id: "standard",
      execution_variant: "fal-wan25-t2v",
      template_version: "1",
    })
  })

  it("routes a text-to-3D submission by the pinned historical variant", async () => {
    const pinned = {
      ...snapshot("model3d", "game-asset"),
      executionVariant: "hunyuan3d",
      templateVersion: "legacy-7",
    }
    const result = await submitFalStyle("model3d", request("game-asset"), pinned)
    expect(fetchJsonMock.mock.calls[0]?.[0]).toContain("hunyuan-3d")
    expect(result.response).toMatchObject({ execution_variant: "hunyuan3d", template_version: "legacy-7" })
  })

  it("rejects a fifth view rather than silently truncating it", async () => {
    await expect(
      submitFalStyle(
        "model3d",
        request("game-asset", ["one", "two", "three", "four", "five"]),
        { ...snapshot("model3d", "game-asset", 4), referenceCount: 5 },
      ),
    ).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      kind: "video" as const,
      result: { video: { url: "https://cdn.example/clip.mp4" }, thumbnail_url: "https://cdn.example/clip.png" },
      primaryType: "video",
    },
    {
      kind: "model3d" as const,
      result: { model_glb: { url: "https://cdn.example/model.glb" }, rendered_image: { url: "https://cdn.example/model.png" } },
      primaryType: "model",
    },
  ])("normalizes $kind thumbnails to the preview output type", async ({ kind, result, primaryType }) => {
    fetchJsonMock
      .mockResolvedValueOnce({ status: "COMPLETED" })
      .mockResolvedValueOnce(result)
    const job = {
      id: "job-1",
      user_id: "user-1",
      kind,
      workflow_id: "standard",
      workflow_revision: null,
      workflow_snapshot: null,
      status: "running",
      provider: kind === "video" ? "fal-video" : "fal-model3d",
      provider_job_id: "request-1",
      provider_status_url: "https://queue.fal.run/status/1",
      request: {},
      provider_response: { response_url: "https://queue.fal.run/result/1" },
      error: null,
      reconcile_token: null,
      reconcile_lease_until: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    } as AigcJobRecord

    const status = await getFalStyleStatus(job)
    expect(status.assets.map((asset) => asset.assetType)).toEqual([primaryType, "preview"])
  })
})
