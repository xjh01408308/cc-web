#!/usr/bin/env bash
# 服务器侧 relay 进程管理：stop | start | restart（默认 restart）
# 由 deploy.sh 调用，也可手动 `bash scripts/restart-relay.sh [stop|start|restart]`。
# 复用 packages/relay/.env；不 build（前端产物已随部署包上传）。
# 注意：pkill -f 必须放在脚本里执行——脚本进程命令行是 'bash scripts/restart-relay.sh'，
# 不含 'tsx src/index.ts'，不会误杀自身。切勿在 ssh 内联命令里直接 pkill -f（那会自杀）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY="$ROOT/packages/relay"
PORT=3001  # 须与 packages/relay/.env 的 RELAY_PORT 一致；改端口请同步改这里
ACTION="${1:-restart}"

stop_relay() {
  echo "[stop] 停止旧 relay..."
  pkill -f "tsx.*src/index.ts" 2>/dev/null || true
  # 端口兜底：清掉仍占用 PORT 的残留进程（命令行匹配失败时）
  local port_pid=""
  if command -v ss >/dev/null 2>&1; then
    port_pid=$(ss -tlnHp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  elif command -v lsof >/dev/null 2>&1; then
    port_pid=$(lsof -ti ":${PORT}" 2>/dev/null | head -1 || true)
  fi
  [ -n "$port_pid" ] && { echo "  清理占用端口 $PORT 的残留进程 PID=$port_pid"; kill -9 "$port_pid" 2>/dev/null || true; }
  sleep 1
}

start_relay() {
  echo "[start] 启动 relay..."
  cd "$RELAY"
  nohup npx tsx --env-file=.env src/index.ts > "$ROOT/relay.log" 2>&1 &
  disown
  echo "[start] 完成，日志: $ROOT/relay.log"
}

case "$ACTION" in
  stop)    stop_relay ;;
  start)   start_relay ;;
  restart) stop_relay; start_relay ;;
  *) echo "用法: $0 [stop|start|restart]"; exit 1 ;;
esac
