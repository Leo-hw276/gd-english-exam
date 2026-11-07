 

 
const codeStore = new Map(); 
const lastSent = new Map(); 
const emailSentCount = new Map(); 

const CODE_TTL_MS = 10 * 60 * 1000; 
const RESEND_COOLDOWN_MS = 60 * 1000; 
const MAX_TRIES = 5; 
const MAX_SEND_PER_HOUR = 10; 

 
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

 
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

 
export function checkCooldown(ip) {
  const key = String(ip || '').trim();
  const last = lastSent.get(key) || 0;
  const diff = Date.now() - last;
  if (diff < RESEND_COOLDOWN_MS) {
    return { ok: false, waitSec: Math.ceil((RESEND_COOLDOWN_MS - diff) / 1000) };
  }
  return { ok: true };
}

 
export function createCode(purpose, email) {
  const key = `${purpose}:${String(email || '').trim().toLowerCase()}`;
  const code = randomCode();
  codeStore.set(key, { code, expiresAt: Date.now() + CODE_TTL_MS, tries: 0 });
  return code;
}

 
export function markSent(ip, email) {
  const dev = String(ip || '').trim();
  lastSent.set(dev, Date.now());

  const mail = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const arr = (emailSentCount.get(mail) || []).filter((t) => now - t < 60 * 60 * 1000);
  arr.push(now);
  emailSentCount.set(mail, arr);
}

 
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

 
export function clearCode(purpose, email) {
  codeStore.delete(`${purpose}:${String(email || '').trim().toLowerCase()}`);
}

 
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
  codeStore.delete(key); 
  return { ok: true };
}

 
export const CODE_TTL_SEC = Math.floor(CODE_TTL_MS / 1000);
export const RESEND_SEC = Math.floor(RESEND_COOLDOWN_MS / 1000);
