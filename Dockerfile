# mail-code-service · 单实例有状态服务镜像（M8 / 需求 §10.5、§6.4）
#
# 关键点：
# - 构建期预置隐身 Chromium 二进制（npx cloakbrowser install），运行期不触网下载
#   （CLOAKBROWSER_AUTO_UPDATE=false + 固定 CACHE_DIR，cloakbrowser 文档 §8.7）；
# - better-sqlite3 等 native 模块在 builder 编译，runtime 直接复用（同 glibc 基础）；
# - 有头登录需虚拟显示：运行时用 xvfb-run 包裹（cloakbrowser 文档 §10.3）；
# - tini 作 PID1 回收 Chromium 子进程；data/ 挂 volume 持久化（C-6）。

# ───────────────────────── builder ─────────────────────────
FROM node:20-bookworm AS builder
WORKDIR /app

# 隐身 Chromium 缓存目录（构建期下载到此，runtime 复用）
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser

COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com

COPY . .
# 注意：cloakbrowser 的 Chromium 不在镜像内构建（国内下载 GitHub 大文件不稳定），改为
# 宿主机预置 + docker-compose 挂载到 /opt/cloakbrowser（见 docs/部署文档.md「cloakbrowser 预置」）。
RUN npm run web:build \
  && npm prune --omit=dev

# ───────────────────────── runtime ─────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    SESSION_DATA_DIR=/app/data \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false

# Chromium 运行库 + Xvfb（有头登录）+ 字体（避免 canvas 指纹异常）+ tini
# 先把 Debian 源换成国内镜像（deb.debian.org 国内下载 Chromium 库/字体极慢）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends \
      tini xvfb xauth \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 libxshmfence1 \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# 复用 builder 已编译的依赖与产物（native 模块免重编）
# 复用 builder 已编译的依赖与产物（native 模块免重编）。
# cloakbrowser 的 Chromium 由 docker-compose 挂载 /opt/cloakbrowser 提供（宿主机预置）。
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY --from=builder /app/web/dist ./web/dist

EXPOSE 8080
VOLUME ["/app/data"]

# 健康检查打 /healthz（含池水位、IMAP 健康账号数）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 回收子进程；xvfb-run 提供虚拟显示（仅登录偶发开浏览器时用到）
ENTRYPOINT ["tini", "-s", "--"]
CMD ["xvfb-run", "-a", "node", "src/index.js"]
