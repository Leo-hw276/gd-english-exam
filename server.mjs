 

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

import {
  EXAM,
  SCORE_TABLE,
  PAPER_SYSTEM_PROMPT,
  buildPaperPromptPartA,
  buildPaperPromptPartB,
  pickTopic,
  SCORE_SYSTEM_PROMPT,
  buildReadAloudScorePrompt,
  buildInfoScorePrompt,
  buildRetellAskScorePrompt,
  FALLBACK_PAPER,
} from './data/exam-spec.mjs';

import {
  clientIp,
  clientIpInfo,
  ipPrefix,
  parseUa,
  rateLimit,
  isBanned,
  banKey,
  createCaptcha,
  verifyCaptcha,
  riskScore,
  makeActivityStore,
  ipToLocation,
  isPrivateIp,
  isTrustedProxy,
  setExtraTrustedProxies,
  countScriptHit,
  resetScriptHits,
} from './data/security.mjs';

import { synthesize as edgeTts, rateStr as ttsRateStr, setCacheDir as setTtsCacheDir, VOICES as TTS_VOICES } from './data/edge-tts.mjs';

import * as Brevo from './data/brevo.mjs';

import { CITY_PROFILES, DEFAULT_CITY, cityProfile } from './data/exam-spec.mjs';
import * as DB from './data/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

 
const Activity = makeActivityStore((events) => {
  try {
    const db0 = DB.data();
    db0.activity = events;
    DB.save();
  } catch {}
});

try { Activity.load(DB.data().activity); } catch {}

 
const geoPromises = new Map(); 
function logVisit(req, kind, fields = {}) {
  const info = clientIpInfo(req);
  const ip = info.ip;
  const ua = req.headers['user-agent'] || '';
  const { browser, os, inApp, bot } = parseUa(ua);
  const rec = Activity.push({
    kind,
    ip,
    ipSource: info.source,
    peerIp: info.peer,
    browser,
    os,
    inApp,
    bot,
    ua: ua.slice(0, 220),
    ...fields,
  });
  
  if (ip && ip !== 'unknown') {
    const doGeo = async () => {
      try {
        const geo = await ipToLocation(ip);
        if (geo.str) rec.geo = geo.str;
      } catch {}
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
      watchdog = setTimeout(() => {
        stalled = true;
        ctl.abort();
      }, STALL);
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
      const msg = stalled
        ? `模型服务 ${STALL / 1000} 秒无响应（已主动断开）`
        : `连接模型服务失败：${e.message}`;
      return { error: msg, status: 504, retryable: true };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      cleanup();
      return {
        error: text || `HTTP ${res.status}`,
        status: res.status,
        retryable: RETRYABLE.has(res.status),
      };
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
              return {
                error: JSON.stringify(j.error),
                status: j.error.code === 'streaming_error' ? 502 : 502,
                retryable: true,
              };
            }
          } catch {
             
          }
        }
      }
    } catch (e) {
      cleanup();
      const msg = stalled
        ? `模型服务输出中断（${STALL / 1000} 秒无新内容，已主动断开）`
        : `读取模型流式响应中断：${e.message}`;
      return { error: msg, status: 504, retryable: true };
    }
    cleanup();

    if (!content.trim()) {
      
      return { error: stalled ? '模型服务无响应' : '模型返回内容为空', status: 502, retryable: stalled };
    }
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

  if (out.error) {
    throw new LlmError(`模型服务返回：${String(out.error).slice(0, 400)}`, out.status || 502);
  }
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
  try {
    return JSON.parse(str);
  } catch {
    try {
      return JSON.parse(str.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
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
      script: arr(s?.script)
        .map((l) => ({ spk: str(l?.spk, 'M').slice(0, 3), en: str(l?.en) }))
        .filter((l) => l.en),
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
    .map((a) => ({
      cn: str(a?.cn),
      reference: str(a?.reference),
      mustInclude: arr(a?.mustInclude).map((m) => str(m)).filter(Boolean),
    }))
    .filter((a) => a.cn);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      answerQuestions: { script: aqScript, questions: aqQs },
      retell: {
        script: retellScript,
        outline,
        starter: str(p?.retell?.starter, ''),
        referenceRetell: str(p?.retell?.referenceRetell, ''),
      },
      askQuestions: asks.slice(0, 2),
    },
  };
}

 
function mergeWithFallback({ partA, partB, topic, notes }) {
  const a = partA || { readAloud: FALLBACK_PAPER.readAloud, chooseInfo: FALLBACK_PAPER.chooseInfo };
  const b =
    partB ||
    {
      answerQuestions: FALLBACK_PAPER.answerQuestions,
      retell: FALLBACK_PAPER.retell,
      askQuestions: FALLBACK_PAPER.askQuestions,
    };
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
  const mk = (d, max) => ({
    score: round1(clamp(d?.score, 0, max)),
    max,
    comment: str(d?.comment, ''),
  });
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
      mispronounced: arr(raw?.wordAnalysis?.mispronounced)
        .map((w) => ({ word: str(w?.word), heardAs: str(w?.heardAs), tip: str(w?.tip) }))
        .filter((w) => w.word)
        .slice(0, 15),
      accuracy: num(raw?.wordAnalysis?.accuracy, 0),
    },
    overall: str(raw?.overall, ''),
    suggestions: arr(raw?.suggestions).map((s) => str(s)).filter(Boolean).slice(0, 6),
  };
  const sum = round1(
    out.dimensions.pronunciation.score + out.dimensions.intonation.score + out.dimensions.fluency.score
  );
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
    const verdict = ['correct', 'partial', 'wrong', 'blank'].includes(it?.verdict)
      ? it.verdict
      : 'wrong';
    let score = clamp(it?.score, 0, perItem);
    if (verdict === 'correct' && score < perItem * 0.66) score = perItem; 
    if (verdict === 'blank') score = 0;
    if (verdict === 'wrong') score = 0;
    out.push({
      index: idx,
      verdict,
      score: round1(clamp(score, 0, perItem)),
      heard: str(it?.heard, ''),
      expected: str(it?.expected, ''),
      missingPoints: arr(it?.missingPoints).map((s) => str(s)).filter(Boolean),
      comment: str(it?.comment, ''),
    });
  }
  return out;
}

function normalizeRetell(raw) {
  const score = round1(clamp(raw?.score, 0, 6));
  const mk = (d, max) => ({
    score: round1(clamp(d?.score, 0, max)),
    max,
    comment: str(d?.comment, ''),
  });
  return {
    score,
    band: str(raw?.band, '-'),
    content: {
      ...mk(raw?.content, 3.0),
      coveredPoints: arr(raw?.content?.coveredPoints).map((s) => str(s)).filter(Boolean),
      missingPoints: arr(raw?.content?.missingPoints).map((s) => str(s)).filter(Boolean),
    },
    accuracy: mk(raw?.accuracy, 1.5),
    fluency: mk(raw?.fluency, 1.5),
    grammarErrors: arr(raw?.grammarErrors)
      .map((g) => ({ error: str(g?.error), correction: str(g?.correction), explain: str(g?.explain) }))
      .filter((g) => g.error || g.correction)
      .slice(0, 10),
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
    out.push({
      index: idx,
      contentScore,
      languageScore,
      score: round1(clamp(score, 0, 1.5)),
      heard: str(it?.heard, ''),
      reference: str(it?.reference, ''),
      comment: str(it?.comment, ''),
    });
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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Server': 'gd-english',
  });
  res.end(body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
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
      if (size > limit) {
        reject(new Error('音频过大（上限 8MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

 
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

 
function buildCsp() {
  const formOrigins = new Set(["'self'"]);
  try {
    const base = epayConf().base;
    if (base) formOrigins.add(new URL(base).origin);
  } catch {}
  return (
    "default-src 'self'; " +
    "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' data: blob:; " +
    "connect-src 'self' data: https://challenges.cloudflare.com https://cloudflareinsights.com; " +
    'frame-src https://challenges.cloudflare.com; ' +
    "font-src 'self' data:; " +
    `object-src 'none'; base-uri 'self'; form-action ${[...formOrigins].join(' ')}; frame-ancestors 'none'`
  );
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      
      if (!path.extname(urlPath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': buildCsp(),
            ...SEC_HEADERS,
          });
          res.end(idx);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SEC_HEADERS,
    };
    if (ext === '.html') headers['Content-Security-Policy'] = buildCsp();
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
  try {
    opts = raw ? JSON.parse(raw) : {};
  } catch {
    opts = {};
  }

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
          apiKey,
          apiBase: cfg.apiBase,
          model: cfg.model,
          system: PAPER_SYSTEM_PROMPT,
          user:
            attempt === 1
              ? prompt
              : `${prompt}\n\n【重要】上一次的返回不是合法 JSON。这次务必**只输出一个合法 JSON 对象**，不要任何解释文字、不要 Markdown 代码块。`,
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

  const paper = mergeWithFallback({
    partA: resA.data || null,
    partB: resB.data || null,
    topic,
    notes,
  });

  console.log(`[paper] topic=${paper.topic} source=${paper.source}`);
  return sendJson(res, 200, {
    ok: true,
    paper,
    warning: notes.length ? notes.join('；') : undefined,
  });
}

 

const wordList = (s) => String(s || '').toLowerCase().match(/[a-z']+/g) || [];

 
const HOMOPHONE_GROUPS = [
  ['there', 'their', "they're"],
  ['to', 'too', 'two'],
  ['your', "you're", 'yore'],
  ['its', "it's"],
  ['here', 'hear'],
  ['where', 'wear', 'were'],
  ['see', 'sea'],
  ['write', 'right', 'rite'],
  ['know', 'no'],
  ['buy', 'by', 'bye'],
  ['read', 'red'],
  ['meet', 'meat'],
  ['week', 'weak'],
  ['son', 'sun'],
  ['for', 'four', 'fore'],
  ['one', 'won'],
  ['are', 'our', 'hour'],
  ['then', 'than'],
  ['live', 'leave'],
  ['walk', 'work'],
  ['think', 'sink', 'thing'],
  ['well', 'will', 'wheel'],
  ['want', 'wont'],
  ['play', 'pray'],
  ['look', 'luck'],
  ['much', 'match'],
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
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
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

  const band = bandOf(score, 6, [
    [5.5, 'A'],
    [4.5, 'B'],
    [3, 'C'],
    [1, 'D'],
    [0.1, 'E'],
    [0, 'F'],
  ]);

  
  const heardSet = new Set(wordList(transcript));
  const missed = [...new Set(wordList(passage))].filter((w) => w.length > 2 && !heardSet.has(w)).slice(0, 20);

  const pausesPerSec = num(metrics?.pauseCount, 0) / Math.max(1, num(metrics?.durationMs, 0) / 1000);
  const intonation = clamp((1 - Math.min(1, pausesPerSec / 0.5)) * 1.5, 0, 1.5);

  return {
    score,
    band,
    overall: transcript
      ? `逐词比对正确率约 ${Math.round(acc * 100)}%，发声占比 ${Math.round((metrics?.voicedRatio || 0) * 100)}%。${
          missed.length ? `有 ${missed.length} 个实词疑似漏读。` : '全文覆盖完整。'
        }`
      : spokeWithoutAsr
      ? `本次未能获取语音转写，按音频特征评分：发声 ${Math.round(speechMs / 1000)} 秒、发声占比 ${Math.round(
          voicedRatio * 100
        )}%、停顿 ${pauseCount} 次。`
      : '本次未检测到有效朗读，请确认麦克风正常并靠近麦克风清晰朗读。',
    dimensions: {
      pronunciation: {
        score: round1(clamp(transcript ? acc * 3 : ratio * 3, 0, 3)),
        max: 3,
        comment: transcript ? '依据逐词比对计算的音素命中率' : '未获得转写，按发声连贯度估算',
      },
      intonation: { score: round1(intonation), max: 1.5, comment: '依据停顿密度估计的节奏表现' },
      fluency: {
        score: round1(clamp((transcript ? aq : clamp(voicedRatio / 0.75, 0, 1)) * 1.5, 0, 1.5)),
        max: 1.5,
        comment: '依据语速与停顿次数估计',
      },
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
      chooseInfo.push({
        index: n,
        verdict,
        score: round1(verdict === 'correct' ? per : verdict === 'partial' ? per / 2 : 0),
        heard,
        expected: correct,
        comment:
          verdict === 'correct'
            ? '信息正确。'
            : verdict === 'partial'
            ? '回答了部分信息，按比例给分。'
            : heard
            ? '回答信息与正确答案不符，得零分。'
            : '未作答。',
      });
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
    return {
      index: 7 + i,
      verdict,
      score: round1(verdict === 'correct' ? per : verdict === 'partial' ? per / 2 : 0),
      heard,
      expected,
      comment:
        verdict === 'blank'
          ? '未作答。'
          : verdict === 'correct'
          ? '要点回答完整。'
          : verdict === 'partial'
          ? '只答到部分要点。'
          : '回答与录音材料不符。',
    };
  });

  const ciSum = chooseInfo.reduce((s, x) => s + x.score, 0);
  const aqSum = answerQuestions.reduce((s, x) => s + x.score, 0);
  const answered = [...chooseInfo, ...answerQuestions].filter((x) => x.heard).length;

  return {
    chooseInfo,
    answerQuestions,
    overall: `共 10 小题，识别到作答 ${answered} 题，本轮按客观要点匹配得分 ${round1(ciSum + aqSum)} 分。`,
    suggestions: answered < 10 ? ['有题目没有识别到作答，注意每题 8 秒内必须开口，且靠近麦克风。'] : [],
  };
}

function localRetellAsk(paper, answers) {
  const outline = paper?.retell?.outline || [];
  const script = paper?.retell?.script || '';
  const heard = answers?.retell?.transcript || '';
  const metrics = answers?.retell?.metrics || null;

  const covered = outline.filter((o) => wordCoverage(o, heard) >= 0.35 || wordCoverage(script, heard) >= 0.3);
  
  const scriptCov = heard ? wordCoverage(script, heard) : 0;
  const corpus = covered.length ? covered.map((_, i) => outline[i]).join(' ') : script;
  const cov = heard ? Math.max(scriptCov, wordCoverage(corpus, heard)) : 0;
  const aq = heard ? acousticQuality(metrics) : 0;

  const contentScore = round1(clamp(cov * 3, 0, 3));
  const accScore = round1(clamp((0.4 + cov * 0.6) * 1.5, 0, 1.5));
  const fluScore = round1(clamp(aq * 1.5, 0, 1.5));
  const score = round1(clamp(contentScore + accScore + fluScore, 0, SCORE_TABLE.retell));

  const band = bandOf(score, 6, [
    [5.5, 'A'],
    [5, 'B'],
    [4, 'C'],
    [2.5, 'D'],
    [1, 'E'],
    [0.5, 'F'],
    [0, 'G'],
  ]);

  const asks = (paper?.askQuestions || []).map((a, i) => {
    const said = answers?.askQuestions?.[i]?.transcript || '';
    const ref = a.reference || '';
    const must = (a.mustInclude || []).join(' ');
    const covC = said && must ? wordCoverage(must, said) : 0;
    const covR = said && ref ? wordCoverage(ref, said) : 0;
    const isQ = /\?$/.test(said.trim()) || /^(what|where|when|who|why|how|which|whose|do|does|did|is|are|can|could|will|would|should|may)\b/i.test(said.trim());
    const contentScore2 = round1(clamp((covC || covR) * 0.75, 0, 0.75));
    const langScore = round1(clamp((isQ ? 0.45 : 0.2) + (covR > 0.4 ? 0.3 : 0), 0, 0.75));
    return {
      index: 12 + i,
      score: round1(clamp(contentScore2 + langScore, 0, 1.5)),
      heard: said,
      reference: ref,
      contentScore: contentScore2,
      languageScore: langScore,
      comment: !said
        ? '未作答。'
        : !isQ
        ? '说的不是一个完整疑问句，注意疑问词与语序。'
        : '内容基本对应，注意时态与介词搭配。',
    };
  });

  return {
    retell: {
      score,
      band,
      overall: heard
        ? `要点覆盖约 ${Math.round(cov * 100)}%，覆盖 ${covered.length}/${outline.length} 个要点。`
        : '本次未识别到转述内容。',
      content: {
        score: contentScore,
        max: 3,
        coveredPoints: covered,
        missingPoints: outline.filter((o) => !covered.includes(o)),
        comment: '按要点关键词覆盖比例计算',
      },
      accuracy: { score: accScore, max: 1.5, comment: '按表达与原文的吻合度估计' },
      fluency: { score: fluScore, max: 1.5, comment: '按语速与停顿估计' },
      grammarErrors: [],
      suggestions: covered.length < outline.length ? ['转述时容易漏要点，建议按思维导图顺序逐点说。'] : [],
    },
    askQuestions: asks,
    overall: '本节由本地规则评分。',
    suggestions: asks.some((a) => !a.heard) ? ['询问信息不要空着，哪怕只说一个疑问句也可能得分。'] : [],
  };
}

async function handleScore(req, res, cfg, session, user) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
  }

  const paper = payload?.paper;
  const answers = payload?.answers;
  if (!paper || !answers) {
    return sendJson(res, 400, { ok: false, error: '缺少 paper 或 answers' });
  }

  
  const preCheck = DB.checkQuota(user);
  if (!preCheck.ok) return sendJson(res, 402, { ok: false, error: preCheck.reason, quota: preCheck });

  const apiKey = apiKeyFor(req, cfg, session);
  
  const common = { apiKey, apiBase: cfg.apiBase, model: cfg.model, stallMs: 90_000 };

  const tasks = [
    {
      key: 'readAloud',
      label: '模仿朗读',
      run: () =>
        callChat({
          ...common,
          system: SCORE_SYSTEM_PROMPT,
          user: buildReadAloudScorePrompt({
            passage: paper.readAloud.passage,
            transcript: answers.readAloud?.transcript,
            metrics: answers.readAloud?.metrics,
          }),
          temperature: 0.2,
          maxTokens: 4096,
          json: true,
        }).then((r) => extractJson(r.content)),
    },
    {
      key: 'info',
      label: '信息获取',
      run: () =>
        callChat({
          ...common,
          system: SCORE_SYSTEM_PROMPT,
          user: buildInfoScorePrompt({ paper, answers }),
          temperature: 0.2,
          maxTokens: 6000,
          json: true,
        }).then((r) => extractJson(r.content)),
    },
    {
      key: 'retellAsk',
      label: '信息转述及询问',
      run: () =>
        callChat({
          ...common,
          system: SCORE_SYSTEM_PROMPT,
          user: buildRetellAskScorePrompt({ paper, answers }),
          temperature: 0.2,
          maxTokens: 6000,
          json: true,
        }).then((r) => extractJson(r.content)),
    },
  ];

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));

  const result = {};
  const errors = [];
  settled.forEach((s, i) => {
    const t = tasks[i];
    if (s.status === 'fulfilled') {
      result[t.key] = s.value;
    } else {
      errors.push(`${t.label}评分失败：${s.reason?.message || s.reason}`);
      result[t.key] = null;
    }
  });

  if (!result.readAloud && !result.info && !result.retellAsk) {
    console.warn('[score] 三路 AI 评分全部失败，全部降级为本地规则评分：', errors.join('；'));
  }

  
  const localWarnings = [];
  if (!result.readAloud) {
    result.readAloud = localReadAloud(paper, answers);
    localWarnings.push('「模仿朗读」本次由本地规则评分（逐词比对 + 声学指标），AI 评委暂不可用');
  }
  if (!result.info) {
    result.info = localInfo(paper, answers);
    localWarnings.push('「信息获取」本次由本地规则评分（答案要点匹配），AI 评委暂不可用');
  }
  if (!result.retellAsk) {
    result.retellAsk = localRetellAsk(paper, answers);
    localWarnings.push('「信息转述及询问」本次由本地规则评分（要点覆盖匹配），AI 评委暂不可用');
  }

   
  const readAloud = normalizeReadAloud(result.readAloud || {});
  const chooseInfo = normalizeItemList(result.info?.chooseInfo, {
    startIndex: 1,
    count: 6,
    perItem: SCORE_TABLE.chooseInfo / 6,
  });
  const answerQuestions = normalizeItemList(result.info?.answerQuestions, {
    startIndex: 7,
    count: 4,
    perItem: SCORE_TABLE.answerQuestions / 4,
  });
  const retell = normalizeRetell(result.retellAsk?.retell || {});
  const askQuestions = normalizeAsk(result.retellAsk?.askQuestions);

  const sum = (a, f) => round1(a.reduce((s, x) => s + f(x), 0));

  const breakdown = {
    readAloud: readAloud.score,
    chooseInfo: sum(chooseInfo, (x) => x.score),
    answerQuestions: sum(answerQuestions, (x) => x.score),
    retell: retell.score,
    askQuestions: sum(askQuestions, (x) => x.score),
  };

  const total = round1(
    clamp(
      breakdown.readAloud +
        breakdown.chooseInfo +
        breakdown.answerQuestions +
        breakdown.retell +
        breakdown.askQuestions,
      0,
      30
    )
  );

  const report = {
    ok: true,
    total,
    maxTotal: EXAM.totalScore,
    grade: gradeLabel(total),
    breakdown,
    maxBreakdown: { ...SCORE_TABLE },
    detail: { readAloud, chooseInfo, answerQuestions, retell, askQuestions },
    partComments: {
      readAloud: readAloud.overall,
      info: str(result.info?.overall, ''),
      retellAsk: str(result.retellAsk?.overall, ''),
    },
    suggestions: [
      ...arr(result.readAloud?.suggestions),
      ...arr(result.info?.suggestions),
      ...arr(result.retellAsk?.suggestions),
    ]
      .map((s) => str(s))
      .filter(Boolean)
      .slice(0, 8),
    warnings: [...errors, ...localWarnings],
    scoringMode: localWarnings.length === 0 ? 'ai' : localWarnings.length === 3 ? 'local' : 'hybrid',
    scoredAt: new Date().toISOString(),
    model: cfg.model,
  };

  console.log(
    `[score] total=${total}/30 mode=${report.scoringMode}  ` +
      Object.entries(breakdown)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
  );

  
  const quota = DB.consumeQuota(user);
  report.quotaAfter = {
    source: quota.source,
    credits: user.credits || 0,
    freeLeft: Math.max(0, (DB.getSettings().pricing.freeTrials || 0) - (user.freeUsed || 0)),
    proActive: Boolean(user.proUntil && user.proUntil > Date.now()),
  };

  
  try {
    report.recordId = DB.addRecord({
      userId: user.id,
      topic: paper?.topic,
      total,
      maxTotal: EXAM.totalScore,
      grade: report.grade,
      report: {
        total,
        grade: report.grade,
        breakdown,
        maxBreakdown: { ...SCORE_TABLE },
        detail: report.detail,
        partComments: report.partComments,
        suggestions: report.suggestions,
        warnings: report.warnings,
        scoringMode: report.scoringMode,
        scoredAt: report.scoredAt,
      },
      paper,
    }).id;
  } catch (e) {
    console.warn('[score] 保存历史记录失败:', e.message);
  }

  return sendJson(res, 200, report);
}


async function handleHealth(req, res, cfg) {
  const s = DB.getSettings();
  sendJson(res, 200, {
    ok: true,
    model: cfg.model,
    apiBase: cfg.apiBase,
    hasKey: Boolean(cfg.apiKey),
    exam: {
      name: EXAM.name,
      total: EXAM.totalScore,
      items: EXAM.totalItems,
      region: s.examRegion || DEFAULT_CITY,
    },
    cities: CITY_PROFILES,
    defaultCity: s.examRegion || DEFAULT_CITY,
    pricing: s.pricing,
    siteName: s.siteName,
    authRequired: true,
    adminPasswordSet: DB.adminPasswordSet(),
    
    cardBuyUrl: String(s.cardBuyUrl || '').trim(),
    payEngine: epayConf().enabled ? 'epay' : 'off',
    payTypes: epayConf().enabled ? epayConf().types : [],
    
    emailVerify: emailVerifyOn(),
    emailCodeResendSec: Brevo.RESEND_SEC,
    
    turnstileSiteKey: String(s.turnstile?.siteKey || '').trim(),
    turnstileRequired: Boolean(String(s.turnstile?.siteKey || '').trim() && String(s.turnstile?.secretKey || '').trim()),
    
    ttsEngine: (() => {
      const sp = s.speechApi || {};
      const base = String(sp.apiBase || '').trim();
      const key = String(sp.apiKey || s.apiKey || '').trim();
      return base && key ? 'api' : 'edge';
    })(),
    asrEngine: (() => {
      const sp = s.speechApi || {};
      const base = String(sp.apiBase || '').trim();
      const key = String(sp.apiKey || s.apiKey || '').trim();
      return base && key ? 'api' : 'browser';
    })(),
    
    urgentNotice: s.urgentNotice?.enabled ? { id: s.urgentNotice.id, title: s.urgentNotice.title, body: s.urgentNotice.body } : null,
  });
}

 

const cookieVal = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
};

 
function sessionByToken(token, wantKind) {
  if (!token) return null;
  const s = DB.getSession(token);
  if (!s) return null;
  if (wantKind && s.kind !== wantKind) return null;
  return s;
}

 
function getSessionFrom(req, wantKind = '') {
  const hdr = req.headers.authorization || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const adminCookie = cookieVal(req, 'jmkt_admin');
  const userCookie = cookieVal(req, 'jmkt_session');

  const order =
    wantKind === 'admin'
      ? [bearer, adminCookie]
      : wantKind === 'user'
      ? [bearer, userCookie]
      : [bearer, userCookie, adminCookie];

  for (const t of order) {
    const s = sessionByToken(t, wantKind);
    if (!s) continue;
    const user = s.kind === 'admin' && s.userId === 'admin' ? null : DB.findUserById(s.userId);
    return { token: t, session: s, user };
  }
  return { token: '', session: null, user: null };
}

function setSessionCookie(res, token, kind = 'user', req = null) {
  const name = kind === 'admin' ? 'jmkt_admin' : 'jmkt_session';
  
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = proto === 'https' || Boolean(req?.socket?.encrypted) || process.env.NODE_ENV === 'production';
  const cookie =
    `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}` + (isHttps ? '; Secure' : '');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [...(Array.isArray(prev) ? prev : [prev]), cookie] : [cookie]);
}

function requireUser(req, res) {
  const { session, user } = getSessionFrom(req, 'user');
  if (!session || !user) {
    sendJson(res, 401, { ok: false, error: '请先登录' });
    return null;
  }
  if (user.disabled) {
    sendJson(res, 403, { ok: false, error: '账号已被停用，请联系管理员' });
    return null;
  }
  return { session, user };
}

function requireAdmin(req, res) {
  const { session } = getSessionFrom(req, 'admin');
  if (!session || session.kind !== 'admin') {
    sendJson(res, 401, { ok: false, error: '需要管理员身份' });
    return null;
  }
  return session;
}

function epayConf() {
  const s = DB.getSettings();
  const e = s.epay || {};
  const pid = String(e.pid || '').trim();
  const key = String(e.key || '').trim();
  let base = String(e.apiBase || '').trim().replace(/\/+$/, '');
  if (!base) base = 'https://pay.521cd.cn/xpay/epay';
  return { enabled: Boolean(e.enabled) && Boolean(pid) && Boolean(key), pid, key, base, types: Array.isArray(e.types) && e.types.length ? e.types : ['alipay', 'wxpay'] };
}

function epaySign(params, key) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== null && params[k] !== undefined)
    .sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(str + key, 'utf8').digest('hex');
}

function epayVerify(params, key) {
  const given = String(params.sign || '').toLowerCase();
  if (!given) return false;
  return epaySign(params, key) === given;
}

function siteOrigin(req) {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = fwd || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function handlePayCreate(req, res) {
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const conf = epayConf();
  if (!conf.enabled) return sendJson(res, 503, { ok: false, error: '在线支付暂未开通' });

  const b = await jsonBody(req);
  const plan = b.plan === 'monthly' ? 'monthly' : 'once';
  const type = conf.types.includes(String(b.type || '')) ? String(b.type) : conf.types[0];
  const pricing = DB.getSettings().pricing || {};
  const monthly = pricing.monthly || {};
  const perUse = pricing.perUse || {};

  const money = plan === 'monthly' ? Number(monthly.price || 19.9) : Number(perUse.price || 1);
  if (!(money > 0)) return sendJson(res, 400, { ok: false, error: '价格配置有误，请联系管理员' });
  const name = plan === 'monthly' ? `${monthly.name || '月卡'}（${monthly.days || 30} 天）` : `${perUse.name || '次卡'} 1 次`;

  const outTradeNo = `E${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
  DB.createPayOrder({ userId: ctx.user.id, outTradeNo, plan, money, name, type });

  const origin = siteOrigin(req);
  const params = {
    pid: conf.pid,
    type,
    out_trade_no: outTradeNo,
    notify_url: `${origin}/api/pay/notify`,
    return_url: `${origin}/api/pay/return`,
    name,
    money: money.toFixed(2),
    sitename: DB.getSettings().siteName || '在线练习系统',
    clientip: clientIp(req),
    device: /mobile|android|iphone/i.test(String(req.headers['user-agent'] || '')) ? 'mobile' : 'pc',
  };
  params.sign = epaySign(params, conf.key);
  params.sign_type = 'MD5';

  sendJson(res, 200, { ok: true, outTradeNo, action: `${conf.base}/submit.php`, params });
}

async function handlePayNotify(req, res) {
  const conf = epayConf();
  const url = new URL(req.url, 'http://localhost');
  const payload = { ...Object.fromEntries(url.searchParams) };
  if (req.method === 'POST') {
    const raw = await readRawBody(req);
    for (const [k, v] of new URLSearchParams(raw)) payload[k] = v;
  }
  if (!conf.enabled) return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('fail');
  if (!epayVerify(payload, conf.key)) {
    DB.log('pay-notify', 'system', `签名校验失败 ${payload.out_trade_no || ''}`);
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('fail');
  }
  if (String(payload.trade_status) !== 'TRADE_SUCCESS') {
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
  }
  const order = DB.getPayOrder(String(payload.out_trade_no || ''));
  if (!order) return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('fail');
  if (Number(order.money) !== Number(payload.money)) {
    DB.log('pay-notify', 'system', `金额不符 ${order.outTradeNo} 订单 ${order.money} 回调 ${payload.money}`);
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('fail');
  }
  const r = DB.completePayOrder(order.outTradeNo, String(payload.trade_no || ''));
  DB.log('pay-notify', 'system', `${order.outTradeNo} ${r.ok ? '已入账' : r.reason}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
}

function handlePayReturn(req, res) {
  const conf = epayConf();
  const url = new URL(req.url, 'http://localhost');
  const payload = Object.fromEntries(url.searchParams);
  const okSign = conf.enabled && epayVerify(payload, conf.key);
  const outTradeNo = String(payload.out_trade_no || '');
  const order = outTradeNo ? DB.getPayOrder(outTradeNo) : null;
  if (okSign && order && String(payload.trade_status) === 'TRADE_SUCCESS' && order.status !== 'paid') {
    DB.completePayOrder(order.outTradeNo, String(payload.trade_no || ''));
  }
  const origin = siteOrigin(req);
  const status = order && (DB.getPayOrder(outTradeNo) || {}).status === 'paid' ? 'ok' : 'pending';
  res.writeHead(302, { Location: `${origin}/?pay=${status}` });
  res.end();
}

async function handlePayStatus(req, res) {
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const url = new URL(req.url, 'http://localhost');
  const no = String(url.searchParams.get('no') || '');
  const order = DB.getPayOrder(no);
  if (!order || order.userId !== ctx.user.id) return sendJson(res, 404, { ok: false, error: '订单不存在' });
  sendJson(res, 200, { ok: true, status: order.status, plan: order.plan, money: order.money });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function readRawBody(req) {
  return readBody(req);
}

 

 
 
async function verifyTurnstile(token, ip) {
  const t = DB.getSettings().turnstile || {};
  
  
  if (!t.siteKey || !t.secretKey) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: '请完成人机验证' };
  try {
    const body = new URLSearchParams({ secret: t.secretKey, response: String(token), remoteip: ip || '' });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (j.success) return { ok: true };
    console.warn('[turnstile] 校验失败', j['error-codes']);
    return { ok: false, error: '人机验证未通过，请刷新后重试' };
  } catch (e) {
    console.warn('[turnstile] 校验异常', e.message);
    return { ok: false, error: '人机验证服务暂时不可用，请稍后重试' };
  }
}

function emailVerifyOn() {
  const b = DB.getSettings().brevo || {};
  return Boolean(b.enabled && b.apiKey && b.senderEmail);
}

 
async function handleEmailCode(req, res) {
  const ip = clientIp(req);
  const rl = RL.emailCode(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });

  let b = {};
  if (req.method === 'POST') {
    b = await jsonBody(req);
  } else {
    const url = new URL(req.url, 'http://localhost');
    b = Object.fromEntries(url.searchParams);
  }

  
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  
  const cd = Brevo.checkCooldown(ip);
  if (!cd.ok) return sendJson(res, 429, { ok: false, error: `发送太频繁，请 ${cd.waitSec} 秒后再获取`, waitSec: cd.waitSec });

  const email = String(b.email || '').trim().toLowerCase();
  const purpose = b.purpose === 'login' ? 'login' : 'register';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });

  
  const hourly = Brevo.checkEmailHourlyLimit(email);
  if (!hourly.ok) return sendJson(res, 429, { ok: false, error: hourly.error });

  
  const exists = Boolean(DB.findUserByEmail(email));
  if (purpose === 'register' && exists) return sendJson(res, 409, { ok: false, error: '该邮箱已注册，请直接登录' });
  if (purpose === 'login' && !exists) return sendJson(res, 404, { ok: false, error: '该邮箱尚未注册' });

  if (!emailVerifyOn()) return sendJson(res, 503, { ok: false, error: '邮箱验证码服务未开启，请联系管理员' });

  
  const code = Brevo.createCode(purpose, email);
  const cfgB = DB.getSettings().brevo;
  const subject = purpose === 'register' ? '注册验证码' : '登录验证码';
  const html = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:15px;color:#222">
    <p>您好，您的${subject}是：</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#3538cd">${code}</p>
    <p style="color:#666;font-size:13px">验证码 ${Brevo.CODE_TTL_SEC / 60} 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。</p>
  </div>`;
  try {
    await Brevo.sendMail(cfgB, { to: email, subject: `${subject} - ${cfgB.senderName || '在线练习系统'}`, html });
  } catch (e) {
    Brevo.clearCode(purpose, email);
    logVisit(req, 'email-code', { action: 'fail', email, ip, detail: e.message });
    return sendJson(res, 502, { ok: false, error: e.message });
  }

  Brevo.markSent(ip, email);
  logVisit(req, 'email-code', { action: 'ok', email, ip, detail: purpose });

  
  const newCap = createCaptcha(ip);
  sendJson(res, 200, {
    ok: true,
    message: `验证码已发送至 ${email}`,
    ttlSec: Brevo.CODE_TTL_SEC,
    resendSec: Brevo.RESEND_SEC,
    captcha: { id: newCap.id, svg: newCap.svg },
  });
}

async function handleRegister(req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  
  if (DB.getSettings()?.security?.registrationOff) {
    return sendJson(res, 503, { ok: false, error: '本站当前暂停新用户注册，请稍后再试' });
  }

  
  if (isBanned(ip)) return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
  const rl = RL.register(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: `注册过于频繁，请 ${rl.retryAfterSec} 秒后重试` });

  const b = await jsonBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  const phone = DB.normalizePhone(b.phone);
  const password = String(b.password || '');
  const name = String(b.name || '').trim();

  
  const tsReg = await verifyTurnstile(b.turnstileToken, ip);
  if (!tsReg.ok) return sendJson(res, 403, { ok: false, error: tsReg.error });

  
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  
  if (!email && !phone) return sendJson(res, 400, { ok: false, error: '请填写邮箱或手机号（填一个即可）' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });

  
  if (emailVerifyOn() && !email) return sendJson(res, 400, { ok: false, error: '注册需要验证邮箱，请填写邮箱' });

  if (String(b.phone || '').trim() && !phone) return sendJson(res, 400, { ok: false, error: '手机号格式不正确（11 位中国大陆手机号）' });
  if (password.length < 6) return sendJson(res, 400, { ok: false, error: '密码至少 6 位' });
  if (email && DB.findUserByEmail(email)) return sendJson(res, 409, { ok: false, error: '该邮箱已注册，请直接登录' });
  if (phone && DB.findUserByPhone(phone)) return sendJson(res, 409, { ok: false, error: '该手机号已注册，请直接登录' });

  
  const recent = Activity.query({ kind: 'register', ip, since: Date.now() - 30 * 60_000 });
  const risk = riskScore({ ip, ua, email: email || phone, recentSameIp: recent.length });
  if (risk.score >= 70) {
    banKey(ip, 10 * 60_000);
    Activity.push({ kind: 'blocked', action: 'register', ip, ua: parseUa(ua).raw, email: email || phone, detail: risk.reasons.join('；') });
    return sendJson(res, 403, { ok: false, error: '检测到异常注册行为，请稍后重试或联系管理员' });
  }

  
  if (emailVerifyOn()) {
    const ev = Brevo.verifyCode('register', email, b.emailCode);
    if (!ev.ok) return sendJson(res, 400, { ok: false, error: ev.error });
  }

  const user = DB.createUser({ email, phone, password, name });
  const token = DB.createSession(user.id, 'user');
  setSessionCookie(res, token, 'user', req);
  const p = DB.getSettings().pricing;

  logVisit(req, 'register', { action: 'ok', userId: user.id, email: email || phone, ip, riskScore: risk.score });

  sendJson(res, 200, {
    ok: true,
    token,
    user: DB.publicUser(user),
    message: `注册成功，已赠送 ${p.freeTrials} 次免费听说模拟`,
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  
  if (DB.getSettings()?.security?.loginOff) {
    return sendJson(res, 503, { ok: false, error: '本站当前暂停登录，请稍后再试' });
  }

  if (isBanned(ip)) return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
  const rl = RL.login(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: `登录过于频繁，请 ${rl.retryAfterSec} 秒后重试` });

  const b = await jsonBody(req);
  
  const account = String(b.account || b.email || b.phone || '').trim();
  const password = String(b.password || '');

  
  const tsLogin = await verifyTurnstile(b.turnstileToken, ip);
  if (!tsLogin.ok) return sendJson(res, 403, { ok: false, error: tsLogin.error });

  
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  const user = DB.findUserByAccount(account);
  if (!user || !DB.verifyPassword(password, user.passHash)) {
    logVisit(req, 'login', { action: 'fail', ip, email: account, detail: '密码错误' });
    
    const fails = Activity.query({ kind: 'login', action: 'fail', ip, since: Date.now() - 3 * 60_000 });
    if (fails.length >= 5) banKey(ip, 3 * 60_000);
    return sendJson(res, 401, { ok: false, error: '邮箱或密码错误' });
  }
  if (user.disabled) return sendJson(res, 403, { ok: false, error: '账号已被停用，请联系管理员' });

  
  if (account.includes('@') && emailVerifyOn()) {
    const ev = Brevo.verifyCode('login', account.toLowerCase(), b.emailCode);
    if (!ev.ok) return sendJson(res, 400, { ok: false, error: ev.error, needEmailCode: true });
  }
  user.lastLoginAt = Date.now();
  DB.save();

  const token = DB.createSession(user.id, 'user');
  setSessionCookie(res, token, 'user', req);

  logVisit(req, 'login', { action: 'ok', userId: user.id, email: account, ip });

  sendJson(res, 200, { ok: true, token, admin: false, user: DB.publicUser(user) });
}

async function handleLogout(req, res) {
  const adminToken = cookieVal(req, 'jmkt_admin');
  const userToken = cookieVal(req, 'jmkt_session');
  if (adminToken) DB.destroySession(adminToken);
  if (userToken) DB.destroySession(userToken);
  res.setHeader('Set-Cookie', [
    'jmkt_session=; Path=/; HttpOnly; Max-Age=0',
    'jmkt_admin=; Path=/; HttpOnly; Max-Age=0',
  ]);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const { session, user } = getSessionFrom(req);
  const adminToken = cookieVal(req, 'jmkt_admin');
  const adminSession = adminToken ? DB.getSession(adminToken) : null;
  const isAdmin = Boolean(adminSession && adminSession.kind === 'admin');

  if (!session && !isAdmin) return sendJson(res, 200, { ok: true, user: null, admin: false });
  if (!user) return sendJson(res, 200, { ok: true, user: null, admin: isAdmin, adminOnly: true });
  const q = DB.checkQuota(user);
  sendJson(res, 200, { ok: true, user: DB.publicUser(user), admin: isAdmin, quota: q });
}

async function handleMyOrders(req, res) {
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const uid = ctx.user.id;
  const paid = DB.listPayOrders(200)
    .filter((o) => o.userId === uid)
    .map((o) => ({
      at: o.paidAt || o.at,
      kind: 'pay',
      plan: o.plan,
      title: o.plan === 'monthly' ? '月卡（在线支付）' : '次卡（在线支付）',
      money: o.money,
      status: o.status,
      outTradeNo: o.outTradeNo,
    }));
  const redeemed = DB.listOrders(200)
    .filter((o) => o.userId === uid && o.code && o.channel !== 'epay')
    .map((o) => ({
      at: o.at,
      kind: 'code',
      plan: o.type === 'monthly' ? 'monthly' : 'credits',
      title: o.type === 'monthly' ? `月卡（兑换码 ${o.value} 天）` : `次卡（兑换码 ${o.value} 次）`,
      money: '',
      status: 'paid',
      code: o.code || '',
    }));
  const all = [...paid, ...redeemed].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50);
  sendJson(res, 200, { ok: true, orders: all });
}

async function handleTickets(req, res) {
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const t = DB.getTicket(id);
      if (!t || t.userId !== ctx.user.id) return sendJson(res, 404, { ok: false, error: '工单不存在' });
      return sendJson(res, 200, { ok: true, ticket: t });
    }
    return sendJson(res, 200, { ok: true, tickets: DB.listTickets({ userId: ctx.user.id, limit: 50 }) });
  }

  const b = await jsonBody(req);
  try {
    if (b.action === 'create') {
      const openCount = DB.listTickets({ userId: ctx.user.id, limit: 500 }).filter((t) => t.status === 'open').length;
      if (openCount >= 5) return sendJson(res, 429, { ok: false, error: '你还有 5 个未结束的工单，请等待处理后再提交' });
      const title = String(b.title || '').trim();
      const body = String(b.body || '').trim();
      if (title.length < 3) return sendJson(res, 400, { ok: false, error: '标题至少 3 个字' });
      if (body.length < 5) return sendJson(res, 400, { ok: false, error: '问题描述至少 5 个字' });
      const t = DB.createTicket({ userId: ctx.user.id, email: ctx.user.email || '', category: b.category, title, body });
      return sendJson(res, 200, { ok: true, ticket: t });
    }
    if (b.action === 'reply') {
      const t = DB.getTicket(String(b.id || ''));
      if (!t || t.userId !== ctx.user.id) return sendJson(res, 404, { ok: false, error: '工单不存在' });
      const text = String(b.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: '内容不能为空' });
      return sendJson(res, 200, { ok: true, ticket: DB.replyTicket(t.id, { by: 'user', text }) });
    }
    if (b.action === 'close' || b.action === 'reopen') {
      const t = DB.getTicket(String(b.id || ''));
      if (!t || t.userId !== ctx.user.id) return sendJson(res, 404, { ok: false, error: '工单不存在' });
      const out = b.action === 'close' ? DB.setTicketStatus(t.id, 'closed') : DB.reopenTicket(t.id);
      return sendJson(res, 200, { ok: true, ticket: out });
    }
    return sendJson(res, 400, { ok: false, error: '未知操作' });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleAdminTickets(req, res) {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const t = DB.getTicket(id);
      if (!t) return sendJson(res, 404, { ok: false, error: '工单不存在' });
      return sendJson(res, 200, { ok: true, ticket: t });
    }
    return sendJson(res, 200, { ok: true, tickets: DB.listTickets({ limit: 200 }) });
  }
  const b = await jsonBody(req);
  try {
    const t = DB.getTicket(String(b.id || ''));
    if (!t) return sendJson(res, 404, { ok: false, error: '工单不存在' });
    if (b.action === 'reply') {
      const text = String(b.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: '回复内容不能为空' });
      return sendJson(res, 200, { ok: true, ticket: DB.replyTicket(t.id, { by: 'admin', text }) });
    }
    if (b.action === 'close') return sendJson(res, 200, { ok: true, ticket: DB.setTicketStatus(t.id, 'closed') });
    if (b.action === 'reopen') return sendJson(res, 200, { ok: true, ticket: DB.setTicketStatus(t.id, 'open') });
    return sendJson(res, 400, { ok: false, error: '未知操作' });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleRedeem(req, res) {
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const b = await jsonBody(req);
  try {
    const out = DB.redeemCode(ctx.user, b.code);
    sendJson(res, 200, {
      ok: true,
      ...out,
      message:
        out.type === 'monthly'
          ? `兑换成功！会员已延长 ${out.value} 天`
          : `兑换成功！已到账 ${out.value} 次听说模拟`,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

 

async function handleAdminLogin(req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  
  if (isBanned(`adm:${ip}`)) {
    return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 3 分钟后再试' });
  }

  
  const rl = RL.adminLogin(ip);
  if (!rl.ok) {
    return sendJson(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试` });
  }

  const b = await jsonBody(req);
  const account = String(b.account || 'admin').trim();
  const pw = String(b.password || '');

  
  const capAd = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!capAd.ok) return sendJson(res, 400, { ok: false, error: capAd.error });

  const s = DB.getSettings();

  if (!s.adminUsername) s.adminUsername = 'admin';

  const bad = () => {
    
    logVisit(req, 'admin-login', { action: 'fail', ip, detail: '账号或密码错误' });
    
    const fails = Activity.query({ kind: 'admin-login', action: 'fail', ip, since: Date.now() - 3 * 60_000 });
    if (fails.length >= 5) banKey(`adm:${ip}`, 3 * 60_000);
    return sendJson(res, 401, { ok: false, error: '账号或密码错误' });
  };

  
  if (account !== s.adminUsername) return bad();
  if (!s.adminPasswordHash) {
    if (pw.length < 6) {
      return sendJson(res, 400, { ok: false, error: '首次设置管理员密码至少 6 位' });
    }
    DB.updateSettings({ adminPasswordHash: DB.hashPassword(pw) });
    DB.log('admin-init', 'system', '首次设置管理员密码');
  } else if (!DB.checkAdminPassword(pw)) {
    return bad();
  }

  logVisit(req, 'admin-login', { action: 'ok', ip, detail: s.adminUsername });
  const token = DB.createSession('admin', 'admin');
  setSessionCookie(res, token, 'admin', req);
  sendJson(res, 200, { ok: true, token, account: s.adminUsername });
}

async function handleUnbanSelf(req, res) {
  const ip = clientIp(req);

  const guard = DB.getUnbanGuard(ip);
  if (guard && guard.locked) {
    logVisit(req, 'unban-self', { action: 'fail', ip, detail: '已永久禁用' });
    return sendJson(res, 403, {
      ok: false,
      error: '该 IP 的自助解封已被永久禁用，请联系管理员在后台处理',
      locked: true,
    });
  }

  const rl = RL.adminLogin(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试` });

  const b = await jsonBody(req);
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  const s = DB.getSettings();
  if (!s.adminPasswordHash) return sendJson(res, 400, { ok: false, error: '尚未设置管理员密码' });
  if (!DB.checkAdminPassword(String(b.password || ''))) {
    const r = DB.noteUnbanFail(ip, DB.UNBAN_MAX_FAILS);
    logVisit(req, 'unban-self', { action: 'fail', ip, detail: `密码错误 ${r.fails}/${DB.UNBAN_MAX_FAILS}` });
    if (r.locked) {
      DB.log('unban-self-lock', 'system', `${ip} 连续输错 ${r.fails} 次，已永久禁用自助解封`);
      return sendJson(res, 403, {
        ok: false,
        error: `密码错误次数已达 ${DB.UNBAN_MAX_FAILS} 次，该 IP 自助解封已永久禁用，请联系管理员`,
        locked: true,
      });
    }
    return sendJson(res, 401, {
      ok: false,
      error: `管理员密码错误，还可尝试 ${r.remain} 次（超过 ${DB.UNBAN_MAX_FAILS} 次将永久禁用）`,
    });
  }

  const n = DB.unbanIp(ip);
  DB.clearUnbanGuard(ip);
  resetScriptHits(ip);
  DB.log('unban-self', 'admin', `${ip} 自助解封（${n} 条）`);
  logVisit(req, 'unban-self', { action: 'ok', ip, detail: `解除 ${n} 条` });
  if (!n) return sendJson(res, 200, { ok: false, error: `当前 IP（${ip}）不在封禁列表中，可能是前缀/网段封禁，请到后台手动处理` });
  sendJson(res, 200, { ok: true, ip, removed: n });
}

async function handleAdminIpCheck(req, res) {
  if (!requireAdmin(req, res)) return;
  const h = req.headers || {};
  const info = clientIpInfo(req);
  const pick = (v) => (v === undefined ? '' : String(Array.isArray(v) ? v.join(', ') : v).slice(0, 300));
  sendJson(res, 200, {
    ok: true,
    at: new Date().toISOString(),
    ip: info.ip,
    source: info.source,
    peer: info.peer,
    trustedProxy: isTrustedProxy(info.peer),
    whitelisted: DB.isIpWhitelisted(info.ip),
    banned: DB.isIpBanned(info.ip),
    headers: {
      'cf-connecting-ip': pick(h['cf-connecting-ip']),
      'x-forwarded-for': pick(h['x-forwarded-for']),
      'x-real-ip': pick(h['x-real-ip']),
      'true-client-ip': pick(h['true-client-ip']),
      'cf-ray': pick(h['cf-ray']),
      'cf-ipcountry': pick(h['cf-ipcountry']),
      'user-agent': pick(h['user-agent']),
    },
  });
}

async function handleAdminOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  const info = clientIpInfo(req);
  sendJson(res, 200, {
    ok: true,
    settings: DB.getPublicSettings(),
    stats: DB.stats(),
    users: DB.listUsers(),
    codes: DB.listCodes({ limit: 300 }),
    orders: DB.listOrders(60),
    payOrders: DB.listPayOrders(60),
    epay: (() => {
      const e = epayConf();
      return { enabled: e.enabled, pid: e.pid, apiBase: e.base, types: e.types, hasKey: Boolean(e.key) };
    })(),
    logs: DB.data().logs.slice(0, 80),
    client: {
      ip: info.ip,
      source: info.source,
      peer: info.peer,
      whitelisted: DB.isIpWhitelisted(info.ip),
    },
  });
}

async function handleAdminSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const cur = DB.getSettings();
  const patch = {};

  
  for (const k of ['apiKey', 'apiBase', 'model', 'siteName', 'examRegion', 'paperTemperature', 'scoreTemperature']) {
    if (b[k] === undefined) continue;
    patch[k] = String(b[k]).trim();
  }
  if (patch.apiBase) {
    patch.apiBase = patch.apiBase.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(patch.apiBase)) {
      return sendJson(res, 400, { ok: false, error: '接口地址需要以 http:// 或 https:// 开头' });
    }
    
    if (!/\/v\d+$/.test(patch.apiBase)) {
      patch.apiBase += '/v1';
      console.log('[settings] 接口地址自动补全为', patch.apiBase);
    }
  }
  if (patch.apiKey === '') delete patch.apiKey; 
  if (b.pricing && typeof b.pricing === 'object') patch.pricing = b.pricing;
  
  if (b.cardBuyUrl !== undefined) {
    const u = String(b.cardBuyUrl || '').trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) {
      return sendJson(res, 400, { ok: false, error: '购买卡密链接需以 http:// 或 https:// 开头' });
    }
    patch.cardBuyUrl = u;
  }
  
  if (b.brevo && typeof b.brevo === 'object') {
    const cb = cur.brevo || {};
    const next = {
      enabled: Boolean(b.brevo.enabled),
      apiKey: String(b.brevo.apiKey || '').trim() || cb.apiKey || '',
      senderEmail: String(b.brevo.senderEmail ?? cb.senderEmail ?? '').trim(),
      senderName: String(b.brevo.senderName ?? cb.senderName ?? '').trim().slice(0, 60) || '在线练习系统',
    };
    if (next.senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.senderEmail)) {
      return sendJson(res, 400, { ok: false, error: 'Brevo 发件邮箱格式不正确' });
    }
    if (next.enabled && (!next.apiKey || !next.senderEmail)) {
      return sendJson(res, 400, { ok: false, error: '开启邮箱验证前，需填写 Brevo API Key 与发件邮箱' });
    }
    patch.brevo = next;
  }
  
  if (b.security && typeof b.security === 'object') {
    const cur2 = cur.security || {};
    patch.security = {
      registrationOff: Boolean(b.security.registrationOff ?? cur2.registrationOff),
      loginOff: Boolean(b.security.loginOff ?? cur2.loginOff),
      speechOff: Boolean(b.security.speechOff ?? cur2.speechOff),
    };
  }
  
  if (b.turnstile && typeof b.turnstile === 'object') {
    const ct = cur.turnstile || {};
    const siteKey = String(b.turnstile.siteKey ?? ct.siteKey ?? '').trim();
    if (siteKey && !/^[A-Za-z0-9_\-]{8,80}$/.test(siteKey)) {
      return sendJson(res, 400, { ok: false, error: 'Turnstile Site Key 格式不正确' });
    }
    
    
    const secretKey = siteKey ? String(b.turnstile.secretKey || '').trim() || ct.secretKey || '' : '';
    patch.turnstile = { siteKey, secretKey };
  }
  
  if (b.urgentNotice !== undefined) {
    if (b.urgentNotice && typeof b.urgentNotice === 'object') {
      const title = String(b.urgentNotice.title || '').trim().slice(0, 100);
      const body  = String(b.urgentNotice.body  || '').trim().slice(0, 2000);
      const enabled = Boolean(b.urgentNotice.enabled);
      const oldUn = cur.urgentNotice || {};
      
      const contentChanged = title !== (oldUn.title || '') || body !== (oldUn.body || '');
      const id = (enabled && contentChanged) ? crypto.randomUUID().slice(0, 8) : (oldUn.id || crypto.randomUUID().slice(0, 8));
      patch.urgentNotice = { enabled, id, title, body };
    } else {
      patch.urgentNotice = { enabled: false, id: '', title: '', body: '' };
    }
  }
  
  if (b.clearSpeech) {
    
    patch.speechApi = { apiBase: '', apiKey: '', ttsModel: 'tts-1', ttsVoice: 'alloy', asrModel: 'whisper-1' };
  } else if (b.speechApi && typeof b.speechApi === 'object') {
    const cs = cur.speechApi || {};
    let base = String(b.speechApi.apiBase || '').trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\//i.test(base)) {
      return sendJson(res, 400, { ok: false, error: '语音服务地址需以 http:// 或 https:// 开头' });
    }
    if (base && !/\/v\d+$/.test(base)) base += '/v1';
    patch.speechApi = {
      
      apiBase: base || cs.apiBase || '',
      apiKey: String(b.speechApi.apiKey || '').trim() || cs.apiKey || '',
      ttsModel: String(b.speechApi.ttsModel || cs.ttsModel || 'tts-1').trim(),
      ttsVoice: String(b.speechApi.ttsVoice || cs.ttsVoice || 'alloy').trim(),
      asrModel: String(b.speechApi.asrModel || cs.asrModel || 'whisper-1').trim(),
    };
  }
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) return sendJson(res, 400, { ok: false, error: '管理员密码至少 6 位' });
    patch.adminPasswordHash = DB.hashPassword(String(b.newPassword));
  }

  DB.updateSettings(patch);
  DB.log('admin-settings', 'admin', Object.keys(patch).filter((k) => k !== 'apiKey' && k !== 'brevo').join(',') || '(无变更)');

  sendJson(res, 200, {
    ok: true,
    settings: DB.getPublicSettings(),
    message: '设置已保存（网站后台为唯一配置入口，立即生效）',
  });
}

 
async function handleAdminModels(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const s = DB.getSettings();
  const apiBase = String(b.apiBase || s.apiBase || '').replace(/\/$/, '');
  const apiKey = String(b.apiKey || s.apiKey || '');
  if (!apiBase) return sendJson(res, 400, { ok: false, error: '请先填写 v1 接口地址' });
  if (!apiKey) return sendJson(res, 400, { ok: false, error: '请先填写 API Key' });

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    const r = await fetch(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const txt = await r.text();
    if (!r.ok) {
      return sendJson(res, 502, { ok: false, error: `上游返回 ${r.status}：${txt.slice(0, 300)}` });
    }
    let list = [];
    try {
      const j = JSON.parse(txt);
      list = (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    } catch {
      return sendJson(res, 502, { ok: false, error: '无法解析模型列表：' + txt.slice(0, 200) });
    }
    list.sort();
    DB.updateSettings({ availableModels: list });
    sendJson(res, 200, { ok: true, models: list, count: list.length });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: '获取模型列表失败：' + e.message });
  }
}

 
async function handleAdminTest(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req).catch(() => ({}));
  const s = DB.getSettings();

  const apiBase = String(b.apiBase || s.apiBase || '').replace(/\/$/, '');
  const apiKey = String(b.apiKey || s.apiKey || '');
  const model = String(b.model || s.model || '');

  if (!apiBase) return sendJson(res, 400, { ok: false, error: '请先填写 v1 接口地址' });
  if (!apiKey) return sendJson(res, 400, { ok: false, error: '请先填写 API Key' });

  const steps = [];
  const t0 = Date.now();

   
  let modelCount = 0;
  if (!b.skipModels) {
    const t = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(`${apiBase}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const txt = await r.text();
      if (!r.ok) {
        steps.push({ step: 'models', ok: false, ms: Date.now() - t, error: `HTTP ${r.status}：${txt.slice(0, 200)}` });
        return sendJson(res, 200, {
          ok: false,
          stage: 'models',
          steps,
          ms: Date.now() - t0,
          hint:
            r.status === 401 || r.status === 403
              ? '密钥无效或没有权限，请检查 API Key 是否正确、是否有多余空格。'
              : r.status === 404
              ? '该地址下没有 /models 接口，请确认 v1 地址是否填写正确（例如应填 https://api.hcnsec.cn/v1）。'
              : '上游服务异常，可稍后重试。',
        });
      }
      let list = [];
      try {
        const j = JSON.parse(txt);
        list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      } catch {}
      modelCount = list.length;
      steps.push({
        step: 'models',
        ok: true,
        ms: Date.now() - t,
        count: modelCount,
        sample: list.slice(0, 5).map((m) => m.id || m.name).filter(Boolean),
      });
    } catch (e) {
      steps.push({
        step: 'models',
        ok: false,
        ms: Date.now() - t,
        error: e.name === 'AbortError' ? '连接超时（20 秒）' : e.message,
      });
      return sendJson(res, 200, {
        ok: false,
        stage: 'models',
        steps,
        ms: Date.now() - t0,
        hint: '无法连接到该地址，请检查网络、地址是否可访问，以及是否需要在地址结尾保留 /v1。',
      });
    }
  }

   
  const tChat = Date.now();
  let content = '';
  try {
    const out = await callChat({
      apiKey,
      apiBase,
      model,
      system: '你是连通性测试助手，只回一个 JSON。',
      user: '请只返回 {"ok":true}',
      temperature: 0,
      maxTokens: 64,
    });
    content = String(out.content || '');
    steps.push({ step: 'chat', ok: true, ms: Date.now() - tChat, sample: content.slice(0, 120) });
  } catch (e) {
    const msg = String(e.message || e);
    steps.push({ step: 'chat', ok: false, ms: Date.now() - tChat, error: msg.slice(0, 300) });
    return sendJson(res, 200, {
      ok: false,
      stage: 'chat',
      steps,
      ms: Date.now() - t0,
      model,
      hint: /无响应|中断|超时/.test(msg)
        ? '地址与密钥正常，但模型本次响应超时（网关或模型侧拥塞），可稍后重试或换一个模型。'
        : /model|not found|404/i.test(msg)
        ? `模型「${model}」可能不可用，请点「拉取模型列表」重新选择。`
        : '模型调用失败，请检查模型名是否正确。',
    });
  }

  sendJson(res, 200, {
    ok: true,
    ms: Date.now() - t0,
    apiBase,
    model,
    modelCount,
    steps,
    sample: content.slice(0, 200),
    message: `连通正常：接口可访问（${modelCount} 个模型），模型「${model}」响应正常`,
  });
}

 

const UPLOAD_DIR = process.env.EXAM_UPLOAD_DIR
  ? path.resolve(process.env.EXAM_UPLOAD_DIR)
  : path.join(path.dirname(DB.DB_FILE), 'uploads');

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; 

async function handleAdminUpload(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const dataUrl = String(b.dataUrl || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return sendJson(res, 400, { ok: false, error: '图片格式不正确（需要 data URL）' });

  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return sendJson(res, 400, { ok: false, error: '只支持 PNG / JPG / WebP / GIF / SVG 图片' });

  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return sendJson(res, 400, { ok: false, error: '图片解码失败' });
  }
  if (!buf.length) return sendJson(res, 400, { ok: false, error: '图片内容为空' });
  if (buf.length > MAX_UPLOAD_BYTES) {
    return sendJson(res, 400, {
      ok: false,
      error: `图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 3MB 以内`,
    });
  }

  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    
    const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    const url = `/uploads/${name}`;
    DB.log('admin-upload', 'admin', `${name} (${(buf.length / 1024).toFixed(0)}KB)`);
    sendJson(res, 200, { ok: true, url, bytes: buf.length, name });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '保存失败：' + e.message });
  }
}

 
function serveUpload(res, urlPath) {
  const name = path.basename(decodeURIComponent(urlPath));
  if (!name || name.includes('..')) return sendJson(res, 400, { ok: false, error: 'Bad name' });
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'Not found' });
  const ext = path.extname(name).slice(1).toLowerCase();
  const type =
    Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
  const buf = fs.readFileSync(file);
  
  
  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (ext === 'svg') {
    headers['Content-Security-Policy'] = "default-src 'none'; script-src 'none'";
    headers['X-Content-Type-Options'] = 'nosniff';
  }
  res.writeHead(200, headers);
  res.end(buf);
}


 

async function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  const b = req.method === 'POST' ? await jsonBody(req).catch(() => ({})) : {};
  const action = String(b.action || '');

  
  if (action === 'clear') {
    if (b.confirm !== 'CLEAR') {
      return sendJson(res, 400, { ok: false, error: '危险操作：需要在请求里带 confirm: "CLEAR"' });
    }
    const done = DB.clearData({
      users: true,
      sessions: true,
      codes: Boolean(b.codes),
      orders: Boolean(b.orders),
      logs: Boolean(b.logs),
    });
    return sendJson(res, 200, {
      ok: true,
      cleared: done,
      message: `已清空 ${done.users || 0} 个用户、${done.sessions || 0} 个会话` +
        (done.codes ? `、${done.codes} 个兑换码` : '') +
        (done.orders ? `、${done.orders} 条流水` : ''),
      users: DB.listUsers(),
    });
  }

  
  if (action === 'delete') {
    try {
      DB.deleteUser(b.id);
      return sendJson(res, 200, { ok: true, users: DB.listUsers(), message: '用户已删除' });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  if (b.id) {
    try {
      const u = DB.updateUser(b.id, b);
      return sendJson(res, 200, { ok: true, user: u, users: DB.listUsers(), message: '已更新用户' });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  
  sendJson(res, 200, { ok: true, users: DB.listUsers() });
}

async function handleAdminCodes(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method === 'GET') return sendJson(res, 200, { ok: true, codes: DB.listCodes({ limit: 500 }) });
  const b = await jsonBody(req);
  try {
    if (b.action === 'disable' || b.action === 'enable') {
      DB.setCodeDisabled(b.code, b.action === 'disable');
      return sendJson(res, 200, { ok: true, codes: DB.listCodes({ limit: 500 }) });
    }
    const made = DB.createCodes({
      type: b.type === 'monthly' ? 'monthly' : 'credits',
      value: Number(b.value) || 1,
      count: Number(b.count) || 1,
      note: b.note || '',
      prefix: b.prefix || 'JMKT',
    });
    sendJson(res, 200, {
      ok: true,
      created: made,
      codes: DB.listCodes({ limit: 500 }),
      message: `已生成 ${made.length} 个兑换码`,
    });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleAdminUsersLegacyRemoved() {
   
}

 

function handleCaptcha(req, res) {
  const ip = clientIp(req);
  const rl = RL.captcha(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: '验证码请求过于频繁' });
  const cap = createCaptcha(ip);
  sendJson(res, 200, { ok: true, id: cap.id, svg: cap.svg, ttlSec: cap.ttlSec });
}

 

function makeSilentWav(seconds = 0.6, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

async function handleAdminSpeechTest(req, res) {
  if (!requireAdmin(req, res)) return;
  const s = DB.getSettings();
  const sp = s.speechApi || {};
  const base = String(sp.apiBase || '').trim();
  const key = String(sp.apiKey || s.apiKey || '').trim();
  const steps = [];

  if (!base) return sendJson(res, 200, { ok: false, error: '未配置「语音 API 地址」，当前朗读使用本地 Edge-TTS', steps });
  if (!key) return sendJson(res, 200, { ok: false, error: '未配置「语音 API Key」，也无法回退到主 Key', steps });

  try {
    const r = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: sp.ttsModel || 'tts-1', input: 'hello', voice: sp.ttsVoice || 'alloy' }),
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      steps.push({ step: 'tts', ok: true, bytes: buf.length, contentType: r.headers.get('content-type') || '' });
    } else {
      const t = (await r.text().catch(() => '')).slice(0, 300);
      steps.push({ step: 'tts', ok: false, status: r.status, error: t });
    }
  } catch (e) {
    steps.push({ step: 'tts', ok: false, error: e.message });
  }

  try {
    const wav = makeSilentWav();
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
    fd.append('model', sp.asrModel || 'whisper-1');
    fd.append('response_format', 'json');
    const r = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const t = (await r.text().catch(() => '')).slice(0, 300);
    if (r.ok) steps.push({ step: 'asr', ok: true, sample: t });
    else steps.push({ step: 'asr', ok: false, status: r.status, error: t });
  } catch (e) {
    steps.push({ step: 'asr', ok: false, error: e.message });
  }

  const ok = steps.every((x) => x.ok);
  sendJson(res, 200, {
    ok,
    base,
    steps,
    hint: ok
      ? '两个接口均可用，朗读与转写会全部走该 API。'
      : '有一项失败：说明该服务地址不支持对应接口或密钥无权限，请更换支持 /audio/speech 与 /audio/transcriptions 的服务。',
  });
}

async function handleAdminSpeechModels(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const s = DB.getSettings();
  const sp = s.speechApi || {};
  let base = String(b.apiBase || sp.apiBase || s.apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return sendJson(res, 400, { ok: false, error: '请先填写 API 地址' });
  if (!/^https?:\/\//i.test(base)) return sendJson(res, 400, { ok: false, error: 'API 地址需以 http:// 或 https:// 开头' });
  if (!/\/v\d+$/.test(base)) base += '/v1';
  const key = String(b.apiKey || sp.apiKey || s.apiKey || '').trim();

  try {
    const r = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 200);
      return sendJson(res, 200, { ok: false, error: `拉取失败（HTTP ${r.status}）${t ? '：' + t : ''}` });
    }
    const d = await r.json().catch(() => null);
    const list = ((d && (d.data || d.models)) || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    sendJson(res, 200, { ok: true, models: list, base });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: `拉取失败：${e.message}` });
  }
}

async function handleTts(req, res) {
  if (DB.getSettings()?.security?.speechOff) {
    return sendJson(res, 503, { ok: false, error: '语音合成服务当前已关闭' });
  }
  
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const ip = clientIp(req);
  const rl = RL.tts(ip);
  if (!rl.ok) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '语音合成请求过于频繁' }));
  }
  const b = await jsonBody(req);
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return sendJson(res, 400, { ok: false, error: '文本不能为空' });

  const s = DB.getSettings();
  const sp = s.speechApi || {};
  const speechBase = String(sp.apiBase || '').trim();
  const speechKey = String(sp.apiKey || s.apiKey || '').trim();

  if (speechBase && speechKey) {
    try {
      const ttsModel = sp.ttsModel || 'tts-1';
      const voice = sp.ttsVoice || 'alloy';
      const r = await fetch(`${speechBase}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${speechKey}`,
        },
        body: JSON.stringify({ model: ttsModel, input: text, voice }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': r.headers.get('content-type') || 'audio/mpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400',
          'X-TTS-Engine': 'api',
        });
        return res.end(buf);
      }
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      console.warn('[tts-api]', r.status, detail);
      return sendJson(res, 502, {
        ok: false,
        error: `语音 API 合成失败（HTTP ${r.status}）${detail ? '：' + detail : ''}`,
        engine: 'api',
      });
    } catch (e) {
      console.warn('[tts-api]', e.message);
      return sendJson(res, 502, { ok: false, error: `语音 API 请求失败：${e.message}`, engine: 'api' });
    }
  }

  
  const fallback = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural';
  const voice = TTS_VOICES[b.voice] ? b.voice : fallback;
  const rate = ttsRateStr(b.speed || 1);
  try {
    const mp3 = await edgeTts(text, { voice, rate });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': mp3.length,
      'Cache-Control': 'public, max-age=86400',
      'X-TTS-Engine': 'edge',
    });
    res.end(mp3);
  } catch (e) {
    console.warn('[tts]', e.message);
    sendJson(res, 502, { ok: false, error: '语音合成失败：' + e.message });
  }
}

function handleTtsVoices(req, res) {
  sendJson(res, 200, { ok: true, voices: TTS_VOICES });
}

 

 
async function handleAsr(req, res, cfg) {
  if (DB.getSettings()?.security?.speechOff) {
    return sendJson(res, 503, { ok: false, error: '语音识别服务当前已关闭' });
  }
  const ctx = requireUser(req, res);
  if (!ctx) return;
  const ip = clientIp(req);
  const rl = RL.tts(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: '转写请求过于频繁' });

  const ctype = String(req.headers['content-type'] || 'audio/webm');
  const audio = await readBodyRaw(req, 8 * 1024 * 1024).catch(() => null);
  if (!audio || !audio.length) return sendJson(res, 400, { ok: false, error: '未收到音频数据' });

  const s = DB.getSettings();
  const sp = s.speechApi || {};
  const asrBase = sp.apiBase || cfg.apiBase;
  const asrKey = sp.apiKey || apiKeyFor(req, cfg, ctx.session);
  if (!asrKey) return sendJson(res, 400, { ok: false, error: '服务端未配置 API Key' });

  const lang = 'en';
  
  const configModel = sp.asrModel || '';
  const fallbackModels = ['whisper-1', 'whisper-large-v3', 'qwen-audio-asr'];
  const models = configModel ? [configModel, ...fallbackModels.filter((m) => m !== configModel)] : fallbackModels;

  for (const model of models) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([audio], { type: ctype }), 'answer.webm');
      fd.append('model', model);
      fd.append('language', lang);
      fd.append('response_format', 'json');

      const r = await fetch(`${asrBase}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${asrKey}` },
        body: fd,
        signal: AbortSignal.timeout(45000),
      });
      const txt = await r.text();
      if (!r.ok) {
        
        if (r.status === 404 || r.status === 400 || r.status === 422) continue;
        return sendJson(res, 502, { ok: false, error: `转写失败（HTTP ${r.status}）：${txt.slice(0, 160)}` });
      }
      let out = '';
      try {
        const j = JSON.parse(txt);
        out = String(j.text || j.transcription || j.result || '').trim();
      } catch {
        out = txt.trim();
      }
      if (out) {
        console.log(`[asr] ok model=${model} chars=${out.length}`);
        return sendJson(res, 200, { ok: true, text: out, model, engine: 'server' });
      }
    } catch (e) {
      
      const msg = String(e.message || e);
      if (/timeout|abort/i.test(msg)) continue;
    }
  }

  
  return sendJson(res, 501, {
    ok: false,
    error: '当前模型网关不支持语音转写接口（/audio/transcriptions），已自动降级为纯声学评分',
    engine: 'server',
  });
}

 

async function handleAdminActivity(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method === 'POST') {
    const b = await jsonBody(req);
    if (b.action === 'clear') {
      const n = Activity.clear();
      return sendJson(res, 200, { ok: true, cleared: n });
    }
    if (b.action === 'stats') {
      return sendJson(res, 200, { ok: true, stats: Activity.stats({ since: Number(b.since) || 0 }) });
    }
    
    const list = Activity.query({
      kind: b.kind || '',
      userId: b.userId || '',
      ip: b.ip || '',
      q: b.q || '',
      since: Number(b.since) || 0,
      until: Number(b.until) || 0,
      limit: Number(b.limit) || 200,
    });
    return sendJson(res, 200, { ok: true, events: list, total: list.length });
  }
  
  const events = Activity.query({ limit: 200 });
  const stats = Activity.stats({ since: Date.now() - 24 * 3600_000 });
  sendJson(res, 200, { ok: true, events, stats });
}

 

async function handleAdminNotices(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const action = String(b.action || 'list');

  if (action === 'list') {
    return sendJson(res, 200, {
      ok: true,
      announcements: DB.listAnnouncements(false),
      abnormal: DB.listAbnormal(false),
    });
  }

  if (action === 'addAnnouncement') {
    const a = DB.addAnnouncement({ title: b.title, body: b.body, level: b.level });
    DB.log('admin-announce', 'admin', a.title);
    return sendJson(res, 200, { ok: true, item: a });
  }
  if (action === 'toggleAnnouncement') {
    const a = DB.toggleAnnouncement(String(b.id), b.active);
    if (!a) return sendJson(res, 404, { ok: false, error: '公告不存在' });
    return sendJson(res, 200, { ok: true, item: a });
  }
  if (action === 'removeAnnouncement') {
    const n = DB.removeAnnouncement(String(b.id));
    return sendJson(res, 200, { ok: true, removed: n });
  }

  if (action === 'addAbnormal') {
    const a = DB.addAbnormal({ type: b.type, value: b.value, reason: b.reason, note: b.note });
    DB.log('admin-abnormal', 'admin', `${a.type}:${a.value}`);
    return sendJson(res, 200, { ok: true, item: a });
  }
  if (action === 'toggleAbnormal') {
    const a = DB.toggleAbnormal(String(b.id), b.active);
    if (!a) return sendJson(res, 404, { ok: false, error: '公示不存在' });
    return sendJson(res, 200, { ok: true, item: a });
  }
  if (action === 'removeAbnormal') {
    const n = DB.removeAbnormal(String(b.id));
    return sendJson(res, 200, { ok: true, removed: n });
  }

  if (action === 'listBanned') {
    return sendJson(res, 200, {
      ok: true,
      banned: DB.listBannedIps(),
      whitelist: DB.listIpWhitelist(),
      trustedProxies: DB.listTrustedProxies(),
      scriptGuard: DB.getSettings().scriptGuard || {},
    });
  }
  if (action === 'saveScriptGuard') {
    const enabled = b.enabled !== false;
    const scriptMax = Math.min(1000, Math.max(1, Number(b.scriptMax) || 5));
    const windowMin = Math.min(1440, Math.max(1, Number(b.windowMin) || 10));
    DB.updateSettings({ scriptGuard: { enabled, scriptMax, windowMin } });
    DB.log('admin-script-guard', 'admin', `enabled=${enabled} max=${scriptMax} window=${windowMin}min`);
    return sendJson(res, 200, {
      ok: true,
      scriptGuard: DB.getSettings().scriptGuard,
      message: enabled
        ? `已保存：${windowMin} 分钟内脚本访问超过 ${scriptMax} 次自动封禁`
        : '已关闭脚本访问自动封禁',
    });
  }
  if (action === 'saveEpay') {
    const patch = {};
    if (b.pid !== undefined) patch.pid = String(b.pid || '').trim().slice(0, 40);
    if (b.key !== undefined) {
      const k = String(b.key || '').trim();
      if (k && !/^\*+$/.test(k)) patch.key = k.slice(0, 128);
    }
    if (b.apiBase !== undefined) {
      const u = String(b.apiBase || '').trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\//i.test(u)) return sendJson(res, 400, { ok: false, error: '接口地址需以 http:// 或 https:// 开头' });
      patch.apiBase = u;
    }
    if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
    if (Array.isArray(b.types)) {
      const allowed = ['alipay', 'wxpay', 'qqpay', 'bank', 'jdpay'];
      patch.types = b.types.filter((t) => allowed.includes(String(t)));
    }
    DB.updateSettings({ epay: patch });
    DB.log('admin-epay', 'admin', `enabled=${DB.getSettings().epay.enabled}`);
    const e = epayConf();
    return sendJson(res, 200, { ok: true, epay: { enabled: e.enabled, pid: e.pid, apiBase: e.base, types: e.types, hasKey: Boolean(e.key) } });
  }
  if (action === 'banIp') {
    const target = String(b.ip || '').trim();
    if (isTrustedProxy(target)) {
      return sendJson(res, 400, {
        ok: false,
        error: '该地址属于 CDN/反向代理或内网地址，禁止封禁（会误伤大量用户）',
      });
    }
    if (DB.isIpWhitelisted(target)) {
      return sendJson(res, 400, { ok: false, error: '该地址在 IP 白名单中，请先从白名单移除' });
    }
    const r = DB.banIp(target, b.note, 'admin');
    DB.log('admin-ban-ip', 'admin', `${b.ip}${r.added ? '' : '（已存在）'}`);
    return sendJson(res, 200, { ok: true, ...r, banned: DB.listBannedIps() });
  }
  if (action === 'addWhitelist') {
    const target = String(b.ip || '').trim();
    if (!target) return sendJson(res, 400, { ok: false, error: '请输入要加入白名单的 IP / 网段' });
    if (isTrustedProxy(target)) {
      return sendJson(res, 400, { ok: false, error: '不能把 CDN/反向代理或内网地址加入白名单' });
    }
    if (target.includes('/')) {
      const [net, bitsStr] = target.split('/');
      const bits = Number(bitsStr);
      const isV6 = net.includes(':');
      const minBits = isV6 ? 16 : 8;
      if (!Number.isInteger(bits) || bits < minBits || bits > (isV6 ? 128 : 32)) {
        return sendJson(res, 400, {
          ok: false,
          error: `网段范围过大或格式不正确（${isV6 ? 'IPv6' : 'IPv4'} 前缀需不小于 /${minBits}）`,
        });
      }
    }
    const r = DB.addIpWhitelist(target, b.note);
    if (r.added) DB.log('admin-whitelist-add', 'admin', `${target}${b.note ? `（${String(b.note).slice(0, 60)}）` : ''}`);
    return sendJson(res, 200, { ok: true, ...r, whitelist: DB.listIpWhitelist() });
  }
  if (action === 'removeWhitelistById') {
    const n = DB.removeIpWhitelistById(String(b.id));
    return sendJson(res, 200, { ok: true, removed: n, whitelist: DB.listIpWhitelist() });
  }
  if (action === 'unbanIp') {
    const n = DB.unbanIp(b.ip);
    resetScriptHits(String(b.ip || '').trim());
    DB.clearUnbanGuard(String(b.ip || '').trim());
    return sendJson(res, 200, { ok: true, removed: n, banned: DB.listBannedIps() });
  }
  if (action === 'removeBannedById') {
    const target = DB.listBannedIps().find((x) => String(x.id) === String(b.id));
    const n = DB.removeBannedIpById(String(b.id));
    if (target) {
      resetScriptHits(String(target.ip || '').trim());
      DB.clearUnbanGuard(String(target.ip || '').trim());
    }
    return sendJson(res, 200, { ok: true, removed: n, banned: DB.listBannedIps() });
  }
  if (action === 'addTrustedProxy') {
    const target = String(b.ip || '').trim();
    if (!target) return sendJson(res, 400, { ok: false, error: '请输入要信任的代理 IP / 网段' });
    const isV6 = target.split('/')[0].includes(':');
    const probe = target.includes('/') ? target.split('/')[0] : target;
    if (isV6 !== probe.includes(':')) return sendJson(res, 400, { ok: false, error: '地址格式不正确' });
    const r = DB.addTrustedProxy(target, b.note);
    if (r.added) {
      for (const w of DB.listIpWhitelist()) {
        if (String(w.ip).trim() === target) DB.removeIpWhitelistById(w.id);
      }
      for (const banned of DB.listBannedIps()) {
        if (String(banned.ip).trim() === target) DB.removeBannedIpById(banned.id);
      }
      setExtraTrustedProxies(DB.listTrustedProxies());
      DB.log('admin-trusted-proxy', 'admin', `${target}${b.note ? `（${String(b.note).slice(0, 60)}）` : ''}`);
    }
    return sendJson(res, 200, { ok: true, ...r, trustedProxies: DB.listTrustedProxies() });
  }
  if (action === 'removeTrustedProxyById') {
    const n = DB.removeTrustedProxyById(String(b.id));
    setExtraTrustedProxies(DB.listTrustedProxies());
    return sendJson(res, 200, { ok: true, removed: n, trustedProxies: DB.listTrustedProxies() });
  }

  return sendJson(res, 400, { ok: false, error: '未知操作' });
}


 

const cliArgs = process.argv.slice(2);
if (cliArgs.some((a) => a === '--list-bans' || a === '--bans')) {
  DB.load();
  const list = DB.listBannedIps();
  if (!list.length) console.log('封禁列表为空');
  else {
    console.log(`共 ${list.length} 条封禁：`);
    for (const b of list) {
      const at = b.at ? new Date(b.at).toLocaleString('zh-CN') : '-';
      console.log(`  ${String(b.ip).padEnd(24)} ${at}  ${b.by || 'admin'}  ${b.note || ''}  [id=${b.id}]`);
    }
  }
  process.exit(0);
}

const unbanTarget = (() => {
  const i = cliArgs.findIndex((a) => a === '--unban');
  if (i >= 0) return cliArgs[i + 1] || '';
  const eq = cliArgs.find((a) => a.startsWith('--unban='));
  return eq ? eq.slice('--unban='.length) : '';
})();
if (cliArgs.includes('--unban-all') || unbanTarget) {
  DB.load();
  if (cliArgs.includes('--unban-all')) {
    const all = DB.listBannedIps();
    let n = 0;
    for (const b of all) {
      n += DB.unbanIp(b.ip);
      DB.clearUnbanGuard(String(b.ip));
    }
    console.log(`已清空封禁列表，解除 ${n} 条`);
  } else {
    const n = DB.unbanIp(unbanTarget);
    DB.clearUnbanGuard(unbanTarget);
    console.log(n > 0 ? `已解封 ${unbanTarget}（同时解除自助解封限制）` : `未找到封禁记录：${unbanTarget}`);
    console.log('当前剩余封禁：', DB.listBannedIps().length, '条');
  }
  DB.flush();
  process.exit(0);
}

const PORT = Number(argValue('--port') || process.env.PORT || process.env.EXAM_PORT || 8777);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  const route = async () => {
    const cfg = getCfg();
    const ipInfo = clientIpInfo(req);
    const ip = ipInfo.ip;
    const whitelisted = DB.isIpWhitelisted(ip);

    
    
    
    const isStaticAsset = /\.(js|css|png|jpg|jpeg|webp|gif|svg|ico|woff2|woff|ttf|map|txt|xml|json)$/i.test(p);
    if (!whitelisted && !isPrivateIp(ip) && !isTrustedProxy(ip) && !isStaticAsset && !p.startsWith('/uploads/')) {
      const guard = DB.getSettings().scriptGuard || {};
      if (guard.enabled !== false) {
        const uaInfo = parseUa(req.headers['user-agent'] || '');
        if (uaInfo.bot) {
          const max = Math.max(1, Number(guard.scriptMax) || 5);
          const windowMs = Math.max(1, Number(guard.windowMin) || 10) * 60_000;
          const hits = countScriptHit(ip, windowMs);
          if (hits > max && !DB.isIpBanned(ip)) {
            const r = DB.banIp(
              ip,
              `脚本访问超限（${guard.windowMin || 10} 分钟内第 ${hits} 次，阈值 ${max}）`,
              'auto'
            );
            if (r.added) {
              logVisit(req, 'blocked', {
                action: 'auto-ban-ip',
                detail: `脚本访问超限 ${hits}/${max}，已自动封禁`,
              });
              DB.log('auto-ban-ip', 'system', `${ip} 脚本访问 ${hits} 次（阈值 ${max}）`);
            }
          }
        }
      }
    }

    
    const banBypass = p === '/api/captcha' || p === '/api/admin/unban-self';
    if (!whitelisted && !banBypass && DB.isIpBanned(ip)) {
      logVisit(req, 'blocked', { action: 'ip-banned', ip, detail: '当前 IP 已被封禁' });
      if (p.startsWith('/api/')) {
        return sendJson(res, 403, { ok: false, error: '当前 IP 已被封禁，如有疑问请联系管理员', banned: true });
      }
      const site = DB.getSettings().siteName || '在线练习系统';
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IP 已被封禁</title>` +
          `<style>body{font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
          `.box{background:#fff;border-radius:16px;padding:36px 40px;max-width:440px;width:90%;text-align:center;box-shadow:0 8px 30px rgba(16,24,40,.08)}` +
          `.x{width:56px;height:56px;border-radius:50%;background:#fef2f2;color:#ef4444;font-size:30px;line-height:56px;margin:0 auto 16px;font-weight:700}` +
          `h1{font-size:19px;margin:0 0 10px;color:#101828}p{color:#667085;font-size:13.5px;line-height:1.7;margin:0 0 18px}` +
          `.f{text-align:left;margin-top:6px}.f label{display:block;font-size:12.5px;color:#475467;margin:10px 0 5px}` +
          `input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d0d5dd;border-radius:9px;font-size:14px;outline:none}` +
          `input:focus{border-color:#2563eb}.caprow{display:flex;gap:8px;align-items:center}.caprow img{height:38px;border-radius:8px;cursor:pointer;background:#f2f4f7}` +
          `button{width:100%;margin-top:16px;padding:10px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:14.5px;cursor:pointer}` +
          `button:disabled{opacity:.6;cursor:default}#msg{margin-top:12px;font-size:13px;min-height:18px}</style></head><body>` +
          `<div class="box"><div class="x">!</div><h1>当前 IP 已被封禁</h1>` +
          `<p>您的访问 IP <b>${ip.replace(/[<>&"]/g, '')}</b> 已被封禁。<br>如为管理员本人，可在下方验证后立即解封。</p>` +
          `<div class="f"><label>管理员密码</label><input id="pw" type="password" autocomplete="current-password" />` +
          `<label>验证码（点击图片刷新）</label><div class="caprow"><input id="code" maxlength="8" style="flex:1" /><span id="capimg"></span></div></div>` +
          `<button id="go">解除对本 IP 的封禁</button><div id="msg"></div></div>` +
          `<script>(function(){var id='';var img=document.getElementById('capimg');var msg=document.getElementById('msg');var go=document.getElementById('go');` +
          `function load(){fetch('/api/captcha').then(function(r){return r.json()}).then(function(d){id=d.id;img.innerHTML=d.svg;var s=img.querySelector('svg');if(s){s.style.height='38px';s.style.cursor='pointer';s.onclick=load;}}).catch(function(){msg.textContent='验证码加载失败';});}` +
          `load();go.onclick=function(){var pw=document.getElementById('pw').value;var code=document.getElementById('code').value.trim();if(!pw){msg.style.color='#b42318';msg.textContent='请输入管理员密码';return;}` +
          `go.disabled=true;msg.style.color='#475467';msg.textContent='处理中…';` +
          `fetch('/api/admin/unban-self',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,captchaId:id,captchaCode:code})})` +
          `.then(function(r){return r.json()}).then(function(d){go.disabled=false;` +
          `if(d.ok){msg.style.color='#067647';msg.textContent='已解除封禁，正在跳转…';setTimeout(function(){location.href='/';},900);}` +
          `else{msg.style.color='#b42318';msg.textContent=d.error||'解封失败';load();}}).catch(function(e){go.disabled=false;msg.style.color='#b42318';msg.textContent='请求失败：'+e.message;load();});};})();</script>` +
          `</body></html>`
      );
    }

    
    
    const isStatic = /\.(js|css|png|jpg|jpeg|webp|gif|svg|ico|woff2|json)$/i.test(p);
    if (!isStatic && (p === '/' || p === '/index.html')) {
      logVisit(req, 'visit', { action: 'open', detail: '首页' });
    }

    
    if (p.startsWith('/api/')) {
      if (!whitelisted && isBanned(ip)) return sendJson(res, 429, { ok: false, error: '请求过于频繁，已临时限制访问' });
      if (!whitelisted) {
        const rl = RL.api(ip);
        if (!rl.ok) return sendJson(res, 429, { ok: false, error: `请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      }
    }

    
    if (p === '/api/health') return handleHealth(req, res, cfg);
    if (p === '/api/pricing') return sendJson(res, 200, { ok: true, pricing: DB.getSettings().pricing });
    if (p === '/api/spec') return sendJson(res, 200, { ok: true, exam: EXAM, cities: CITY_PROFILES });
    if (p === '/api/captcha') return handleCaptcha(req, res);
    
    if (p === '/api/notices') {
      return sendJson(res, 200, {
        ok: true,
        announcements: DB.listAnnouncements(true),
        abnormal: DB.listAbnormal(true),
      });
    }

    if (p === '/api/pay/create' && req.method === 'POST') return handlePayCreate(req, res);
    if (p === '/api/pay/notify') return handlePayNotify(req, res);
    if (p === '/api/pay/return') return handlePayReturn(req, res);
    if (p === '/api/pay/status') return handlePayStatus(req, res);

    
    if (p === '/api/tts' && req.method === 'POST') return handleTts(req, res);
    if (p === '/api/tts/voices') return handleTtsVoices(req, res);
    if (p === '/api/asr' && req.method === 'POST') return handleAsr(req, res, cfg);

    
    if (p === '/api/auth/register' && req.method === 'POST') return handleRegister(req, res);
    if (p === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res);
    if (p === '/api/auth/email-code') return handleEmailCode(req, res);
    if (p === '/api/auth/me') return handleMe(req, res);
    if (p === '/api/account/orders') return handleMyOrders(req, res);
    if (p === '/api/tickets') return handleTickets(req, res);
    if (p === '/api/admin/tickets') return handleAdminTickets(req, res);
    if (p === '/api/redeem' && req.method === 'POST') return handleRedeem(req, res);

    
    if (p === '/api/paper' && (req.method === 'POST' || req.method === 'GET')) {
      const ctx = requireUser(req, res);
      if (!ctx) return;
      return handlePaper(req, res, cfg, ctx.session, ctx.user);
    }
    if (p === '/api/score' && req.method === 'POST') {
      const ctx = requireUser(req, res);
      if (!ctx) return;
      return handleScore(req, res, cfg, ctx.session, ctx.user);
    }

    
    if (p === '/api/records' && req.method === 'GET') {
      const ctx = requireUser(req, res);
      if (!ctx) return;
      return sendJson(res, 200, { ok: true, records: DB.listRecords(ctx.user.id, 50) });
    }
    if (p.startsWith('/api/records/') && req.method === 'GET') {
      const ctx = requireUser(req, res);
      if (!ctx) return;
      const rec = DB.getRecord(ctx.user.id, p.slice('/api/records/'.length));
      if (!rec) return sendJson(res, 404, { ok: false, error: '记录不存在' });
      return sendJson(res, 200, { ok: true, record: rec });
    }

    
    if (p === '/api/admin/login' && req.method === 'POST') return handleAdminLogin(req, res);
    if (p === '/api/admin/unban-self' && req.method === 'POST') return handleUnbanSelf(req, res);
    if (p === '/api/admin/overview') return handleAdminOverview(req, res);
    if (p === '/api/admin/ip-check') return handleAdminIpCheck(req, res);
    if (p === '/api/admin/settings' && req.method === 'POST') return handleAdminSettings(req, res);
    if (p === '/api/admin/models' && req.method === 'POST') return handleAdminModels(req, res);
    if (p === '/api/admin/test' && req.method === 'POST') return handleAdminTest(req, res);
    if (p === '/api/admin/speech-test' && req.method === 'POST') return handleAdminSpeechTest(req, res);
    if (p === '/api/admin/speech-models' && req.method === 'POST') return handleAdminSpeechModels(req, res);
    if (p === '/api/admin/upload' && req.method === 'POST') return handleAdminUpload(req, res);
    if (p === '/api/admin/codes') return handleAdminCodes(req, res);
    if (p === '/api/admin/users') return handleAdminUsers(req, res);
    if (p === '/api/admin/activity') return handleAdminActivity(req, res);
    
    if (p === '/api/admin/notices' && req.method === 'POST') return handleAdminNotices(req, res);

    
    if (p.startsWith('/uploads/')) return serveUpload(res, p);

    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown API' });
    return serveStatic(res, p);
  };

  route().catch((e) => {
    console.error('[error]', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
  });
});

server.listen(PORT, HOST, () => {
  const s = DB.getSettings();
  const cfg = getCfg();
  DB.load();
  setExtraTrustedProxies(DB.listTrustedProxies());
  console.log('');
  console.log('  听说易 · 英语听说在线模拟练习系统');
  console.log('  ------------------------------------------------');
  console.log(`  地址   : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  考区   : ${CITY_PROFILES[s.examRegion]?.name || CITY_PROFILES[DEFAULT_CITY].name}`);
  console.log(`  模型   : ${cfg.model}`);
  console.log(`  接口   : ${cfg.apiBase}`);
  console.log(`  密钥   : ${cfg.apiKey ? cfg.apiKey.slice(0, 8) + '...' + cfg.apiKey.slice(-4) : '(未配置，请到 /#admin 后台配置)'}`);
  console.log(`  数据   : ${DB.DB_FILE}`);
  console.log(`  管理员 : ${DB.adminPasswordSet() ? '已设置密码' : '未设置（首次进入 /#admin 时设置）'}`);
  console.log('');
});
