// data/security.mjs
// ---------------------------------------------------------------------------
// IP 解析、可信代理、白名单，以及 server.mjs 依赖的安全辅助函数
// ---------------------------------------------------------------------------

import net from 'node:net';
import crypto from 'node:crypto';

// ----------------------------- 可信代理 CIDR --------------------------------

const DEFAULT_TRUSTED_CIDRS = [
  '127.0.0.1/32',
  '::1/128',
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

function parseCidrList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getTrustedProxyCidrs() {
  return [...DEFAULT_TRUSTED_CIDRS, ...parseCidrList(process.env.TRUSTED_PROXY_CIDRS)];
}

// ----------------------------- IP 归一化 ------------------------------------

export function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (!s) return '';
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/^::ffff:/i, '');
  return s;
}

function ipv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return { value: v, bits: 32 };
}

function ipv6ToBigInt(ip) {
  let addr = ip;
  if (addr.includes('.')) {
    const idx = addr.lastIndexOf(':');
    const v4 = addr.slice(idx + 1);
    const octets = v4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = octets.map((n) => n.toString(16).padStart(2, '0')).join('');
    addr = addr.slice(0, idx + 1) + hex.slice(0, 4) + ':' + hex.slice(4);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = addr.split(':');
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    v = (v << 16n) | BigInt(n);
  }
  return { value: v, bits: 128 };
}

function ipToBigInt(ip) {
  const s = normalizeIp(ip);
  const version = net.isIP(s);
  if (version === 4) return ipv4ToBigInt(s);
  if (version === 6) return ipv6ToBigInt(s);
  return null;
}

// ----------------------------- CIDR 匹配 ------------------------------------

export function ipInCidr(ip, cidr) {
  const text = String(cidr || '').trim();
  if (!text) return false;
  const slash = text.indexOf('/');
  const base = slash === -1 ? text : text.slice(0, slash);
  const prefix = slash === -1 ? null : Number(text.slice(slash + 1));

  const a = ipToBigInt(ip);
  const b = ipToBigInt(base);
  if (!a || !b || a.bits !== b.bits) return false;

  if (prefix === null) return a.value === b.value;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;
  if (prefix === 0) return true;

  const shift = BigInt(a.bits - prefix);
  return a.value >> shift === b.value >> shift;
}

export const inCidr4 = ipInCidr;

// ----------------------------- 可信代理判断 --------------------------------

export function isTrustedProxy(ip) {
  const target = normalizeIp(ip);
  if (!target) return false;
  return getTrustedProxyCidrs().some((cidr) => ipInCidr(target, cidr));
}

// ----------------------------- 客户端真实 IP -------------------------------

export function clientIp(req) {
  const h = req?.headers || {};
  const peer = normalizeIp(req?.socket?.remoteAddress || '');

  if (!isTrustedProxy(peer)) return peer || 'unknown';

  const candidates = [
    h['cf-connecting-ip'],
    h['true-client-ip'],
    h['x-real-ip'],
    h['x-forwarded-for'],
    h['x-vercel-forwarded-for'],
  ]
    .flatMap((v) => String(v || '').split(','))
    .map((s) => normalizeIp(s))
    .filter(Boolean);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (!isTrustedProxy(candidates[i])) return candidates[i];
  }

  return candidates[0] || peer || 'unknown';
}

// ----------------------------- IP 白名单 ------------------------------------

export function getIpWhitelist() {
  return parseCidrList(process.env.IP_WHITELIST);
}

export function isIpWhitelistEnabled() {
  return getIpWhitelist().length > 0;
}

export function isIpInWhitelist(ip) {
  const list = getIpWhitelist();
  if (list.length === 0) return true;
  const target = normalizeIp(ip);
  if (!target || target === 'unknown') return false;
  for (const entry of list) {
    if (entry.includes('/')) {
      if (ipInCidr(target, entry)) return true;
    } else if (normalizeIp(entry) === target) {
      return true;
    }
  }
  return false;
}

export function isRequestAllowed(req) {
  if (!isIpWhitelistEnabled()) return true;
  return isIpInWhitelist(clientIp(req));
}

// ----------------------------- 其他安全辅助函数 -----------------------------

export function ipPrefix(ip) {
  const s = normalizeIp(ip);
  if (net.isIP(s) === 4) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (net.isIP(s) === 6) return s.split(':').slice(0, 4).join(':') + '::/64';
  return s;
}

export function parseUa(ua) {
  const s = String(ua || '');
  const lower = s.toLowerCase();
  const bot = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|curl|wget|python-requests/i.test(lower);
  let browser = 'Unknown';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/chrome\//i.test(s) && !/opr\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s) && !/chrome\//i.test(s)) browser = 'Safari';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/opr\//i.test(s)) browser = 'Opera';
  let os = 'Unknown';
  if (/windows nt/i.test(s)) os = 'Windows';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/mac os x/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';
  const inApp = /wechat|micromessenger|qq\/|alipay|dingtalk|weibo/i.test(lower);
  return { browser, os, inApp, bot };
}

const rateBuckets = new Map();

export function rateLimit(key, { windowMs = 60_000, max = 60 } = {}) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= max;
  const retryAfter = ok ? 0 : Math.ceil((b.start + windowMs - now) / 1000);
  return { ok, retryAfter, count: b.count, max };
}

const bannedKeys = new Map();

export function banKey(reqOrIp) {
  if (typeof reqOrIp === 'string') return normalizeIp(reqOrIp);
  return clientIp(reqOrIp);
}

export function isBanned(key) {
  const k = String(key || '');
  const until = bannedKeys.get(k);
  if (!until) return false;
  if (Date.now() > until) {
    bannedKeys.delete(k);
    return false;
  }
  return true;
}

const captchas = new Map();

export function createCaptcha() {
  const id = crypto.randomBytes(8).toString('hex');
  const a = crypto.randomInt(1, 10);
  const b = crypto.randomInt(1, 10);
  const text = `${a} + ${b} = ?`;
  const answer = String(a + b);
  captchas.set(id, { answer, expires: Date.now() + 5 * 60_000 });
  return { id, text };
}

export function verifyCaptcha(id, answer) {
  const rec = captchas.get(String(id || ''));
  if (!rec) return false;
  captchas.delete(String(id));
  if (Date.now() > rec.expires) return false;
  return String(answer || '').trim() === rec.answer;
}

export function riskScore(req) {
  let score = 0;
  const ua = req?.headers?.['user-agent'] || '';
  if (!ua) score += 30;
  if (parseUa(ua).bot) score += 40;
  if (/curl|wget|python|java\//i.test(ua)) score += 20;
  const ip = clientIp(req);
  if (isPrivateIp(ip)) score += 5;
  return Math.min(100, score);
}

export function makeActivityStore(onChange) {
  let events = [];
  const notify = () => {
    if (typeof onChange === 'function') {
      try { onChange(events); } catch {}
    }
  };
  return {
    load(list) {
      events = Array.isArray(list) ? list.slice() : [];
    },
    push(rec) {
      const item = { ...rec, at: new Date().toISOString() };
      events.push(item);
      if (events.length > 500) events = events.slice(-500);
      notify();
      return item;
    },
    all() {
      return events.slice();
    },
  };
}

export async function ipToLocation(ip) {
  return { str: '' };
}

export function isPrivateIp(ip) {
  const s = normalizeIp(ip);
  const v = net.isIP(s);
  if (v === 4) {
    if (s.startsWith('10.') || s.startsWith('127.')) return true;
    if (s.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
    if (s.startsWith('169.254.')) return true;
    return false;
  }
  if (v === 6) {
    if (s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

const scriptHits = new Map();

export function countScriptHit(key) {
  const k = String(key || '');
  const n = (scriptHits.get(k) || 0) + 1;
  scriptHits.set(k, n);
  return n;
}

export function resetScriptHits(key) {
  if (key === undefined) scriptHits.clear();
  else scriptHits.delete(String(key));
}