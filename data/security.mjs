 

import crypto from 'node:crypto';

 

 
const CF_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inCidr4(ip, cidr) {
  const [net, bitsStr] = String(cidr).split('/');
  const bits = Number(bitsStr);
  if (!Number.isFinite(bits) || bits <= 0 || bits > 32) return false;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a === null || b === null) return false;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

 
function isTrustedProxy(addr) {
  const v = String(addr || '').replace(/^::ffff:/, '');
  if (!v) return false;
  if (isPrivateIp(v)) return true;
  const extra = String(process.env.TRUSTED_PROXY_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of [...CF_IPV4, ...extra]) if (inCidr4(v, c)) return true;
  return false;
}

 
export function clientIp(req) {
  const h = req.headers || {};
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!isTrustedProxy(peer)) return peer || 'unknown';

  const pick = (v) => String(v || '').split(',')[0].trim();
  const cand =
    pick(h['cf-connecting-ip']) ||
    pick(h['true-client-ip']) ||
    pick(h['x-real-ip']) ||
    pick(h['x-forwarded-for']) ||
    pick(h['x-vercel-forwarded-for']) ||
    peer;
  
  return cand.replace(/^::ffff:/, '') || 'unknown';
}

 
export function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}` : ip;
}

 

const geoCache = new Map(); 
const GEO_TTL = 24 * 3600 * 1000; 

export function isPrivateIp(ip) {
  if (!ip) return true;
  const v = ip.replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
  if (v.includes(':')) return v.startsWith('fc') || v.startsWith('fd') || v === '::';
  return (
    v.startsWith('10.') ||
    v.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v) ||
    v.startsWith('127.')
  );
}

 
export async function ipToLocation(ip) {
  if (!ip || ip === 'unknown') return { str: '', country: '', region: '', city: '' };
  const key = ip.replace(/^::ffff:/, '');
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit;
  if (isPrivateIp(key)) {
    const rec = { str: '本地（内网）', country: '', region: '内网', city: '', at: Date.now() };
    geoCache.set(key, rec);
    return rec;
  }

  
  const pending = geoCache.get(`p:${key}`);
  if (pending) return pending;

  const rec = { str: '', country: '', region: '', city: '', at: Date.now() };
  geoCache.set(key, rec); 
  const task = (async () => {
    try {
      
      const sources = [
        { url: `http://ip-api.com/json/${key}?lang=zh-CN&fields=status,country,regionName,city`, parse: (d) => (d.status === 'success' ? { country: d.country || '', region: d.regionName || '', city: d.city || '' } : null) },
        { url: `https://ipapi.co/${key}/json/`, parse: (d) => (d && d.city ? { country: d.country_name || '', region: d.region || '', city: d.city || '' } : null) },
      ];
      for (const src of sources) {
        try {
          const r = await fetch(src.url, { signal: AbortSignal.timeout(2500) });
          if (!r.ok) continue;
          const d = await r.json();
          const geo = src.parse(d);
          if (!geo) continue;
          rec.country = geo.country;
          rec.region = geo.region;
          rec.city = geo.city;
          rec.str = [geo.region, geo.city].filter(Boolean).join(' ');
          break;
        } catch {
          
        }
      }
    } catch {
      
    } finally {
      rec.at = Date.now();
      geoCache.set(key, rec);
      geoCache.delete(`p:${key}`);
    }
    return rec;
  })();
  geoCache.set(`p:${key}`, task);
  return task;
}

 

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

  
  const inApp = has(/MicroMessenger/i)
    ? '微信'
    : has(/\bQQ\//i)
    ? 'QQ'
    : has(/Aweme|BytedanceWebview/i)
    ? '抖音'
    : has(/Alipay/i)
    ? '支付宝'
    : '';

  
  const bot = !browser || browser === '未知' || browser === '脚本/程序' || has(/HeadlessChrome|bot|crawler|spider|scrapy/i);

  return { browser, os, inApp, bot, raw: s.slice(0, 220) };
}

 

const buckets = new Map(); 

 
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

 
const bans = new Map(); 
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

 
const scriptHits = new Map(); 

 
export function countScriptHit(ip, windowMs = 10 * 60_000) {
  if (!ip || isPrivateIp(ip)) return 0;
  const now = Date.now();
  const arr = (scriptHits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  scriptHits.set(ip, arr);
  
  if (scriptHits.size > 5000) {
    for (const [k, v] of scriptHits) {
      if (!v.length || now - v[v.length - 1] > windowMs) scriptHits.delete(k);
    }
  }
  return arr.length;
}

 
export function getScriptHits(ip, windowMs = 10 * 60_000) {
  const arr = scriptHits.get(ip) || [];
  const now = Date.now();
  return arr.filter((t) => now - t < windowMs).length;
}

 
export function resetScriptHits(ip) {
  scriptHits.delete(ip);
}

 

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const captchas = new Map(); 

function sweepCaptchas() {
  const now = Date.now();
  for (const [k, v] of captchas) if (now > v.exp) captchas.delete(k);
}


const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';

 
function pickAnswer(len = 4) {
  const rnd = (s) => s[crypto.randomInt(s.length)];
  const chars = [rnd(UPPER), rnd(LOWER), rnd(DIGITS)];
  const pools = [UPPER, LOWER, DIGITS];
  while (chars.length < len) chars.push(rnd(pools[crypto.randomInt(pools.length)]));
  
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function createCaptcha(ip = '') {
  sweepCaptchas();
  const answer = pickAnswer(4);

  const id = crypto.randomBytes(16).toString('hex');
  captchas.set(id, { answer, exp: Date.now() + CAPTCHA_TTL_MS, ip });

  const W = 130;
  const H = 44;
  const rand = (a, b) => a + Math.random() * (b - a);

  
  let glyphs = '';
  for (let i = 0; i < answer.length; i++) {
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

  
  let lines = '';
  for (let i = 0; i < 5; i++) {
    lines +=
      `<path d="M${rand(0, 20).toFixed(0)},${rand(0, H).toFixed(0)} Q${rand(30, 100).toFixed(0)},${rand(0, H).toFixed(0)} ` +
      `${rand(110, W).toFixed(0)},${rand(0, H).toFixed(0)}" stroke="hsl(${Math.floor(rand(180, 320))} 60% 70%)"` +
      ` stroke-width="${rand(0.8, 1.8).toFixed(1)}" fill="none" opacity="0.75"/>`;
  }
  
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

 
export function verifyCaptcha(id, input, ip = '') {
  sweepCaptchas();
  const rec = captchas.get(String(id || ''));
  if (!rec) return { ok: false, error: '验证码已过期，请点击图片刷新' };
  captchas.delete(String(id));
  if (rec.ip && ip && rec.ip !== ip) return { ok: false, error: '验证码与当前设备不匹配，请刷新重试' };
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  if (!norm(input)) return { ok: false, error: '请输入图形验证码' };
  if (norm(input) !== norm(rec.answer)) {
    
    if (norm(input).toUpperCase() === norm(rec.answer).toUpperCase()) {
      return { ok: false, error: '验证码大小写不正确，请输入已保存的验证码重试' };
    }
    return { ok: false, error: '验证码不正确' };
  }
  return { ok: true };
}

 

 
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