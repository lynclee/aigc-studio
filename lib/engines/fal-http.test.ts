import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SubmitRequest } from "@/lib/aigc/types"

vi.mock("@/lib/aigc/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aigc/http")>()
  return { ...actual, fetchJson: vi.fn() }
})

import { fetchJson } from "@/lib/aigc/http"
import { ProviderInputError, submitFalStyle } from "@/lib/engines/fal-http"

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
    await expect(submitFalStyle("video", request("standard", ["one"]))).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })

  it("preserves four ordered Hunyuan views", async () => {
    await submitFalStyle("model3d", request("standard", ["front", "back", "left", "right"]))

    const [url, init] = fetchJsonMock.mock.calls[0]
    expect(url).toContain("hunyuan-3d")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input_image_url: "front",
      back_image_url: "back",
      left_image_url: "left",
      right_image_url: "right",
    })
  })

  it("uses the Tripo multiview endpoint and its required view ordering", async () => {
    await submitFalStyle("model3d", request("game-asset", ["front", "back", "left", "right"]))

    const [url, init] = fetchJsonMock.mock.calls[0]
    expect(url).toContain("multiview-to-3d")
    expect(JSON.parse(String(init?.body)).image_urls).toEqual(["front", "left", "back", "right"])
  })

  it("rejects a fifth view rather than silently truncating it", async () => {
    await expect(
      submitFalStyle("model3d", request("game-asset", ["one", "two", "three", "four", "five"])),
    ).rejects.toBeInstanceOf(ProviderInputError)
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })
})
