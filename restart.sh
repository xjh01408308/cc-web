#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== cc-web 重启 ==="

# 按端口杀掉进程，不误杀其他 node
echo "[1/4] 停止旧进程..."
for port in 3001 5173; do
    pid=$(lsof -ti ":$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "  关闭占用端口 $port 的进程 PID=$pid"
        kill -9 "$pid" 2>/dev/null || true
    fi
done
sleep 2

echo ""
echo "[2/4] 构建前端..."
cd "$SCRIPT_DIR/packages/frontend"
npx vite build

echo ""
echo "[3/4] 启动中继服务 (端口 3001)..."
cd "$SCRIPT_DIR/packages/relay"
npx tsx --env-file=.env src/index.ts &
sleep 1

echo ""
echo "[4/4] 启动本地服务 + 前端 (端口 5173)..."
cd "$SCRIPT_DIR/packages/local"
npx tsx --env-file=.env src/index.ts &
sleep 1

cd "$SCRIPT_DIR/packages/frontend"
npx vite --host 0.0.0.0 --port 5173 &

echo ""
echo "=== 全部启动完成 ==="
echo "  前端: http://localhost:5173"
echo "  中继: ws://localhost:3001"

wait
