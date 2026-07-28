#!/usr/bin/env bash
# 本地打包：收集 local 节点运行所需文件 → cc-web-local.tar.gz
# 产物只含【代码与配置模板】，白名单方式排除 node_modules / .git / data / .env；
# 目标机（Windows 或 Linux）解压后 `npm install` → 配置 packages/local/.env →
# 用 restart-local.sh（Linux）/ restart-local.bat（Windows）启动。
# local / shared 均为 source-only（ADR-0001），无需 build。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT/cc-web-local.tar.gz"

echo "=== [1/2] 确认 local 源码就绪 ==="
[ -d "$ROOT/packages/local/src" ] || { echo "✗ 缺少 packages/local/src"; exit 1; }
[ -d "$ROOT/packages/shared/src" ] || { echo "✗ 缺少 packages/shared/src"; exit 1; }

echo "=== [2/2] 打包 $OUT ==="
# 白名单：只打 local 节点运行所需文件。.env / data / node_modules 不在列，不会泄露本地配置。
# 两套重启脚本都带上，目标机按系统选用（Windows: restart-local.bat / Linux: restart-local.sh）。
FILES=(
  package.json
  tsconfig.base.json
  packages/local/package.json
  packages/local/tsconfig.json
  packages/local/src
  packages/local/.env.example
  packages/shared/package.json
  packages/shared/src
  restart-local.sh
  restart-local.bat
)
[ -f "$ROOT/package-lock.json" ] && FILES+=(package-lock.json)

tar -czf "$OUT" -C "$ROOT" "${FILES[@]}"

echo "=== 打包完成 ==="
ls -lh "$OUT"
echo ""
echo "目标机部署（Windows / Linux 通用）："
echo "  tar -xzf cc-web-local.tar.gz"
echo "  npm install                       # 装 tsx / @cc-web/shared / better-sqlite3 等"
echo "  cp packages/local/.env.example packages/local/.env   # 配置 RELAY_URL / NODE_ID / NODE_SECRET"
echo "  Windows: restart-local.bat        Linux: ./restart-local.sh"
