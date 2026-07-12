import { describe, expect, it } from "vitest"
import { redactObjectSecrets } from "@/lib/jobs/store"

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
})
