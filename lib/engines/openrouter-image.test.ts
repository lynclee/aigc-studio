import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SubmitRequest } from "@/lib/aigc/types"

vi.mock("@/lib/aigc/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aigc/http")>()
  return { ...actual, fetchJson: vi.fn() }
})
vi.mock("@/lib/assets/r2-direct", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assets/r2-direct")>()
  return { ...actual, storeImageBytesInR2: vi.fn() }
})

import { fetchJson } from "@/lib/aigc/http"
import { storeImageBytesInR2 } from "@/lib/assets/r2-direct"
import { submitOpenRouterImage } from "@/lib/engines/openrouter-image"
import { ProviderInputError } from "@/lib/engines/provider-utils"
import { createWorkflowJobSnapshot } from "@/lib/workflows/revision"

const fetchJsonMock = vi.mocked(fetchJson)
const storeImageBytesInR2Mock = vi.mocked(storeImageBytesInR2)

function request(workflowId: string): SubmitRequest {
  return { prompt: "portrait", workflowId, input: { workflow: workflowId }, userId: "user-1" }
}

describe("OpenRouter image workflow execution metadata", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "or-secret"
    process.env.OPENROUTER_IMAGE_MODEL = "default-model"
    process.env.OPENROUTER_IMAGE_STANDARD_MODEL = "standard-model"
    process.env.OPENROUTER_IMAGE_DETAIL_MODEL = "detail-model"
    fetchJsonMock.mockResolvedValue({
      data: [{ b64_json: Buffer.from("image-bytes").toString("base64"), media_type: "image/png" }],
      usage: { images: 1 },
    })
    storeImageBytesInR2Mock.mockResolvedValue({
      assetType: "image",
      position: 0,
      r2Key: "user-1/job/image-0.png",
      contentType: "image/png",
    })
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_IMAGE_MODEL
    delete process.env.OPENROUTER_IMAGE_STANDARD_MODEL
    delete process.env.OPENROUTER_IMAGE_DETAIL_MODEL
    vi.clearAllMocks()
  })

  it("uses the catalog variant for model selection and persists its audit identity", async () => {
    const result = await submitOpenRouterImage(request("detail"), createWorkflowJobSnapshot({
      kind: "image", workflowId: "detail", provider: "openrouter-image",
    }))

    const requestBody = JSON.parse(String(fetchJsonMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.model).toBe("detail-model")
    expect(result.response).toMatchObject({
      model: "detail-model",
      catalog_workflow_id: "detail",
      execution_variant: "openrouter-detail",
      template_version: "1",
    })
  })

  it("uses the pinned variant instead of resolving the live catalog again", async () => {
    const pinned = {
      ...createWorkflowJobSnapshot({ kind: "image", workflowId: "standard", provider: "openrouter-image" }),
      executionVariant: "openrouter-detail",
      templateVersion: "legacy-7",
    }
    const result = await submitOpenRouterImage(request("standard"), pinned)
    const requestBody = JSON.parse(String(fetchJsonMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.model).toBe("detail-model")
    expect(result.response).toMatchObject({ execution_variant: "openrouter-detail", template_version: "legacy-7" })
  })

  it("does not silently ignore reference images unsupported by the catalog", async () => {
    const withReference = request("standard")
    withReference.input.images = [{ name: "ref.png", image: "data:image/png;base64,AAAA" }]
    const snapshot = {
      ...createWorkflowJobSnapshot({ kind: "image", workflowId: "standard", provider: "openrouter-image" }),
      referenceCount: 1,
    }
    await expect(submitOpenRouterImage(withReference, snapshot)).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })
})
