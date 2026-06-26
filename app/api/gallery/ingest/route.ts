/**
 * POST /api/gallery/ingest —— 作品画廊「回写」入口,给 comfyui_modal_bridge 插件用。
 *
 * 数据流:美术同学的 bridge 插件出图 → 图先直传 Cloudflare R2(key 带 open_id
 * 前缀做隔离)→ 插件带上门户的 BRIDGE_API_KEY,POST 这个 endpoint 写一条索引到
 * Supabase `gallery_items` 表 → 门户(app/portal/page.tsx)按登录用户 open_id 读取展示。
 *
 * 鉴权:`Authorization: Bearer <BRIDGE_API_KEY>`,与 env BRIDGE_API_KEY 比对,
 * 不匹配 401。这是「机器对机器」的共享密钥,不是用户会话 —— 插件侧配置同一个 key。
 *
 * ⚠️ 用 service_role 写库(绕过 RLS),不依赖 Supabase Auth。
 */

import { NextResponse } from "next/server"
import { getSupabaseAdmin } from "@/lib/supabase/admin"

// 需要 node runtime:service_role 客户端 + 读 server-only env
export const runtime = "nodejs"

interface IngestBody {
  open_id?: unknown
  r2_key?: unknown
  prompt?: unknown
  source?: unknown
}

export async function POST(req: Request) {
  // 1) 鉴权:共享密钥
  const expected = process.env.BRIDGE_API_KEY
  if (!expected) {
    // 未配置 key 时直接 500 —— 否则任何人都能裸写,宁可拒绝
    return NextResponse.json(
      { ok: false, error: "BRIDGE_API_KEY 未配置" },
      { status: 500 },
    )
  }
  const auth = req.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : ""
  if (!token || token !== expected) {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401 })
  }

  // 2) 解析 body
  let body: IngestBody
  try {
    body = (await req.json()) as IngestBody
  } catch {
    return NextResponse.json({ ok: false, error: "请求体非法 JSON" }, { status: 400 })
  }

  const openId = typeof body.open_id === "string" ? body.open_id.trim() : ""
  const r2Key = typeof body.r2_key === "string" ? body.r2_key.trim() : ""
  if (!openId || !r2Key) {
    return NextResponse.json(
      { ok: false, error: "缺少 open_id 或 r2_key" },
      { status: 400 },
    )
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : null
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "bridge"

  // 3) 写库(service_role)
  const admin = getSupabaseAdmin()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Supabase 未配置" },
      { status: 500 },
    )
  }

  const { data, error } = await admin
    .from("gallery_items")
    .insert({ user_open_id: openId, r2_key: r2Key, prompt, source })
    .select("id")
    .single()

  if (error) {
    return NextResponse.json(
      { ok: false, error: `写入失败: ${error.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, id: data.id })
}
