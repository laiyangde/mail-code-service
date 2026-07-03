#!/usr/bin/env bash
# 本地一键触发服务器更新：SSH 到生产机 git 拉取最新代码 + 重建容器 + 健康检查。
# 前置：已配置免密登录、服务器已首次部署（git clone + .env 就绪）。见 docs/部署文档.md。
#
# 用法：
#   bash scripts/deploy.sh
# 可用环境变量覆盖默认：
#   DEPLOY_SERVER=root@118.89.134.75  DEPLOY_DIR=/opt/mail-code-service  DEPLOY_BRANCH=main  bash scripts/deploy.sh
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@118.89.134.75}"
APP_DIR="${DEPLOY_DIR:-/opt/mail-code-service}"
BRANCH="${DEPLOY_BRANCH:-feature/queue-confirm-admin}"

echo "→ 部署到 ${SERVER}:${APP_DIR}（分支 ${BRANCH}）"

# shellcheck disable=SC2029  # 变量需在本地展开后传给远端
ssh "${SERVER}" "APP_DIR='${APP_DIR}' BRANCH='${BRANCH}' bash -s" <<'REMOTE'
set -euo pipefail
cd "${APP_DIR}"
echo "→ 拉取代码"
git fetch --all --prune
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"
echo "→ 重建并启动容器"
docker compose up -d --build
docker compose ps
echo "→ 等待健康检查"
for i in $(seq 1 10); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "✓ 健康检查通过"
    exit 0
  fi
  sleep 2
done
echo "✗ 健康检查未通过，请查看：docker compose logs --tail=100" >&2
exit 1
REMOTE

echo "✓ 部署完成：https://19880321.xyz"
