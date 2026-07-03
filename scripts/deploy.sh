#!/usr/bin/env bash
# 本地一键部署：tar 同步源码到生产机 + 重建容器 + 健康检查。
# 与实际部署方式一致——服务器是 tar 推送的源码目录（非 git repo）。
# 前置：已配置免密登录、服务器已首次部署（.env / cloakbrowser 就绪）。见 docs/部署文档.md。
#
# 用法：
#   bash scripts/deploy.sh
# 可用环境变量覆盖默认：
#   DEPLOY_SERVER=ubuntu@118.89.134.75  DEPLOY_DIR=/opt/mail-code-service  bash scripts/deploy.sh
set -euo pipefail

SERVER="${DEPLOY_SERVER:-ubuntu@118.89.134.75}"
APP_DIR="${DEPLOY_DIR:-/opt/mail-code-service}"

echo "→ 同步源码到 ${SERVER}:${APP_DIR}（排除 node_modules/.git/data/.env/dist）"
# 服务器的 .env / data 被排除，不会被覆盖；tar 解压只更新源码文件
tar czf - \
  --exclude='./node_modules' --exclude='./.git' --exclude='./data' \
  --exclude='./.env' --exclude='./web/dist' --exclude='./dist' \
  --exclude='*.log' --exclude='./.claude' . \
  | ssh "${SERVER}" "tar xzf - -C '${APP_DIR}'"

echo "→ 重建并重启容器"
ssh "${SERVER}" "cd '${APP_DIR}' && sudo docker compose build && sudo docker compose up -d && sudo docker compose ps --format 'table {{.Name}}\t{{.Status}}'"

echo "→ 健康检查"
for i in $(seq 1 10); do
  if ssh "${SERVER}" "curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1"; then
    echo "✓ 部署完成：https://19880321.xyz"
    exit 0
  fi
  sleep 2
done
echo "✗ 健康检查未通过，查看：ssh ${SERVER} 'cd ${APP_DIR} && sudo docker compose logs --tail=100'" >&2
exit 1
