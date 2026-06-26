/**
 * 登录图形验证码打码（接口式，沿用 register-factory 现有方案：云码 jfbym customApi）。
 * token 走环境变量，绝不硬编码 / 落日志（NFR-1）。
 */
import axios from 'axios';
import { requireEnv } from '../../config.js';

/** 云码自定义识别接口 */
const CAPTCHA_API_URL = 'http://api.jfbym.com/api/YmServer/customApi';

/** SWPU 图形验证码对应的题型编号 */
const CAPTCHA_TYPE = '10111';

/**
 * 识别一张 base64 验证码图片，返回识别文本。
 * @param {string} base64Image 不含 `data:image/...;base64,` 前缀的纯 base64
 * @returns {Promise<string>} 识别出的验证码
 */
export async function recognizeCaptcha(base64Image) {
  const token = requireEnv('SWPU_CAPTCHA_API_TOKEN');
  const { data } = await axios.post(
    CAPTCHA_API_URL,
    { token, type: CAPTCHA_TYPE, image: base64Image },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  // 云码成功码为 10000，识别结果在 data.data.data
  if (data && data.code === 10000) {
    return data.data.data;
  }
  throw new Error(`验证码识别失败：${data?.msg || '未知错误'}`);
}
