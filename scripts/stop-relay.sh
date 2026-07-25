#!/usr/bin/env bash
# 停止服务器侧 relay 进程：stop-relay.sh 是 restart-relay.sh stop 的语义化入口。
# stop 逻辑（pkill + 端口兜底）统一在 restart-relay.sh，见该脚本关于 pkill 自杀的注释。
exec "$(cd "$(dirname "$0")" && pwd)/restart-relay.sh" stop
