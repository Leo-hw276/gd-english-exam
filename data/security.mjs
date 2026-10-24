/**
 * security.mjs —— 安全与审计（零依赖）
 *
 * 提供四件事：
 *  1. 真实访客 IP 提取（兼容 Vercel / Railway / Nginx / Cloudflare 等反代）
 *  2. User-Agent 解析（浏览器 / 系统 / 是否疑似机器人）
 *  3. 令牌桶限流（防批量注册、防接口刷量、缓解应用层 DDoS）
 *  4. 图形验证码（SVG 生成 + 大小写不敏感校验，无需任何第三方库）
 */

import crypto from 'node:crypto';

/* ==================================================================
 *  1. 访客 IP
 * ================================================================== */

/**
 * 取真实 IP。部署在 Vercel / Railway / Nginx / Cloudflare 后面时，
 * req.socket.remoteAddress 拿到的是反代地址，必须优先读转发头。
 */
export function clientIp(req) {
  const h = req.headers || {};
  const pick = (v) => String(v || '').split(',')[0].trim();
  const cand =
    pick(h['cf-connecting-ip']) ||
    pick(h['x-real-ip']) ||
    pick(h['x-forwarded-for']) ||
    pick(h['x-vercel-forwarded-for']) ||
    pick(h['true-client-ip']) ||
    req.socket?.remoteAddress ||
    '';
  // IPv6 映射地址归一化成 IPv4
  return cand.replace(/^::ffff:/, '') || 'unknown';
}

/** 只保留前两段，用于「同网段聚集」判断（IPv6 保留前四段） */
export function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}` : ip;
}

/* ==================================================================
 *  2. User-Agent 解析
 * ================================================================== */

export function parseUa(ua = '') {
  const s = String(ua);
  const has = (re) => re.test(s);

  let browser = '未知';
  if (has(/MicroMessenger/i)) browser = '微信内置浏览器';
  else if (has(/Edg[A-Z]?\//)) browser = 'Edge';
  else if (has(/OPR\/|Opera/i)) browser = 'Opera';
  else if (has(/Firefox\//)) browser = 'Firefox';
  else if (has(/Chrome\//)) browser = 'Chrome';
  else if (has(/Safari\//)) browser = 'Safari';
  else if (has(/curl|wget|python|node-fetch|axios|okhttp|Go-http/i)) browser = '脚本/程序';

  let os = '未知';
  if (has(/Windows NT 10/)) os = 'Windows 10/11';
  else if (has(/Windows NT/)) os = 'Windows';
  else if (has(/Android/)) os = 'Android';
  else if (has(/iPhone|iPad|iPod/)) os = 'iOS';
  else if (has(/Mac OS X/)) os = 'macOS';
  else if (has(/Linux/)) os = 'Linux';

  // 微信 / QQ / 抖音等内置浏览器
  const inApp = has(/MicroMessenger/i)
    ? '微信'
    : has(/\bQQ\//i)
    ? 'QQ'
    : has(/Aweme|BytedanceWebview/i)
    ? '抖音'
    : has(/Alipay/i)
    ? '支付宝'
    : '';

  // 疑似自动化：无浏览器标识、含无头关键字
  const bot = !browser || browser === '未知' || browser === '脚本/程序' || has(/HeadlessChrome|bot|crawler|spider|scrapy/i);

  return { browser, os, inApp, bot, raw: s.slice(0, 220) };
}

/* ==================================================================
 *  3. 限流（令牌桶 + 滑动窗口）
 * ================================================================== */

const buckets = new Map(); // key -> { tokens, ts, hits: [] }

/** 定期清理，避免长期运行内存膨胀 */
const SWEEP_MS = 10 * 60 * 1000;
let sweeper = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (now - b.ts > 30 * 60 * 1000) buckets.delete(k);
    }
  }, SWEEP_MS);
  sweeper.unref?.();
}

/**
 * 滑动窗口限流。
 * @returns {{ok:boolean, remaining:number, retryAfterSec:number, count:number}}
 */
export function rateLimit(key, { windowMs = 60_000, max = 60 } = {}) {
  ensureSweeper();
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { ts: now, hits: [] };
    buckets.set(key, b);
  }
  b.ts = now;
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= max) {
    const oldest = b.hits[0];
    return {
      ok: false,
      remaining: 0,
      count: b.hits.length,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }
  b.hits.push(now);
  return { ok: true, remaining: max - b.hits.length, count: b.hits.length, retryAfterSec: 0 };
}

/** 手动封禁一个键（用于风控命中后临时拉黑） */
const bans = new Map(); // key -> until
export function banKey(key, ms) {
  bans.set(key, Date.now() + ms);
}
export function isBanned(key) {
  const until = bans.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    bans.delete(key);
    return false;
  }
  return true;
}

/* ==================================================================
 *  4. 图形验证码
 *
 *  要求：图像 + 字母数字混合，校验时【大小写不敏感】（用户要求「大小写、数字一样」）。
 *  实现：纯 SVG（无 canvas 依赖，服务端直出），带干扰线与噪点，
 *  答案为内存态，5 分钟过期，一次性使用。
 * ================================================================== */

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const captchas = new Map(); // id -> { answer, exp, ip }

function sweepCaptchas() {
  const now = Date.now();
  for (const [k, v] of captchas) if (now > v.exp) captchas.delete(k);
}

// 去掉容易混淆的字符（0/O、1/I/l）
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createCaptcha(ip = '') {
  sweepCaptchas();
  const len = 4;
  let answer = '';
  const bytes = crypto.randomBytes(len * 2);
  for (let i = 0; i < len; i++) answer += CAPTCHA_CHARS[bytes[i] % CAPTCHA_CHARS.length];

  const id = crypto.randomBytes(16).toString('hex');
  captchas.set(id, { answer, exp: Date.now() + CAPTCHA_TTL_MS, ip });

  const W = 130;
  const H = 44;
  const rand = (a, b) => a + Math.random() * (b - a);

  // 每个字符独立旋转/偏移，防止被简单切割识别
  let glyphs = '';
  for (let i = 0; i < len; i++) {
    const x = 16 + i * 28 + rand(-3, 3);
    const y = 30 + rand(-4, 4);
    const rot = rand(-26, 26).toFixed(1);
    const size = rand(22, 27).toFixed(1);
    const hue = Math.floor(rand(200, 300));
    glyphs +=
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Georgia,'Times New Roman',serif"` +
      ` font-size="${size}" font-weight="700" fill="hsl(${hue} 70% 32%)"` +
      ` transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${answer[i]}</text>`;
  }

  // 干扰线
  let lines = '';
  for (let i = 0; i < 5; i++) {
    lines +=
      `<path d="M${rand(0, 20).toFixed(0)},${rand(0, H).toFixed(0)} Q${rand(30, 100).toFixed(0)},${rand(0, H).toFixed(0)} ` +
      `${rand(110, W).toFixed(0)},${rand(0, H).toFixed(0)}" stroke="hsl(${Math.floor(rand(180, 320))} 60% 70%)"` +
      ` stroke-width="${rand(0.8, 1.8).toFixed(1)}" fill="none" opacity="0.75"/>`;
  }
  // 噪点
  let dots = '';
  for (let i = 0; i < 34; i++) {
    dots += `<circle cx="${rand(0, W).toFixed(0)}" cy="${rand(0, H).toFixed(0)}" r="${rand(0.6, 1.7).toFixed(1)}" fill="hsl(${Math.floor(rand(0, 360))} 65% 62%)" opacity="0.7"/>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="图形验证码">` +
    `<rect width="${W}" height="${H}" fill="#f4f6fb"/>` +
    lines +
    glyphs +
    dots +
    `</svg>`;

  return { id, svg, ttlSec: Math.round(CAPTCHA_TTL_MS / 1000) };
}

/**
 * 校验验证码：大小写不敏感，忽略空格。
 * 无论对错都立即销毁该 id（防重放）。
 */
export function verifyCaptcha(id, input, ip = '') {
  sweepCaptchas();
  const rec = captchas.get(String(id || ''));
  if (!rec) return { ok: false, error: '验证码已过期，请点击刷新' };
  captchas.delete(String(id));
  if (rec.ip && ip && rec.ip !== ip) return { ok: false, error: '验证码与当前设备不匹配，请刷新重试' };
  const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
  if (!norm(input)) return { ok: false, error: '请输入图形验证码' };
  if (norm(input) !== norm(rec.answer)) return { ok: false, error: '验证码不正确' };
  return { ok: true };
}

/* ==================================================================
 *  5. 风控评分（识别批量注册 / 水军）
 * ================================================================== */

/**
 * 依据「同 IP 前缀近期注册数、UA 是否为脚本、是否一次性邮箱」给出风险分。
 * 分数越高越可疑；由调用方决定是否拒绝或仅记录。
 */
const disposableEmailDomains = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
  'temp-mail.org', 'getnada.com', 'maildrop.cc', 'fakeinbox.com',
]);

export function riskScore({ ip, ua, email, recentSamePrefix = 0, recentSameIp = 0 }) {
  const { bot } = parseUa(ua);
  const reasons = [];
  let score = 0;

  if (bot) {
    score += 40;
    reasons.push('请求未携带正常浏览器标识');
  }
  const domain = String(email || '').split('@')[1] || '';
  if (domain && disposableEmailDomains.has(domain)) {
    score += 40;
    reasons.push('使用了临时邮箱域名');
  }
  if (recentSameIp >= 3) {
    score += Math.min(30, recentSameIp * 6);
    reasons.push(`同一 IP 近期注册 ${recentSameIp} 次`);
  }
  if (recentSamePrefix >= 5) {
    score += Math.min(25, recentSamePrefix * 3);
    reasons.push(`同一网段近期注册 ${recentSamePrefix} 次`);
  }
  if (!String(email || '').includes('@')) {
    score += 10;
    reasons.push('邮箱格式异常');
  }
  return { score: Math.min(100, score), reasons, bot };
}

/* ==================================================================
 *  6. 活动日志（登录 / 朗读 / 风控）
 * ================================================================== */

const MAX_EVENTS = 4000;

export function makeActivityStore(persist) {
  let events = [];

  const load = (arr) => {
    events = Array.isArray(arr) ? arr.slice(0, MAX_EVENTS) : [];
  };
  const all = () => events;

  function push(ev) {
    const rec = {
      at: Date.now(),
      id: crypto.randomBytes(6).toString('hex'),
      ...ev,
    };
    events.unshift(rec);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    try {
      persist?.(events);
    } catch {}
    return rec;
  }

  /** 按条件筛选：kind / userId / ip / 关键字 / 时间范围 */
  function query({ kind = '', userId = '', ip = '', q = '', since = 0, until = 0, limit = 200 } = {}) {
    const kw = String(q || '').toLowerCase();
    return events
      .filter((e) => {
        if (kind && e.kind !== kind) return false;
        if (userId && e.userId !== userId) return false;
        if (ip && !String(e.ip || '').includes(ip)) return false;
        if (since && e.at < since) return false;
        if (until && e.at > until) return false;
        if (kw) {
          const hay = [e.kind, e.action, e.email, e.ip, e.ua, e.browser, e.os, e.detail, e.text]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      })
      .slice(0, Math.max(1, Math.min(1000, limit)));
  }

  /** 汇总统计：按 IP / 网段 / 用户聚合，便于发现批量注册 */
  function stats({ since = 0 } = {}) {
    const byIp = new Map();
    const byPrefix = new Map();
    const byUser = new Map();
    let logins = 0;
    let registers = 0;
    let reads = 0;
    let bots = 0;

    for (const e of events) {
      if (since && e.at < since) continue;
      if (e.kind === 'login') logins++;
      if (e.kind === 'register') registers++;
      if (e.kind === 'read') reads++;
      if (e.bot) bots++;

      const bump = (map, key, label) => {
        if (!key) return;
        const cur = map.get(key) || { key, label, count: 0, lastAt: 0, bots: 0 };
        cur.count++;
        cur.lastAt = Math.max(cur.lastAt, e.at);
        if (e.bot) cur.bots++;
        map.set(key, cur);
      };
      bump(byIp, e.ip, e.browser);
      bump(byPrefix, ipPrefix(e.ip), e.os);
      if (e.userId) bump(byUser, e.userId, e.email);
    }

    const top = (m, n = 10) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, n).map((v) => ({ ...v, label: v.label || '' }));
    return {
      total: events.length,
      logins,
      registers,
      reads,
      bots,
      topIps: top(byIp),
      topPrefixes: top(byPrefix),
      topUsers: top(byUser),
    };
  }

  function clear() {
    const n = events.length;
    events = [];
    try {
      persist?.(events);
    } catch {}
    return n;
  }

  return { load, all, push, query, stats, clear };
}