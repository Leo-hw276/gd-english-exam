import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EXAM, SCORE_TABLE, PAPER_SYSTEM_PROMPT, buildPaperPromptPartA, buildPaperPromptPartB, pickTopic, SCORE_SYSTEM_PROMPT, buildReadAloudScorePrompt, buildInfoScorePrompt, buildRetellAskScorePrompt, FALLBACK_PAPER, } from './data/exam-spec.mjs';
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
  const rec = Activity.push({ kind, ip, browser, os, inApp, bot, ua: ua.slice(0, 220), ...fields, });
  if (ip && ip !== 'unknown') {
    const doGeo = async () => {
      try { const geo = await ipToLocation(ip); if (geo.str) rec.geo = geo.str; } catch {}
    };
    if (geoPromises.has(ip)) geoPromises.get(ip).then(() => doGeo());
    else { const p = doGeo().finally(() => geoPromises.delete(ip)); geoPromises.set(ip, p); }
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
  constructor(message, status) { super(message); this.status = status || 502; }
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
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens ?? 4096, stream: true, stream_options: { include_usage: true }, };
    if (withJson) body.response_format = { type: 'json_object' };
    const ctl = new AbortController();
    let stalled = false;
    let watchdog = null;
    const overall = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    const bump = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => { stalled = true; ctl.abort(); }, STALL); };
    const cleanup = () => { clearTimeout(overall); if (watchdog) clearTimeout(watchdog); };
    bump();
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal, });
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
            if (j.error) { cleanup(); return { error: JSON.stringify(j.error), status: 502, retryable: true }; }
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
    if (out.error && json && /response_format|json_object|unsupported|invalid.*param|bad_request/i.test(out.error)) out = await run(false);
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

function closeBrackets(s) { /* ... 保留原样，因篇幅省略 ... */ }
function endsInString(s) { /* ... 保留原样 ... */ }
function repairTruncatedJson(tail) { /* ... 保留原样 ... */ }
function tryParseJson(str) { /* ... 保留原样 ... */ }
function extractJson(text) { /* ... 保留原样 ... */ }

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, num(v, lo)));
const round1 = (v) => Math.round(v * 10) / 10;
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const arr = (v) => (Array.isArray(v) ? v : []);

function normalizeQuestion(q, fallbackOptions, fallbackIndex) { /* ... 保留原样 ... */ }
function validatePartA(raw) { /* ... 保留原样 ... */ }
function validatePartB(raw) { /* ... 保留原样 ... */ }
function mergeWithFallback({ partA, partB, topic, notes }) { /* ... 保留原样 ... */ }
function normalizeReadAloud(raw) { /* ... 保留原样 ... */ }
function normalizeItemList(rawList, { startIndex, count, perItem }) { /* ... 保留原样 ... */ }
function normalizeRetell(raw) { /* ... 保留原样 ... */ }
function normalizeAsk(rawList) { /* ... 保留原样 ... */ }
function gradeLabel(total) { /* ... 保留原样 ... */ }
function sendJson(res, status, obj) { /* ... 保留原样 ... */ }
function readBody(req, limit = 12 * 1024 * 1024) { /* ... 保留原样 ... */ }
function readBodyRaw(req, limit = 12 * 1024 * 1024) { /* ... 保留原样 ... */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const HTML_CSP = "default-src 'self'; " + "script-src 'self' https://challenges.cloudflare.com; " + "style-src 'self' 'unsafe-inline'; " + "img-src 'self' data: blob:; " + "media-src 'self' data: blob:; " + "connect-src 'self' https://challenges.cloudflare.com; " + 'frame-src https://challenges.cloudflare.com; ' + "font-src 'self' data:; " + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(res, urlPath) { /* ... 保留原样 ... */ }
function apiKeyFor(req, cfg, session) { /* ... 保留原样 ... */ }
async function handlePaper(req, res, cfg, session, user) { /* ... 保留原样 ... */ }

const wordList = (s) => String(s || '').toLowerCase().match(/[a-z']+/g) || [];
const HOMOPHONE_GROUPS = [ /* ... 保留原样 ... */ ];
function editDistance(a, b) { /* ... 保留原样 ... */ }
function sameWord(a, b) { /* ... 保留原样 ... */ }
function wordCoverage(reference, heard) { /* ... 保留原样 ... */ }
function seqAccuracy(reference, heard) { /* ... 保留原样 ... */ }
function acousticQuality(metrics) { /* ... 保留原样 ... */ }
function bandOf(score, max, bands) { /* ... 保留原样 ... */ }
function localReadAloud(paper, answers) { /* ... 保留原样 ... */ }
function localInfo(paper, answers) { /* ... 保留原样 ... */ }