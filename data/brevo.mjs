/**
 * Brevo 邮件服务（Transactional Email API）
 *
 * 用法：
 *   const { sendMail, createCode, verifyCode, getCooldown } = ...
 *
 * 官网文档：https://developers.brevo.com/reference/sendtransacemail
 * 接口地址：POST https://api.brevo.com/v3/smtp/email
 * 鉴权头：  api-key: xkeysib-xxxxxxxx
 *
 * 说明：
 * - 发件邮箱（senderEmail）必须先在 Brevo 后台完成验证，否则接口会拒绝。
 * - 验证码为 6 位纯数字，10 分钟有效，错误 5 次作废，验证通过后立即失效（一次性）。
 * - 同一邮箱 60 秒内只能重发一次，防止被刷邮件。
 */

/** 验证码存储：key = purpose:email（purpose: register / login） */
const codeStore = new Map(); // -> { code, expiresAt, tries }
const lastSent = new Map(); // 设备(IP) -> 上次发送时间戳（同一设备换邮箱同样受限）
const emailSentCount = new Map(); // email -> [时间戳...]（每小时最多 10 封，防轰炸单个邮箱）

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 秒重发间隔（按设备）
const MAX_TRIES = 5; // 最多错 5 次
const MAX_SEND_PER_HOUR = 10; // 单邮箱每小时最多 10 封

/** 生成 6 位数字验证码 */
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 发送邮件（Brevo）
 * @param {{apiKey:string, senderEmail:string, senderName?:string}} cfg
 * @param {{to:string, subject:string, html:string}} msg
 */
export async function sendMail(cfg, msg) {
  const apiKey = String(cfg?.apiKey || '').trim();
  const senderEmail = String(cfg?.senderEmail || '').trim();
  if (!apiKey) throw new Error('邮件服务未配置（缺少 API Key）');
  if (!senderEmail) throw new Error('邮件服务未配置（缺少发件邮箱）');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: String(cfg?.senderName || '在线练习系统').slice(0, 60), email: senderEmail },
        to: [{ email: msg.to }],
        subject: String(msg.subject || '').slice(0, 200),
        htmlContent: String(msg.html || ''),
      }),
      signal: ctl.signal,
    });
    const txt = await r.text();
    if (!r.ok) {
      let detail = txt.slice(0, 300);
      try {
        const j = JSON.parse(txt);
        detail = j.message || j.code || detail;
      } catch {}
      throw new Error(`邮件发送失败（${r.status}）：${detail}`);
    }
    return true;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('邮件服务响应超时，请稍后再试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查重发冷却：同一设备（IP）60 秒内只能发一次，换邮箱也一样受限
 * @param {string} ip 设备标识（客户端 IP）
 * @returns {{ok:boolean, waitSec?:number, error?:string}}
 */
export function checkCooldown(ip) {
  const key = String(ip || '').trim();
  const last = lastSent.get(key) || 0;
  const diff = Date.now() - last;
  if (diff < RESEND_COOLDOWN_MS) {
    return { ok: false, waitSec: Math.ceil((RESEND_COOLDOWN_MS - diff) / 1000) };
  }
  return { ok: true };
}

/**
 * 生成并保存验证码（发送失败时由调用方清除）
 * @returns {string} 验证码明文（仅用于发邮件）
 */
export function createCode(purpose, email) {
  const key = `${purpose}:${String(email || '').trim().toLowerCase()}`;
  const code = randomCode();
  codeStore.set(key, { code, expiresAt: Date.now() + CODE_TTL_MS, tries: 0 });
  return code;
}

/** 记录一次发送：设备冷却 + 单邮箱每小时频次 */
export function markSent(ip, email) {
  const dev = String(ip || '').trim();
  lastSent.set(dev, Date.now());

  const mail = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const arr = (emailSentCount.get(mail) || []).filter((t) => now - t < 60 * 60 * 1000);
  arr.push(now);
  emailSentCount.set(mail, arr);
}

/** 单邮箱每小时发送次数检查（防止不停轰炸同一个邮箱） */
export function checkEmailHourlyLimit(email) {
  const mail = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const arr = (emailSentCount.get(mail) || []).filter((t) => now - t < 60 * 60 * 1000);
  emailSentCount.set(mail, arr);
  if (arr.length >= MAX_SEND_PER_HOUR) {
    return { ok: false, error: '该邮箱今天收到的验证码过多，请稍后再试' };
  }
  return { ok: true };
}

/** 清除某邮箱的验证码（发送失败时调用） */
export function clearCode(purpose, email) {
  codeStore.delete(`${purpose}:${String(email || '').trim().toLowerCase()}`);
}

/**
 * 校验验证码
 * @returns {{ok:boolean, error?:string}}
 */
export function verifyCode(purpose, email, input) {
  const key = `${purpose}:${String(email || '').trim().toLowerCase()}`;
  const rec = codeStore.get(key);
  if (!rec) return { ok: false, error: '验证码不存在或已失效，请重新获取' };
  if (Date.now() > rec.expiresAt) {
    codeStore.delete(key);
    return { ok: false, error: '验证码已过期，请重新获取' };
  }
  if (rec.tries >= MAX_TRIES) {
    codeStore.delete(key);
    return { ok: false, error: '验证码错误次数过多，请重新获取' };
  }
  const val = String(input || '').trim();
  if (val !== rec.code) {
    rec.tries += 1;
    return { ok: false, error: `邮箱验证码错误（还可尝试 ${MAX_TRIES - rec.tries} 次）` };
  }
  codeStore.delete(key); // 一次性使用
  return { ok: true };
}

/** 验证码有效期（秒），供前端提示 */
export const CODE_TTL_SEC = Math.floor(CODE_TTL_MS / 1000);
export const RESEND_SEC = Math.floor(RESEND_COOLDOWN_MS / 1000);
