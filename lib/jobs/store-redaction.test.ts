import { describe, expect, it } from "vitest"
import { mergeProviderResponse, redactObjectSecrets } from "@/lib/jobs/store"

describe("provider response redaction", () => {
  it("redacts credential-named fields and dynamic credentials embedded in messages", () => {
    const result = redactObjectSecrets({
      auth_key: "dynamic-key",
      nested: { delivery_token: "dynamic-token" },
      error: "upstream rejected auth_key=dynamic-secret Authorization: Bearer abc.def",
    })

    expect(result.auth_key).toBe("[redacted]")
    expect(result.nested.delivery_token).toBe("[redacted]")
    expect(result.error).not.toContain("dynamic-secret")
    expect(result.error).not.toContain("abc.def")
  })

  it("keeps immutable execution identity when a later poll returns only status fields", () => {
    expect(mergeProviderResponse(
      { catalog_workflow_id: "standard", execution_variant: "seedance2_r2v", template_version: "1" },
      { status: "running", progress: 0.5, execution_variant: "provider-overwrite" },
    )).toMatchObject({
      catalog_workflow_id: "standard",
      execution_variant: "seedance2_r2v",
      template_version: "1",
      status: "running",
      progress: 0.5,
    })
  })
})
