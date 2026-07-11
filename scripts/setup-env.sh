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
asks SUPABASE_SERVICE_ROLE_KEY     "service_role key"
echo "── Cloudflare R2 ──"
ask  R2_ACCOUNT_ID        "Account ID"
asks R2_ACCESS_KEY_ID     "Access Key ID"
asks R2_SECRET_ACCESS_KEY "Secret Access Key"
ask  R2_BUCKET            "桶名 Bucket"
echo "── 图片生成服务 ──"
read -r -p "  图片服务 modal / openrouter / fal / comfyui [AIGC_IMAGE_PROVIDER] (直接回车=modal): " image_provider
image_provider="${image_provider:-modal}"
case "$image_provider" in
  modal|openrouter|fal|comfyui) set_kv AIGC_IMAGE_PROVIDER "$image_provider" ;;
  *) echo "✗ 图片服务只能是 modal、openrouter、fal 或 comfyui"; exit 1 ;;
esac

case "$image_provider" in
  modal)
    echo "── Modal 图片服务 ──"
    ask  MODAL_ENDPOINT_BASE "Endpoint Base URL"
    asks MODAL_KEY           "Key"
    asks MODAL_SECRET        "Secret"
    ;;
  openrouter)
    echo "── OpenRouter 图片服务 ──"
    asks OPENROUTER_API_KEY "API Key"
    ask OPENROUTER_IMAGE_MODEL "默认图片模型 ID"
    ask OPENROUTER_IMAGE_STANDARD_MODEL "可选标准出图模型 ID"
    ask OPENROUTER_IMAGE_DETAIL_MODEL "可选细节增强模型 ID"
    ask OPENROUTER_IMAGE_RESOLUTION "可选输出尺寸档(例如 1K / 2K)"
    ask OPENROUTER_IMAGE_ASPECT_RATIO "可选画面比例(例如 1:1 / 16:9)"
    ;;
  fal)
    echo "── fal.ai 图片服务 ──"
    ask FAL_IMAGE_ENDPOINT "图片 Endpoint 路径(例如 fal-ai/flux/schnell)"
    ask FAL_IMAGE_STANDARD_ENDPOINT "可选标准出图 Endpoint 覆盖"
    ask FAL_IMAGE_DETAIL_ENDPOINT "可选细节增强 Endpoint 覆盖"
    ;;
  comfyui)
    echo "── 自建 ComfyUI 图片服务 ──"
    ask COMFYUI_BASE_URL "ComfyUI 服务根地址(不要带 /api)"
    asks COMFY_ORG_API_KEY "工作流含 GPT Image 等付费 API 节点时填写的 ComfyUI Account API Key"
    ;;
esac

echo "── fal.ai（3D / 视频）──"
asks FAL_KEY "API Key"
ask FAL_MODEL3D_STANDARD_ENDPOINT "可选标准 3D Endpoint 覆盖"
ask FAL_MODEL3D_GAME_ASSET_ENDPOINT "可选游戏资产 3D Endpoint 覆盖"
ask FAL_VIDEO_ENDPOINT "可选视频 Endpoint 覆盖"
ask AIGC_ASSET_HOST_ALLOWLIST "可选输出文件域名白名单(逗号分隔;默认可信列表够用就留空)"
echo "── 自生成密钥(敏感输入不回显;直接回车=用 openssl 自动生成一串)──"
for k in SESSION_SECRET CRON_SECRET; do
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
