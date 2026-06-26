/**
 * 数据库迁移脚本（npm run migrate）：建库 + 应用 schema（幂等）。
 * 首版用单文件 schema.sql 幂等建表；后续演进引入 user_version + 顺序迁移。
 */
import { openDb, applySchema, DB_PATH } from './db.js';
import { logger } from '../logger.js';

const db = openDb(DB_PATH);
applySchema(db);
db.close();
logger.info({ dbPath: DB_PATH }, '数据库迁移完成：schema 已就位');
