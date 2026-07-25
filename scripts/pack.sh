#!/usr/bin/env bash
# 本地打包：构建前端 + 收集运行所需文件 → cc-web.tar.gz
# 产物只含【代码与前端构建产物】，白名单方式排除 node_modules / .git / data / .env；
# 部署到服务器现有目录时只覆盖代码，配置与数据原样保留（见 scripts/deploy.sh）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT/cc-web.tar.gz"

echo "=== [1/2] 构建前端 (vite build) ==="
npm -w packages/frontend run build

echo "=== [2/2] 打包 $OUT ==="
# 白名单：只打运行所需文件。.env / data / node_modules 不在列，天然不会覆盖服务器配置。
FILES=(
  package.json
  packages/relay/package.json
  packages/relay/src
  packages/shared/package.json
  packages/shared/src
  packages/frontend/package.json
  packages/frontend/dist
  scripts/restart-relay.sh
)
[ -f "$ROOT/package-lock.json" ] && FILES+=(package-lock.json)

tar -czf "$OUT" -C "$ROOT" "${FILES[@]}"

echo "=== 打包完成 ==="
ls -lh "$OUT"
