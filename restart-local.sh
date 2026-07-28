#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== cc-web 本地节点重启 ==="

# 前置检查（与 restart-local.bat 对齐）
if [ ! -d "$SCRIPT_DIR/packages/local/node_modules" ]; then
  echo "[WARN] packages/local/node_modules not found — run \"npm install\" in repo root first."
fi
if [ ! -f "$SCRIPT_DIR/packages/local/.env" ]; then
  echo "[ERROR] packages/local/.env not found — copy from .env.example and set NODE_ID / NODE_SECRET."
  exit 1
fi

echo "[1/2] 停止旧进程..."
pkill -f "tsx.*packages/local/src/index.ts" 2>/dev/null || true
sleep 2

echo ""
echo "[2/2] 启动本地服务..."
cd "$SCRIPT_DIR/packages/local"
LOG="$SCRIPT_DIR/local.log"
nohup npx tsx --env-file=.env src/index.ts >> "$LOG" 2>&1 &
disown

echo ""
echo "=== 本地节点启动完成 ==="
# 从 .env 读取 RELAY_URL 显示，兜底用默认值
relay=$(grep -E '^RELAY_URL=' "$SCRIPT_DIR/packages/local/.env" 2>/dev/null | cut -d= -f2- || echo "ws://localhost:3001/ws/local")
echo "  连接中继: ${relay:-ws://localhost:3001/ws/local}"
echo "  日志:     $LOG (tail -f \"$LOG\" 跟踪输出)"
