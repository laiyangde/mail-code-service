/**
 * 唯一码生成与自验证（FR-2.2/2.3，NFR-1）。
 *
 * 结构：`<prefix>-<base32(payload‖sig)>`
 * - payload：{@link PAYLOAD_BYTES} 字节随机，作 DB 主键的唯一部分（不可枚举）；
 * - sig：`HMAC-SHA256(CODE_SIGNING_SECRET, prefix‖payload)` 截断 {@link SIG_BYTES} 字节，
 *   作**自验证签名**——收到 code 先本地验签（{@link verifyCodeShape}），验不过即判定伪造/枚举，
 *   在进单飞锁与串行执行器、查库之前直接拒绝，杜绝无效流量放大冲击调度核心（封堵 activate 限流被绕过的 DoS）。
 *
 * 说明：签名门只挡「凭空伪造的 code」，**不改变** code 是 bearer 凭证的本质（泄漏仍可用）；
 * 故它是限流与不可枚举性的补充，不是替代。CODE_SIGNING_SECRET 一经签发不可更改，否则历史 code 全部失效。
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** payload 随机字节数：48bit，自用量级唯一性无忧 */
const PAYLOAD_BYTES = 6;
/** 签名截断字节数：32bit，作 DoS 前置门足够（盲造通过概率 2^-32） */
const SIG_BYTES = 4;
/** payload+sig=10B=80bit，恰为 5 的倍数 → base32 定长 16 字符、无 padding */
const RAW_BYTES = PAYLOAD_BYTES + SIG_BYTES;

/** Crockford base32 字母表（去除 I L O U，避免人工抄写歧义） */
const B32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** 解码映射：含大小写与常见混淆容错（i/l→1, o→0） */
const B32_MAP = buildDecodeMap();

/**
 * 生成一个签名唯一码。
 * @param {string} prefix 套餐前缀
 * @returns {string} `<prefix>-<16位 base32>`
 */
export function generateCode(prefix) {
  const payload = randomBytes(PAYLOAD_BYTES);
  const sig = signPayload(prefix, payload);
  return `${prefix}-${base32Encode(Buffer.concat([payload, sig]))}`;
}

/**
 * 自验证：仅做**本地密码学校验**（格式 + 签名），不查库、不加锁。
 * 用于 API 边界前置拦截伪造/枚举码，避免其进入调度核心（FR-0 并发模型的 DoS 防护）。
 * @param {unknown} code 待验证的唯一码
 * @returns {boolean} 签名是否合法
 */
export function verifyCodeShape(code) {
  if (typeof code !== 'string') return false;
  // 前缀可能含 '-'，body 为 base32（不含 '-'）→ 以最后一个 '-' 分隔
  const dash = code.lastIndexOf('-');
  if (dash < 1) return false;
  const prefix = code.slice(0, dash);
  const raw = base32Decode(code.slice(dash + 1));
  if (!raw || raw.length !== RAW_BYTES) return false;
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const got = raw.subarray(PAYLOAD_BYTES);
  const want = signPayload(prefix, payload);
  return timingSafeEqual(got, want); // 等长保证（均 SIG_BYTES）
}

/**
 * 按套餐批量生成签名码并入库（管理员用，FR-2.3）。主键碰撞（概率极低）时重生成重试。
 * 初始 `quota_left = plan.quota`、`status = unused`（永久有效，retain_until = NULL）。
 * @param {object} store
 * @param {string} prefix 套餐前缀（须已存在）
 * @param {number} count 数量
 * @param {number} [issuedAt] 签发时间戳（ms）
 * @returns {string[]} 生成的唯一码
 */
export function batchGenerate(store, prefix, count, issuedAt = Date.now()) {
  const plan = store.plan.getByPrefix(prefix);
  if (!plan) throw new Error(`套餐前缀不存在：${prefix}`);
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(insertUniqueCode(store, prefix, plan.quota, issuedAt));
  }
  return codes;
}

/**
 * 生成并入库一个唯一码，主键冲突时重试（payload 碰撞极罕见，兜底健壮性）。
 * @param {object} store
 * @param {string} prefix
 * @param {number} quotaLeft
 * @param {number} issuedAt
 * @param {number} [maxRetries]
 * @returns {string} 已入库的唯一码
 */
function insertUniqueCode(store, prefix, quotaLeft, issuedAt, maxRetries = 3) {
  for (let attempt = 0; ; attempt++) {
    const code = generateCode(prefix);
    try {
      store.accessCode.insert({ code, prefix, status: 'unused', quotaLeft, issuedAt });
      return code;
    } catch (err) {
      if (attempt >= maxRetries) throw err; // 连续碰撞（近乎不可能）→ 抛出由上层处理
    }
  }
}

/**
 * 对 `prefix‖payload` 计算 HMAC 并截断为签名。
 * @param {string} prefix
 * @param {Buffer} payload
 * @returns {Buffer} 长度 SIG_BYTES 的签名
 */
function signPayload(prefix, payload) {
  return createHmac('sha256', config.auth.codeSigningSecret)
    .update(prefix)
    .update('\0') // 分隔符：消除 prefix/payload 拼接歧义
    .update(payload)
    .digest()
    .subarray(0, SIG_BYTES);
}

/**
 * Crockford base32 编码（大端逐 5bit）。
 * @param {Buffer} buf
 * @returns {string}
 */
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Crockford base32 解码；含非法字符返回 null（供验签快速否决）。
 * @param {string} str
 * @returns {Buffer|null}
 */
function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const v = B32_MAP[ch];
    if (v === undefined) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 构造 base32 解码映射（大小写 + i/l→1、o→0 容错）。 */
function buildDecodeMap() {
  const map = Object.create(null);
  for (let i = 0; i < B32_ALPHABET.length; i++) {
    const ch = B32_ALPHABET[i];
    map[ch] = i;
    map[ch.toUpperCase()] = i;
  }
  // 人工抄写常见混淆
  map['i'] = map['I'] = map['l'] = map['L'] = 1;
  map['o'] = map['O'] = 0;
  return map;
}
