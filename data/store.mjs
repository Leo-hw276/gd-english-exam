/**
 * store.mjs —— 轻量 JSON 持久化层（零依赖）
 *
 * 保存：平台设置（API Key / v1 地址 / 模型 / 定价）、用户、会话、兑换码、流水日志。
 * 写入采用「临时文件 + 原子重命名」，避免进程中断导致数据文件损坏。
 *
 * 数据文件默认落在 <项目根>/data/db.json（可用 EXAM_DB_FILE 覆盖；
 * Railway 上建议挂载 Volume 并把路径指到 /data/db.json）。
 *
 * 配置优先级：环境变量 > .env 文件 > 后台设置 > 内置默认值
 *   —— 密钥永远不该写进代码，所以 server.mjs / store.mjs 里没有任何硬编码 Key。
 */

// 必须最先加载 .env：下面的 DB_FILE 与 DEFAULT_SETTINGS 都依赖 process.env
import { configSources, envLocked } from './env.mjs';

// 再导出，方便 server.mjs 直接通过 DB.configSources / DB.envLocked 使用
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

/* ------------------------------------------------------------------ *
 *  默认设置
 * ------------------------------------------------------------------ */

export const DEFAULT_PRICING = {
  currency: 'CNY',
  currencySymbol: '¥',
  freeTrials: 2,
  freeTrialNote: '新用户注册即赠 2 次完整听说模拟（三大题五小节，含 AI 逐题评分报告）。',
  perUse: {
    name: '次卡',
    price: 2.9,
    unit: '次',
    desc: '一次完整听说模拟：自动组卷 + 全程录音 + 30 分制 AI 评分报告。',
  },
  monthly: {
    name: '月卡',
    price: 29.9,
    days: 30,
    desc: '30 天内不限次练习，适合考前冲刺，每天可练多套。',
  },
  sourceNote:
    '定价由本站管理员在后台自行设定，非官方收费标准；广东省中考英语听说考试本身不向考生收取任何费用。',
  sourceImage: '', // 定价说明配图（/uploads/xxx.png），由管理员后台上传
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
  // 单句精练每日限额（0 = 不限）
  practiceDailyLimit: 50,
  // 紧急开关：被攻击/维护时可一键关闭对应入口
  security: {
    registrationOff: false, // 关闭新用户注册
    loginOff: false, // 关闭登录（已登录用户仍可用）
    speechOff: false, // 关闭语音合成与识别（省带宽/防刷）
  },
};

/* ------------------------------------------------------------------ *
 *  密码与令牌
 * ------------------------------------------------------------------ */

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

/** 生成易读兑换码，如 JMKT-7F3K-92QD-XB4M（去掉了 0/O/1/I 等易混字符） */
export function generateCode(prefix = 'JMKT', groups = 3, size = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) =>
    Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return [prefix, ...Array.from({ length: groups }, () => pick(size))].join('-');
}

/* ------------------------------------------------------------------ *
 *  数据库
 * ------------------------------------------------------------------ */

const EMPTY_DB = () => ({
  settings: { ...DEFAULT_SETTINGS },
  users: [],
  sessions: {},
  codes: [],
  logs: [],
  orders: [],
  activity: [],   // 登录 / 注册 / 朗读等活动审计（含 IP、浏览器）
  records: [],    // 考生历史成绩记录（用于复盘）
});

let db = null;
let saveTimer = null;
let dirty = false;

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
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
  // 配置唯一入口是网站后台（管理员在 /#admin 里填 v1 地址、密钥、模型并保存在库里）。
  // 环境变量只在新库第一次初始化时作为初始默认值（见 EMPTY_DB），之后以数据库为准，
  // 后台随时可改 —— 不经过部署平台的变量注入，改完立即生效。
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

/* ------------------------------------------------------------------ *
 *  设置
 * ------------------------------------------------------------------ */

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
    security: s.security || { registrationOff: false, loginOff: false, speechOff: false },
    // 配置来源（db=网站后台保存；环境变量仅作新库初始值，不锁定）
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

/* ------------------------------------------------------------------ *
 *  用户
 * ------------------------------------------------------------------ */

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
  return load().users.find((u) => u.email === e) || null;
}
export function findUserById(id) {
  return load().users.find((u) => u.id === id) || null;
}

export function createUser({ email, password, name }) {
  const db0 = load();
  const e = String(email).trim().toLowerCase();
  if (findUserByEmail(e)) throw new Error('该邮箱已注册');
  const user = {
    id: crypto.randomUUID(),
    email: e,
    name: name || e.split('@')[0],
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
  log('register', user.id, e);
  save();
  return user;
}

export function log(action, userId = '', detail = '') {
  const db0 = load();
  db0.logs.unshift({ at: Date.now(), action, userId, detail });
  if (db0.logs.length > 800) db0.logs.length = 800;
  save();
}

/* ------------------------------------------------------------------ *
 *  考试记录（复盘用）
 * ------------------------------------------------------------------ */

/** 保存一次考试的评分结果 */
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
    // 精简报告：只留评分与诊断，不存完整试卷原文以免库太大
    report,
    paperBrief: {
      topic: paper?.topic || topic || '',
      readAloud: paper?.readAloud?.passage || '',
    },
  };
  db0.records.unshift(rec);
  // 每用户最多保留 100 条
  const mine = db0.records.filter((r) => r.userId === userId);
  if (mine.length > 100) {
    const drop = new Set(mine.slice(100).map((r) => r.id));
    db0.records = db0.records.filter((r) => !drop.has(r.id));
  }
  save();
  return rec;
}

/** 列出某用户的历史记录（不含完整报告） */
export function listRecords(userId, limit = 50) {
  const db0 = load();
  return db0.records
    .filter((r) => r.userId === userId)
    .slice(0, limit)
    .map((r) => ({ id: r.id, at: r.at, topic: r.topic, total: r.total, maxTotal: r.maxTotal, grade: r.grade }));
}

/** 取单条完整记录 */
export function getRecord(userId, id) {
  const db0 = load();
  return db0.records.find((r) => r.id === id && r.userId === userId) || null;
}

/* ------------------------------------------------------------------ *
 *  会话
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  额度 / 会员
 * ------------------------------------------------------------------ */

/** 是否还能开考；返回 {ok, source} */
export function checkQuota(user) {
  if (!user) return { ok: false, source: 'none', reason: '请先登录' };
  if (user.disabled) return { ok: false, source: 'none', reason: '账号已被管理员停用' };
  if (user.proUntil && user.proUntil > Date.now()) return { ok: true, source: 'pro' };
  if ((user.credits || 0) > 0) return { ok: true, source: 'credits' };
  const free = (getSettings().pricing.freeTrials || 0) - (user.freeUsed || 0);
  if (free > 0) return { ok: true, source: 'free' };
  return { ok: false, source: 'none', reason: '免费次数已用完，请使用兑换码开通次卡或月卡' };
}

/** 消耗一次额度（优先扣免费次数 → 次卡 → 月卡不扣） */
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

/* ------------------------------------------------------------------ *
 *  兑换码
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  用户数据：导出 / 导入 / 一键清空
 *  注意：导出文件包含密码哈希（scrypt 加盐），用于完整备份与还原，
 *  请只保存在自己手上，不要公开分享。
 * ------------------------------------------------------------------ */

export function exportUsers() {
  const db0 = load();
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    users: db0.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      passHash: u.passHash,
      credits: u.credits || 0,
      freeUsed: u.freeUsed || 0,
      proUntil: u.proUntil || 0,
      usedCount: u.usedCount || 0,
      disabled: Boolean(u.disabled),
      createdAt: u.createdAt || Date.now(),
      lastLoginAt: u.lastLoginAt || 0,
    })),
  };
}

/**
 * 导入用户。
 * @param {object} payload  导出文件的内容，或直接是用户数组
 * @param {'merge'|'replace'} mode  merge=按邮箱覆盖/新增；replace=先清空再导入
 */
export function importUsers(payload, mode = 'merge') {
  const db0 = load();
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.users) ? payload.users : null;
  if (!list) throw new Error('导入内容格式不正确（需要 users 数组）');
  if (!list.length) throw new Error('导入内容为空');

  const result = { added: 0, updated: 0, skipped: 0, removed: 0 };

  if (mode === 'replace') {
    result.removed = db0.users.length;
    db0.users = [];
    db0.sessions = {};
  }

  const byEmail = new Map(db0.users.map((u) => [String(u.email).toLowerCase(), u]));

  for (const raw of list) {
    const email = String(raw?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      result.skipped++;
      continue;
    }
    const existing = byEmail.get(email);
    const fields = {
      name: String(raw.name || email.split('@')[0]).slice(0, 40),
      passHash: typeof raw.passHash === 'string' && raw.passHash.includes(':') ? raw.passHash : hashPassword('123456'),
      credits: Math.max(0, Number(raw.credits) || 0),
      freeUsed: Math.max(0, Number(raw.freeUsed) || 0),
      proUntil: Number(raw.proUntil) || 0,
      usedCount: Math.max(0, Number(raw.usedCount) || 0),
      disabled: Boolean(raw.disabled),
      createdAt: Number(raw.createdAt) || Date.now(),
      lastLoginAt: Number(raw.lastLoginAt) || 0,
    };

    if (existing) {
      Object.assign(existing, fields);
      result.updated++;
    } else {
      const u = { id: String(raw.id || crypto.randomUUID()), email, ...fields };
      db0.users.push(u);
      byEmail.set(email, u);
      result.added++;
    }
  }

  log('admin-import-users', 'admin', `mode=${mode} +${result.added} ~${result.updated} -${result.removed}`);
  save();
  return result;
}

/**
 * 一键清空用户数据。
 * @param {{users?:boolean, sessions?:boolean, codes?:boolean, orders?:boolean, logs?:boolean}} scope
 */
export function clearData(scope = {}) {
  const db0 = load();
  const done = {};
  if (scope.users !== false) {
    done.users = db0.users.length;
    db0.users = [];
  }
  // 用户没了，用户会话必须一起清，否则会出现"幽灵登录"；
  // 但管理员自己的会话要保留，否则清空后立刻被踢出后台。
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

/* ------------------------------------------------------------------ *
 *  管理员
 * ------------------------------------------------------------------ */

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

// 进程退出前落盘
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
process.on('exit', flush);
