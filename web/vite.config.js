/**
 * Vite 配置（M7）：前端独立子工程，root 指向 `web/` 自身目录。
 * - 构建产物落 `web/dist`，由 fastify @fastify/static 同源托管（src/index.js）。
 * - dev server 把 `/api` 代理到后端（默认 :8080），支持热更新独立联调。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** 后端地址（联调用），可经 VITE_API_TARGET 覆盖 */
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8080';

export default defineConfig({
  root: rootDir,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // SSE 与普通请求同走 /api 前缀；ws:false 保持 EventSource 走 HTTP 长连接
      '/api': { target: apiTarget, changeOrigin: true, ws: false },
    },
  },
});
