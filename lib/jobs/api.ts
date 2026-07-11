import { NextResponse } from "next/server"
import { HttpJsonError, MissingProviderEnvError } from "@/lib/aigc/http"
import { BackendStoreError } from "@/lib/jobs/store"

export function jsonError(error: unknown, fallbackStatus = 500): NextResponse {
  if (error instanceof MissingProviderEnvError) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_provider_env",
        provider: error.provider,
        message: "Provider is not configured.",
      },
      { status: 503 },
    )
  }
  if (error instanceof BackendStoreError) {
    return NextResponse.json(
      { ok: false, error: "backend_store_error", message: "Service temporarily unavailable." },
      { status: error.status },
    )
  }

  if (error instanceof HttpJsonError) {
    return NextResponse.json(
      { ok: false, error: "provider_http_error", message: "Provider request failed.", provider_status: error.status },
      { status: 502 },
    )
  }
  const typed = typedHttpError(error)
  if (typed) {
    const { status, code, message, exposeMessage } = typed
    if (status >= 400 && status < 500) {
      return NextResponse.json(
        { ok: false, error: code, message: exposeMessage ? message : safeMessageFor(code) },
        { status },
      )
    }
    return NextResponse.json({ ok: false, error: code, message: safeMessageFor(code) }, { status })
  }
  return NextResponse.json(
    { ok: false, error: "internal_error", message: "Internal server error." },
    { status: fallbackStatus },
  )
}

function typedHttpError(error: unknown): {
  status: number
  code: string
  message: string
  exposeMessage: boolean
} | null {
  if (!(error instanceof Error)) return null
  const candidate = error as Error & {
    status?: unknown
    code?: unknown
    publicMessage?: unknown
    exposeMessage?: unknown
  }
  if (typeof candidate.status !== "number") return null
  const code = typeof candidate.code === "string" && candidate.code ? candidate.code : "request_error"
  const message =
    typeof candidate.publicMessage === "string" && candidate.publicMessage
      ? candidate.publicMessage
      : candidate.message
  return {
    status: candidate.status,
    code,
    message,
    exposeMessage: candidate.exposeMessage === true,
  }
}

function safeMessageFor(code: string): string {
  if (code === "invalid_provider_config") return "Provider is not configured."
  if (code === "unsupported_cancel") return "Cancellation is not supported for this provider."
  if (code === "provider_contract_error") return "Provider returned an unsupported response."
  if (code === "invalid_provider_input") return "Invalid request."
  return "Request failed."
}

export async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => ({}))
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

export function readPrompt(body: Record<string, unknown>): string | null {
  const prompt = body.prompt
  if (typeof prompt !== "string") return null
  const trimmed = prompt.trim()
  return trimmed ? trimmed : null
}
