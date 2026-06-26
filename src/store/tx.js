/**
 * 事务包装（供原子收码事务等复用）。
 */

/**
 * 构造一个 IMMEDIATE 写事务。
 *
 * better-sqlite3 的 `db.transaction()` 默认 DEFERRED（首次写时才升级写锁），
 * IMMEDIATE 在 BEGIN 时即取写锁，缩短「读—判断—写」的竞态窗口；配合单写串行
 * 执行器，彻底根除 TOCTOU（INV-6）。事务体必须是**同步**函数（better-sqlite3 要求）。
 *
 * @template {unknown[]} A
 * @template R
 * @param {import('better-sqlite3').Database} db
 * @param {(...args: A) => R} fn 事务体（同步）
 * @returns {(...args: A) => R} 以 immediate 模式执行的事务函数
 */
export function immediateTx(db, fn) {
  const txn = db.transaction(fn);
  return (...args) => txn.immediate(...args);
}
