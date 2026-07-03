/**
 * alias_index 表 CRUD（纯 SQL）：别名生成游标的持久化（FR-3.3）。
 *
 * 顺序遍历「姓氏 × 名字」拼音字典：每次取码前调 advance() 原子取出当前游标并推进一格；
 * 名字内层递增，越界回绕并向姓氏进位，姓氏越界则整体归零重头再遍历。
 *
 * **原子性**：better-sqlite3 单连接同步执行，advance() 的「读→算→写」包在 db.transaction 内，
 * JS 单线程下不会被其它 activate 交错，天然无 TOCTOU（契合 FR-0 并发模型）。
 */
import { SURNAME_COUNT, GIVEN_NAME_COUNT } from '../lease/alias-dict.js';

/** @param {import('better-sqlite3').Database} db */
export function createAliasIndexRepo(db) {
  // 幂等播种单行（id=1）；已存在则忽略，不覆盖已推进的游标
  db.prepare(
    `INSERT OR IGNORE INTO alias_index (id, surname_index, given_name_index) VALUES (1, 0, 0)`,
  ).run();

  const getStmt = db.prepare(
    `SELECT surname_index AS surnameIndex, given_name_index AS givenNameIndex
       FROM alias_index WHERE id = 1`,
  );
  const setStmt = db.prepare(
    `UPDATE alias_index SET surname_index = ?, given_name_index = ? WHERE id = 1`,
  );

  // 事务包裹「读当前 → 推进 → 写回」，返回本次要使用的游标（推进前的值）
  const advanceTx = db.transaction(() => {
    const cur = getStmt.get() ?? { surnameIndex: 0, givenNameIndex: 0 };
    // 取模回绕，兜底越界（字典缩表 / 历史脏数据）
    const surnameIndex = cur.surnameIndex % SURNAME_COUNT;
    const givenNameIndex = cur.givenNameIndex % GIVEN_NAME_COUNT;

    // 推进一格：名字内层递增，越界回绕并向姓氏进位
    let nextGiven = givenNameIndex + 1;
    let nextSurname = surnameIndex;
    if (nextGiven >= GIVEN_NAME_COUNT) {
      nextGiven = 0;
      nextSurname = (surnameIndex + 1) % SURNAME_COUNT;
    }
    setStmt.run(nextSurname, nextGiven);

    return { surnameIndex, givenNameIndex };
  });

  return {
    /**
     * 原子取出当前游标并推进一格。
     * @returns {{ surnameIndex: number, givenNameIndex: number }} 本次生成应使用的游标
     */
    advance() {
      return advanceTx();
    },
    /** 读当前游标（不推进），供监控/测试断言 */
    peek() {
      return getStmt.get() ?? { surnameIndex: 0, givenNameIndex: 0 };
    },
  };
}
