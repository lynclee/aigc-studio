#!/usr/bin/env node
/**
 * 一键给 R2 桶配 CORS（当前产物由服务端写入 R2；本脚本只为浏览器读取预签名 GET/HEAD 不被 CORS 挡）。
 *
 * 用法:
 *   node scripts/setup-r2-cors.mjs https://你的域名.vercel.app
 *
 * ── 核实结论(2026-06-29,Cloudflare 官方文档)──────────────────────────────
 * 1) R2 的 S3 兼容 API **支持 `PutBucketCors`**(✅ Feature Implemented)。
 *    出处:https://developers.cloudflare.com/r2/api/s3/api/
 *    (Bucket-level operations 表里 PutBucketCors / GetBucketCors / DeleteBucketCors 均为 ✅)
 *    所以可以用 @aws-sdk/client-s3 的 PutBucketCorsCommand 程序化配 CORS,endpoint 指向
 *    `https://<account_id>.r2.cloudflarestorage.com`、region="auto"。
 *
 * 2) ⚠️ Token 权限:配 CORS 属于「编辑桶配置 / edit bucket configuration」。按官方权限矩阵
 *    出处:https://developers.cloudflare.com/r2/api/tokens/#permissions
 *      - **Object Read & Write**:只「read/write/list objects」—— 可供服务端日常读写对象,
 *        但**不含**编辑桶配置,对 PutBucketCors 大概率 AccessDenied。
 *      - **Admin Read & Write**:明确含「edit bucket configuration」—— 配 CORS 要用这一档。
 *    门户日常用的 R2_ACCESS_KEY 多半是 Object 档(只为服务端对象读写),拿来跑本脚本可能被拒。
 *    若被拒:① 临时另造一个 Admin Read & Write 的 R2 API Token 跑一次本脚本;或
 *           ② 直接 dashboard 手动配置只允许 GET/HEAD 的 CORS;或
 *           ③ wrangler:`wrangler r2 bucket cors set <桶> --file cors.json`
 *              (wrangler 走自己的 OAuth 登录,权限独立于 S3 access key)。
 *
 * 3) 为什么用 aws-sdk 而非 wrangler:@aws-sdk/client-s3 已是本项目依赖(lib/r2.ts 在用),
 *    复用 .env.local 里现成的 R2_* 凭据,零额外安装 / 零额外登录。wrangler 路径作为兜底
 *    写在上面注释里。
 *
 * 4) 新版 aws-sdk(本仓库 3.1075.0)默认给请求加 CRC32 flexible checksum 头,而 R2 的
 *    PutBucketCors **不支持** `x-amz-sdk-checksum-algorithm` / `x-amz-checksum-algorithm`
 *    (同上 S3 API 表标 ❌)。故 client 显式 `requestChecksumCalculation: "WHEN_REQUIRED"`
 *    关掉自动校验和,避免 R2 拒签。
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 手动逐行解析 ../.env.local(不引 dotenv)──────────────────────────────
function loadEnvLocal() {
  const envPath = join(__dirname, "..", ".env.local")
  const out = {}
  let raw
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    return out // 文件不存在 → 返回空,后面统一报缺变量
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    // 去掉可能存在的成对引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  console.error("用法: node scripts/setup-r2-cors.mjs https://你的域名.vercel.app\n")
  process.exit(1)
}

async function main() {
  const origin = process.argv[2]
  if (!origin) {
    die("缺少域名参数。请把部署后拿到的域名作为第一个参数传入。")
  }
  if (!/^https?:\/\//.test(origin)) {
    die(`域名必须带协议(http:// 或 https://),你传的是:${origin}`)
  }
  // CORS AllowedOrigins 只认 scheme://host[:port],不带路径;去掉尾部 / 和多余 path
  let normalizedOrigin
  try {
    normalizedOrigin = new URL(origin).origin
  } catch {
    die(`域名格式不合法:${origin}`)
  }

  const env = loadEnvLocal()
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY
  const bucket = env.R2_BUCKET

  const missing = []
  if (!accountId) missing.push("R2_ACCOUNT_ID")
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID")
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY")
  if (!bucket) missing.push("R2_BUCKET")
  if (missing.length) {
    die(
      `.env.local 缺少变量:${missing.join(", ")}\n  先跑 bash scripts/setup-env.sh 填好 R2_* 再来。`,
    )
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // R2 的 PutBucketCors 不支持 flexible checksum 头,关掉新版 SDK 的自动 CRC32(见顶部注释 4)
    requestChecksumCalculation: "WHEN_REQUIRED",
  })

  const corsRule = {
    AllowedOrigins: [normalizedOrigin],
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["content-length"],
    MaxAgeSeconds: 3600,
  }

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: { CORSRules: [corsRule] },
      }),
    )
    console.log(
      `✓ 已为桶 ${bucket} 配好 CORS(允许 ${normalizedOrigin} GET/HEAD)`,
    )
  } catch (err) {
    const code = err?.name || err?.Code || "Unknown"
    console.error(`\n✗ 配 CORS 失败(${code}): ${err?.message || err}\n`)
    console.error(
      "可能原因:R2 凭据是 Object 档(不含『编辑桶配置』权限)。两个兜底:",
    )
    console.error(
      "  1) 改用 dashboard 手动配置 CORS —— 进桶 Settings → CORS Policy,只允许 GET/HEAD;",
    )
    console.error(
      "  2) 或临时用 Admin Read & Write 的 R2 API Token 重跑本脚本。",
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
