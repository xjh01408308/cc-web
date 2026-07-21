#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
PORT=3001

stopped=0

# 1) PID 文件：kill 启动时记录的进程
#    注意：restart-cloud.sh 里 $! 记录的是 npx 父进程，
#    真正监听端口的 tsx 子进程在 npx 退出后可能成为孤儿，
#    因此还需下面的命令行匹配与端口兜底。
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

# 2) 按命令行匹配杀掉 tsx 整条进程链（npx 父进程 + node/tsx 子进程）
#    前提：云服务器只跑 cc-web relay，不会误杀其他 tsx 进程。
if pkill -f "tsx.*src/index.ts" 2>/dev/null; then
    stopped=1
fi

# 3) 端口兜底：清理仍占用 3001 的残留进程
#    原 lsof 在精简镜像/容器上可能未安装，优先用 ss（iproute2 基本自带），lsof 作回退。
port_pid=""
if command -v ss >/dev/null 2>&1; then
    port_pid=$(ss -tlnHp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
elif command -v lsof >/dev/null 2>&1; then
    port_pid=$(lsof -ti ":${PORT}" 2>/dev/null)
fi

if [ -n "$port_pid" ]; then
    echo "关闭占用端口 $PORT 的残留进程 PID=$port_pid"
    kill -9 "$port_pid" 2>/dev/null || true
    stopped=1
fi

if [ "$stopped" -eq 0 ]; then
    echo "没有运行中的云服务进程"
else
    echo "云服务已停止"
fi
