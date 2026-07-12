/**
 * 内部交付 endpoint 的统一错误响应。对外只给稳定 code，不泄露内部信息。
 */

import { NextResponse } from "next/server"
import { DeliveryTokenConfigError, DeliveryTokenError } from "@/lib/delivery/token"

export function deliveryError(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: code }, { status })
}

export function mapInternalError(error: unknown): NextResponse {
  if (error instanceof DeliveryTokenConfigError) return deliveryError(503, "delivery_unconfigured")
  if (error instanceof DeliveryTokenError) return deliveryError(401, "invalid_delivery_token")
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500
  const code =
    status >= 500
      ? "internal_error"
      : typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "bad_request"
  return deliveryError(status, code)
}
