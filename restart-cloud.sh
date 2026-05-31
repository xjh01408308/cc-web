#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
mkdir -p "$PID_DIR"

echo "=== cc-web 云服务启动 ==="

echo "[1/3] 停止旧进程..."
bash "$SCRIPT_DIR/stop-cloud.sh" 2>/dev/null || true
sleep 1

echo ""
echo "[2/3] 构建前端..."
cd "$SCRIPT_DIR/packages/frontend"
npx vite build

echo ""
echo "[3/3] 启动服务..."
cd "$SCRIPT_DIR/packages/relay"
nohup npx tsx --env-file=../../.env src/index.ts > "$PID_DIR/relay.log" 2>&1 &
echo "$!" > "$PID_DIR/relay.pid"

sleep 1

echo ""
echo "=== 云服务启动完成 ==="
echo "  中继:   http://127.0.0.1:3001 (relay 同时提供静态文件服务)"
echo "  日志:   $PID_DIR/relay.log"
echo "  停止:   bash stop-cloud.sh"
