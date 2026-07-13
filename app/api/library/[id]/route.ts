import { NextResponse } from "next/server"
import { tombstoneGenerationAssets } from "@/lib/assets/delete"
import { jsonError } from "@/lib/jobs/api"
import { getSession } from "@/lib/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function DELETE(_req: Request, context: RouteContext) {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_generation_id" }, { status: 400 })
  }

  try {
    const result = await tombstoneGenerationAssets(id, session.userId)
    // Missing and cross-owner IDs intentionally have the same response.
    if (!result.found) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 })

    const status = result.pendingAssets > 0
      ? "pending_delete"
      : result.errorAssets > 0
        ? "error"
        : "deleted"
    return NextResponse.json(
      {
        ok: true,
        id: result.generationId,
        status,
        pendingAssets: result.pendingAssets,
        deletedAssets: result.deletedAssets,
        errorAssets: result.errorAssets,
      },
      { status: result.pendingAssets > 0 ? 202 : 200 },
    )
  } catch (error) {
    return jsonError(error)
  }
}
