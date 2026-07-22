#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== cc-web 本地节点重启 ==="

echo "[1/2] 停止旧进程..."
pkill -f "tsx.*packages/local/src/index.ts" 2>/dev/null || true
sleep 2

echo ""
echo "[2/2] 启动本地服务..."
cd "$SCRIPT_DIR/packages/local"
nohup npx tsx --env-file=.env src/index.ts >/dev/null 2>&1 &
disown

echo ""
echo "=== 本地节点启动完成 ==="
# 从 .env 读取 RELAY_URL 显示，兜底用默认值
relay=$(grep -E '^RELAY_URL=' "$SCRIPT_DIR/packages/local/.env" 2>/dev/null | cut -d= -f2- || echo "ws://localhost:3001/ws/local")
echo "  连接中继: ${relay:-ws://localhost:3001/ws/local}"

wait
