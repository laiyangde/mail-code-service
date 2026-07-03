import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, applySchema } from '../../src/store/db.js';
import { createStore } from '../../src/store/index.js';
import { generateAlias } from '../../src/lease/alias-generator.js';
import {
  SURNAMES,
  GIVEN_NAMES,
  SURNAME_COUNT,
  GIVEN_NAME_COUNT,
} from '../../src/lease/alias-dict.js';

/** 每个用例用独立内存库 */
function freshStore() {
  const db = openDb(':memory:');
  applySchema(db);
  return createStore(db);
}

const SWPU_RULE = { charset: 'a-z0-9', minLen: 6, maxLen: 18, domain: 'swpu.edu.cn' };

describe('别名生成（FR-3.3）', () => {
  describe('generateAlias：姓名 + 随机数字', () => {
    it('按游标取姓名，结尾补 1~2 位数字，全程小写字母/数字', () => {
      const alias = generateAlias(SWPU_RULE, { surnameIndex: 0, givenNameIndex: 0 });
      const base = SURNAMES[0] + GIVEN_NAMES[0]; // wang + wei
      expect(alias.startsWith(base)).toBe(true);
      // 结尾 1~2 位数字
      expect(alias).toMatch(/^[a-z]+[a-z0-9]*\d{1,2}$/);
      const digits = alias.slice(base.length);
      expect(digits.length).toBeGreaterThanOrEqual(1);
      expect(digits.length).toBeLessThanOrEqual(2);
    });

    it('首字符恒为字母（满足平台约束）', () => {
      for (let s = 0; s < SURNAME_COUNT; s += 17) {
        for (let g = 0; g < GIVEN_NAME_COUNT; g += 31) {
          const alias = generateAlias(SWPU_RULE, { surnameIndex: s, givenNameIndex: g });
          expect(alias[0]).toMatch(/[a-z]/);
        }
      }
    });

    it('遍历全字典：长度恒落在 [minLen, maxLen]，字符集合规', () => {
      for (let s = 0; s < SURNAME_COUNT; s++) {
        for (let g = 0; g < GIVEN_NAME_COUNT; g += 7) {
          const alias = generateAlias(SWPU_RULE, { surnameIndex: s, givenNameIndex: g });
          expect(alias.length).toBeGreaterThanOrEqual(SWPU_RULE.minLen);
          expect(alias.length).toBeLessThanOrEqual(SWPU_RULE.maxLen);
          expect(alias).toMatch(/^[a-z0-9]+$/);
        }
      }
    });

    it('超 maxLen 时截断姓名基串到「刚好容纳数字」', () => {
      // chengfeng(9) 为最长名之一：chengfeng + 2 位数字 = 11，需 maxLen 更小才触发截断
      const rule = { minLen: 6, maxLen: 8 };
      const alias = generateAlias(rule, { surnameIndex: 0, givenNameIndex: 0 });
      expect(alias.length).toBeLessThanOrEqual(8);
      expect(alias.length).toBeGreaterThanOrEqual(6);
    });

    it('姓名过短时补随机数字兜底 minLen（如单字母姓 e + 短名）', () => {
      const si = SURNAMES.indexOf('e');
      const gi = GIVEN_NAMES.indexOf('wei');
      const alias = generateAlias(SWPU_RULE, { surnameIndex: si, givenNameIndex: gi });
      expect(alias.length).toBeGreaterThanOrEqual(SWPU_RULE.minLen);
    });
  });

  describe('aliasIndex 游标：顺序遍历 + 持久化', () => {
    let store;
    beforeEach(() => {
      store = freshStore();
    });

    it('首次 advance 返回 {0,0} 并推进到 {0,1}', () => {
      expect(store.aliasIndex.advance()).toEqual({ surnameIndex: 0, givenNameIndex: 0 });
      expect(store.aliasIndex.peek()).toEqual({ surnameIndex: 0, givenNameIndex: 1 });
    });

    it('名字越界回绕并向姓氏进位', () => {
      // 快进到本姓氏最后一个名字
      for (let i = 0; i < GIVEN_NAME_COUNT - 1; i++) store.aliasIndex.advance();
      // 此刻游标 = {0, GIVEN_NAME_COUNT-1}
      expect(store.aliasIndex.advance()).toEqual({
        surnameIndex: 0,
        givenNameIndex: GIVEN_NAME_COUNT - 1,
      });
      // 进位到下一姓氏、名字归零
      expect(store.aliasIndex.peek()).toEqual({ surnameIndex: 1, givenNameIndex: 0 });
    });

    it('游标持久化：新 store 复用同一 db 从上次位置续遍历', () => {
      const db = openDb(':memory:');
      applySchema(db);
      const s1 = createStore(db);
      s1.aliasIndex.advance(); // {0,0} → 推进到 {0,1}
      s1.aliasIndex.advance(); // {0,1} → 推进到 {0,2}
      const s2 = createStore(db); // 同一 db，播种被 INSERT OR IGNORE 跳过
      expect(s2.aliasIndex.advance()).toEqual({ surnameIndex: 0, givenNameIndex: 2 });
    });
  });
});
