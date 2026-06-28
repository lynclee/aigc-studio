/**
 * POST /api/gallery/upload-url —— presigned-PUT 核心:验 upload-token → 签 R2 预签名 PUT
 * URL → 写一条画廊索引。取代旧的 /api/gallery/ingest(那条接受客户端传 open_id,可冒名)。
 *
 * 鉴权:`Authorization: Bearer <upload-token>` → verifyUploadToken 推导 openId,失败 401。
 *   ⚠️ **open_id 一律来自 token 的签名 payload,绝不接受客户端在 body 里传** —— 这是防冒名
 *      的根:持 A 的 token 只能拿到 A 的 open_id。
 *
 * key 构造:`<openId>/<uuid>.<ext>` —— **强制本人 open_id 前缀**。即便预签名 PUT 泄露,也只
 *   能写到本人前缀下的那一个随机 key,写不进别人的命名空间(防冒名的第二道闸)。
 *
 * 流程:① 验 token 得 openId ② 校验 ext(白名单)③ 生成 key ④ service_role 写一行
 *   gallery_items(user_open_id=openId)⑤ 签 PUT URL ⑥ 回 { uploadUrl, r2_key }。
 *   插件随后把图 PUT 到 uploadUrl(Content-Type 须与签名一致)。索引由门户写,插件不碰库。
 */

import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { verifyUploadToken } from "@/lib/upload-token"
import { signPutUrl } from "@/lib/r2"
import { getSupabaseAdmin } from "@/lib/supabase/admin"

// node runtime:node:crypto + service_role 客户端 + 读 server-only env
export const runtime = "nodejs"

/** ext 白名单 → Content-Type 映射。非白名单 ext 一律 400。 */
const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  glb: "model/gltf-binary",
}

interface UploadUrlBody {
  prompt?: unknown
  ext?: unknown
}

export async function POST(req: Request) {
  // 1) 鉴权:从 upload-token 推导 open_id(不接受客户端传 open_id)
  const auth = req.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : ""
  const openId = token ? verifyUploadToken(token) : null
  if (!openId) {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401 })
  }

  // 2) 解析 body:prompt(可选)+ ext(默认 png,白名单校验)
  let body: UploadUrlBody = {}
  try {
    body = (await req.json()) as UploadUrlBody
  } catch {
    // 允许空 body / 非 JSON —— 用默认 ext=png、prompt=null
    body = {}
  }
  const ext = (typeof body.ext === "string" ? body.ext : "png").trim().toLowerCase()
  const contentType = EXT_CONTENT_TYPE[ext]
  if (!contentType) {
    return NextResponse.json(
      { ok: false, error: `不支持的 ext:${ext}(允许 ${Object.keys(EXT_CONTENT_TYPE).join("/")})` },
      { status: 400 },
    )
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : null

  // 3) 构造 key —— 强制本人 open_id 前缀,杜绝冒名
  const r2Key = `${openId}/${randomUUID()}.${ext}`

  // 4) 写画廊索引(service_role,绕过 RLS)。open_id 取自 token,不取自 body。
  const admin = getSupabaseAdmin()
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 500 })
  }
  const { error } = await admin
    .from("gallery_items")
    .insert({ user_open_id: openId, r2_key: r2Key, prompt, source: "bridge" })
  if (error) {
    return NextResponse.json(
      { ok: false, error: `写入失败: ${error.message}` },
      { status: 500 },
    )
  }

  // 5) 签预签名 PUT URL(10 分钟过期)。env 缺失 → null → 500。
  const uploadUrl = await signPutUrl(r2Key, contentType)
  if (!uploadUrl) {
    return NextResponse.json({ ok: false, error: "R2 未配置" }, { status: 500 })
  }

  // 6) 回 { uploadUrl, r2_key } —— 插件 PUT 图到 uploadUrl(Content-Type 须与签名一致)
  return NextResponse.json({ ok: true, uploadUrl, r2_key: r2Key })
}
