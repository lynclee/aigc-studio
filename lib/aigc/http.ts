export class HttpJsonError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
  }
}

export class FetchJsonTimeoutError extends Error {
  public readonly code = "FETCH_JSON_TIMEOUT"
  public readonly status = 504

  constructor(public readonly timeoutMs: number) {
    super(`Upstream request timed out after ${timeoutMs}ms`)
    this.name = "FetchJsonTimeoutError"
  }
}

export class MissingProviderEnvError extends Error {
  constructor(public readonly provider: string, public readonly missing: string[]) {
    super(`${provider} missing deployment env: ${missing.join(", ")}`)
  }
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

export async function readJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch {
    return { text }
  }
}

const DEFAULT_FETCH_JSON_TIMEOUT_MS = 30_000

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_JSON_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeoutError = new FetchJsonTimeoutError(timeoutMs)
  let timedOut = false

  const abortFromCaller = () => {
    controller.abort(init.signal?.reason)
  }

  if (init.signal?.aborted) {
    abortFromCaller()
  } else {
    init.signal?.addEventListener("abort", abortFromCaller, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutError)
  }, timeoutMs)

  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: controller.signal })
    const body = await readJsonResponse(res)
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      if (typeof body.message === "string") detail = body.message
      if (typeof body.error === "string") detail = body.error
      throw new HttpJsonError(detail, res.status, body)
    }
    return body
  } catch (error) {
    if (timedOut) throw timeoutError
    throw error
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", abortFromCaller)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
