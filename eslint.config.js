import js from '@eslint/js';
import globals from 'globals';

/** ESLint 9 flat config（ESM 工程，中文注释，遵循全局 CLAUDE.md） */
export default [
  {
    ignores: ['node_modules/', 'data/', 'dist/', 'web/dist/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // session.js 内含 page.evaluate 注入的浏览器上下文代码（window/document），放行浏览器全局
    files: ['src/provider/swpu/session.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Web 前端（React + Vite）：浏览器全局 + JSX 解析（node 全局由上方 **/*.js 块合并提供）
    files: ['web/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
