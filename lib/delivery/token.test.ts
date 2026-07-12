import { beforeEach, describe, expect, it } from "vitest"
import { DeliveryTokenError, signDeliveryToken, verifyDeliveryToken } from "@/lib/delivery/token"

const SECRET = "test-secret-at-least-32-chars-long-000"

beforeEach(() => {
  process.env.BRIDGE_DELIVERY_TOKEN_SECRET = SECRET
})

describe("delivery token", () => {
  it("round-trips and binds jobId + userId", () => {
    const token = signDeliveryToken({ jobId: "job-1", userId: "user-1" })
    const claims = verifyDeliveryToken(token)
    expect(claims.jobId).toBe("job-1")
    expect(claims.userId).toBe("user-1")
    expect(claims.exp).toBeGreaterThan(Date.now())
  })

  it("rejects a tampered payload (can't swap job/user)", () => {
    const token = signDeliveryToken({ jobId: "job-1", userId: "user-1" })
    const [v, , sig] = token.split(".")
    const forged = Buffer.from(JSON.stringify({ j: "job-2", u: "user-1", e: Date.now() + 1_000_000 })).toString("base64url")
    expect(() => verifyDeliveryToken(`${v}.${forged}.${sig}`)).toThrow(DeliveryTokenError)
  })

  it("rejects a tampered signature", () => {
    const parts = signDeliveryToken({ jobId: "j", userId: "u" }).split(".")
    parts[2] = `${parts[2].slice(0, -2)}xx`
    expect(() => verifyDeliveryToken(parts.join("."))).toThrow(DeliveryTokenError)
  })

  it("rejects an expired token", () => {
    const expired = signDeliveryToken({ jobId: "j", userId: "u" }, -1_000)
    expect(() => verifyDeliveryToken(expired)).toThrow(DeliveryTokenError)
  })

  it("rejects a token signed with a different secret", () => {
    const token = signDeliveryToken({ jobId: "j", userId: "u" })
    process.env.BRIDGE_DELIVERY_TOKEN_SECRET = "another-secret-another-another-00000000"
    expect(() => verifyDeliveryToken(token)).toThrow(DeliveryTokenError)
  })

  it("rejects non-string / malformed tokens", () => {
    expect(() => verifyDeliveryToken(123 as unknown)).toThrow(DeliveryTokenError)
    expect(() => verifyDeliveryToken("a.b")).toThrow(DeliveryTokenError)
    expect(() => verifyDeliveryToken("v2.x.y")).toThrow(DeliveryTokenError)
  })
})
