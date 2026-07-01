import { describe, it, expect } from 'vitest';
import {
  extractAddress,
  senderRuleHits,
  matchSender,
  matchMail,
} from '../../src/provider/swpu/mail-match.js';

describe('M2 收码三重匹配（C-4 防串号）', () => {
  describe('extractAddress', () => {
    it('从 "Name <addr>" 提取小写地址', () => {
      expect(extractAddress('"GitHub" <noreply@github.com>')).toBe('noreply@github.com');
    });
    it('裸地址也归一化为小写', () => {
      expect(extractAddress('NoReply@GitHub.Com')).toBe('noreply@github.com');
    });
    it('空值返回空串', () => {
      expect(extractAddress('')).toBe('');
      expect(extractAddress(null)).toBe('');
    });
  });

  describe('senderRuleHits', () => {
    it('@域名：后缀匹配，含子域', () => {
      expect(senderRuleHits('noreply@github.com', '@github.com')).toBe(true);
      expect(senderRuleHits('x@mail.github.com', '@github.com')).toBe(true); // 子域命中
      expect(senderRuleHits('noreply@githubx.com', '@github.com')).toBe(false); // 相邻域不命中
    });
    it('通配 *.sendgrid.net', () => {
      expect(senderRuleHits('bounce@em123.sendgrid.net', '*.sendgrid.net')).toBe(true);
      expect(senderRuleHits('x@sendgrid.com', '*.sendgrid.net')).toBe(false);
    });
    it('完整地址精确匹配（大小写不敏感）', () => {
      expect(senderRuleHits('a@b.com', 'A@B.com')).toBe(true);
      expect(senderRuleHits('a@b.com', 'c@b.com')).toBe(false);
    });
  });

  describe('matchSender', () => {
    it('命中任一规则即可', () => {
      expect(matchSender('noreply@github.com', ['@gitlab.com', '@github.com'])).toBe(true);
    });
    it('空规则列表不命中', () => {
      expect(matchSender('a@b.com', [])).toBe(false);
    });
  });

  describe('matchMail 三重判定', () => {
    /** @type {import('../../src/provider/email-provider.js').MailMatch} */
    const match = { to: 'alias123@swpu.edu.cn', fromSenders: ['@github.com'], since: 1000 };

    it('To+From+时间窗三重命中', () => {
      expect(
        matchMail(
          { fromAddr: 'noreply@github.com', toAddrs: ['alias123@swpu.edu.cn'], date: 1001 },
          match,
        ),
      ).toBe(true);
    });
    it('To 不匹配 → 拒（主隔离键）', () => {
      expect(
        matchMail(
          { fromAddr: 'noreply@github.com', toAddrs: ['other@swpu.edu.cn'], date: 1001 },
          match,
        ),
      ).toBe(false);
    });
    it('From 不匹配 → 拒', () => {
      expect(
        matchMail(
          { fromAddr: 'evil@spam.com', toAddrs: ['alias123@swpu.edu.cn'], date: 1001 },
          match,
        ),
      ).toBe(false);
    });
    it('早于 since（秒级）→ 拒（防别名复用前的历史邮件，R-2）', () => {
      expect(
        matchMail(
          { fromAddr: 'noreply@github.com', toAddrs: ['alias123@swpu.edu.cn'], date: 999 },
          match,
        ),
      ).toBe(false);
    });
    it('等于 since → 接受（边界）', () => {
      expect(
        matchMail(
          { fromAddr: 'noreply@github.com', toAddrs: ['alias123@swpu.edu.cn'], date: 1000 },
          match,
        ),
      ).toBe(true);
    });
    it('fromSenders 为空 → 只按 To+时间匹配（不校验发件人）', () => {
      const openMatch = { to: 'alias123@swpu.edu.cn', fromSenders: [], since: 1000 };
      // 任意发件人，只要 To + 时间命中即接受
      expect(
        matchMail(
          { fromAddr: 'anyone@whatever.com', toAddrs: ['alias123@swpu.edu.cn'], date: 1001 },
          openMatch,
        ),
      ).toBe(true);
      // To 仍必须命中
      expect(
        matchMail(
          { fromAddr: 'anyone@whatever.com', toAddrs: ['other@swpu.edu.cn'], date: 1001 },
          openMatch,
        ),
      ).toBe(false);
      // 时间窗仍生效
      expect(
        matchMail(
          { fromAddr: 'anyone@whatever.com', toAddrs: ['alias123@swpu.edu.cn'], date: 999 },
          openMatch,
        ),
      ).toBe(false);
    });
  });
});
