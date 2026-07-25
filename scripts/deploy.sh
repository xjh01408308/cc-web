#!/usr/bin/env bash
# 部署：上传 → 停旧+备份 → 清旧代码+解压+装依赖 → 确保配置 → 起新 relay
# 高频迭代用 `npm run deploy`（会先 pack）。复用服务器现有 .env / data / node_modules / nginx / 证书。
# 全新部署：若服务器无 packages/relay/.env，自动生成初始生产配置（INITIAL_ADMIN_PASSWORD=admin，登录后请改）。
# 失败安全：部署前备份 .env + data/ 到 backup/；中途失败 relay 不会启动，可从 backup/ 恢复。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV="$ROOT/.env.deploy"
TAR="$ROOT/cc-web.tar.gz"

[ -f "$ENV" ] || { echo "✗ 缺少 .env.deploy，参见 .env.deploy.example"; exit 1; }
[ -f "$TAR" ] || { echo "✗ 缺少 $TAR，请先 npm run pack"; exit 1; }

# shellcheck disable=SC1090
set -a; . "$ENV"; set +a

: "${DEPLOY_HOST:?DEPLOY_HOST 未设置}"
: "${DEPLOY_USER:?DEPLOY_USER 未设置}"
: "${DEPLOY_PATH:?DEPLOY_PATH 未设置}"

SSH_OPTS=()
SCP_OPTS=(-q)
[ -n "${DEPLOY_KEY:-}" ] && { SSH_OPTS+=(-i "$DEPLOY_KEY"); SCP_OPTS+=(-i "$DEPLOY_KEY"); }
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

echo "=== [1/5] 上传 → $TARGET:$DEPLOY_PATH ==="
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$DEPLOY_PATH'"
scp "${SCP_OPTS[@]}" "$TAR" "$TARGET:$DEPLOY_PATH/cc-web.tar.gz"

echo "=== [2/5] 停止旧 relay + 备份 .env / data → backup/ ==="
# 停旧走 scripts/restart-relay.sh stop（脚本内 pkill 不会误杀 ssh 会话；ssh 内联 pkill -f 会自杀）。
# 首次部署服务器还没有该脚本，跳过（也没有旧 relay 可停）。
ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$DEPLOY_PATH' && \
  if [ -f scripts/restart-relay.sh ]; then bash scripts/restart-relay.sh stop || echo '  stop 出错（忽略，[5/5] 会用新版重新停启）'; else echo '  首次部署，无旧 relay'; fi; \
  mkdir -p backup && cp -a packages/relay/.env packages/relay/data backup/ 2>/dev/null || true"

echo "=== [3/5] 清空旧代码目录 + 解压新版本 + 装生产依赖 ==="
# rm 只删 src/dist，让已删除的文件真正消失；node_modules / .env / data 不在删除路径，原样保留。
ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$DEPLOY_PATH' && \
  rm -rf packages/relay/src packages/shared/src packages/frontend/dist && \
  tar -xzf cc-web.tar.gz && rm -f cc-web.tar.gz && \
  npm install --omit=dev"

echo "=== [4/5] 确保配置（首次部署生成 packages/relay/.env）==="
# 复用现有 .env；仅当不存在（全新部署）时生成。
# admin 密码取自本地 .env.deploy 的 DEPLOY_INITIAL_ADMIN_PASSWORD（不硬编码弱密码），
# 经 ssh stdin 写入（不暴露在远程命令行/ps），文件权限 600。
if ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$DEPLOY_PATH' && [ -f packages/relay/.env ]"; then
  echo '  复用现有 packages/relay/.env'
else
  if [ -z "${DEPLOY_INITIAL_ADMIN_PASSWORD:-}" ]; then
    echo '  ✗ 全新部署需在 .env.deploy 设置 DEPLOY_INITIAL_ADMIN_PASSWORD（首次 admin 密码，登录后请改）'
    exit 1
  fi
  printf 'NODE_ENV=production\nINITIAL_ADMIN_PASSWORD=%s\nRELAY_PORT=3001\n' "$DEPLOY_INITIAL_ADMIN_PASSWORD" | \
    ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$DEPLOY_PATH' && mkdir -p packages/relay && cat > packages/relay/.env && chmod 600 packages/relay/.env"
  echo '  [!] 已生成 packages/relay/.env（权限 600）；admin 初始密码 = DEPLOY_INITIAL_ADMIN_PASSWORD，请登录后修改'
fi

echo "=== [5/5] 启动 relay（scripts/restart-relay.sh）==="
ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$DEPLOY_PATH' && bash scripts/restart-relay.sh"

echo "=== 部署完成 ==="
echo "  配置/数据备份于: $DEPLOY_PATH/backup/（部署失败时可从此恢复 .env / data）"
