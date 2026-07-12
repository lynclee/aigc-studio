import { describe, expect, it } from "vitest"
import { serializeGeneration } from "@/lib/generations/serialize"
import type { AigcGenerationRecord } from "@/lib/aigc/types"

describe("public generation serialization", () => {
  it("exposes the public workflow identity without leaking the provider", async () => {
    const generation = {
      id: "generation-1",
      job_id: "job-1",
      user_id: "user-1",
      kind: "video",
      workflow_id: "standard",
      prompt: "clip",
      provider: "modal-bridge",
      provider_job_id: "provider-job-1",
      metadata: {},
      created_at: "2026-07-12T00:00:00.000Z",
    } satisfies AigcGenerationRecord

    const serialized = await serializeGeneration(generation, [])
    expect(serialized).toMatchObject({ workflow_id: "standard" })
    expect(serialized).not.toHaveProperty("provider")
    expect(serialized).not.toHaveProperty("provider_job_id")
    expect(JSON.stringify(serialized)).not.toContain("modal-bridge")
  })
})
