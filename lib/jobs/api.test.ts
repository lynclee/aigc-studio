import { describe, expect, it } from "vitest"
import { jsonError } from "@/lib/jobs/api"
import { JobInputError } from "@/lib/jobs/input"
import { MissingProviderEnvError } from "@/lib/aigc/http"

describe("job API errors", () => {
  it("preserves stable input error codes for the client", async () => {
    const response = jsonError(new JobInputError("reference_images_total_too_large"))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "reference_images_total_too_large",
    })
  })

  it("does not expose provider identities or environment names to the browser", async () => {
    const response = jsonError(new MissingProviderEnvError("modal-bridge", ["MODAL_BRIDGE_API_KEY"]))

    expect(response.status).toBe(503)
    const payload = await response.json()
    expect(payload).toEqual({
      ok: false,
      error: "missing_provider_env",
      message: "Provider is not configured.",
    })
    expect(JSON.stringify(payload)).not.toContain("modal-bridge")
    expect(JSON.stringify(payload)).not.toContain("MODAL_BRIDGE_API_KEY")
  })
})
