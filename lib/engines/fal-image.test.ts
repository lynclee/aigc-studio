import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SubmitRequest } from "@/lib/aigc/types"

vi.mock("@/lib/aigc/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aigc/http")>()
  return { ...actual, fetchJson: vi.fn() }
})

import { fetchJson } from "@/lib/aigc/http"
import { ensureFalImageConfigured, submitFalImage } from "@/lib/engines/fal-image"
import { ProviderInputError } from "@/lib/engines/provider-utils"
import { MissingProviderEnvError } from "@/lib/aigc/http"
import { createWorkflowJobSnapshot } from "@/lib/workflows/revision"

const fetchJsonMock = vi.mocked(fetchJson)

function request(workflowId: string): SubmitRequest {
  return { prompt: "portrait", workflowId, input: { workflow: workflowId }, userId: "user-1" }
}

describe("Fal image workflow execution metadata", () => {
  beforeEach(() => {
    process.env.FAL_KEY = "fal-secret"
    process.env.FAL_IMAGE_STANDARD_ENDPOINT = "example/standard"
    process.env.FAL_IMAGE_DETAIL_ENDPOINT = "example/detail"
    fetchJsonMock.mockResolvedValue({
      request_id: "request-1",
      status_url: "https://queue.fal.run/status/1",
      response_url: "https://queue.fal.run/result/1",
    })
  })

  afterEach(() => {
    delete process.env.FAL_KEY
    delete process.env.FAL_IMAGE_STANDARD_ENDPOINT
    delete process.env.FAL_IMAGE_DETAIL_ENDPOINT
    vi.clearAllMocks()
  })

  it("drives endpoint selection and audit identity from the catalog variant", async () => {
    const result = await submitFalImage(request("detail"), createWorkflowJobSnapshot({
      kind: "image", workflowId: "detail", provider: "fal-image",
    }))

    expect(fetchJsonMock.mock.calls[0]?.[0]).toBe("https://queue.fal.run/example/detail")
    expect(result.response).toMatchObject({
      catalog_workflow_id: "detail",
      execution_variant: "fal-image-detail",
      template_version: "1",
    })
  })

  it("uses the pinned variant even when it differs from the current public workflow mapping", async () => {
    const pinned = {
      ...createWorkflowJobSnapshot({ kind: "image", workflowId: "standard", provider: "fal-image" }),
      executionVariant: "fal-image-detail",
      templateVersion: "legacy-7",
    }
    const result = await submitFalImage(request("standard"), pinned)
    expect(fetchJsonMock.mock.calls[0]?.[0]).toBe("https://queue.fal.run/example/detail")
    expect(result.response).toMatchObject({ execution_variant: "fal-image-detail", template_version: "legacy-7" })
  })

  it("does not silently ignore reference images unsupported by the catalog", async () => {
    const withReference = request("standard")
    withReference.input.images = [{ name: "ref.png", image: "data:image/png;base64,AAAA" }]
    const snapshot = {
      ...createWorkflowJobSnapshot({ kind: "image", workflowId: "standard", provider: "fal-image" }),
      referenceCount: 1,
    }
    await expect(submitFalImage(withReference, snapshot)).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })

  it("does not report ready when only the non-default detail endpoint exists", () => {
    delete process.env.FAL_IMAGE_STANDARD_ENDPOINT
    expect(() => ensureFalImageConfigured()).toThrow(MissingProviderEnvError)
  })
})
