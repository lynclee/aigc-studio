#!/usr/bin/env bash
# 把 .env.local 里的 env 批量推到 Vercel(命令行备选)。
#
# 用法:
#   bash scripts/push-env-to-vercel.sh                 # 默认推到 production
#   bash scripts/push-env-to-vercel.sh preview         # 推到 preview
#   bash scripts/push-env-to-vercel.sh development      # 推到 development
#
# 前置:
#   1) npm i -g vercel(或 npx vercel)
#   2) vercel login
#   3) 在本项目目录 vercel link(把本地目录关联到 Vercel 项目)
#
# 👉 更简单的办法:Vercel 网页 Settings → Environment Variables 右上角可**直接粘贴整个 .env**
#    一次导入全部变量。本脚本是「就爱命令行」时的备选。
#
# 注意:某个 env 在 Vercel 上已存在时,`vercel env add` 会**交互式询问是否覆盖**,
#       按提示确认即可(脚本不替你决定,避免误删线上值)。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

TARGET="${1:-production}"
case "$TARGET" in
  production | preview | development) ;;
  *)
    echo "✗ 环境参数只能是 production / preview / development,你传的是:$TARGET"
    exit 1
    ;;
esac

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ 找不到 $ENV_FILE。先跑 bash scripts/setup-env.sh 填好再来。"
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "✗ 没找到 vercel CLI。先 npm i -g vercel && vercel login && vercel link。"
  echo "  (或者干脆用 Vercel 网页直接粘贴整个 .env,见脚本顶部注释。)"
  exit 1
fi

echo "── 把 $ENV_FILE 推到 Vercel [$TARGET] ──"
count=0
while IFS= read -r line || [ -n "$line" ]; do
  # 跳过空行 / 注释
  case "$line" in
    "" | \#*) continue ;;
  esac
  key="${line%%=*}"
  val="${line#*=}"
  # 去掉 key 两端空白(只取规整的 KEY=VALUE 行)
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  # 跳过没有 = 或 key 为空 或 值为空的行
  [ -z "$key" ] && continue
  [ "$key" = "$line" ] && continue   # 行里没有 = 号
  [ -z "$val" ] && { echo "  · 跳过空值 $key"; continue; }
  # 去掉值两端可能的成对引号
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac

  echo "  → $key"
  # 用 printf 把值从 stdin 喂给 vercel,避免值出现在进程 argv 里被别的进程看到
  printf '%s' "$val" | vercel env add "$key" "$TARGET"
  count=$((count + 1))
done < "$ENV_FILE"

echo
echo "✓ 处理完毕,共尝试推送 $count 个变量到 [$TARGET]。"
echo "  已存在的变量若被询问覆盖,按提示确认即可。"
