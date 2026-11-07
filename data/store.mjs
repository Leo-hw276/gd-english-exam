 


import { configSources, envLocked } from './env.mjs';


export { configSources, envLocked };

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const DB_FILE = process.env.EXAM_DB_FILE
  ? path.resolve(process.env.EXAM_DB_FILE)
  : path.join(ROOT, 'data', 'db.json');

 

export const DEFAULT_PRICING = {
  currency: 'CNY',
  currencySymbol: '¥',
  freeTrials: 1,
  freeTrialNote: '新用户注册即赠 1 次完整听说模拟（三大题五小节，含 AI 逐题评分报告）。',
  perUse: {
    name: '次卡',
    price: 1,
    unit: '次',
    desc: '一次完整听说模拟：自动组卷 + 全程录音 + 30 分制 AI 评分报告。',
  },
  monthly: {
    name: '月卡',
    price: 19.9,
    days: 30,
    desc: '30 天内不限次练习，适合考前冲刺，每天可练多套。',
  },
  sourceNote:
    '定价由本站管理员在后台自行设定，非官方收费标准；广东省中考英语听说考试本身不向考生收取任何费用。',
  sourceImage: '', 
};

export const DEFAULT_SETTINGS = {
  apiKey: process.env.EXAM_API_KEY || '',
  apiBase: process.env.EXAM_API_BASE || 'https://api.hcnsec.cn/v1',
  model: process.env.EXAM_MODEL || 'DeepSeek-V4.1-Flash',
  availableModels: [],
  adminUsername: 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : '',
  siteName: '广东中考英语听说 · 在线模拟',
  examRegion: 'jiangmen',
  pricing: DEFAULT_PRICING,
  paperTemperature: 0.85,
  scoreTemperature: 0.2,
  
  practiceDailyLimit: 50,
  
  security: {
    registrationOff: false, 
    loginOff: false, 
    speechOff: false, 
  },
  
  cardBuyUrl: '',
  
  brevo: {
    enabled: false,
    apiKey: '',      
    senderEmail: '',  
    senderName: '在线练习系统',
  },
  
  bannedIps: [],
  
  urgentNotice: {
    enabled: false,
    id: '',       
    title: '',
    body: '',
  },
  
  turnstile: {
    siteKey: '',    
    secretKey: '',  
  },
  
  speechApi: {
    apiBase: '',     
    apiKey: '',      
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    asrModel: 'whisper-1',
  },
  
  scriptGuard: {
    enabled: true,
    scriptMax: 5, 
    windowMin: 10, 
  },
};

 

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  let calc;
  try {
    calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const newToken = () => crypto.randomBytes(24).toString('hex');

 
export function generateCode(prefix = 'JMKT', groups = 3, size = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) =>
    Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return [prefix, ...Array.from({ length: groups }, () => pick(size))].join('-');
}

 

const EMPTY_DB = () => ({
  settings: { ...DEFAULT_SETTINGS },
  users: [],
  sessions: {},
  codes: [],
  logs: [],
  orders: [],
  activity: [],   
  records: [],    
  announcements: [], 
  abnormal: [],      
});

let db = null;
let saveTimer = null;
let dirty = false;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

export function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = deepMerge(EMPTY_DB(), JSON.parse(raw));
    } else {
      db = EMPTY_DB();
    }
  } catch (e) {
    console.error('[store] 数据文件损坏，已启用空库：', e.message);
    const broken = DB_FILE + '.broken-' + Date.now();
    try {
      fs.renameSync(DB_FILE, broken);
      console.error('[store] 原文件已另存为', broken);
    } catch {}
    db = EMPTY_DB();
  }
  
  
  
  if (process.env.ADMIN_PASSWORD && !db.settings.adminPasswordHash) {
    db.settings.adminPasswordHash = hashPassword(process.env.ADMIN_PASSWORD);
    save();
  }
  return db;
}

export function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 120);
}

export function flush() {
  if (!dirty || !db) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[store] 写入失败：', e.message);
  }
}

export const data = () => load();

 

export function getSettings() {
  return load().settings;
}

export function getPublicSettings() {
  const s = getSettings();
  const hasKey = Boolean(s.apiKey);
  return {
    siteName: s.siteName,
    examRegion: s.examRegion,
    model: s.model,
    apiBase: s.apiBase,
    apiKeySet: hasKey,
    apiKeyHint: hasKey ? s.apiKey.slice(0, 6) + '••••' + s.apiKey.slice(-4) : '',
    availableModels: s.availableModels,
    pricing: s.pricing,
    cardBuyUrl: String(s.cardBuyUrl || '').trim(),
    emailVerify: Boolean(s.brevo?.enabled && s.brevo?.apiKey && s.brevo?.senderEmail),
    
    brevo: {
      enabled: Boolean(s.brevo?.enabled),
      apiKeySet: Boolean(s.brevo?.apiKey),
      apiKeyHint: s.brevo?.apiKey ? s.brevo.apiKey.slice(0, 8) + '••••' + s.brevo.apiKey.slice(-4) : '',
      senderEmail: s.brevo?.senderEmail || '',
      senderName: s.brevo?.senderName || '',
    },
    security: s.security || { registrationOff: false, loginOff: false, speechOff: false },
    
    urgentNotice: s.urgentNotice?.enabled ? { id: s.urgentNotice.id, title: s.urgentNotice.title, body: s.urgentNotice.body } : null,
    
    turnstileSiteKey: String(s.turnstile?.siteKey || '').trim(),
    turnstileSecretSet: Boolean(s.turnstile?.secretKey),
    
    speechApi: {
      apiBase: s.speechApi?.apiBase || '',
      apiKeySet: Boolean(s.speechApi?.apiKey),
      apiKeyHint: s.speechApi?.apiKey ? s.speechApi.apiKey.slice(0, 6) + '••••' + s.speechApi.apiKey.slice(-4) : '',
      ttsModel: s.speechApi?.ttsModel || 'tts-1',
      ttsVoice: s.speechApi?.ttsVoice || 'alloy',
      asrModel: s.speechApi?.asrModel || 'whisper-1',
    },
    
    sources: configSources(s),
    locked: envLocked(s),
  };
}

export function updateSettings(patch) {
  const s = getSettings();
  const db0 = load();
  db0.settings = deepMerge(s, patch);
  save();
  return db0.settings;
}

 

const publicUser = (u) => {
  if (!u) return null;
  const proActive = u.proUntil && u.proUntil > Date.now();
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    credits: u.credits || 0,
    freeLeft: Math.max(0, (getSettings().pricing.freeTrials || 0) - (u.freeUsed || 0)),
    proUntil: u.proUntil || 0,
    proActive: Boolean(proActive),
    proDaysLeft: proActive ? Math.ceil((u.proUntil - Date.now()) / 86400000) : 0,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || 0,
    usedCount: u.usedCount || 0,
  };
};
export { publicUser };

export function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return load().users.find((u) => u.email === e) || null;
}
export function findUserByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return load().users.find((u) => u.phone === p) || null;
}
export function findUserByAccount(account) {
  const s = String(account || '').trim();
  if (!s) return null;
  return s.includes('@') ? findUserByEmail(s) : findUserByPhone(s);
}
export function findUserById(id) {
  return load().users.find((u) => u.id === id) || null;
}

 
export function normalizePhone(phone) {
  const d = String(phone || '').replace(/[\s-]/g, '').replace(/^\+?86/, '');
  return /^1\d{10}$/.test(d) ? d : '';
}

 
export function createUser({ email, phone, password, name }) {
  const db0 = load();
  const e = String(email || '').trim().toLowerCase();
  const p = normalizePhone(phone);
  if (!e && !p) throw new Error('请填写邮箱或手机号');
  if (e && findUserByEmail(e)) throw new Error('该邮箱已注册');
  if (p && findUserByPhone(p)) throw new Error('该手机号已注册');
  const user = {
    id: crypto.randomUUID(),
    email: e,
    phone: p,
    name: name || (e ? e.split('@')[0] : `用户${p.slice(-4)}`),
    passHash: hashPassword(password),
    credits: 0,
    freeUsed: 0,
    proUntil: 0,
    disabled: false,
    usedCount: 0,
    createdAt: Date.now(),
    lastLoginAt: 0,
  };
  db0.users.push(user);
  log('register', user.id, e || p);
  save();
  return user;
}

export function log(action, userId = '', detail = '') {
  const db0 = load();
  db0.logs.unshift({ at: Date.now(), action, userId, detail });
  if (db0.logs.length > 800) db0.logs.length = 800;
  save();
}

 

 
export function addRecord({ userId, topic, total, maxTotal, grade, report, paper }) {
  const db0 = load();
  const rec = {
    id: newToken(),
    userId,
    at: Date.now(),
    topic: topic || '',
    total,
    maxTotal,
    grade: grade || '',
    
    report,
    paperBrief: {
      topic: paper?.topic || topic || '',
      readAloud: paper?.readAloud?.passage || '',
    },
  };
  db0.records.unshift(rec);
  
  const mine = db0.records.filter((r) => r.userId === userId);
  if (mine.length > 100) {
    const drop = new Set(mine.slice(100).map((r) => r.id));
    db0.records = db0.records.filter((r) => !drop.has(r.id));
  }
  save();
  return rec;
}

 
export function listRecords(userId, limit = 50) {
  const db0 = load();
  return db0.records
    .filter((r) => r.userId === userId)
    .slice(0, limit)
    .map((r) => ({ id: r.id, at: r.at, topic: r.topic, total: r.total, maxTotal: r.maxTotal, grade: r.grade }));
}

 
export function getRecord(userId, id) {
  const db0 = load();
  return db0.records.find((r) => r.id === id && r.userId === userId) || null;
}

 

const SESSION_TTL = 30 * 86400000;

export function createSession(userId, kind = 'user') {
  const db0 = load();
  const token = newToken();
  db0.sessions[token] = { userId, kind, exp: Date.now() + SESSION_TTL };
  save();
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const db0 = load();
  const s = db0.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) {
    delete db0.sessions[token];
    save();
    return null;
  }
  return s;
}

export function destroySession(token) {
  const db0 = load();
  if (token && db0.sessions[token]) {
    delete db0.sessions[token];
    save();
  }
}

 

 
export function checkQuota(user) {
  if (!user) return { ok: false, source: 'none', reason: '请先登录' };
  if (user.disabled) return { ok: false, source: 'none', reason: '账号已被管理员停用' };
  if (user.proUntil && user.proUntil > Date.now()) return { ok: true, source: 'pro' };
  if ((user.credits || 0) > 0) return { ok: true, source: 'credits' };
  const free = (getSettings().pricing.freeTrials || 0) - (user.freeUsed || 0);
  if (free > 0) return { ok: true, source: 'free' };
  return { ok: false, source: 'none', reason: '免费次数已用完，请使用兑换码开通次卡或月卡' };
}

 
export function consumeQuota(user) {
  const q = checkQuota(user);
  if (!q.ok) return q;
  user.usedCount = (user.usedCount || 0) + 1;
  if (q.source === 'free') {
    user.freeUsed = (user.freeUsed || 0) + 1;
  } else if (q.source === 'credits') {
    user.credits = Math.max(0, (user.credits || 0) - 1);
  }
  log('consume', user.id, `${q.source} → 剩余 ${user.credits || 0} 次`);
  save();
  return q;
}

 

export function createCodes({ type, value, count = 1, note = '', prefix = 'JMKT' }) {
  const db0 = load();
  const made = [];
  for (let i = 0; i < Math.min(500, Math.max(1, Number(count) || 1)); i++) {
    let code;
    do {
      code = generateCode(prefix);
    } while (db0.codes.some((c) => c.code === code));
    const rec = {
      code,
      type: type === 'monthly' ? 'monthly' : 'credits',
      value: Math.max(1, Number(value) || 1),
      note: note || '',
      createdAt: Date.now(),
      createdBy: 'admin',
      usedBy: '',
      usedAt: 0,
      disabled: false,
    };
    db0.codes.unshift(rec);
    made.push(rec);
  }
  log('codes', '', `生成 ${made.length} 个 ${type} 兑换码`);
  save();
  return made;
}

export function redeemCode(user, rawCode) {
  const db0 = load();
  const code = String(rawCode || '').trim().toUpperCase().replace(/\s/g, '');
  const rec = db0.codes.find((c) => c.code === code);
  if (!rec) throw new Error('兑换码不存在，请核对后重试');
  if (rec.disabled) throw new Error('该兑换码已被管理员作废');
  if (rec.usedBy) throw new Error('该兑换码已被使用');

  if (rec.type === 'monthly') {
    const days = rec.value;
    const base = user.proUntil && user.proUntil > Date.now() ? user.proUntil : Date.now();
    user.proUntil = base + days * 86400000;
  } else {
    user.credits = (user.credits || 0) + rec.value;
  }
  rec.usedBy = user.id;
  rec.usedAt = Date.now();
  db0.orders.unshift({
    at: Date.now(),
    userId: user.id,
    type: rec.type,
    value: rec.value,
    code: rec.code,
  });
  log('redeem', user.id, `${rec.type} ${rec.value} via ${rec.code}`);
  save();
  return { type: rec.type, value: rec.value, user: publicUser(user) };
}

export function listCodes({ onlyUnused = false, limit = 300 } = {}) {
  let arr = load().codes;
  if (onlyUnused) arr = arr.filter((c) => !c.usedBy && !c.disabled);
  return arr.slice(0, limit);
}

export function setCodeDisabled(code, disabled) {
  const rec = load().codes.find((c) => c.code === code);
  if (!rec) throw new Error('兑换码不存在');
  rec.disabled = Boolean(disabled);
  save();
  return rec;
}

export function listUsers() {
  return load().users.map(publicUser);
}

export function updateUser(id, patch) {
  const u = findUserById(id);
  if (!u) throw new Error('用户不存在');
  if (patch.credits !== undefined) u.credits = Math.max(0, Number(patch.credits) || 0);
  if (patch.addCredits !== undefined) u.credits = Math.max(0, (u.credits || 0) + Number(patch.addCredits || 0));
  if (patch.addDays !== undefined) {
    const base = u.proUntil && u.proUntil > Date.now() ? u.proUntil : Date.now();
    u.proUntil = base + Number(patch.addDays || 0) * 86400000;
  }
  if (patch.proUntil !== undefined) u.proUntil = Number(patch.proUntil) || 0;
  if (patch.disabled !== undefined) u.disabled = Boolean(patch.disabled);
  if (patch.resetFree !== undefined && patch.resetFree) u.freeUsed = 0;
  if (patch.password) u.passHash = hashPassword(patch.password);
  log('admin-user', u.id, JSON.stringify(patch));
  save();
  return publicUser(u);
}

export function deleteUser(id) {
  const db0 = load();
  const i = db0.users.findIndex((u) => u.id === id);
  if (i < 0) throw new Error('用户不存在');
  db0.users.splice(i, 1);
  for (const [t, s] of Object.entries(db0.sessions)) if (s.userId === id) delete db0.sessions[t];
  log('admin-delete-user', id, '');
  save();
}

 

 
export function clearData(scope = {}) {
  const db0 = load();
  const done = {};
  if (scope.users !== false) {
    done.users = db0.users.length;
    db0.users = [];
  }
  
  
  if (scope.users !== false || scope.sessions) {
    const keepAdmin = Object.fromEntries(
      Object.entries(db0.sessions).filter(([, s]) => s && s.kind === 'admin')
    );
    done.sessions = Object.keys(db0.sessions).length - Object.keys(keepAdmin).length;
    db0.sessions = keepAdmin;
  }
  if (scope.codes) {
    done.codes = db0.codes.length;
    db0.codes = [];
  }
  if (scope.orders) {
    done.orders = db0.orders.length;
    db0.orders = [];
  }
  if (scope.logs) {
    done.logs = db0.logs.length;
    db0.logs = [];
  }
  log('admin-clear-data', 'admin', JSON.stringify(done));
  save();
  return done;
}

export function listOrders(limit = 200) {
  return load().orders.slice(0, limit);
}

export function stats() {
  const db0 = load();
  const now = Date.now();
  return {
    users: db0.users.length,
    proUsers: db0.users.filter((u) => u.proUntil > now).length,
    codes: db0.codes.length,
    codesUsed: db0.codes.filter((c) => c.usedBy).length,
    orders: db0.orders.length,
    attempts: db0.users.reduce((s, u) => s + (u.usedCount || 0), 0),
    revenueEstimate:
      Math.round(
        db0.orders.reduce((s, o) => {
          const p = db0.settings.pricing;
          return s + (o.type === 'monthly' ? (p.monthly?.price || 0) : (p.perUse?.price || 0) * (o.value || 1));
        }, 0) * 100
      ) / 100,
  };
}

 

 
export function addAnnouncement({ title, body, level = 'info', author = 'admin' }) {
  const db0 = load();
  const item = {
    id: newToken().slice(0, 12),
    at: Date.now(),
    title: String(title || '').slice(0, 80),
    body: String(body || '').slice(0, 2000),
    level: ['info', 'warn', 'alert'].includes(level) ? level : 'info',
    author: String(author || 'admin').slice(0, 40),
    active: true,
  };
  db0.announcements.unshift(item);
  if (db0.announcements.length > 100) db0.announcements.length = 100;
  save();
  return item;
}

 
export function listAnnouncements(onlyActive = true) {
  const db0 = load();
  return (db0.announcements || []).filter((a) => (onlyActive ? a.active : true)).slice(0, 50);
}

 
export function toggleAnnouncement(id, active) {
  const db0 = load();
  const a = (db0.announcements || []).find((x) => x.id === id);
  if (!a) return null;
  a.active = Boolean(active);
  save();
  return a;
}

 
export function removeAnnouncement(id) {
  const db0 = load();
  const before = (db0.announcements || []).length;
  db0.announcements = (db0.announcements || []).filter((x) => x.id !== id);
  save();
  return before - db0.announcements.length;
}

 
export function addAbnormal({ type = 'ip', value, reason, note }) {
  const db0 = load();
  const item = {
    id: newToken().slice(0, 12),
    at: Date.now(),
    type: ['ip', 'account', 'address'].includes(type) ? type : 'ip',
    value: String(value || '').slice(0, 120),
    reason: String(reason || '').slice(0, 120),
    note: String(note || '').slice(0, 500),
    active: true,
  };
  db0.abnormal.unshift(item);
  if (db0.abnormal.length > 100) db0.abnormal.length = 100;
  save();
  return item;
}

 
export function listAbnormal(onlyActive = true) {
  const db0 = load();
  return (db0.abnormal || []).filter((a) => (onlyActive ? a.active : true)).slice(0, 50);
}

export function toggleAbnormal(id, active) {
  const db0 = load();
  const a = (db0.abnormal || []).find((x) => x.id === id);
  if (!a) return null;
  a.active = Boolean(active);
  save();
  return a;
}

export function removeAbnormal(id) {
  const db0 = load();
  const before = (db0.abnormal || []).length;
  db0.abnormal = (db0.abnormal || []).filter((x) => x.id !== id);
  save();
  return before - db0.abnormal.length;
}

 

 
export function isIpBanned(ip) {
  if (!ip) return false;
  const v = String(ip).replace(/^::ffff:/, '');
  const list = getSettings().bannedIps || [];
  for (const b of list) {
    const target = String(b.ip || '').trim();
    if (!target) continue;
    
    if (target.includes('/')) {
      const [net, bitsStr] = target.split('/');
      const bits = Number(bitsStr);
      if (v.includes(':')) {
        
        if (Number.isFinite(bits) && bits > 0 && v.startsWith(net.slice(0, 2))) return true;
      } else {
        const mask = Number.isFinite(bits) && bits > 0 ? bits : 24;
        const ipN = v.split('.').map(Number);
        const netN = net.split('.').map(Number);
        if (ipN.length === 4 && netN.length === 4) {
          const toInt = (arr) =>
            ((arr[0] || 0) << 24) + ((arr[1] || 0) << 16) + ((arr[2] || 0) << 8) + (arr[3] || 0);
          const shift = 32 - mask;
          if ((toInt(ipN) >>> shift) === (toInt(netN) >>> shift)) return true;
        }
      }
    } else if (target.endsWith('.')) {
      
      if (v.startsWith(target)) return true;
    } else if (v === target) {
      
      return true;
    }
  }
  return false;
}

 
export function banIp(ip, note = '', by = 'admin') {
  const db0 = load();
  const s = db0.settings;
  if (!s.bannedIps) s.bannedIps = [];
  const key = String(ip || '').trim();
  if (!key) return { added: false, reason: 'IP 不能为空' };
  if (s.bannedIps.some((b) => String(b.ip).trim() === key)) {
    return { added: false, reason: '该 IP 已在封禁列表中' };
  }
  s.bannedIps.unshift({
    id: newToken().slice(0, 12),
    ip: key,
    note: String(note || '').slice(0, 200),
    by: String(by || 'admin').slice(0, 40),
    auto: by === 'auto',
    at: Date.now(),
  });
  save();
  return { added: true };
}

 
export function unbanIp(ip) {
  const db0 = load();
  const s = db0.settings;
  if (!s.bannedIps) return 0;
  const before = s.bannedIps.length;
  s.bannedIps = s.bannedIps.filter((b) => String(b.ip).trim() !== String(ip || '').trim());
  save();
  return before - s.bannedIps.length;
}

 
export function listBannedIps() {
  return getSettings().bannedIps || [];
}

 
export function removeBannedIpById(id) {
  const db0 = load();
  const s = db0.settings;
  if (!s.bannedIps) return 0;
  const before = s.bannedIps.length;
  s.bannedIps = s.bannedIps.filter((b) => b.id !== id);
  save();
  return before - s.bannedIps.length;
}

 

export function adminPasswordSet() {
  return Boolean(getSettings().adminPasswordHash);
}

export function setAdminPassword(pw) {
  updateSettings({ adminPasswordHash: hashPassword(pw) });
}

export function checkAdminPassword(pw) {
  const s = getSettings();
  if (!s.adminPasswordHash) return false;
  return verifyPassword(pw, s.adminPasswordHash);
}


for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
process.on('exit', flush);
