// data/security.mjs
// ---------------------------------------------------------------------------
// IP 解析与访问控制
// 注意：若原文件中还有 logVisit / hashPassword 等函数，请保留在本文件末尾。
// ---------------------------------------------------------------------------

import net from 'node:net';

/** 内置可信代理网段：Cloudflare 官方 IPv4 段 + 本地回环 */
const DEFAULT_TRUSTED_CIDRS = [
  '127.0.0.1/32',
  '::1/128',
  // Cloudflare IPv4
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

/** 可信代理 CIDR = 内置段 + 环境变量 TRUSTED_PROXY_CIDRS */
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
  // 处理内嵌 IPv4，例如 ::ffff:1.2.3.4
  if (addr.includes('.')) {
    const idx = addr.lastIndexOf(':');
    const v4 = addr.slice(idx + 1);
    const octets = v4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
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

/** 判断 ip 是否落在 cidr 内（同时支持 IPv4 / IPv6，单 IP 也可匹配） */
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

/** 兼容旧代码可能引用的 inCidr4 */
export const inCidr4 = ipInCidr;

// ----------------------------- 可信代理判断 --------------------------------

export function isTrustedProxy(ip) {
  const target = normalizeIp(ip);
  if (!target) return false;
  return getTrustedProxyCidrs().some((cidr) => ipInCidr(target, cidr));
}

// ----------------------------- 客户端真实 IP -------------------------------

/**
 * 获取客户端真实 IP。
 * 规则：对端不在可信代理内 → 直接用 socket 地址（防伪造）；
 *       对端可信 → 合并转发头，从右向左跳过可信代理，取第一个非可信地址。
 */
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

/** 读取白名单：逗号分隔，支持精确 IP 与 CIDR */
export function getIpWhitelist() {
  return parseCidrList(process.env.IP_WHITELIST);
}

export function isIpWhitelistEnabled() {
  return getIpWhitelist().length > 0;
}

export function isIpInWhitelist(ip) {
  const list = getIpWhitelist();
  if (list.length === 0) return true; // 未配置 = 不启用
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

/** 请求是否通过白名单校验 */
export function isRequestAllowed(req) {
  if (!isIpWhitelistEnabled()) return true;
  return isIpInWhitelist(clientIp(req));
}