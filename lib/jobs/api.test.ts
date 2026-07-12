import { describe, expect, it } from "vitest"
import { jsonError } from "@/lib/jobs/api"
import { JobInputError } from "@/lib/jobs/input"

describe("job API errors", () => {
  it("preserves stable input error codes for the client", async () => {
    const response = jsonError(new JobInputError("reference_images_total_too_large"))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "reference_images_total_too_large",
    })
  })
})
