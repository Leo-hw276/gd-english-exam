import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EXAM, SCORE_TABLE, PAPER_SYSTEM_PROMPT, buildPaperPromptPartA, buildPaperPromptPartB, pickTopic, SCORE_SYSTEM_PROMPT, buildReadAloudScorePrompt, buildInfoScorePrompt, buildRetellAskScorePrompt, FALLBACK_PAPER } from './data/exam-spec.mjs';
import { clientIp, ipPrefix, parseUa, rateLimit, isBanned, banKey, createCaptcha, verifyCaptcha, riskScore, makeActivityStore, ipToLocation, isPrivateIp, countScriptHit, resetScriptHits, isRequestAllowed } from './data/security.mjs';
import { synthesize as edgeTts, rateStr as ttsRateStr, setCacheDir as setTtsCacheDir, VOICES as TTS_VOICES } from './data/edge-tts.mjs';
import * as Brevo from './data/brevo.mjs';
import { CITY_PROFILES, DEFAULT_CITY, cityProfile } from './data/exam-spec.mjs';
import * as DB from './data/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const Activity = makeActivityStore((events) => {
  try { const db0 = DB.data(); db0.activity = events; DB.save(); } catch {}
});
try { Activity.load(DB.data().activity); } catch {}

const geoPromises = new Map();

function logVisit(req, kind, fields = {}) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const { browser, os, inApp, bot } = parseUa(ua);
  const rec = Activity.push({ kind, ip, browser, os, inApp, bot, ua: ua.slice(0, 220), ...fields });
  if (ip && ip !== 'unknown') {
    const doGeo = async () => {
      try { const geo = await ipToLocation(ip); if (geo.str) rec.geo = geo.str; } catch {}
    };
    if (geoPromises.has(ip)) geoPromises.get(ip).then(() => doGeo());
    else {
      const p = doGeo().finally(() => geoPromises.delete(ip));
      geoPromises.set(ip, p);
    }
  }
  return rec;
}

try { setTtsCacheDir(path.join(__dirname, 'data', 'tts-cache')); } catch {}

const RL = {
  register: (ip) => rateLimit(`reg:${ip}`, { windowMs: 10 * 60_000, max: 5 }),
  login: (ip) => rateLimit(`login:${ip}`, { windowMs: 5 * 60_000, max: 10 }),
  adminLogin: (ip) => rateLimit(`adm-login:${ip}`, { windowMs: 5 * 60_000, max: 5 }),
  captcha: (ip) => rateLimit(`cap:${ip}`, { windowMs: 60_000, max: 120 }),
  emailCode: (ip) => rateLimit(`ec:${ip}`, { windowMs: 10 * 60_000, max: 10 }),
  paper: (uid) => rateLimit(`paper:${uid}`, { windowMs: 60_000, max: 3 }),
  api: (ip) => rateLimit(`api:${ip}`, { windowMs: 60_000, max: 120 }),
  tts: (ip) => rateLimit(`tts:${ip}`, { windowMs: 60_000, max: 40 }),
};

function getCfg() {
  const s = DB.getSettings();
  return {
    apiKey: s.apiKey || '',
    apiBase: s.apiBase || 'https://api.hcnsec.cn/v1',
    model: s.model || 'DeepSeek-V4.1-Flash',
    temperaturePaper: Number(s.paperTemperature ?? 0.85),
    temperatureScore: Number(s.scoreTemperature ?? 0.2),
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

const LLM_TIMEOUT_MS = Math.max(15_000, Number(process.env.EXAM_LLM_TIMEOUT_MS || 120_000));
const LLM_STALL_MS = Math.max(8_000, Number(process.env.EXAM_LLM_STALL_MS || 45_000));
const LLM_RETRIES = Math.max(0, Math.min(3, Number(process.env.EXAM_LLM_RETRIES || 1)));
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callChat({ apiKey, apiBase, model, system, user, temperature, maxTokens, json, stallMs }) {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
  const STALL = Math.max(8_000, Number(stallMs) || LLM_STALL_MS);

  const run = async (withJson) => {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (withJson) body.response_format = { type: 'json_object' };

    const ctl = new AbortController();
    let stalled = false;
    let watchdog = null;
    const overall = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    const bump = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; ctl.abort(); }, STALL);
    };
    const cleanup = () => {
      clearTimeout(overall);
      if (watchdog) clearTimeout(watchdog);
    };
    bump();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      cleanup();
      const msg = stalled ? `模型服务 ${STALL / 1000} 秒无响应（已主动断开）` : `连接模型服务失败：${e.message}`;
      return { error: msg, status: 504, retryable: true };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      cleanup();
      return { error: text || `HTTP ${res.status}`, status: res.status, retryable: RETRYABLE.has(res.status) };
    }

    let content = '';
    let usage = null;
    let buf = '';
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        bump();
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta;
            if (d?.content) content += d.content;
            const legacyText = j.choices?.[0]?.message?.content;
            if (!d?.content && legacyText) content += legacyText;
            if (j.usage) usage = j.usage;
            if (j.error) {
              cleanup();
              return { error: JSON.stringify(j.error), status: 502, retryable: true };
            }
          } catch {}
        }
      }
    } catch (e) {
      cleanup();
      const msg = stalled ? `模型服务输出中断（${STALL / 1000} 秒无新内容，已主动断开）` : `读取模型流式响应中断：${e.message}`;
      return { error: msg, status: 504, retryable: true };
    }
    cleanup();
    if (!content.trim()) return { error: stalled ? '模型服务无响应' : '模型返回内容为空', status: 502, retryable: stalled };
    return { content, usage };
  };

  const attempt = async () => {
    let out = await run(Boolean(json));
    if (out.error && json && /response_format|json_object|unsupported|invalid.*param|bad_request/i.test(out.error)) {
      out = await run(false);
    }
    return out;
  };

  let out = await attempt();
  let tries = 0;
  while (out.error && out.retryable && tries < LLM_RETRIES) {
    tries++;
    const wait = 1200 * tries;
    console.warn(`[llm] 第 ${tries} 次重试（${wait}ms 后）：${String(out.error).slice(0, 140)}`);
    await sleep(wait);
    out = await attempt();
  }
  if (out.error) throw new LlmError(`模型服务返回：${String(out.error).slice(0, 400)}`, out.status || 502);
  return { content: out.content, usage: out.usage };
}

function closeBrackets(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = inStr ? '"' : '';
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

function endsInString(s) {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
  }
  return inStr;
}

function repairTruncatedJson(tail) {
  let cur = String(tail).replace(/\s+$/, '');
  for (let round = 0; round < 60; round++) {
    let c = cur;
    c = c.replace(/[,:\s]+$/, '');
    if (endsInString(c)) {
      const q = c.lastIndexOf('"');
      c = q >= 0 ? c.slice(0, q) : c;
      c = c.replace(/[,:\s]+$/, '');
      c = c.replace(/"[^"]*"\s*:\s*$/, '');
      c = c.replace(/[,:\s]+$/, '');
    }
    const full = c + closeBrackets(c);
    const got = tryParseJson(full);
    if (got) return got;
    const idx = c.lastIndexOf(',');
    if (idx < 0) break;
    cur = c.slice(0, idx);
  }
  return null;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch {
    try { return JSON.parse(str.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
  }
}

function extractJson(text) {
  if (!text) throw new LlmError('模型未返回内容', 502);
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  if (first < 0) throw new LlmError('模型返回中找不到 JSON', 502);
  const tail = s.slice(first);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const got = tryParseJson(tail.slice(0, i + 1));
        if (got) return got;
        break;
      }
    }
  }
  const repaired = repairTruncatedJson(tail);
  if (repaired) {
    console.warn('[json] 输出被截断，已修复后解析成功');
    return repaired;
  }
  throw new LlmError('模型返回的 JSON 不完整', 502);
}

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, num(v, lo)));
const round1 = (v) => Math.round(v * 10) / 10;
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const arr = (v) => (Array.isArray(v) ? v : []);

function normalizeQuestion(q, fallbackOptions, fallbackIndex) {
  const options = arr(q?.options).map((o) => str(o)).filter(Boolean);
  const ok = options.length === 2 || options.length === 3;
  return {
    q: str(q?.q ?? q?.question, 'Question'),
    options: ok ? options : fallbackOptions,
    answerIndex: clamp(q?.answerIndex ?? fallbackIndex, 0, Math.max(0, options.length - 1)) | 0,
    evidence: str(q?.evidence, ''),
  };
}

function validatePartA(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const passage = str(p?.readAloud?.passage);
  if (!passage || passage.split(/\s+/).length < 40) errors.push('模仿朗读短文缺失或过短');
  const segs = arr(p?.chooseInfo)
    .map((s) => ({
      script: arr(s?.script).map((l) => ({ spk: str(l?.spk, 'M').slice(0, 3), en: str(l?.en) })).filter((l) => l.en),
      questions: arr(s?.questions).map((q, qi) => normalizeQuestion(q, ['—', '—'], qi % 2)),
    }))
    .filter((s) => s.script.length && s.questions.length);
  const ciCount = segs.reduce((n, s) => n + s.questions.length, 0);
  if (ciCount !== 6) errors.push(`听选信息题量应为 6，实际 ${ciCount}`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { readAloud: { passage }, chooseInfo: segs.slice(0, 3) } };
}

function validatePartB(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const aqScript = str(p?.answerQuestions?.script);
  const aqQs = arr(p?.answerQuestions?.questions).map((q) => ({
    q: str(q?.q ?? q?.question, 'Question'),
    answer: str(q?.answer, '—'),
    keyPoints: arr(q?.keyPoints).map((k) => str(k)).filter(Boolean),
  }));
  if (!aqScript) errors.push('回答问题录音材料缺失');
  if (aqQs.length !== 4) errors.push(`回答问题题量应为 4，实际 ${aqQs.length}`);
  const retellScript = str(p?.retell?.script);
  let outline = arr(p?.retell?.outline).map((o) => str(o)).filter(Boolean);
  if (!retellScript) errors.push('信息转述录音材料缺失');
  if (outline.length < 3) errors.push('信息转述要点不足');
  if (outline.length > 6) outline = outline.slice(0, 6);
  const asks = arr(p?.askQuestions)
    .map((a) => ({ cn: str(a?.cn), reference: str(a?.reference), mustInclude: arr(a?.mustInclude).map((m) => str(m)).filter(Boolean) }))
    .filter((a) => a.cn);
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { answerQuestions: { script: aqScript, questions: aqQs }, retell: { script: retellScript, outline, starter: str(p?.retell?.starter, ''), referenceRetell: str(p?.retell?.referenceRetell, '') }, askQuestions: asks.slice(0, 2) } };
}

function mergeWithFallback({ partA, partB, topic, notes }) {
  const a = partA || { readAloud: FALLBACK_PAPER.readAloud, chooseInfo: FALLBACK_PAPER.chooseInfo };
  const b = partB || { answerQuestions: FALLBACK_PAPER.answerQuestions, retell: FALLBACK_PAPER.retell, askQuestions: FALLBACK_PAPER.askQuestions };
  return {
    topic: partA && partB ? topic : `${topic}（部分使用内置备用材料）`,
    generatedAt: new Date().toISOString(),
    source: partA && partB ? 'ai' : 'hybrid',
    readAloud: a.readAloud,
    chooseInfo: a.chooseInfo,
    answerQuestions: b.answerQuestions,
    retell: b.retell,
    askQuestions: b.askQuestions,
    notes,
  };
}

function normalizeReadAloud(raw) {
  const score = round1(clamp(raw?.score, 0, 6));
  const dims = raw?.dimensions || {};
  const mk = (d, max) => ({ score: round1(clamp(d?.score, 0, max)), max, comment: str(d?.comment, '') });
  const out = {
    score,
    band: str(raw?.band, '-'),
    dimensions: {
      pronunciation: mk(dims.pronunciation, 2.5),
      intonation: mk(dims.intonation, 1.5),
      fluency: mk(dims.fluency, 2.0),
    },
    wordAnalysis: {
      missed: arr(raw?.wordAnalysis?.missed).map((w) => str(w)).filter(Boolean).slice(0, 25),
      mispronounced: arr(raw?.wordAnalysis?.mispronounced).map((w) => ({ word: str(w?.word), heardAs: str(w?.heardAs), tip: str(w?.tip) })).filter((w) => w.word).slice(0, 15),
      accuracy: num(raw?.wordAnalysis?.accuracy, 0),
    },
    overall: str(raw?.overall, ''),
    suggestions: arr(raw?.suggestions).map((s) => str(s)).filter(Boolean).slice(0, 6),
  };
  const sum = round1(out.dimensions.pronunciation.score + out.dimensions.intonation.score + out.dimensions.fluency.score);
  if (Math.abs(sum - out.score) <= 0.6) out.score = sum;
  out.score = round1(clamp(out.score, 0, 6));
  return out;
}

function normalizeItemList(rawList, { startIndex, count, perItem }) {
  const byIndex = new Map();
  for (const it of arr(rawList)) {
    const idx = Number(it?.index);
    if (Number.isFinite(idx)) byIndex.set(idx, it);
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    const idx = startIndex + k;
    const it = byIndex.get(idx) || arr(rawList)[k] || {};
    const verdict = ['correct', 'partial', 'wrong', 'blank'].includes(it?.verdict) ? it.verdict : 'wrong';
    let score = clamp(it?.score, 0, perItem);
    if (verdict === 'correct' && score < perItem * 0.66) score = perItem;
    if (verdict === 'blank') score = 0;
    if (verdict === 'wrong') score = 0;
    out.push({ index: idx, verdict, score: round1(clamp(score, 0, perItem)), heard: str(it?.heard, ''), expected: str(it?.expected, ''), missingPoints: arr(it?.missingPoints).map((s) => str(s)).filter(Boolean), comment: str(it?.comment, '') });
  }
  return out;
}

function normalizeRetell(raw) {
  const score = round1(clamp(raw?.score, 0, 6));
  const mk = (d, max) => ({ score: round1(clamp(d?.score, 0, max)), max, comment: str(d?.comment, '') });
  return {
    score,
    band: str(raw?.band, '-'),
    content: { ...mk(raw?.content, 3.0), coveredPoints: arr(raw?.content?.coveredPoints).map((s) => str(s)).filter(Boolean), missingPoints: arr(raw?.content?.missingPoints).map((s) => str(s)).filter(Boolean) },
    accuracy: mk(raw?.accuracy, 1.5),
    fluency: mk(raw?.fluency, 1.5),
    grammarErrors: arr(raw?.grammarErrors).map((g) => ({ error: str(g?.error), correction: str(g?.correction), explain: str(g?.explain) })).filter((g) => g.error || g.correction).slice(0, 10),
    overall: str(raw?.overall, ''),
    suggestions: arr(raw?.suggestions).map((s) => str(s)).filter(Boolean).slice(0, 6),
  };
}

function normalizeAsk(rawList) {
  const byIndex = new Map();
  for (const it of arr(rawList)) {
    const idx = Number(it?.index);
    if (Number.isFinite(idx)) byIndex.set(idx, it);
  }
  const out = [];
  for (let k = 0; k < 2; k++) {
    const idx = 12 + k;
    const it = byIndex.get(idx) || arr(rawList)[k] || {};
    const contentScore = round1(clamp(it?.contentScore, 0, 0.75));
    const languageScore = round1(clamp(it?.languageScore, 0, 0.75));
    let score = round1(clamp(it?.score ?? contentScore + languageScore, 0, 1.5));
    if (Math.abs(contentScore + languageScore - score) <= 0.2) score = round1(contentScore + languageScore);
    out.push({ index: idx, contentScore, languageScore, score: round1(clamp(score, 0, 1.5)), heard: str(it?.heard, ''), reference: str(it?.reference, ''), comment: str(it?.comment, '') });
  }
  return out;
}

function gradeLabel(total) {
  if (total >= 27) return { label: '优秀 A', color: '#12b76a' };
  if (total >= 24) return { label: '良好 B', color: '#2e90fa' };
  if (total >= 18) return { label: '及格 C', color: '#f79009' };
  return { label: '待提高 D', color: '#f04438' };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Server': 'gd-english' });
  res.end(body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBodyRaw(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('音频过大（上限 8MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };

const HTML_CSP = "default-src 'self'; " + "script-src 'self' https://challenges.cloudflare.com; " + "style-src 'self' 'unsafe-inline'; " + "img-src 'self' data: blob:; " + "media-src 'self' data: blob:; " + "connect-src 'self' https://challenges.cloudflare.com; " + 'frame-src https://challenges.cloudflare.com; ' + "font-src 'self' data:; " + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) {
      if (!path.extname(urlPath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_CSP, ...SEC_HEADERS });
          res.end(idx);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS };
    if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

function apiKeyFor(req, cfg, session) {
  if (session?.kind === 'admin') {
    const hdr = req.headers['x-api-key'];
    if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  }
  return cfg.apiKey;
}

async function handlePaper(req, res, cfg, session, user) {
  const raw = await readBody(req);
  const q = DB.checkQuota(user);
  if (!q.ok) return sendJson(res, 402, { ok: false, error: q.reason, quota: q });
  let opts = {};
  try { opts = raw ? JSON.parse(raw) : {}; } catch { opts = {}; }
  const apiKey = apiKeyFor(req, cfg, session);
  const seed = randomUUID().slice(0, 8);
  if (opts.offline) {
    return sendJson(res, 200, { ok: true, paper: { ...FALLBACK_PAPER, offline: true } });
  }
  const topic = str(opts.topic, '') || pickTopic(seed);
  const difficulty = str(opts.difficulty, '标准');
  const generate = async (label, prompt, validate, maxTokens) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        const { content, usage } = await callChat({
          apiKey, apiBase: cfg.apiBase, model: cfg.model,
          system: PAPER_SYSTEM_PROMPT,
          user: attempt === 1 ? prompt : `${prompt}\n\n〖重要〗上一次的返回不是合法 JSON。这次务必**只输出一个合法 JSON 对象**，不要任何解释文字、不要 Markdown 代码块。`,
          temperature: 0.85,
          maxTokens,
          json: true,
        });
        const checked = validate(extractJson(content));
        if (!checked.ok) {
          console.warn(`[paper:${label}] attempt ${attempt} 结构不符：${checked.errors.join('；')}`);
          if (attempt === 2) return { error: `结构不符合官方要求：${checked.errors.join('；')}` };
          continue;
        }
        console.log(`[paper:${label}] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s tokens=${usage?.total_tokens ?? '?'}`);
        return { data: checked.data };
      } catch (e) {
        console.warn(`[paper:${label}] attempt ${attempt} 失败：${e.message}`);
        if (attempt === 2) return { error: e.message };
      }
    }
    return { error: '未知错误' };
  };
  const [resA, resB] = await Promise.all([
    generate('A', buildPaperPromptPartA({ topic, difficulty, seed }), validatePartA, 4500),
    generate('B', buildPaperPromptPartB({ topic, difficulty, seed }), validatePartB, 5000),
  ]);
  const notes = [];
  if (resA.error) notes.push(`模仿朗读 / 听选信息使用了内置备用材料（${resA.error}）`);
  if (resB.error) notes.push(`回答问题 / 信息转述 / 询问信息使用了内置备用材料（${resB.error}）`);
  const paper = mergeWithFallback({ partA: resA.data || null, partB: resB.data || null, topic, notes });
  console.log(`[paper] topic=${paper.topic} source=${paper.source}`);
  return sendJson(res, 200, { ok: true, paper, warning: notes.length ? notes.join('；') : undefined });
}

const wordList = (s) => String(s || '').toLowerCase().match(/[a-z']+/g) || [];

const HOMOPHONE_GROUPS = [
  ['there', 'their', "they're"], ['to', 'too', 'two'], ['your', "you're", 'yore'], ['its', "it's"], ['here', 'hear'], ['where', 'wear', 'were'], ['see', 'sea'], ['write', 'right', 'rite'], ['know', 'no'], ['buy', 'by', 'bye'], ['read', 'red'], ['meet', 'meat'], ['week', 'weak'], ['son', 'sun'], ['for', 'four', 'fore'], ['one', 'won'], ['are', 'our', 'hour'], ['then', 'than'], ['live', 'leave'], ['walk', 'work'], ['think', 'sink', 'thing'], ['well', 'will', 'wheel'], ['want', 'wont'], ['play', 'pray'], ['look', 'luck'], ['much', 'match'],
];

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function sameWord(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const stem = (w) => w.replace(/(ing|ed|es|s|ly|er|est)$/, '');
  if (stem(a) === stem(b) && Math.min(a.length, b.length) >= 3) return true;
  for (const g of HOMOPHONE_GROUPS) if (g.includes(a) && g.includes(b)) return true;
  const d = editDistance(a, b);
  const toll = Math.min(a.length, b.length) <= 4 ? 1 : 2;
  return d <= toll;
}

function wordCoverage(reference, heard) {
  const ref = [...new Set(wordList(reference))].filter((w) => w.length > 1);
  if (!ref.length) return 0;
  const h = wordList(heard);
  let hit = 0;
  for (const w of ref) {
    if (h.some((x) => sameWord(w, x))) hit++;
  }
  return hit / ref.length;
}

function seqAccuracy(reference, heard) {
  const a = wordList(reference);
  const b = wordList(heard);
  if (!a.length) return 0;
  if (!b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = sameWord(a[i - 1], b[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return clamp(dp[b.length] / a.length, 0, 1);
}

function acousticQuality(metrics) {
  if (!metrics) return 0.4;
  const voiced = clamp(metrics.voicedRatio, 0, 1);
  let s = 0.25 + voiced * 0.6;
  const wpm = num(metrics.wordsPerMinute, 0);
  if (wpm > 0) {
    if (wpm >= 100 && wpm <= 160) s += 0.16;
    else if (wpm >= 75 && wpm <= 190) s += 0.08;
    else s -= 0.06;
  } else {
    s -= 0.1;
  }
  const pauses = num(metrics.pauseCount, 0);
  const secs = Math.max(1, num(metrics.durationMs, 0) / 1000);
  if (pauses / secs > 0.35) s -= 0.12;
  return clamp(s, 0, 1);
}

function bandOf(score, max, bands) {
  for (const [min, label] of bands) if (score >= min) return label;
  return bands[bands.length - 1][1];
}

function localReadAloud(paper, answers) {
  const passage = paper?.readAloud?.passage || '';
  const transcript = answers?.readAloud?.transcript || '';
  const metrics = answers?.readAloud?.metrics || null;
  const words = wordList(passage).length;
  const speechMs = num(metrics?.speechMs, 0);
  const voicedRatio = num(metrics?.voicedRatio, 0);
  const pauseCount = num(metrics?.pauseCount, 0);
  const expectMs = words ? Math.round((words / 130) * 60000) : 0;
  const durRatio = expectMs ? speechMs / expectMs : 0;
  const spokeWithoutAsr = !transcript && voicedRatio >= 0.3 && durRatio >= 0.5;
  const acc = transcript ? seqAccuracy(passage, transcript) : 0;
  const aq = transcript ? acousticQuality(metrics) : 0;
  let ratio;
  if (transcript) {
    ratio = clamp(acc * 0.65 + aq * 0.35, 0, 1);
  } else if (spokeWithoutAsr) {
    const durScore = clamp(durRatio, 0, 1);
    const fluency = clamp(voicedRatio / 0.75, 0, 1);
    const pausePenalty = clamp(1 - pauseCount / Math.max(6, Math.round(words / 12)), 0, 1);
    ratio = clamp(0.5 * durScore + 0.3 * fluency + 0.2 * pausePenalty, 0, 1) * 0.8;
  } else {
    ratio = 0;
  }
  const score = round1(clamp(ratio * SCORE_TABLE.readAloud, 0, SCORE_TABLE.readAloud));
  const band = bandOf(score, 6, [[5.5, 'A'], [4.5, 'B'], [3, 'C'], [1, 'D'], [0.1, 'E'], [0, 'F']]);
  const heardSet = new Set(wordList(transcript));
  const missed = [...new Set(wordList(passage))].filter((w) => w.length > 2 && !heardSet.has(w)).slice(0, 20);
  const pausesPerSec = num(metrics?.pauseCount, 0) / Math.max(1, num(metrics?.durationMs, 0) / 1000);
  const intonation = clamp((1 - Math.min(1, pausesPerSec / 0.5)) * 1.5, 0, 1.5);
  return {
    score,
    band,
    overall: transcript
      ? `逐词比对正确率约 ${Math.round(acc * 100)}%，发声占比 ${Math.round((metrics?.voicedRatio || 0) * 100)}%。${missed.length ? `有 ${missed.length} 个实词疑似漏读。` : '全文覆盖完整。'}`
      : spokeWithoutAsr
        ? `本次未能获取语音转写，按音频特征评分：发声 ${Math.round(speechMs / 1000)} 秒、发声占比 ${Math.round(voicedRatio * 100)}%、停顿 ${pauseCount} 次。`
        : '本次未检测到有效朗读，请确认麦克风正常并靠近麦克风清晰朗读。',
    dimensions: {
      pronunciation: { score: round1(clamp(transcript ? acc * 3 : ratio * 3, 0, 3)), max: 3, comment: transcript ? '依据逐词比对计算的音素命中率' : '未获得转写，按发声连贯度估算' },
      intonation: { score: round1(intonation), max: 1.5, comment: '依据停顿密度估计的节奏表现' },
      fluency: { score: round1(clamp((transcript ? aq : clamp(voicedRatio / 0.75, 0, 1)) * 1.5, 0, 1.5)), max: 1.5, comment: '依据语速与停顿次数估计' },
    },
    wordAnalysis: { accuracy: round1(acc * 100) / 100, mispronounced: [], missed },
    suggestions: [
      transcript || spokeWithoutAsr ? '' : '没有检测到朗读声音，请先做一次麦克风试音，确认设备正常。',
      missed.length ? `重点补练这些词：${missed.slice(0, 8).join(', ')}` : '',
      metrics && (metrics.pauseCount || 0) > 3 ? '停顿偏多，建议先默读两遍再开口，减少中途卡壳。' : '',
    ].filter(Boolean),
  };
}

function localInfo(paper, answers) {
  const segs = paper?.chooseInfo || [];
  const ciAns = answers?.chooseInfo || [];
  const chooseInfo = [];
  segs.forEach((seg, si) => {
    (seg.questions || []).forEach((q, qi) => {
      const n = si * 2 + qi + 1;
      const heard = ciAns?.[si]?.[qi]?.transcript || '';
      const correct = q.options?.[q.answerIndex] || '';
      const cov = heard ? wordCoverage(correct, heard) : 0;
      const verdict = !heard ? 'blank' : cov >= 0.6 ? 'correct' : cov >= 0.25 ? 'partial' : 'wrong';
      const per = SCORE_TABLE.chooseInfo / 6;
      chooseInfo.push({ index: n, verdict, score: round1(verdict === 'correct' ? per : verdict === 'partial' ? per / 2 : 0), heard, expected: correct, comment: verdict === 'correct' ? '信息正确。' : verdict === 'partial' ? '回答了部分信息，按比例给分。' : heard ? '回答信息与正确答案不符，得零分。' : '未作答。' });
    });
  });
  const aqQs = paper?.answerQuestions?.questions || [];
  const aqAns = answers?.answerQuestions || [];
  const answerQuestions = aqQs.map((q, i) => {
    const heard = aqAns?.[i]?.transcript || '';
    const expected = q.answer || '';
    const keyText = [expected, ...(q.keyPoints || [])].join(' ');
    const cov = heard && keyText ? wordCoverage(keyText, heard) : 0;
    const per = SCORE_TABLE.answerQuestions / 4;
    const verdict = !heard ? 'blank' : cov >= 0.5 ? 'correct' : cov >= 0.2 ? 'partial' : 'wrong';
    return { index: 7 + i, verdict, score: round1(verdict === 'correct' ? per : verdict === 'partial' ? per / 2 : 0), heard, expected, comment: verdict === 'blank' ? '未作答。' : verdict === 'correct' ? '要点回答完整。' : verdict === 'partial' ? '只答到部分要点。' : '回答与录音材料不符。' };
  });
  const ciSum = chooseInfo.reduce((s, x) => s + x.score, 0);
  const aqSum = answerQuestions.reduce((s, x) => s + x.score, 0);
  const answered = [...chooseInfo, ...answerQuestions].filter((x) => x.verdict !== 'blank').length;
  return { chooseInfo, answerQuestions, ciSum, aqSum, answered };
}