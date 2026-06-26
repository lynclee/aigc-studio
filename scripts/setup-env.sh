#!/usr/bin/env bash
# 交互式填写 .env.local —— 敏感值输入不回显,只写本地 .env.local(已被 .gitignore 忽略),
# 不进 git、不经过任何对话/AI。用法:  bash scripts/setup-env.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ENV_FILE=".env.local"
[ -f "$ENV_FILE" ] || cp .env.example "$ENV_FILE"

# 写/更新一个 key=value(用 | 作 sed 分隔,避免值里的 / 干扰;留空则跳过)
set_kv() {
  local key="$1" val="$2"
  [ -z "$val" ] && return 0
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
ask()  { local k="$1" p="$2" v; read -r    -p "  $p [$k] (留空跳过): " v; set_kv "$k" "$v"; }   # 可见
asks() { local k="$1" p="$2" v; read -r -s -p "  $p [$k] (留空跳过): " v; echo; set_kv "$k" "$v"; } # 隐藏

echo "── 飞书 / Lark ──"
ask  LARK_APP_ID            "App ID"
asks LARK_APP_SECRET        "App Secret"
ask  LARK_REDIRECT_URI      "回调 URL(https://<域名>/api/auth/lark/callback)"
echo "── Supabase ──"
ask  NEXT_PUBLIC_SUPABASE_URL      "Project URL"
asks NEXT_PUBLIC_SUPABASE_ANON_KEY "anon public key"
asks SUPABASE_SERVICE_ROLE_KEY     "service_role key"
echo "── Cloudflare R2 ──"
ask  R2_ACCOUNT_ID        "Account ID"
asks R2_ACCESS_KEY_ID     "Access Key ID"
asks R2_SECRET_ACCESS_KEY "Secret Access Key"
ask  R2_BUCKET            "桶名 Bucket"
echo "── 自生成密钥(直接回车=用 openssl 自动生成一串)──"
for k in SESSION_SECRET BRIDGE_API_KEY CRON_SECRET; do
  read -r -s -p "  $k (回车=自动生成): " v; echo
  [ -z "$v" ] && v="$(openssl rand -hex 32)"
  set_kv "$k" "$v"
done

echo
echo "✓ 已写入 $ENV_FILE"
if git check-ignore "$ENV_FILE" >/dev/null 2>&1; then
  echo "✓ 再次确认:$ENV_FILE 被 git 忽略,不会进版本库。"
else
  echo "⚠️ 警告:$ENV_FILE 未被 git 忽略!先去 .gitignore 加 .env*。"
fi
