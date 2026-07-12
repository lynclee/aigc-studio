import { describe, expect, it } from "vitest"
import { JobLeaseLostError } from "@/lib/jobs/store"
import { isLeaseLostError } from "@/lib/jobs/reconcile"

describe("reconcile lease-loss classification", () => {
  it("recognizes the typed fencing error", () => {
    expect(isLeaseLostError(new JobLeaseLostError("lost"))).toBe(true)
  })

  it("recognizes a cross-module error by stable code", () => {
    expect(isLeaseLostError({ code: "reconcile_lease_lost" })).toBe(true)
  })

  it("does not classify ordinary provider errors as lease loss", () => {
    expect(isLeaseLostError(new Error("provider failed"))).toBe(false)
  })
})
