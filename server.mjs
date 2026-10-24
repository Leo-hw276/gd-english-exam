/**
 * 广东中考英语听说考试在线练习系统 —— 后端服务
 *
 * 职责：
 *  1. 托管前端静态页面
 *  2. 代理 DeepSeek-V4-Flash，用于「自动组卷」与「智能评分」
 *  3. 把 5 个部分的得分合成为满分 30 分的总分
 *
 * 启动： node server.mjs [--port 8777]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
  ipPrefix,
  parseUa,
  rateLimit,
  isBanned,
  banKey,
  createCaptcha,
  verifyCaptcha,
  riskScore,
  makeActivityStore,
} from './data/security.mjs';

import { synthesize as edgeTts, rateStr as ttsRateStr, setCacheDir as setTtsCacheDir, VOICES as TTS_VOICES } from './data/edge-tts.mjs';

import { CITY_PROFILES, DEFAULT_CITY, cityProfile } from './data/exam-spec.mjs';
import * as DB from './data/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- 活动审计日志（登录/注册/朗读/风控事件）---------- */
const Activity = makeActivityStore((events) => {
  try {
    const db0 = DB.data();
    db0.activity = events;
    DB.save();
  } catch {}
});
// 从持久化数据中恢复
try { Activity.load(DB.data().activity); } catch {}

/* ---------- Edge-TTS 缓存目录 ---------- */
try { setTtsCacheDir(path.join(__dirname, 'data', 'tts-cache')); } catch {}

/* ---------- 限流预设 ---------- */
const RL = {
  // 注册：每 IP 每 10 分钟最多 5 次
  register: (ip) => rateLimit(`reg:${ip}`, { windowMs: 10 * 60_000, max: 5 }),
  // 登录：每 IP 每 5 分钟最多 10 次
  login: (ip) => rateLimit(`login:${ip}`, { windowMs: 5 * 60_000, max: 10 }),
  // 验证码请求：每 IP 每分钟最多 20 次
  captcha: (ip) => rateLimit(`cap:${ip}`, { windowMs: 60_000, max: 20 }),
  // 组卷：每用户每分钟 3 次
  paper: (uid) => rateLimit(`paper:${uid}`, { windowMs: 60_000, max: 3 }),
  // 通用 API：每 IP 每分钟 120 次
  api: (ip) => rateLimit(`api:${ip}`, { windowMs: 60_000, max: 120 }),
  // TTS：每 IP 每分钟 40 次
  tts: (ip) => rateLimit(`tts:${ip}`, { windowMs: 60_000, max: 40 }),
};

/* ---------------------------- 配置 ---------------------------- */

/**
 * 运行期配置全部来自「数据库设置」，管理员可在后台随时改：
 *   apiKey / apiBase / model / pricing ...
 * 环境变量在 store.load() 里已做最高优先级覆盖。
 */
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

/* ------------------------ LLM 调用封装 ------------------------ */

class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

/**
 * 调用模型（强制使用流式）
 *
 * 重要：本网关对**非流式**请求有约 30 秒的上游超时，超时即返回 524。
 * 组卷/评分的长输出必然超过 30 秒，因此这里始终使用 SSE 流式请求，
 * 边收边拼，既避免超时，也能更早发现连接异常。
 */
/* ---- 模型调用的时间预算（可用环境变量覆盖）----
 * 网关偶发「连上了但一直不吐字」的情况，若不设停滞看门狗，请求会一直挂着，
 * 既拖垮体验，也让本地降级迟迟不触发。这里三层保护：
 *   1. 停滞看门狗：连续 STALL_MS 没有收到任何数据 → 主动断开
 *   2. 单次总超时：一次调用最长 TIMEOUT_MS
 *   3. 自动重试：可重试错误（超时/5xx/限流）再试 RETRIES 次
 */
const LLM_TIMEOUT_MS = Math.max(15_000, Number(process.env.EXAM_LLM_TIMEOUT_MS || 120_000));
const LLM_STALL_MS = Math.max(8_000, Number(process.env.EXAM_LLM_STALL_MS || 25_000));
const LLM_RETRIES = Math.max(0, Math.min(3, Number(process.env.EXAM_LLM_RETRIES || 1)));

/** 这些状态码值得重试；其余（如 401 令牌错误、400 参数错误）重试也没用 */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callChat({ apiKey, apiBase, model, system, user, temperature, maxTokens, json }) {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;

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
      }, LLM_STALL_MS);
    };
    const cleanup = () => {
      clearTimeout(overall);
      if (watchdog) clearTimeout(watchdog);
    };

    bump(); // 连接/首字节也要受看门狗约束

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
        ? `模型服务 ${LLM_STALL_MS / 1000} 秒无响应（已主动断开）`
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
            // 网关有时把上游错误塞在流里
            if (j.error) {
              cleanup();
              return {
                error: JSON.stringify(j.error),
                status: j.error.code === 'streaming_error' ? 502 : 502,
                retryable: true,
              };
            }
          } catch {
            /* 忽略无法解析的心跳片段 */
          }
        }
      }
    } catch (e) {
      cleanup();
      const msg = stalled
        ? `模型服务输出中断（${LLM_STALL_MS / 1000} 秒无新内容，已主动断开）`
        : `读取模型流式响应中断：${e.message}`;
      return { error: msg, status: 504, retryable: true };
    }
    cleanup();

    if (!content.trim()) {
      // 有内容但解析为空，也可能是被中断；内容本身为空则重试价值不大
      return { error: stalled ? '模型服务无响应' : '模型返回内容为空', status: 502, retryable: stalled };
    }
    return { content, usage };
  };

  /** 一次完整尝试：json 兼容性降级 + 可重试错误的退避重试 */
  const attempt = async () => {
    let out = await run(Boolean(json));
    // 部分网关不支持 response_format，去掉后重试
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

/** 从可能夹带解释文字/Markdown 围栏的回复中提取第一个完整 JSON 对象 */
function extractJson(text) {
  if (!text) throw new LlmError('模型未返回内容', 502);
  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const first = s.indexOf('{');
  if (first < 0) throw new LlmError('模型返回中找不到 JSON', 502);

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < s.length; i++) {
    const ch = s[i];
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
        const candidate = s.slice(first, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // 尝试修复常见的尾逗号
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
          } catch (e) {
            throw new LlmError(`JSON 解析失败：${e.message}`, 502);
          }
        }
      }
    }
  }
  throw new LlmError('模型返回的 JSON 不完整', 502);
}

/* --------------------------- 组卷校验 --------------------------- */

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, num(v, lo)));
const round1 = (v) => Math.round(v * 10) / 10;
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const arr = (v) => (Array.isArray(v) ? v : []);

function normalizeQuestion(q, fallbackOptions, fallbackIndex) {
  const options = arr(q?.options).map((o) => str(o)).filter(Boolean);
  return {
    q: str(q?.q ?? q?.question, 'Question'),
    options: options.length === 3 ? options : fallbackOptions,
    answerIndex: clamp(q?.answerIndex ?? fallbackIndex, 0, 2) | 0,
    evidence: str(q?.evidence, ''),
  };
}

/** 校验并规整组卷第一批：模仿朗读 + 听选信息 */
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
      questions: arr(s?.questions).map((q, qi) => normalizeQuestion(q, ['—', '—', '—'], qi % 3)),
    }))
    .filter((s) => s.script.length && s.questions.length);

  const ciCount = segs.reduce((n, s) => n + s.questions.length, 0);
  if (ciCount !== 6) errors.push(`听选信息题量应为 6，实际 ${ciCount}`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { readAloud: { passage }, chooseInfo: segs.slice(0, 3) } };
}

/** 校验并规整组卷第二批：回答问题 + 信息转述 + 询问信息 */
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

/** 把失败的那一半用内置备用卷补齐，保证考试一定能开始 */
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

/* --------------------------- 评分合成 --------------------------- */

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
  if (Math.abs(sum - out.score) <= 0.6) out.score = sum; // 让维度分与总分自洽
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
    if (verdict === 'correct' && score < perItem * 0.66) score = perItem; // 正确必给满分（除明确扣分说明）
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

/* ---------------------------- HTTP ---------------------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
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
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/** 仅管理员可通过请求头临时覆盖 Key；普通用户一律用后台配置的 Key */
function apiKeyFor(req, cfg, session) {
  if (session?.kind === 'admin') {
    const hdr = req.headers['x-api-key'];
    if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  }
  return cfg.apiKey;
}

/* --------------------------- 路由处理 --------------------------- */

async function handlePaper(req, res, cfg, session, user) {
  const raw = await readBody(req);

  // 开考前先校验额度（真正的扣费在交卷评分时进行）
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

  // 在服务端预先确定话题，保证两次并行组卷围绕同一话题
  const topic = str(opts.topic, '') || pickTopic(seed);
  const difficulty = str(opts.difficulty, '标准');

  /** 单批组卷：带一次重试 */
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

  // 两批并行组卷 —— 输出更短、更快，且任何一批失败都能用备用材料补齐
  const [resA, resB] = await Promise.all([
    generate('A', buildPaperPromptPartA({ topic, difficulty, seed }), validatePartA, 2600),
    generate('B', buildPaperPromptPartB({ topic, difficulty, seed }), validatePartB, 3200),
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

/* ==================================================================
 *  本地降级评分
 *
 *  模型网关偶发 502/504 时，若直接报错，考生既拿不到报告、额度又被扣掉。
 *  因此这里用纯客观规则兜底：逐词比对 + 要点覆盖 + 声学指标，
 *  保证「任何情况下都能交卷拿到分数」，并在报告里明确标注哪几节是本地评分。
 * ================================================================== */

const wordList = (s) => String(s || '').toLowerCase().match(/[a-z']+/g) || [];

/** 参考文本的词汇被覆盖的比例（0–1） */
function wordCoverage(reference, heard) {
  const ref = [...new Set(wordList(reference))].filter((w) => w.length > 1);
  if (!ref.length) return 0;
  const h = new Set(wordList(heard));
  return ref.filter((w) => h.has(w)).length / ref.length;
}

/** 逐词对齐正确率：用最长公共子序列估计朗读准确度 */
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
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return clamp(dp[b.length] / a.length, 0, 1);
}

/** 由声学指标估计「开口质量」0–1 */
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

  const acc = transcript ? seqAccuracy(passage, transcript) : 0;
  const aq = transcript ? acousticQuality(metrics) : 0;
  const ratio = clamp(acc * 0.65 + aq * 0.35, 0, 1);
  const score = round1(clamp(ratio * SCORE_TABLE.readAloud, 0, SCORE_TABLE.readAloud));

  const band = bandOf(score, 6, [
    [5.5, 'A'],
    [4.5, 'B'],
    [3, 'C'],
    [1, 'D'],
    [0.1, 'E'],
    [0, 'F'],
  ]);

  // 找出漏读的词（参考里没被听到的实词）
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
      : '本次未识别到有效朗读内容，请确认麦克风正常并靠近麦克风清晰朗读。',
    dimensions: {
      pronunciation: { score: round1(clamp(acc * 3, 0, 3)), max: 3, comment: '依据逐词比对计算的音素命中率' },
      intonation: { score: round1(intonation), max: 1.5, comment: '依据停顿密度估计的节奏表现' },
      fluency: { score: round1(clamp(aq * 1.5, 0, 1.5)), max: 1.5, comment: '依据语速与停顿次数估计' },
    },
    wordAnalysis: { accuracy: round1(acc * 100) / 100, mispronounced: [], missed },
    suggestions: [
      transcript ? '' : '全程没有识别到语音，先做一次麦克风试音，确认设备正常。',
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
  // 若大纲要点识别不到，退化为「与原文词汇覆盖度」
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

  // 先校验额度，但**先不扣**：只有成功产出报告才扣费
  const preCheck = DB.checkQuota(user);
  if (!preCheck.ok) return sendJson(res, 402, { ok: false, error: preCheck.reason, quota: preCheck });

  const apiKey = apiKeyFor(req, cfg, session);
  const common = { apiKey, apiBase: cfg.apiBase, model: cfg.model };

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
          maxTokens: 2200,
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
          maxTokens: 3200,
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
          maxTokens: 3200,
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

  // AI 评委不可用时改用本地客观规则，保证考生始终拿得到报告、额度不白扣
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

  /* ---- 合成 30 分总分 ---- */
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

  // 报告已成功生成，此刻才真正扣减额度（评分失败不扣费）
  const quota = DB.consumeQuota(user);
  report.quotaAfter = {
    source: quota.source,
    credits: user.credits || 0,
    freeLeft: Math.max(0, (DB.getSettings().pricing.freeTrials || 0) - (user.freeUsed || 0)),
    proActive: Boolean(user.proUntil && user.proUntil > Date.now()),
  };

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
  });
}

/* ==================================================================
 *  认证 / 会员 / 兑换码 / 管理员 接口
 * ================================================================== */

const cookieVal = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
};

/** 按令牌取会话，可限定类型（'user' / 'admin'） */
function sessionByToken(token, wantKind) {
  if (!token) return null;
  const s = DB.getSession(token);
  if (!s) return null;
  if (wantKind && s.kind !== wantKind) return null;
  return s;
}

/**
 * 取当前会话。
 * 用户会话与管理会话使用两个独立 Cookie（jmkt_session / jmkt_admin），互不覆盖，
 * 因此同一个人可以「一边用普通账号练题、一边在后台当管理员」。
 * wantKind 指定优先读取哪一个 Cookie，避免管理员登录后抢走用户会话。
 */
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

function setSessionCookie(res, token, kind = 'user') {
  const name = kind === 'admin' ? 'jmkt_admin' : 'jmkt_session';
  const cookie =
    `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : '');
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

async function jsonBody(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/* ---------------- 用户认证 ---------------- */

async function handleRegister(req, res) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  // 限流
  if (isBanned(ip)) return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
  const rl = RL.register(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: `注册过于频繁，请 ${rl.retryAfterSec} 秒后重试` });

  const b = await jsonBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const name = String(b.name || '').trim();

  // 验证码校验
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < 6) return sendJson(res, 400, { ok: false, error: '密码至少 6 位' });
  if (DB.findUserByEmail(email)) return sendJson(res, 409, { ok: false, error: '该邮箱已注册，请直接登录' });

  // 风控评分
  const recent = Activity.query({ kind: 'register', ip, since: Date.now() - 30 * 60_000 });
  const risk = riskScore({ ip, ua, email, recentSameIp: recent.length });
  if (risk.score >= 70) {
    banKey(ip, 10 * 60_000);
    Activity.push({ kind: 'blocked', action: 'register', ip, ua: parseUa(ua).raw, email, detail: risk.reasons.join('；') });
    return sendJson(res, 403, { ok: false, error: '检测到异常注册行为，请稍后重试或联系管理员' });
  }

  const user = DB.createUser({ email, password, name });
  const token = DB.createSession(user.id, 'user');
  setSessionCookie(res, token);
  const p = DB.getSettings().pricing;

  Activity.push({ kind: 'register', action: 'ok', userId: user.id, email, ip, ...parseUa(ua), riskScore: risk.score });

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

  if (isBanned(ip)) return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
  const rl = RL.login(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: `登录过于频繁，请 ${rl.retryAfterSec} 秒后重试` });

  const b = await jsonBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');

  // 验证码校验
  const cap = verifyCaptcha(b.captchaId, b.captchaCode, ip);
  if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });

  const user = DB.findUserByEmail(email);
  if (!user || !DB.verifyPassword(password, user.passHash)) {
    Activity.push({ kind: 'login', action: 'fail', ip, ...parseUa(ua), email, detail: '密码错误' });
    // 连续失败 5 次 → 临时封 3 分钟
    const fails = Activity.query({ kind: 'login', action: 'fail', ip, since: Date.now() - 3 * 60_000 });
    if (fails.length >= 5) banKey(ip, 3 * 60_000);
    return sendJson(res, 401, { ok: false, error: '邮箱或密码错误' });
  }
  if (user.disabled) return sendJson(res, 403, { ok: false, error: '账号已被停用，请联系管理员' });
  user.lastLoginAt = Date.now();
  DB.save();

  const token = DB.createSession(user.id, 'user');
  setSessionCookie(res, token, 'user');

  Activity.push({ kind: 'login', action: 'ok', userId: user.id, email, ip, ...parseUa(ua) });

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

/* ---------------- 管理员 ---------------- */

async function handleAdminLogin(req, res) {
  const b = await jsonBody(req);
  const account = String(b.account || 'admin').trim();
  const pw = String(b.password || '');
  const s = DB.getSettings();

  if (!s.adminUsername) s.adminUsername = 'admin';

  if (account !== s.adminUsername) return sendJson(res, 401, { ok: false, error: '账号或密码错误' });
  if (!s.adminPasswordHash) return sendJson(res, 401, { ok: false, error: '管理员密码未设置' });
  if (!DB.checkAdminPassword(pw)) return sendJson(res, 401, { ok: false, error: '账号或密码错误' });

  const token = DB.createSession('admin', 'admin');
  setSessionCookie(res, token, 'admin');
  sendJson(res, 200, { ok: true, token, account: s.adminUsername });
}

async function handleAdminOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, {
    ok: true,
    settings: DB.getPublicSettings(),
    stats: DB.stats(),
    users: DB.listUsers(),
    codes: DB.listCodes({ limit: 300 }),
    orders: DB.listOrders(60),
    logs: DB.data().logs.slice(0, 80),
  });
}

async function handleAdminSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await jsonBody(req);
  const cur = DB.getSettings();
  const patch = {};

  // v1 地址 / 密钥 / 模型 全部来自网站后台，保存即生效（数据库是权威来源）
  for (const k of ['apiKey', 'apiBase', 'model', 'siteName', 'examRegion', 'paperTemperature', 'scoreTemperature']) {
    if (b[k] === undefined) continue;
    patch[k] = String(b[k]).trim();
  }
  if (patch.apiBase) {
    patch.apiBase = patch.apiBase.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(patch.apiBase)) {
      return sendJson(res, 400, { ok: false, error: '接口地址需要以 http:// 或 https:// 开头' });
    }
    // 兼容只填域名的情况：自动补 /v1
    if (!/\/v\d+$/.test(patch.apiBase)) {
      patch.apiBase += '/v1';
      console.log('[settings] 接口地址自动补全为', patch.apiBase);
    }
  }
  if (patch.apiKey === '') delete patch.apiKey; // 空字符串 = 不修改
  if (b.pricing && typeof b.pricing === 'object') patch.pricing = b.pricing;
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) return sendJson(res, 400, { ok: false, error: '管理员密码至少 6 位' });
    patch.adminPasswordHash = DB.hashPassword(String(b.newPassword));
  }

  DB.updateSettings(patch);
  DB.log('admin-settings', 'admin', Object.keys(patch).filter((k) => k !== 'apiKey').join(',') || '(无变更)');

  sendJson(res, 200, {
    ok: true,
    settings: DB.getPublicSettings(),
    message: '设置已保存（网站后台为唯一配置入口，立即生效）',
  });
}

/** 拉取上游 /v1/models 列表，供管理员选择 */
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

/**
 * 连通性测试
 * 之前的问题：只测了 chat，而且用的是「已保存」的配置 —— 管理员改了输入框里
 * 的地址/密钥后点测试，测的还是旧的，容易误判。现在：
 *   1. 优先用请求体里传来的地址/密钥/模型（即当前输入框的值），没传才回退到已保存配置
 *   2. 分两步测：先 GET /models（快，验证地址+密钥），再发一次 chat（验证模型可用）
 *   3. 每一步都返回耗时与失败原因，前端可以逐条显示
 */
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

  /* --- 第 1 步：拉模型列表，验证「地址 + 密钥」是否可用 --- */
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

  /* --- 第 2 步：真发一次对话，验证「模型」是否可用 --- */
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

/* ---------------- 图片上传（定价说明配图等） ---------------- */

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

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // 单张图最大 3MB

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
    // 文件名用时间戳 + 随机串，避免中文名与重名问题
    const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    const url = `/uploads/${name}`;
    DB.log('admin-upload', 'admin', `${name} (${(buf.length / 1024).toFixed(0)}KB)`);
    sendJson(res, 200, { ok: true, url, bytes: buf.length, name });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '保存失败：' + e.message });
  }
}

/** 托管已上传的图片 */
function serveUpload(res, urlPath) {
  const name = path.basename(decodeURIComponent(urlPath));
  if (!name || name.includes('..')) return sendJson(res, 400, { ok: false, error: 'Bad name' });
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'Not found' });
  const ext = path.extname(name).slice(1).toLowerCase();
  const type =
    Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(buf);
}


/* ---------------- 用户数据 导出 / 导入 / 清空 ---------------- */

async function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  const b = req.method === 'POST' ? await jsonBody(req).catch(() => ({})) : {};
  const action = String(b.action || '');

  // 导出
  if (action === 'export' || (req.method === 'GET' && new URL(req.url, 'http://x').searchParams.get('export'))) {
    const dump = DB.exportUsers();
    DB.log('admin-export-users', 'admin', `${dump.users.length} 个用户`);
    return sendJson(res, 200, { ok: true, ...dump });
  }

  // 导入
  if (action === 'import') {
    try {
      const mode = b.mode === 'replace' ? 'replace' : 'merge';
      const result = DB.importUsers(b.data, mode);
      return sendJson(res, 200, {
        ok: true,
        ...result,
        message:
          `导入完成：新增 ${result.added}，更新 ${result.updated}` +
          (result.skipped ? `，跳过 ${result.skipped}` : '') +
          (result.removed ? `，清空原有 ${result.removed}` : ''),
        users: DB.listUsers(),
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 一键清空
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

  // 删除单个用户 / 更新单个用户
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

  // 默认：列出用户
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
  /* 旧实现已合并到上面的 handleAdminUsers */
}

/* ---------------- 验证码 ---------------- */

function handleCaptcha(req, res) {
  const ip = clientIp(req);
  const rl = RL.captcha(ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: '验证码请求过于频繁' });
  const cap = createCaptcha(ip);
  sendJson(res, 200, { ok: true, id: cap.id, svg: cap.svg, ttlSec: cap.ttlSec });
}

/* ---------------- Edge-TTS 语音合成 ---------------- */

async function handleTts(req, res) {
  const ip = clientIp(req);
  const rl = RL.tts(ip);
  if (!rl.ok) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '语音合成请求过于频繁' }));
  }
  const b = await jsonBody(req);
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return sendJson(res, 400, { ok: false, error: '文本不能为空' });
  const voice = TTS_VOICES[b.voice] ? b.voice : 'en-US-AriaNeural';
  const rate = ttsRateStr(b.speed || 1);
  try {
    const mp3 = await edgeTts(text, { voice, rate });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': mp3.length,
      'Cache-Control': 'public, max-age=86400',
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

/* ---------------- 管理员活动日志 ---------------- */

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
    // 筛选查询
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
  // GET: 返回最近 200 条 + 统计
  const events = Activity.query({ limit: 200 });
  const stats = Activity.stats({ since: Date.now() - 24 * 3600_000 });
  sendJson(res, 200, { ok: true, events, stats });
}


/* ---------------------------- 启动 ---------------------------- */

const PORT = Number(argValue('--port') || process.env.PORT || process.env.EXAM_PORT || 8777);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-api-key,Authorization',
      'Access-Control-Allow-Credentials': 'true',
    });
    return res.end();
  }

  const route = async () => {
    const cfg = getCfg();
    const ip = clientIp(req);

    // 全局限流（每 IP 每分钟 120 次 API 调用）
    if (p.startsWith('/api/')) {
      if (isBanned(ip)) return sendJson(res, 429, { ok: false, error: '请求过于频繁，已临时限制访问' });
      const rl = RL.api(ip);
      if (!rl.ok) return sendJson(res, 429, { ok: false, error: `请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
    }

    // ---------- 公开 ----------
    if (p === '/api/health') return handleHealth(req, res, cfg);
    if (p === '/api/pricing') return sendJson(res, 200, { ok: true, pricing: DB.getSettings().pricing });
    if (p === '/api/spec') return sendJson(res, 200, { ok: true, exam: EXAM, cities: CITY_PROFILES });
    if (p === '/api/captcha') return handleCaptcha(req, res);

    // ---------- TTS（语音合成，公开但限流）----------
    if (p === '/api/tts' && req.method === 'POST') return handleTts(req, res);
    if (p === '/api/tts/voices') return handleTtsVoices(req, res);

    // ---------- 认证 ----------
    if (p === '/api/auth/register' && req.method === 'POST') return handleRegister(req, res);
    if (p === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res);
    if (p === '/api/auth/me') return handleMe(req, res);
    if (p === '/api/redeem' && req.method === 'POST') return handleRedeem(req, res);

    // ---------- 考试（需登录 + 额度）----------
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

    // ---------- 管理员 ----------
    if (p === '/api/admin/login' && req.method === 'POST') return handleAdminLogin(req, res);
    if (p === '/api/admin/overview') return handleAdminOverview(req, res);
    if (p === '/api/admin/settings' && req.method === 'POST') return handleAdminSettings(req, res);
    if (p === '/api/admin/models' && req.method === 'POST') return handleAdminModels(req, res);
    if (p === '/api/admin/test' && req.method === 'POST') return handleAdminTest(req, res);
    if (p === '/api/admin/upload' && req.method === 'POST') return handleAdminUpload(req, res);
    if (p === '/api/admin/codes') return handleAdminCodes(req, res);
    if (p === '/api/admin/users') return handleAdminUsers(req, res);
    if (p === '/api/admin/activity') return handleAdminActivity(req, res);

    // 已上传的图片（定价说明配图等）
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
  console.log('');
  console.log('  广东中考英语听说考试在线练习系统');
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
