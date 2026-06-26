/**
 * SQLite 连接管理（better-sqlite3：同步、单写连接，天然串行化，契合 FR-0）。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/** 默认库文件路径（位于 dataDir，挂 volume 持久化，重启可恢复 C-6） */
export const DB_PATH = join(config.dataDir, 'mail-code-service.db');

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * 打开一个 SQLite 连接并设置连接级 PRAGMA。
 * - journal_mode=WAL：读写不互锁（库级持久，重复设置幂等）；
 * - foreign_keys=ON：**连接级**，必须每条连接显式开启。
 * @param {string} filePath 库文件路径（传 ':memory:' 用于测试内存库）
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(filePath) {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 应用 schema.sql（幂等：IF NOT EXISTS 建表 + 护栏索引）。
 * @param {import('better-sqlite3').Database} db
 */
export function applySchema(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}

/** @type {import('better-sqlite3').Database | undefined} */
let singleton;

/**
 * 获取进程级单例连接（惰性创建并建表）。运行态统一用它（C-7 单实例单连接）。
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (!singleton) {
    singleton = openDb(DB_PATH);
    applySchema(singleton);
  }
  return singleton;
}
