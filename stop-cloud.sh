#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

stopped=0

for name in relay; do
    pid_file="$PID_DIR/$name.pid"
    if [ -f "$pid_file" ]; then
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "停止 $name (PID=$pid)"
            kill "$pid" 2>/dev/null
            stopped=1
        fi
        rm -f "$pid_file"
    fi
done

# 兜底：清理占用端口的残留进程
for port in 3001; do
    pid=$(lsof -ti ":$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "关闭占用端口 $port 的残留进程 PID=$pid"
        kill -9 "$pid" 2>/dev/null || true
        stopped=1
    fi
done

if [ "$stopped" -eq 0 ]; then
    echo "没有运行中的云服务进程"
else
    echo "云服务已停止"
fi
