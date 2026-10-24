/**
 * app.js —— 广东省江门市中考英语听说考试（人机对话）在线模拟 · 主控程序
 *
 * 考试流程严格对齐江门考区官方录音时间分配：
 *   一、模仿朗读                    录音播放 2 遍 → 准备 50s → 朗读 50s
 *   二、信息获取 第一节 听选信息      阅题 10s → 录音 2 遍 → 每题作答 8s
 *   二、信息获取 第二节 回答问题      读题 15s → 录音 2 遍 → 每题作答 8s
 *   三、信息转述及询问 第一节 信息转述 读题 15s → 录音 2 遍 → 准备 50s → 转述 60s
 *   三、信息转述及询问 第二节 询问信息 每题 准备 15s → 提问 8s
 */

import { Tts, Recorder, openMic, micTest, startCue, stopCue, audioCtx, listMicrophones, countdownBeeps } from './audio.js';
import { Asr, AsrStatus, isAsrSupported, alignWords } from './speech.js';
import { drawWave, bindWavePlayer } from './wave.js';

/* ==================================================================
 *  基础工具
 * ================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

let overlayEl = null;
function showOverlay(html, wide = false) {
  hideOverlay();
  overlayEl = document.createElement('div');
  overlayEl.className = 'overlay';
  overlayEl.innerHTML = `<div class="box"${
    wide ? ' style="max-width:860px;width:min(860px,90vw);text-align:left"' : ''
  }>${html}</div>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}
function hideOverlay() {
  overlayEl?.remove();
  overlayEl = null;
}
const busy = (title, sub = '') =>
  showOverlay(`<div class="spinner"></div><h3 style="margin-bottom:6px">${esc(title)}</h3>
    <p class="muted" style="margin:0">${esc(sub)}</p>`);

export function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
  // 顶栏高亮当前页
  $$('.topnav a').forEach((a) => a.classList.toggle('active', a.dataset.goto === id));

  // 管理后台是独立入口：隐藏面向考生的导航与登录入口，只保留返回首页
  const adminMode = id === 'screen-admin';
  document.body.classList.toggle('admin-mode', adminMode);

  if (id === 'screen-account') renderAccount();
  if (id === 'screen-pricing') renderPricing();
  if (id === 'screen-auth') refreshAllCaptchas();
}

/* ==================================================================
 *  全局状态
 * ================================================================== */

export const S = {
  cfg: null,
  paper: null,
  city: 'jiangmen',
  cities: {},
  pricing: null,
  user: null,
  isAdmin: false,
  quota: null,
  answers: {
    readAloud: { transcript: '', metrics: null },
    chooseInfo: [],
    answerQuestions: [],
    retell: { transcript: '', metrics: null },
    askQuestions: [],
  },
  micStream: null,
  micDeviceId: null,
  asrStatus: AsrStatus.UNKNOWN,
  asrUsable: isAsrSupported(),
  recording: null,
  startedRecording: false,
  marks: {},
  lastReport: null,
  examAborted: false, // 考生主动结束考试 → 立刻中断所有播报与录音
};

const PART_META = [
  { id: 'readAloud', name: '模仿朗读', keys: ['p1'], nums: [1], max: 6 },
  { id: 'chooseInfo', name: '听选信息', keys: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], nums: [1, 2, 3, 4, 5, 6], max: 9 },
  { id: 'answerQuestions', name: '回答问题', keys: ['a7', 'a8', 'a9', 'a10'], nums: [7, 8, 9, 10], max: 6 },
  { id: 'retell', name: '信息转述', keys: ['r11'], nums: [11], max: 6 },
  { id: 'askQuestions', name: '询问信息', keys: ['k12', 'k13'], nums: [12, 13], max: 3 },
];

function cityCfg() {
  return (
    S.cities[S.city] || {
      name: '江门市',
      readAloud: { playTimes: 2, prepareSec: 50, recordSec: 50 },
      retell: { prepareSec: 50, recordSec: 60 },
    }
  );
}

/* ==================================================================
 *  API 客户端
 * ================================================================== */

async function api(path, body, method = 'POST') {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(path, opt);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务返回异常（${res.status}）：${text.slice(0, 200)}`);
  }
  if (res.status >= 400 || data.ok === false) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ==================================================================
 *  认证与账户
 * ================================================================== */

async function refreshMe() {
  try {
    const d = await api('/api/auth/me', undefined, 'GET');
    S.user = d.user || null;
    S.isAdmin = Boolean(d.admin);
    if (d.quota) S.quota = d.quota;
  } catch {
    S.user = null;
    S.isAdmin = false;
  }
  renderUserChip();
  renderQuotaHint();
  window.dispatchEvent(new CustomEvent('jmkt:auth', { detail: { user: S.user, admin: S.isAdmin } }));
}

function quotaText() {
  if (!S.user) return '未登录';
  if (S.user.proActive) return `月卡 · 剩 ${S.user.proDaysLeft} 天`;
  if (S.user.credits > 0) return `次卡 · 剩 ${S.user.credits} 次`;
  if (S.user.freeLeft > 0) return `免费 · 剩 ${S.user.freeLeft} 次`;
  return '额度已用完';
}

function renderUserChip() {
  const chip = $('#user-chip');
  const openBtn = $('#btn-auth-open');
  if (!chip || !openBtn) return;
  if (S.user) {
    chip.classList.remove('hidden');
    openBtn.classList.add('hidden');
    $('#uc-name').textContent = (S.user.name || S.user.email) + (S.isAdmin ? ' · 管理员' : '');
    const q = $('#uc-quota');
    q.textContent = quotaText();
    q.className = 'uc-quota ' + (S.user.proActive || S.user.credits > 0 || S.user.freeLeft > 0 ? 'ok' : 'bad');
  } else {
    chip.classList.add('hidden');
    openBtn.classList.remove('hidden');
  }
}

function renderQuotaHint() {
  const el = $('#quota-hint');
  if (!el) return;
  if (!S.user) {
    el.innerHTML = `当前未登录。新用户注册即送 <b>${S.pricing?.freeTrials ?? 2}</b> 次免费听说模拟 →
      <a href="#" data-goto="screen-auth">立即注册</a>　|　已有兑换码？<a href="#" data-goto="screen-account">去兑换</a>`;
  } else {
    el.innerHTML = `当前额度：<b>${esc(quotaText())}</b>　|
      <a href="#" data-goto="screen-account">我的账户</a>　|　<a href="#" data-goto="screen-pricing">收费标准</a>`;
  }
}

/* ---------- 验证码 ---------- */

async function loadCaptcha(imgEl, idEl) {
  try {
    const d = await api('/api/captcha', undefined, 'GET');
    if (imgEl) imgEl.innerHTML = d.svg || '';
    if (idEl) idEl.value = d.id || '';
  } catch {
    if (imgEl) imgEl.innerHTML = '<span style="font-size:11px;color:#888">加载失败，点击重试</span>';
  }
}

function refreshAllCaptchas() {
  loadCaptcha($('#li-captcha-img'), $('#li-captcha-id'));
  loadCaptcha($('#rg-captcha-img'), $('#rg-captcha-id'));
}

export async function doLogin() {
  const email = $('#li-email').value.trim();
  const password = $('#li-pass').value;
  const captchaId = $('#li-captcha-id')?.value || '';
  const captchaCode = $('#li-captcha')?.value?.trim() || '';
  if (!email || !password) return toast('请填写邮箱和密码', 'warn');
  if (!captchaCode) return toast('请输入验证码', 'warn');
  try {
    const d = await api('/api/auth/login', { email, password, captchaId, captchaCode });
    S.user = d.user;
    S.isAdmin = Boolean(d.admin);
    await refreshMe();
    toast('登录成功，欢迎回来！', 'ok');
    showScreen('screen-intro');
  } catch (e) {
    toast('登录失败：' + e.message, 'bad', 5000);
    loadCaptcha($('#li-captcha-img'), $('#li-captcha-id'));
    if ($('#li-captcha')) $('#li-captcha').value = '';
  }
}

export async function doRegister() {
  const email = $('#rg-email').value.trim();
  const password = $('#rg-pass').value;
  const name = $('#rg-name').value.trim();
  const captchaId = $('#rg-captcha-id')?.value || '';
  const captchaCode = $('#rg-captcha')?.value?.trim() || '';
  if (!email || !password) return toast('请填写邮箱和密码', 'warn');
  if (password.length < 6) return toast('密码至少 6 位', 'warn');
  if (!captchaCode) return toast('请输入验证码', 'warn');
  try {
    const d = await api('/api/auth/register', { email, password, name, captchaId, captchaCode });
    S.user = d.user;
    await refreshMe();
    toast(d.message || '注册成功！', 'ok', 5000);
    showScreen('screen-intro');
  } catch (e) {
    toast('注册失败：' + e.message, 'bad', 5000);
    loadCaptcha($('#rg-captcha-img'), $('#rg-captcha-id'));
    if ($('#rg-captcha')) $('#rg-captcha').value = '';
  }
}

async function doLogout() {
  await api('/api/auth/logout', {}, 'POST').catch(() => {});
  S.user = null;
  S.isAdmin = false;
  renderUserChip();
  renderQuotaHint();
  window.dispatchEvent(new CustomEvent('jmkt:auth', { detail: { user: null, admin: false } }));
  toast('已退出登录', 'ok');
  showScreen('screen-intro');
}

async function doRedeem() {
  const code = $('#rd-code').value.trim();
  const hint = $('#rd-hint');
  if (!code) return toast('请输入兑换码', 'warn');
  if (!S.user) {
    toast('请先登录后再兑换', 'warn');
    return showScreen('screen-auth');
  }
  try {
    const d = await api('/api/redeem', { code });
    S.user = d.user;
    renderUserChip();
    renderQuotaHint();
    hint.textContent = d.message;
    hint.style.color = 'var(--ok)';
    $('#rd-code').value = '';
    toast(d.message, 'ok', 5000);
    renderAccount();
  } catch (e) {
    hint.textContent = e.message;
    hint.style.color = 'var(--bad)';
    toast('兑换失败：' + e.message, 'bad', 5000);
  }
}

function renderAccount() {
  const body = $('#acc-body');
  if (!body) return;
  if (!S.user) {
    body.innerHTML = `请先 <a href="#" data-goto="screen-auth">登录</a> 或 <a href="#" data-goto="screen-auth" data-tab="register">注册</a>。`;
    $('#acc-orders').textContent = '—';
    return;
  }
  const u = S.user;
  body.innerHTML = `
    <div class="stat-grid" style="margin-top:6px">
      <div class="stat"><div class="k">账号</div><div class="v" style="font-size:15px">${esc(u.email)}</div></div>
      <div class="stat"><div class="k">免费次数剩余</div><div class="v">${u.freeLeft}</div></div>
      <div class="stat"><div class="k">次卡剩余</div><div class="v">${u.credits} 次</div></div>
      <div class="stat"><div class="k">月卡</div><div class="v">${u.proActive ? '剩 ' + u.proDaysLeft + ' 天' : '未开通'}</div></div>
    </div>
    <p class="muted" style="margin-top:14px">
      累计完成模拟：<b>${u.usedCount}</b> 次　·　注册时间：${new Date(u.createdAt).toLocaleString('zh-CN')}
      ${u.proActive ? `　·　会员到期：${new Date(u.proUntil).toLocaleDateString('zh-CN')}` : ''}
    </p>
    <div class="callout info" style="margin-top:12px">
      <b>当前可练习状态：</b>${esc(quotaText())}。
      ${u.proActive || u.credits > 0 || u.freeLeft > 0 ? '可以随时开始考试。' : '额度已用完，请使用兑换码开通次卡或月卡。'}
    </div>`;
  const el = $('#acc-orders');
  if (el) el.innerHTML = '<p class="muted">兑换成功后额度会立即到账，可在上方「次卡剩余 / 月卡」处查看。</p>';
  renderHistory();
}

/* ------------------------------------------------------------------ *
 *  练习记录（复盘）
 * ------------------------------------------------------------------ */

async function renderHistory() {
  const box = $('#acc-history');
  if (!box) return;
  if (!S.user) {
    box.innerHTML = '<p class="muted">登录后可查看历史练习记录并复盘。</p>';
    return;
  }
  box.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const d = await api('/api/records', undefined, 'GET');
    const list = d.records || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted">还没有练习记录，完成一次模拟考试后会自动保存在这里。</p>';
      return;
    }
    box.innerHTML = list
      .map(
        (r) => `<div class="hist-item">
          <span class="hist-date">${new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          <span class="hist-topic">${esc(r.topic || '模拟考试')}</span>
          <span class="hist-score">${r.total}<small> / ${r.maxTotal}</small></span>
          <button class="btn sm ghost" data-hist="${r.id}">查看报告</button>
        </div>`
      )
      .join('');
    $$('[data-hist]', box).forEach((btn) => {
      btn.onclick = () => openHistoryRecord(btn.dataset.hist);
    });
  } catch (e) {
    box.innerHTML = `<p class="muted">记录加载失败：${esc(e.message)}</p>`;
  }
}

async function openHistoryRecord(id) {
  busy('正在载入历史报告…', '');
  try {
    const d = await api(`/api/records/${id}`, undefined, 'GET');
    const rec = d.record;
    if (!rec) throw new Error('记录不存在');
    S.lastReport = rec.report;
    hideOverlay();
    renderReport(rec.report, { history: true, topic: rec.topic, at: rec.at });
  } catch (e) {
    hideOverlay();
    toast('载入失败：' + e.message, 'bad', 5000);
  }
}

/* ==================================================================
 *  收费标准页
 * ================================================================== */

function renderPricing() {
  const p = S.pricing;
  const grid = $('#price-grid');
  if (!grid || !p) return;
  const sym = p.currencySymbol || '¥';
  const free = p.freeTrials ?? 2;
  grid.innerHTML = `
    <div class="price-card free">
      <div class="pc-tag">新手福利</div>
      <div class="pc-name">免费体验</div>
      <div class="pc-price"><span class="cur">${sym}</span><span class="num">0</span></div>
      <div class="pc-desc">${esc(p.freeTrialNote || `新用户注册即送 ${free} 次完整模拟。`)}</div>
      <ul class="pc-list">
        <li>完整三大题 · 五小节 · 14 小题</li>
        <li>30 分制 AI 评分报告</li>
        <li>逐题发音诊断与波形回看</li>
        <li>共 ${free} 次</li>
      </ul>
      ${
        S.user
          ? `<button class="btn lg" data-goto="screen-account">进入我的账户</button>`
          : `<button class="btn lg" data-goto="screen-auth" data-tab="register">注册领取</button>`
      }
    </div>
    <div class="price-card">
      <div class="pc-tag">按次付费</div>
      <div class="pc-name">${esc(p.perUse?.name || '次卡')}</div>
      <div class="pc-price"><span class="cur">${sym}</span><span class="num">${p.perUse?.price ?? 2.9}</span><span class="unit">/${esc(p.perUse?.unit || '次')}</span></div>
      <div class="pc-desc">${esc(p.perUse?.desc || '')}</div>
      <ul class="pc-list">
        <li>1 次 = 1 套完整模拟 + 评分报告</li>
        <li>不限期，用完为止</li>
        <li>支持兑换码开通</li>
      </ul>
      <button class="btn ghost lg" data-goto="screen-account">用兑换码开通</button>
    </div>
    <div class="price-card hot">
      <div class="pc-tag best">最受欢迎</div>
      <div class="pc-name">${esc(p.monthly?.name || '月卡')}</div>
      <div class="pc-price"><span class="cur">${sym}</span><span class="num">${p.monthly?.price ?? 29.9}</span><span class="unit">/${p.monthly?.days ?? 30} 天</span></div>
      <div class="pc-desc">${esc(p.monthly?.desc || '')}</div>
      <ul class="pc-list">
        <li>有效期内<b>不限次</b>练习</li>
        <li>适合考前冲刺</li>
        <li>支持兑换码开通</li>
      </ul>
      <button class="btn lg" data-goto="screen-account">用兑换码开通</button>
    </div>`;
  const src = $('#price-source');
  if (src) {
    const img = p.sourceImage
      ? `<img class="price-source-img" src="${esc(p.sourceImage)}" alt="定价说明配图" loading="lazy" />`
      : '';
    src.innerHTML = `<b>定价来源：</b>${esc(p.sourceNote || '')}
      <br><b>当前标准：</b>免费 ${free} 次 · 次卡 ${sym}${p.perUse?.price ?? 2.9}/次 · 月卡 ${sym}${
      p.monthly?.price ?? 29.9
    }/${p.monthly?.days ?? 30} 天。${img}`;
  }
  const lf = $('#li-free');
  if (lf) lf.textContent = String(free);
  const rg = $('#reg-gift');
  if (rg) rg.innerHTML = `<b>新用户福利：</b>${esc(p.freeTrialNote || `注册即送 ${free} 次免费听说模拟`)}`;
}

/* ==================================================================
 *  环境自检
 * ================================================================== */

async function runEnvCheck() {
  const list = $('#env-list');
  const items = [];

  try {
    const health = await api('/api/health', undefined, 'GET');
    S.cfg = health;
    if (health.cities) S.cities = health.cities;
    if (health.defaultCity) S.city = health.defaultCity;
    if (health.pricing) S.pricing = health.pricing;
    items.push({ k: '评分服务端', v: '已连接', ok: true });
    $('#pill-api').textContent = `接口正常 · ${health.model}`;
    $('#pill-api').className = 'pill ok';
    $('#pill-model').textContent = health.model;
    if (health.siteName) document.title = health.siteName;
  } catch (e) {
    items.push({ k: '评分服务端', v: '未连接：' + e.message, ok: false });
    $('#pill-api').textContent = '接口异常';
    $('#pill-api').className = 'pill bad';
  }

  fillCitySelect();
  renderPricing();

  const hasMedia = Boolean(navigator.mediaDevices?.getUserMedia);
  items.push({ k: '麦克风录音', v: hasMedia ? '支持' : '不支持（需 Chrome/Edge + HTTPS 或 localhost）', ok: hasMedia });
  items.push({
    k: '音频录制 (MediaRecorder)',
    v: typeof window.MediaRecorder !== 'undefined' ? '支持' : '不支持（将只做声学分析，无回放）',
    ok: typeof window.MediaRecorder !== 'undefined',
  });

  // 语音合成：自动降级链（浏览器原生 → 服务端 edge-tts）
  items.push({
    k: '语音合成（播放考试录音）',
    v: Tts.statusText(),
    ok: Tts.mode() !== 'none',
  });
  const pillTts = $('#pill-tts');
  if (pillTts) {
    if (Tts.mode() === 'native') {
      pillTts.textContent = 'TTS：本地语音';
      pillTts.className = 'pill ok';
    } else if (Tts.mode() === 'server') {
      pillTts.textContent = 'TTS：服务端音频';
      pillTts.className = 'pill ok';
    } else {
      pillTts.textContent = 'TTS：不可用';
      pillTts.className = 'pill bad';
    }
  }

  let asrNote;
  if (!isAsrSupported()) asrNote = '不支持 —— 将启用「纯声学评分」模式';
  else if (S.asrStatus === AsrStatus.NETWORK_FAIL) asrNote = '识别服务不可达 —— 将启用「纯声学评分」模式';
  else if (S.asrStatus === AsrStatus.OK) asrNote = '已实测可用';
  else asrNote = '浏览器支持（Chrome/Edge 需可访问识别服务，首次作答后确认）';
  items.push({ k: '语音识别（转写作答内容）', v: asrNote, ok: isAsrSupported() && S.asrStatus !== AsrStatus.NETWORK_FAIL });

  list.innerHTML = items
    .map(
      (i) => `<div class="box"><div class="k">${esc(i.k)}</div>
      <div class="v" style="color:${i.ok ? 'var(--ok)' : 'var(--warn)'}">${esc(i.v)}</div></div>`
    )
    .join('');

  const badge = $('#pill-asr');
  if (!isAsrSupported()) {
    badge.textContent = '语音识别：不可用';
    badge.className = 'pill warn';
  } else if (S.asrStatus === AsrStatus.NETWORK_FAIL) {
    badge.textContent = '语音识别：不可达';
    badge.className = 'pill bad';
  } else if (S.asrStatus === AsrStatus.OK) {
    badge.textContent = '语音识别：正常';
    badge.className = 'pill ok';
  } else {
    badge.textContent = '语音识别：待验证';
    badge.className = 'pill';
  }
}

function fillCitySelect() {
  const sel = $('#inp-city');
  if (!sel) return;
  const entries = Object.entries(S.cities);
  if (!entries.length) return;
  sel.innerHTML = entries
    .map(([k, v]) => `<option value="${esc(k)}"${k === S.city ? ' selected' : ''}>${esc(v.name)}</option>`)
    .join('');
  sel.value = S.city;
  const hint = $('#city-hint');
  if (hint) hint.textContent = S.cities[S.city]?.note || '';
}

/* ==================================================================
 *  试卷结构表（江门考区）
 * ================================================================== */

const SPEC_ROWS = [
  ['一、模仿朗读', '', '屏幕呈现一段 60–85 词的英语短文。录音播放 2 遍后，考生有 50 秒准备时间，在 50 秒内模仿朗读短文，须包含全部内容。', 1, 6],
  ['二、信息获取', '第一节 听选信息', '屏幕呈现英文问题和 3 个备选答案，共播放三段对话或独白，每段各播放两遍。各段播放前 10 秒阅题；每段播放后有两个问题，在 8 秒内选择正确的信息口头回答。', 6, 9],
  ['二、信息获取', '第二节 回答问题', '屏幕呈现 4 个英语问题，播放一段对话或独白 2 遍，录音播放前有 15 秒阅读 4 个问题。每题在 8 秒内口头回答。', 4, 6],
  ['三、信息转述及询问', '第一节 信息转述', '屏幕呈现信息要点提示（思维导图形式），录音播放 2 遍。15 秒读题、50 秒准备，在 60 秒内口头转述短文，须包含全部要点。', 1, 6],
  ['三、信息转述及询问', '第二节 询问信息', '屏幕呈现 2 个中文问题，每题有 15 秒准备时间，在 8 秒内用英语翻译问句（口头提问）。', 2, 3],
];

function renderSpecTable() {
  $('#spec-body').innerHTML = SPEC_ROWS.map(
    (r) => `<tr>
      <td><b>${esc(r[0])}</b></td>
      <td>${esc(r[1])}</td>
      <td style="color:var(--ink-2);font-size:13.5px">${esc(r[2])}</td>
      <td class="num">${r[3]}</td>
      <td class="num">${r[4]}</td>
    </tr>`
  ).join('');
}

/* ==================================================================
 *  舞台 & 进度
 * ================================================================== */

function renderNav() {
  $('#nav-parts').innerHTML = PART_META.map((p) => {
    const dots = p.keys
      .map((k, i) => {
        const st = S.marks[k] || 'pending';
        return `<span class="dot ${st}" data-key="${k}" title="第 ${p.nums[i]} 题">${p.nums[i]}</span>`;
      })
      .join('');
    return `<div class="nav-part">
      <div class="t"><span>${esc(p.name)}</span><span>${p.max}分</span></div>
      <div class="dots">${dots}</div>
    </div>`;
  }).join('');
  $('#nav-count').textContent = `${Object.values(S.marks).filter((v) => v === 'done').length} / 14`;
}

function markKey(key, status) {
  S.marks[key] = status;
  renderNav();
}

function toAnswer(ans) {
  return {
    transcript: ans?.transcript || '',
    metrics: ans?.metrics || null,
    envelope: ans?.envelope || null,
    audioUrl: ans?.audioUrl || null,
  };
}

function renderStage({ idx, title, body, phase = '' }) {
  $('#stage-idx').textContent = idx;
  $('#stage-ttl').textContent = title;
  $('#stage-body').innerHTML = body;
  setPhase(phase);
}

function setPhase(text, kind = '') {
  const el = $('#stage-phase');
  el.textContent = text;
  el.className = 'pill' + (kind ? ' ' + kind : '');
}

function renderRecPanel(mountId, { timerText = '--', note = '', stoppable = false } = {}) {
  const el = $(mountId);
  if (!el) return;
  el.innerHTML = `
    <div class="recpanel" id="recpanel">
      <div class="rec-badge" id="recbadge"><span class="lamp"></span><span id="reclabel">准备中</span></div>
      <div class="timer" id="rectimer">${esc(timerText)}</div>
      <div class="meter">
        <div class="bar"><i id="recbar"></i></div>
        <div class="lbl"><span id="recnote">${esc(note)}</span><span id="recwpm"></span></div>
      </div>
      <div class="wave" id="recwave">${'<i></i>'.repeat(24)}</div>
    </div>
    ${
      stoppable
        ? `<div class="row end" style="margin-top:10px">
             <button class="btn danger sm hidden" id="btn-stoprec">■ 我答完了 · 结束录音</button>
           </div>`
        : ''
    }`;
}

function updateMeter(level) {
  const bar = $('#recbar');
  const wave = $('#recwave');
  if (bar) bar.style.width = Math.round(level * 100) + '%';
  if (wave) {
    wave.children[0]?.remove();
    const el = document.createElement('i');
    el.style.height = Math.max(6, level * 100) + '%';
    el.style.background = level > 0.72 ? 'var(--warn)' : 'var(--brand-2)';
    wave.appendChild(el);
  }
}

function setTimer(sec, cls = '') {
  const el = $('#rectimer');
  if (!el) return;
  el.textContent = sec >= 0 ? String(sec) : '--';
  el.className = 'timer ' + cls;
}

function setRecState(on, label) {
  const badge = $('#recbadge');
  if (!badge) return;
  badge.classList.toggle('on', on);
  if (label) $('#reclabel').textContent = label;
  $('#recpanel')?.classList.toggle('live', on);
}

/* ==================================================================
 *  倒计时
 * ================================================================== */

function countdown(seconds, { onTick, cancelRef } = {}) {
  return new Promise((resolve) => {
    const total = seconds * 1000;
    const t0 = performance.now();
    const step = () => {
      if (cancelRef?.cancelled || S.examAborted) return resolve('cancelled');
      const left = Math.max(0, total - (performance.now() - t0));
      onTick?.(Math.ceil(left / 1000), 1 - left / total);
      if (left <= 0) return resolve('done');
      requestAnimationFrame(step);
    };
    step();
  });
}

/* ==================================================================
 *  录音作答（核心）
 * ================================================================== */

async function recordAnswer({ seconds, key, label = '录音中', note = '', canFinishEarly = true }) {
  const cancelRef = { cancelled: false };

  // 考生已提前交卷：不再开录音，直接返回空作答
  if (S.examAborted) {
    markKey(key, 'done');
    return { transcript: '', metrics: null, envelope: null, audioUrl: null, endedEarly: true };
  }

  renderRecPanel('#rec-mount', { timerText: seconds, note, stoppable: canFinishEarly });
  setPhase(label, 'brand');

  // 关键：确保上一段考试录音彻底停下，绝不与录音作答重叠
  await Tts.stopNow();

  // ① 3.5 秒「滴滴」提示音 + 倒计时进度条
  await countdownBeeps({
    totalMs: 3500,
    onTick: (p) => {
      const box = $('#playstate');
      if (box) {
        box.innerHTML =
          `<b>请准备录音…</b><div class="progress-bar countdown" style="margin-top:8px">` +
          `<div class="fill" style="width:${Math.round(p * 100)}%"></div></div>`;
      }
    },
  });

  // ② 语音播报「开始录音」，播报结束才开启麦克风采集
  await Tts.speak(SAY.startRecord, { rate: Tts.getSpeed() });

  // 播报期间考生可能已交卷，此时不能再开录音
  if (S.examAborted) {
    markKey(key, 'done');
    return { transcript: '', metrics: null, envelope: null, audioUrl: null, endedEarly: true };
  }

  await startCue();

  if (!S.micStream) throw new Error('麦克风未就绪');

  const rec = new Recorder(S.micStream);
  rec.onTick = updateMeter;

  const asr = new Asr();
  asr.onUpdate = (final, interim) => {
    const live = $('#reclive');
    if (!live) return;
    const t = (final + ' ' + interim).trim();
    live.textContent = t || '（正在识别…）';
    live.classList.toggle('empty', !t);
  };
  asr.onStatus = (st, detail) => {
    S.asrStatus = st;
    if (st === AsrStatus.DENIED || st === AsrStatus.NETWORK_FAIL) {
      if (detail) toast(detail + '，已切换为纯声学评分', 'warn', 5000);
    }
  };

  rec.start();
  if (isAsrSupported()) asr.start();
  setRecState(true, '正在录音');
  S.recording = { rec, asr };

  if (canFinishEarly) {
    const btn = $('#btn-stoprec');
    if (btn) {
      btn.classList.remove('hidden');
      btn.onclick = () => {
        cancelRef.cancelled = true;
        btn.disabled = true;
        btn.textContent = '正在结束…';
      };
    }
  }

  const result = await countdown(seconds, {
    cancelRef,
    onTick: (sec) => setTimer(sec, sec <= 5 ? 'crit' : sec <= 10 ? 'warn' : ''),
  });

  setRecState(false, result === 'cancelled' ? '已提前结束' : '录音结束');
  await stopCue();
  // ④ 录音结束语音播报
  await Tts.speak(SAY.endRecord, { rate: Tts.getSpeed() });

  const asrText = asr.stop();
  const { blob, blobUrl, metrics, envelope } = await rec.stop();
  S.recording = null;

  markKey(key, 'done');

  // 原生识别没拿到文字（不支持/被拒/网络不可达）→ 上传录音走服务端转写兜底
  let transcript = asrText || '';
  if (!transcript && blob && blob.size > 2000) {
    transcript = await transcribeOnServer(blob);
  }

  return {
    transcript: transcript || '',
    metrics,
    envelope,
    audioUrl: blobUrl,
    endedEarly: result === 'cancelled',
  };
}

/** 服务端转写兜底：失败时静默返回空串，交卷仍可走纯声学评分 */
async function transcribeOnServer(blob) {
  try {
    const r = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (!r.ok) return '';
    const j = await r.json().catch(() => null);
    return (j && j.ok && j.text) || '';
  } catch {
    return '';
  }
}

const recMountHtml = () => `
  <div id="playstate" class="muted" style="margin-top:14px"></div>
  <div id="rec-mount" style="margin-top:8px"></div>
  <div style="margin-top:10px">
    <div class="muted" style="font-size:12px;margin-bottom:4px">实时识别（用于评分，仅供参考）</div>
    <div class="transcript-box empty" id="reclive">等待开始录音…</div>
  </div>`;

/* ==================================================================
 *  听力播放
 * ================================================================== */

async function playListening(text, times, { label = '正在播放录音', asLines = null } = {}) {
  setPhase(label, 'brand');
  const box = $('#playstate');
  for (let t = 1; t <= times; t++) {
    if (S.examAborted) return;
    if (box) box.innerHTML = `<b>第 ${t} 遍 / 共 ${times} 遍</b> 正在播放录音……请仔细听。`;
    setPhase(`${label}（${t}/${times}）`, 'brand');
    if (asLines && asLines.length) {
      for (const line of asLines) {
        if (S.examAborted) return;
        await Tts.speak(line.en, { rate: 0.92, pitch: line.spk === 'W' ? 1.08 : 0.92 });
      }
    } else {
      await Tts.speak(text, { rate: 0.92 });
    }
    if (S.examAborted) return;
    if (t < times) await sleep(700);
  }
  await Tts.stopNow();
  if (box) box.innerHTML = `<b>录音播放完毕。</b>`;
}

/* ==================================================================
 *  题干播报（真实考场也是语音播报题目要求）
 * ================================================================== */

/**
 * 朗读大题题干与作答要求（英文），走 TTS 降级链并受全局倍速控制。
 * @param {string} text 英文播报内容
 */
async function announceRequirement(text, { label = '正在播报题目要求' } = {}) {
  if (!text || S.examAborted) return;
  setPhase(label, 'brand');
  const box = $('#playstate');
  if (box) box.innerHTML = `<b>正在播报题目要求…</b>`;
  await Tts.speak(text, { rate: Tts.getSpeed() });
}

/** 供各小节使用的播报文案（考试指令用中文，只有题目内容本身是英文） */
const SAY = {
  p1: (playTimes, prepareSec, recordSec) =>
    `第一部分，模仿朗读。请听短文${playTimes}遍。听完后有${prepareSec}秒钟准备时间，` +
    `然后请在${recordSec}秒钟内模仿朗读。听到开始录音的提示音后开始朗读。`,
  p2: (n) =>
    `第二部分，听选信息。请听第${n}题的录音，录音播放两遍。` +
    `请根据所听到的问题和括号内的提示，在8秒钟内选择正确的信息并口头回答。`,
  p3: () =>
    `第二部分第二节，回答问题。请听录音，录音播放两遍。` +
    `请根据所听内容回答第七到第十题，简短回答即可。现在有15秒钟阅读这四个问题。`,
  p4: (prepareSec, recordSec) =>
    `第三部分第一节，信息转述。请听一段独白，录音播放两遍。` +
    `请根据所听内容和要点提示，在${prepareSec}秒钟准备后，用${recordSec}秒钟说一段话，要包含全部要点。`,
  p5: () =>
    `第三部分第二节，询问信息。请根据提示用英语提出一个问题，` +
    `你有15秒钟的准备时间和8秒钟的提问时间。`,
  startRecord: '开始录音。',
  endRecord: '录音结束。',
};

/* ==================================================================
 *  第一部分：模仿朗读
 * ================================================================== */

async function runReadAloud() {
  const cfg = cityCfg().readAloud;
  const p = S.paper.readAloud.passage;
  const words = p.trim().split(/\s+/);

  renderStage({
    idx: '第 1 题',
    title: '一、模仿朗读',
    phase: '准备中',
    body: `
    <div class="instruction">
      <b>一、模仿朗读（共 6 分）</b><br>
      听以下短文 <b>${cfg.playTimes} 遍</b>，然后你有 <b>${cfg.prepareSec} 秒钟</b>的时间准备，接着模仿朗读。
      当听到「开始录音」的信号后，请在 <b>${cfg.recordSec} 秒钟</b>内朗读短文；答完后可点击「我答完了 · 结束录音」提前结束。
    </div>
    <div class="passage" id="passage-body">${words.map((w, i) => `<span class="w" data-w="${i}">${esc(w)}</span>`).join(' ')}</div>
    <div class="row" style="margin-top:14px">
      <button class="btn ghost sm" id="btn-replay-p1">重听范文录音</button>
    </div>
    ${recMountHtml()}`,
  });

  markKey('p1', 'active');
  $('#nav-current').textContent = '模仿朗读';
  $('#nav-max').textContent = '6 分';

  // 每大题开始前自动播报题干与作答要求
  await announceRequirement(SAY.p1(cfg.playTimes, cfg.prepareSec, cfg.recordSec));

  await playListening(p, cfg.playTimes, { label: '正在播放范文录音' });

  $('#btn-replay-p1').onclick = async () => {
    if (S.recording || S.startedRecording) return toast('录音已开始，无法重听', 'warn');
    await playListening(p, 1, { label: '重听范文' });
  };

  setPhase('准备中', 'warn');
  renderRecPanel('#rec-mount', { timerText: cfg.prepareSec, note: '准备时间：先默读一遍，标出难读的词' });
  setRecState(false, '准备中');
  $('#playstate').innerHTML = `<b>范文播放完毕。</b>现在你有 ${cfg.prepareSec} 秒准备时间。`;
  await countdown(cfg.prepareSec, { onTick: (s) => setTimer(s, s <= 5 ? 'warn' : '') });

  S.startedRecording = true;
  const ans = await recordAnswer({
    seconds: cfg.recordSec,
    key: 'p1',
    label: '录音中',
    note: '请清晰、连贯地朗读全文',
  });
  S.startedRecording = false;
  S.answers.readAloud = toAnswer(ans);

  highlightReadAloud(p, ans.transcript, ans.envelope);
  setPhase('本题结束', 'ok');
  // 让考生看清自己的朗读波形再进入下一节（完整波形回看在成绩报告里）
  if (ans.envelope) toast('朗读波形已生成，可在成绩报告中回看全部题目', 'ok', 3500);
  await sleep(2600);
}

function highlightReadAloud(passage, transcript, envelope) {
  const body = $('#passage-body');
  if (body && transcript) {
    const { hit } = alignWords(passage, transcript);
    $$('.w', body).forEach((el, i) => {
      el.classList.remove('hit', 'miss');
      el.classList.add(hit[i] ? 'hit' : 'miss');
    });
  }
  const panel = $('#recpanel');
  if (panel && envelope) {
    panel.insertAdjacentHTML(
      'afterend',
      `<div class="wavestrip">
         <div class="wavelabel"><span>你的朗读波形</span><span>蓝色＝有声音，灰色＝停顿</span></div>
         <div class="wavewrap"><canvas class="wavecanvas wave-final" data-height="72"></canvas></div>
       </div>`
    );
    const c = $('.wave-final');
    if (c) {
      c.__levels = envelope;
      c.__h = 72;
      requestAnimationFrame(() => drawWave(c, envelope, { progress: 1, height: 72 }));
    }
  }
}

/* ==================================================================
 *  第二部分第一节：听选信息
 * ================================================================== */

async function runChooseInfo() {
  const segs = S.paper.chooseInfo;
  S.answers.chooseInfo = segs.map((s) => s.questions.map(() => ({})));

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];

    renderStage({
      idx: `第 ${si * 2 + 1}–${si * 2 + 2} 题`,
      title: '二、信息获取 · 第一节 听选信息',
      phase: '阅题中',
      body: `
        <div class="instruction">
          <b>二、信息获取 第一节 听选信息（共 6 小题，每小题 1.5 分，满分 9 分）</b><br>
          听下面第 ${si + 1} 段录音，播放两遍。请根据所听到的问题和括号内的提示，
          在 <b>8 秒钟</b>内选择正确的信息<b>口头回答</b>。现在你有 <b>10 秒钟</b>的阅题时间。
        </div>
        <div class="qlist">${seg.questions
          .map((q, qi) => {
            const n = si * 2 + qi + 1;
            return `<div class="qitem" id="q-${n}">
              <div class="qh"><span class="qn">${n}</span><span class="qt">${esc(q.q)}</span></div>
              <div class="opts">${q.options.map((o) => `<span class="opt">${esc(o)}</span>`).join('')}</div>
            </div>`;
          })
          .join('')}</div>
        ${recMountHtml()}`,
    });
    $('#nav-current').textContent = `听选信息（第 ${si + 1} 段）`;
    $('#nav-max').textContent = '9 分';

    if (si === 0) await announceRequirement(SAY.p2(si * 2 + 1));

    setPhase('阅题中', 'warn');
    renderRecPanel('#rec-mount', { timerText: 10, note: '阅题时间：看清两个备选答案' });
    setRecState(false, '阅题中');
    await countdown(10, { onTick: (s) => setTimer(s, s <= 3 ? 'warn' : '') });

    await playListening('', 2, { label: '正在播放录音', asLines: seg.script });

    for (let qi = 0; qi < seg.questions.length; qi++) {
      const n = si * 2 + qi + 1;
      markKey(`c${n}`, 'active');
      $$('.qitem').forEach((e) => e.classList.remove('active'));
      $(`#q-${n}`)?.classList.add('active');
      const q = seg.questions[qi];
      $('#playstate').innerHTML = `<b>第 ${n} 题：</b>${esc(q.q)}`;

      const ans = await recordAnswer({
        seconds: 8,
        key: `c${n}`,
        label: `第 ${n} 题 录音中`,
        note: `请口头回答：${q.q}`,
      });
      S.answers.chooseInfo[si][qi] = toAnswer(ans);
      $(`#q-${n}`)?.classList.add('done');
      await sleep(250);
    }
  }
}

/* ==================================================================
 *  第二部分第二节：回答问题
 * ================================================================== */

async function runAnswerQuestions() {
  const { script, questions } = S.paper.answerQuestions;
  S.answers.answerQuestions = questions.map(() => ({}));

  renderStage({
    idx: '第 7–10 题',
    title: '二、信息获取 · 第二节 回答问题',
    phase: '读题中',
    body: `
      <div class="instruction">
        <b>二、信息获取 第二节 回答问题（共 4 小题，每小题 1.5 分，满分 6 分）</b><br>
        听下面一段录音，播放两遍。请根据所听内容回答第 7–10 四个问题，简短回答即可。
        现在你有 <b>15 秒钟</b>的时间阅读这四个问题。
      </div>
      <div class="qlist">${questions
        .map(
          (q, i) => `<div class="qitem" id="q-${7 + i}">
            <div class="qh"><span class="qn">${7 + i}</span><span class="qt">${esc(q.q)}</span></div>
          </div>`
        )
        .join('')}</div>
      ${recMountHtml()}`,
  });
  $('#nav-current').textContent = '回答问题';
  $('#nav-max').textContent = '6 分';

  await announceRequirement(SAY.p3());

  setPhase('读题中', 'warn');
  renderRecPanel('#rec-mount', { timerText: 15, note: '读题时间：抓住每个疑问词' });
  setRecState(false, '读题中');
  await countdown(15, { onTick: (s) => setTimer(s, s <= 3 ? 'warn' : '') });

  await playListening(script, 2, { label: '正在播放录音' });

  for (let i = 0; i < questions.length; i++) {
    const n = 7 + i;
    markKey(`a${n}`, 'active');
    $$('.qitem').forEach((e) => e.classList.remove('active'));
    $(`#q-${n}`)?.classList.add('active');
    $('#playstate').innerHTML = `<b>第 ${n} 题：</b>${esc(questions[i].q)}`;

    const ans = await recordAnswer({
      seconds: 8,
      key: `a${n}`,
      label: `第 ${n} 题 录音中`,
      note: `请口头回答：${questions[i].q}`,
    });
    S.answers.answerQuestions[i] = toAnswer(ans);
    $(`#q-${n}`)?.classList.add('done');
    await sleep(250);
  }
}

/* ==================================================================
 *  第三部分第一节：信息转述
 * ================================================================== */

async function runRetell() {
  const cfg = cityCfg().retell;
  const { script, outline, starter } = S.paper.retell;

  renderStage({
    idx: '第 11 题',
    title: '三、信息转述及询问 · 第一节 信息转述',
    phase: '读题中',
    body: `
      <div class="instruction">
        <b>三、信息转述及询问 第一节 信息转述（共 1 小题，满分 6 分）</b><br>
        你将听到一段独白，录音播放两遍。请根据所听到的内容和下面的要点提示，
        在 <b>${cfg.recordSec} 秒钟</b>内说一段话，<b>包含全部要点</b>。
        现在你有 <b>15 秒钟</b>的时间阅读要点提示。
        ${starter ? `<br><b>你的转述可以这样开始：</b>「${esc(starter)} …」` : ''}
      </div>
      <h3 style="margin-top:16px">思维导图</h3>
      <div class="mindmap">
        <div class="mm-root">${esc(S.paper.topic || '话题')}</div>
        <div class="mm-branches">
          ${outline
            .map((o, i) => {
              const raw = String(o);
              const m = raw.split(/[:：]/);
              const q = (m[0] || '').trim();
              const a = (m.slice(1).join('：') || '').trim();
              return `<div class="mm-node">
                <div class="mm-idx">${i + 1}</div>
                <div class="mm-q">${esc(q)}</div>
                ${a ? `<div class="mm-a">${esc(a)}</div>` : ''}
              </div>`;
            })
            .join('')}
        </div>
      </div>
      ${recMountHtml()}`,
  });
  $('#nav-current').textContent = '信息转述';
  $('#nav-max').textContent = '6 分';

  await announceRequirement(SAY.p4(cfg.prepareSec, cfg.recordSec));

  setPhase('读题中', 'warn');
  renderRecPanel('#rec-mount', { timerText: 15, note: '读题时间：把 4 个要点串成一条线' });
  setRecState(false, '读题中');
  await countdown(15, { onTick: (s) => setTimer(s, s <= 3 ? 'warn' : '') });

  await playListening(script, 2, { label: '正在播放录音' });

  setPhase('准备中', 'warn');
  renderRecPanel('#rec-mount', { timerText: cfg.prepareSec, note: '准备时间：在心里按要点顺序过一遍' });
  setRecState(false, '准备中');
  $('#playstate').innerHTML = `<b>录音播放完毕。</b>现在你有 ${cfg.prepareSec} 秒钟准备时间。`;
  await countdown(cfg.prepareSec, { onTick: (s) => setTimer(s, s <= 5 ? 'warn' : '') });

  markKey('r11', 'active');
  const ans = await recordAnswer({
    seconds: cfg.recordSec,
    key: 'r11',
    label: '录音中',
    note: '请连续说一段话，覆盖 5 个要点',
  });
  S.answers.retell = toAnswer(ans);
  setPhase('本题结束', 'ok');
  await sleep(700);
}

/* ==================================================================
 *  第三部分第二节：询问信息
 * ================================================================== */

async function runAskQuestions() {
  const asks = S.paper.askQuestions;
  S.answers.askQuestions = asks.map(() => ({}));

  for (let i = 0; i < asks.length; i++) {
    const n = 12 + i;
    renderStage({
      idx: `第 ${n} 题`,
      title: '三、信息转述及询问 · 第二节 询问信息',
      phase: '准备中',
      body: `
        <div class="instruction">
          <b>三、信息转述及询问 第二节 询问信息（共 2 小题，每小题 1.5 分，满分 3 分）</b><br>
          请根据以下提示<b>用英语提出一个问题</b>。你有 <b>15 秒钟</b>的准备时间和 <b>8 秒钟</b>的提问时间。
          评分要素：内容完整性 0.75 分 + 语言准确性 0.75 分。
        </div>
        <div class="muted" style="margin-bottom:8px">请把下面这句话翻译成英语问句并说出来：</div>
        <div class="cnq">${esc(asks[i].cn)}</div>
        ${recMountHtml()}`,
    });
    $('#nav-current').textContent = `询问信息（第 ${i + 1} 题）`;
    $('#nav-max').textContent = '3 分';
    markKey(`k${n}`, 'active');

    if (i === 0) await announceRequirement(SAY.p5());

    setPhase('准备中', 'warn');
    renderRecPanel('#rec-mount', { timerText: 15, note: '注意疑问词和语序' });
    setRecState(false, '准备中');
    await countdown(15, { onTick: (s) => setTimer(s, s <= 3 ? 'warn' : '') });

    const ans = await recordAnswer({
      seconds: 8,
      key: `k${n}`,
      label: `第 ${n} 题 录音中`,
      note: '请用英语提问',
    });
    S.answers.askQuestions[i] = toAnswer(ans);
    await sleep(250);
  }
}

/* ==================================================================
 *  完整流程
 * ================================================================== */

async function runFullExam() {
  S.marks = {};
  PART_META.forEach((p) => p.keys.forEach((k) => (S.marks[k] = 'pending')));
  S.answers = {
    readAloud: { transcript: '', metrics: null },
    chooseInfo: [],
    answerQuestions: [],
    retell: { transcript: '', metrics: null },
    askQuestions: [],
  };
  S.startedRecording = false;
  S.examAborted = false;
  renderNav();
  showScreen('screen-exam');

  try {
    if (!S.micStream) S.micStream = await openMic(S.micDeviceId);
  } catch (e) {
    toast('无法获取麦克风：' + e.message, 'bad', 6000);
    showScreen('screen-intro');
    return;
  }

  audioCtx();

  try {
    await runReadAloud();
    if (S.examAborted) return;
    await runChooseInfo();
    if (S.examAborted) return;
    await runAnswerQuestions();
    if (S.examAborted) return;
    await runRetell();
    if (S.examAborted) return;
    await runAskQuestions();
    if (S.examAborted) return;
  } catch (e) {
    console.error(e);
    if (!S.examAborted) toast('考试过程出错：' + e.message, 'bad', 6000);
  }

  await doScore();
}

/* ==================================================================
 *  评分
 * ================================================================== */

function collectPayload() {
  const strip = (a) => ({ transcript: a?.transcript || '', metrics: a?.metrics || null });
  return {
    paper: {
      topic: S.paper.topic,
      readAloud: S.paper.readAloud,
      chooseInfo: S.paper.chooseInfo,
      answerQuestions: S.paper.answerQuestions,
      retell: S.paper.retell,
      askQuestions: S.paper.askQuestions,
    },
    answers: {
      readAloud: strip(S.answers.readAloud),
      chooseInfo: (S.answers.chooseInfo || []).map((seg) => (seg || []).map(strip)),
      answerQuestions: (S.answers.answerQuestions || []).map(strip),
      retell: strip(S.answers.retell),
      askQuestions: (S.answers.askQuestions || []).map(strip),
    },
  };
}

async function doScore() {
  // 评分期间不允许任何播报或录音残留
  S.examAborted = true;
  await Tts.stopNow();
  if (S.recording) {
    try {
      S.recording.asr?.stop();
    } catch {}
    await S.recording.rec.stop().catch(() => {});
    S.recording = null;
  }
  setRecState(false, '已结束');
  busy('AI 正在按官方评分标准评卷…', '逐题比对语音内容 · 结合声学指标定档 · 合成 30 分总分');
  try {
    const report = await api('/api/score', collectPayload());
    S.lastReport = report;
    hideOverlay();
    renderReport(report);
    showScreen('screen-report');
    await refreshMe();
  } catch (e) {
    hideOverlay();
    if (e.status === 402) {
      toast('额度已用完：' + e.message, 'warn', 6000);
      showScreen('screen-pricing');
    } else {
      toast('评分失败：' + e.message, 'bad', 6000);
    }
    await refreshMe();
  }
}

/* ==================================================================
 *  成绩报告
 * ================================================================== */

function scoreColor(ratio) {
  if (ratio >= 0.85) return 'var(--ok)';
  if (ratio >= 0.65) return 'var(--brand-2)';
  if (ratio >= 0.45) return 'var(--warn)';
  return 'var(--bad)';
}

function renderReport(r) {
  $('#rp-total').textContent = Number(r.total).toFixed(1).replace(/\.0$/, '');
  const CIRC = 2 * Math.PI * 86;
  const ring = $('#ring-fill');
  ring.style.strokeDasharray = String(CIRC);
  ring.style.stroke = scoreColor(r.total / 30);
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = String(CIRC * (1 - r.total / 30));
  });
  const g = $('#rp-grade');
  g.textContent = r.grade?.label || '';
  g.style.background = (r.grade?.color || '#3538cd') + '1a';
  g.style.color = r.grade?.color || '#3538cd';

  const names = {
    readAloud: ['一、模仿朗读', '6'],
    chooseInfo: ['二、信息获取① 听选信息', '9'],
    answerQuestions: ['二、信息获取② 回答问题', '6'],
    retell: ['三、信息转述', '6'],
    askQuestions: ['三、询问信息', '3'],
  };
  $('#rp-breakdown').innerHTML = Object.entries(names)
    .map(([k, [nm, max]]) => {
      const sc = r.breakdown?.[k] ?? 0;
      const pct = Math.max(0, Math.min(1, sc / Number(max)));
      return `<div class="brk-row">
        <span class="nm">${esc(nm)}</span>
        <span class="track"><i data-pct="${pct}" style="background:${scoreColor(pct)}"></i></span>
        <span class="sc" style="color:${scoreColor(pct)}">${round1(sc)} <span>/ ${max}</span></span>
      </div>`;
    })
    .join('');
  setTimeout(() => {
    $$('#rp-breakdown .track > i').forEach((el) => (el.style.width = Number(el.dataset.pct) * 100 + '%'));
  }, 60);

  const acc = r.detail?.readAloud?.wordAnalysis?.accuracy;
  $('#rp-meta').textContent =
    `评分模型：${r.model || 'DeepSeek'} · 考区：${cityCfg().name} · 语音识别：${
      S.asrUsable ? '已启用' : '不可用（纯声学评分）'
    }` + (typeof acc === 'number' && acc > 0 ? ` · 朗读逐词正确率：${Math.round(acc * 100)}%` : '');

  if (r.warnings?.length) {
    $('#rp-warn-card').style.display = '';
    $('#rp-warn').innerHTML = '<b>评分提示</b><br>' + r.warnings.map(esc).join('<br>');
  } else {
    $('#rp-warn-card').style.display = 'none';
  }

  $('#rp-tips').innerHTML = (r.suggestions?.length ? r.suggestions : ['本次没有返回具体建议。'])
    .map((t) => `<li>${esc(t)}</li>`)
    .join('');

  const d = r.detail || {};
  $('#rp-detail').innerHTML = [
    renderWaveOverview(),
    renderReadAloudDetail(d.readAloud),
    renderItemsDetail('二、信息获取 第一节 · 听选信息（每小题 1.5 分）', d.chooseInfo),
    renderItemsDetail('二、信息获取 第二节 · 回答问题（每小题 1.5 分）', d.answerQuestions),
    renderRetellDetail(d.retell),
    renderAskDetail(d.askQuestions),
  ].join('');

  mountAllWaves();
}

/* ---------- 录音波形回看 ---------- */

function allAnswerEnvelopes() {
  const out = [];
  const grab = (a) => a?.envelope && out.push(a.envelope);
  grab(S.answers.readAloud);
  (S.answers.chooseInfo || []).forEach((seg) => (seg || []).forEach(grab));
  (S.answers.answerQuestions || []).forEach(grab);
  grab(S.answers.retell);
  (S.answers.askQuestions || []).forEach(grab);
  return out;
}

function renderWaveOverview() {
  const rows = [];
  const push = (label, a) => {
    if (!a?.envelope) return;
    const m = a.metrics || {};
    rows.push({
      label,
      note: `${((m.durationMs || 0) / 1000).toFixed(1)}s · 发声 ${Math.round((m.voicedRatio || 0) * 100)}% · 停顿 ${
        m.pauseCount || 0
      } 次`,
      audioUrl: a.audioUrl,
    });
  };

  push('第 1 题 · 模仿朗读', S.answers.readAloud);
  (S.answers.chooseInfo || []).forEach((seg, si) =>
    (seg || []).forEach((a, qi) => push(`第 ${si * 2 + qi + 1} 题 · 听选信息`, a))
  );
  (S.answers.answerQuestions || []).forEach((a, i) => push(`第 ${7 + i} 题 · 回答问题`, a));
  push('第 11 题 · 信息转述', S.answers.retell);
  (S.answers.askQuestions || []).forEach((a, i) => push(`第 ${12 + i} 题 · 询问信息`, a));

  if (!rows.length) return '';

  return `<div class="card">
    <h2>录音波形回看</h2>
    <p class="muted">波形直观反映你的作答状态：<b>蓝色柱＝有效人声</b>，<b>灰色＝静音或停顿</b>。
      大片平坦说明没开口；中间的空档就是卡壳的位置。点击波形可跳转播放，也可以直接播放自己的录音。</p>
    <div class="timeline-legend" style="margin-bottom:12px">
      <span><i style="background:#3538cd"></i>有声音</span>
      <span><i style="background:#e4e7ec"></i>静音／停顿</span>
    </div>
    <div class="wave-stack">
      ${rows
        .map(
          (r, i) => `<div class="wave-card">
            <div class="wh"><span>${esc(r.label)}</span><span class="meta">${esc(r.note)}</span></div>
            <div class="wavewrap"><canvas class="wavecanvas wv" data-idx="${i}" data-height="64"></canvas></div>
            ${
              r.audioUrl
                ? `<audio class="wv-audio" data-idx="${i}" controls preload="metadata" src="${r.audioUrl}"></audio>`
                : ''
            }
          </div>`
        )
        .join('')}
    </div>
  </div>`;
}

function mountAllWaves() {
  const envs = allAnswerEnvelopes();
  $$('.wavecanvas.wv').forEach((c) => {
    const levels = envs[Number(c.dataset.idx)];
    if (!levels) return;
    c.__h = 64;
    c.__levels = levels;
    drawWave(c, levels, { progress: 1, height: 64 });
    const audio = $(`.wv-audio[data-idx="${c.dataset.idx}"]`);
    if (audio) bindWavePlayer(c, audio);
  });
}

/* ---------- 明细 ---------- */

function verdictTag(v) {
  const map = {
    correct: ['ok', '正确'],
    partial: ['warn', '部分正确'],
    wrong: ['bad', '错误'],
    blank: ['bad', '未作答'],
  };
  const [cls, label] = map[v] || ['', v || '—'];
  return `<span class="tag ${cls}">${esc(label)}</span>`;
}

function renderReadAloudDetail(a) {
  if (!a) return '';
  const dims = a.dimensions || {};
  const dimHtml = ['pronunciation', 'intonation', 'fluency']
    .map((k) => {
      const d = dims[k];
      if (!d) return '';
      const nm = { pronunciation: '语音（音素准确度）', intonation: '语调与节奏', fluency: '流利度' }[k];
      return `<div class="dim">
        <div class="h"><span>${nm}</span><span class="s">${round1(d.score)} / ${d.max}</span></div>
        <div class="c">${esc(d.comment || '')}</div>
      </div>`;
    })
    .join('');

  const wa = a.wordAnalysis || {};
  const chips = [
    ...(wa.mispronounced || []).map(
      (w) => `<span class="wordchip" title="${esc(w.tip || '')}">${esc(w.word)}${w.heardAs ? ` → ${esc(w.heardAs)}` : ''}</span>`
    ),
    ...(wa.missed || []).map((w) => `<span class="wordchip miss" title="漏读">${esc(w)}</span>`),
  ].join(' ');

  return `<div class="card">
    <h2>一、模仿朗读 <span class="pill brand">${esc(a.band || '-')} 档</span>
      <span class="pill ok" style="margin-left:6px">${round1(a.score)} / 6 分</span></h2>
    <p>${esc(a.overall || '')}</p>
    ${dimHtml}
    ${
      chips
        ? `<h3 style="margin-top:16px">发音诊断（红色＝读错，黄色＝漏读）</h3><div>${chips}</div>
           ${
             (wa.mispronounced || []).length
               ? `<ul class="tips">${wa.mispronounced
                   .map(
                     (w) =>
                       `<li><b>${esc(w.word)}</b>${
                         w.heardAs ? `（系统听到的是「${esc(w.heardAs)}」）` : ''
                       }：${esc(w.tip || '')}</li>`
                   )
                   .join('')}</ul>`
               : ''
           }`
        : ''
    }
    ${
      a.suggestions?.length
        ? `<h3 style="margin-top:14px">改进建议</h3><ul class="tips">${a.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
        : ''
    }
  </div>`;
}

function renderItemsDetail(title, list) {
  if (!list?.length) return '';
  const total = list.reduce((s, x) => s + (x.score || 0), 0);
  return `<div class="card">
    <h2>${esc(title)} <span class="pill ok" style="margin-left:6px">${round1(total)} / ${list.length * 1.5} 分</span></h2>
    <div class="qlist">
      ${list
        .map(
          (it) => `<div class="qitem">
          <div class="qh">
            <span class="qn">${it.index}</span>
            <span class="qt" style="flex:1">${verdictTag(it.verdict)} <b style="font-family:inherit">${round1(it.score)} 分</b></span>
          </div>
          <div style="margin-left:32px;margin-top:8px;font-size:14px">
            ${it.heard ? `<div><span class="muted">你回答：</span>${esc(it.heard)}</div>` : '<div class="muted">（未识别到作答）</div>'}
            ${it.expected ? `<div><span class="muted">参考答案：</span><b>${esc(it.expected)}</b></div>` : ''}
            ${it.missingPoints?.length ? `<div><span class="muted">漏掉要点：</span>${it.missingPoints.map(esc).join('；')}</div>` : ''}
            ${it.comment ? `<div style="margin-top:6px;color:var(--ink-2)">${esc(it.comment)}</div>` : ''}
          </div>
        </div>`
        )
        .join('')}
    </div>
  </div>`;
}

function renderRetellDetail(t) {
  if (!t) return '';
  const mk = (nm, d) =>
    d
      ? `<div class="dim">
          <div class="h"><span>${nm}</span><span class="s">${round1(d.score)} / ${d.max}</span></div>
          ${d.coveredPoints?.length ? `<div class="c"><span class="tag ok">已覆盖</span>${d.coveredPoints.map(esc).join('；')}</div>` : ''}
          ${
            d.missingPoints?.length
              ? `<div class="c" style="margin-top:6px"><span class="tag bad">缺失要点</span>${d.missingPoints.map(esc).join('；')}</div>`
              : ''
          }
          <div class="c">${esc(d.comment || '')}</div>
        </div>`
      : '';

  return `<div class="card">
    <h2>三、信息转述 <span class="pill brand">${esc(t.band || '-')} 档</span>
      <span class="pill ok" style="margin-left:6px">${round1(t.score)} / 6 分</span></h2>
    <p>${esc(t.overall || '')}</p>
    ${mk('内容（要点覆盖）', t.content)}
    ${mk('语言准确性', t.accuracy)}
    ${mk('流畅性', t.fluency)}
    ${
      t.grammarErrors?.length
        ? `<h3 style="margin-top:16px">语法纠错</h3>
           <table class="spec"><thead><tr><th>你的表达</th><th>正确说法</th><th>说明</th></tr></thead><tbody>
           ${t.grammarErrors
             .map((g) => `<tr><td>${esc(g.error)}</td><td><b>${esc(g.correction)}</b></td><td>${esc(g.explain)}</td></tr>`)
             .join('')}
           </tbody></table>`
        : ''
    }
    ${
      t.suggestions?.length
        ? `<h3 style="margin-top:14px">改进建议</h3><ul class="tips">${t.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
        : ''
    }
  </div>`;
}

function renderAskDetail(list) {
  if (!list?.length) return '';
  const total = list.reduce((s, x) => s + (x.score || 0), 0);
  return `<div class="card">
    <h2>三、询问信息 <span class="pill ok" style="margin-left:6px">${round1(total)} / 3 分</span></h2>
    <div class="qlist">
      ${list
        .map((it, i) => {
          const cn = S.paper?.askQuestions?.[i]?.cn || '';
          return `<div class="qitem">
          <div class="qh"><span class="qn">${it.index}</span>
            <span class="qt" style="flex:1">${esc(cn)} <b style="font-family:inherit">${round1(it.score)} 分</b></span></div>
          <div style="margin-left:32px;margin-top:8px;font-size:14px">
            <div><span class="muted">你提的问题：</span>${esc(it.heard || '（未识别到作答）')}</div>
            <div><span class="muted">参考问句：</span><b>${esc(it.reference || S.paper?.askQuestions?.[i]?.reference || '')}</b></div>
            <div style="margin-top:6px">
              <span class="tag">内容 ${round1(it.contentScore)}/0.75</span>
              <span class="tag">语言 ${round1(it.languageScore)}/0.75</span>
            </div>
            ${it.comment ? `<div style="margin-top:6px;color:var(--ink-2)">${esc(it.comment)}</div>` : ''}
          </div>
        </div>`;
        })
        .join('')}
    </div>
  </div>`;
}

/* ==================================================================
 *  作答原文 + 波形回看
 * ================================================================== */

function showAnswerReview() {
  const blocks = [];
  const add = (label, a) => {
    const m = a?.metrics;
    const idx = blocks.length;
    blocks.push(`<div class="wave-card">
      <div class="wh"><span>${esc(label)}</span>
        <span class="meta">${
          m
            ? `${((m.durationMs || 0) / 1000).toFixed(1)}s · 发声 ${Math.round((m.voicedRatio || 0) * 100)}% · 停顿 ${
                m.pauseCount || 0
              } 次`
            : ''
        }</span></div>
      <div class="transcript-box ${a?.transcript ? '' : 'empty'}">${esc(
        a?.transcript || '（未识别到语音内容——可能是未作答，或语音识别服务不可用）'
      )}</div>
      ${
        a?.envelope
          ? `<div class="wavewrap" style="margin-top:8px"><canvas class="wavecanvas rv" data-idx="${idx}" data-height="52"></canvas></div>`
          : ''
      }
      ${a?.audioUrl ? `<audio class="rv-audio" data-idx="${idx}" controls preload="metadata" src="${a.audioUrl}"></audio>` : ''}
    </div>`);
  };

  add('第 1 题 · 模仿朗读', S.answers.readAloud);
  (S.answers.chooseInfo || []).forEach((seg, si) => (seg || []).forEach((a, qi) => add(`第 ${si * 2 + qi + 1} 题 · 听选信息`, a)));
  (S.answers.answerQuestions || []).forEach((a, i) => add(`第 ${7 + i} 题 · 回答问题`, a));
  add('第 11 题 · 信息转述', S.answers.retell);
  (S.answers.askQuestions || []).forEach((a, i) => add(`第 ${12 + i} 题 · 询问信息`, a));

  showOverlay(
    `<div class="row between" style="margin-bottom:12px">
      <h3 style="margin:0">我的作答原文与录音波形</h3>
      <button class="btn ghost sm" id="close-review">关闭</button>
    </div>
    <div style="max-height:66vh;overflow:auto;padding-right:4px">${blocks.join('')}</div>`,
    true
  );
  $('#close-review').onclick = hideOverlay;

  const envs = allAnswerEnvelopes();
  $$('.wavecanvas.rv').forEach((c) => {
    const levels = envs[Number(c.dataset.idx)];
    if (!levels) return;
    c.__h = 52;
    c.__levels = levels;
    drawWave(c, levels, { progress: 1, height: 52 });
    const audio = $(`.rv-audio[data-idx="${c.dataset.idx}"]`);
    if (audio) bindWavePlayer(c, audio);
  });
}

/* ==================================================================
 *  启动考试
 * ================================================================== */

async function startExam({ offline = false } = {}) {
  if (!S.user) {
    toast('请先登录 / 注册，新用户送免费次数', 'warn', 4500);
    showScreen('screen-auth');
    return;
  }
  const topic = $('#inp-topic').value.trim();
  const difficulty = $('#inp-diff').value;
  S.city = $('#inp-city')?.value || S.city;

  showScreen('screen-exam');
  renderStage({ idx: '—', title: '正在组卷', body: '', phase: '生成中' });

  // 百分比进度条覆层
  const progressOverlay = showOverlay(
    `<div class="spinner"></div>
     <h3 style="margin-bottom:8px">${esc(offline ? '正在载入内置示例卷…' : 'DeepSeek 正在按官方题型自动命题…')}</h3>
     <p class="muted" style="margin:0 0 12px">三大题 · 五小节 · 14 小题 · 满分 30 分</p>
     <div class="progress-bar"><div class="fill" id="paper-progress-fill"></div></div>
     <div class="progress-text" id="paper-progress-text">准备中…</div>`);

  // 模拟进度（实际请求是单次 API，用定时器平滑推进到 90%，收到响应后跳到 100%）
  let pct = 0;
  const fill = () => document.getElementById('paper-progress-fill');
  const txt = () => document.getElementById('paper-progress-text');
  const setProgress = (p, label) => {
    pct = p;
    const f = fill(); if (f) f.style.width = `${Math.round(p)}%`;
    const t = txt(); if (t) t.textContent = label || `${Math.round(p)}%`;
  };
  const stages = [
    [8, '正在连接 AI 模型…'],
    [18, '正在分析题型要求…'],
    [32, '正在生成模仿朗读材料…'],
    [46, '正在生成听选信息题…'],
    [58, '正在生成回答问题…'],
    [70, '正在生成信息转述…'],
    [82, '正在生成询问信息…'],
    [90, '正在校验试卷结构…'],
  ];
  let si = 0;
  const ticker = setInterval(() => {
    if (si < stages.length) {
      setProgress(stages[si][0], stages[si][1]);
      si++;
    } else if (pct < 92) {
      setProgress(pct + 0.3, '正在等待 AI 响应…');
    }
  }, offline ? 200 : 2800);

  try {
    const data = await api('/api/paper', { topic, difficulty, offline });
    clearInterval(ticker);
    setProgress(100, '组卷完成');
    await new Promise((r) => setTimeout(r, 400));
    hideOverlay();
    if (!data.paper) throw new Error('未取得试卷');
    S.paper = data.paper;
    if (data.warning) toast(data.warning, 'warn', 7000);
    toast(`组卷完成：话题「${S.paper.topic}」`, 'ok');
    await runFullExam();
  } catch (e) {
    clearInterval(ticker);
    hideOverlay();
    if (e.status === 401) {
      toast('请先登录后再开始考试', 'warn', 4500);
      showScreen('screen-auth');
      return;
    }
    if (e.status === 402) {
      toast('额度已用完，请使用兑换码开通次卡或月卡', 'warn', 6000);
      showScreen('screen-pricing');
      return;
    }
    toast('组卷失败：' + e.message, 'bad', 6000);
    showScreen('screen-intro');
  }
}

/* ==================================================================
 *  麦克风试音（带实时波形）
 * ================================================================== */

async function runMicTest() {
  const hint = $('#mic-hint');
  const mount = $('#mictest-mount');
  const btn = $('#btn-mictest');
  if (S.recording) return toast('考试录音进行中，请稍后再试音', 'warn');

  btn.disabled = true;
  hint.textContent = '';
  await Tts.stopNow();

  const SAMPLE =
    'Hello, my name is Li Hua. I am a Grade Nine student in Guangdong. I like reading and playing basketball.';

  mount.innerHTML = `
    <div class="mictest-panel live" id="mt-panel">
      <div class="hd">
        <div class="rec-badge on"><span class="lamp"></span><span id="mt-label">试音中 · 请用正常音量朗读下面这句话</span></div>
        <div class="timer" id="mt-timer" style="font-size:26px">5</div>
      </div>
      <div class="passage" style="font-size:16.5px;padding:12px 16px;line-height:1.85">${esc(SAMPLE)}</div>
      <div class="meter" style="margin-top:12px">
        <div class="bar"><i id="mt-bar"></i></div>
        <div class="lbl"><span>实时音量</span><span id="mt-note">波形应该有明显起伏</span></div>
      </div>
      <div class="wavewrap" style="margin-top:10px">
        <canvas id="mt-canvas" class="wavecanvas" data-height="86"></canvas>
      </div>
      <div class="timeline-legend">
        <span><i style="background:#6172f3"></i>有效人声</span>
        <span><i style="background:#e4e7ec"></i>静音／停顿</span>
      </div>
    </div>`;

  const canvas = $('#mt-canvas');
  canvas.__h = 86;
  const live = [];
  const t0 = performance.now();

  try {
    const res = await micTest(5000, (lvl) => {
      live.push(lvl);
      const bar = $('#mt-bar');
      if (bar) bar.style.width = Math.round(lvl * 100) + '%';
      const t = $('#mt-timer');
      if (t) t.textContent = String(Math.max(0, Math.ceil(5 - (performance.now() - t0) / 1000)));
      if (live.length % 2 === 0) drawWave(canvas, live, { height: 86 });
    });

    const m = res.metrics || {};
    const ok = (m.meanRms || 0) > 0.006 && (m.voicedRatio || 0) > 0.08;
    $('#mt-panel')?.classList.remove('live');
    const lbl = $('#mt-label');
    if (lbl) lbl.textContent = ok ? '试音完成 · 麦克风工作正常' : '试音完成 · 没有检测到足够的人声';
    const note = $('#mt-note');
    if (note)
      note.textContent = `发声占比 ${Math.round((m.voicedRatio || 0) * 100)}% · 平均音量 ${(m.meanRms || 0).toFixed(
        4
      )} · 停顿 ${m.pauseCount || 0} 次`;

    canvas.__levels = res.envelope || live;
    drawWave(canvas, canvas.__levels, { progress: 1, height: 86 });

    if (res.blobUrl) {
      canvas
        .closest('.wavewrap')
        .insertAdjacentHTML(
          'afterend',
          `<audio id="mt-audio" controls preload="metadata" src="${res.blobUrl}" style="width:100%;height:34px;margin-top:8px"></audio>`
        );
      bindWavePlayer(canvas, $('#mt-audio'));
    }

    hint.textContent = ok
      ? '麦克风正常，可以开始考试了。'
      : '音量偏低或几乎没说话，请检查麦克风是否被静音、是否选对了输入设备，然后重新试音。';
    toast(ok ? '麦克风试音通过' : '未检测到足够人声，请检查麦克风', ok ? 'ok' : 'warn', 5000);
  } catch (e) {
    $('#mt-panel')?.classList.remove('live');
    hint.textContent = '试音失败：' + e.message;
    toast('麦克风不可用：' + e.message, 'bad', 5000);
  } finally {
    btn.disabled = false;
  }
}

/* ==================================================================
 *  事件绑定 & 初始化
 * ================================================================== */

function bind() {
  renderSpecTable();

  $('#btn-start').onclick = () => startExam({ offline: false });
  $('#btn-offline').onclick = () => startExam({ offline: true });
  $('#btn-check').onclick = () => runEnvCheck();
  $('#btn-mictest').onclick = runMicTest;
  $('#btn-auth-open').onclick = () => showScreen('screen-auth');
  $('#btn-login').onclick = doLogin;
  $('#btn-register').onclick = doRegister;
  $('#btn-logout').onclick = doLogout;
  $('#btn-redeem').onclick = doRedeem;

  // 验证码：点击图片刷新 + 切换 tab 时刷新
  $('#li-captcha-img')?.addEventListener('click', () => loadCaptcha($('#li-captcha-img'), $('#li-captcha-id')));
  $('#rg-captcha-img')?.addEventListener('click', () => loadCaptcha($('#rg-captcha-img'), $('#rg-captcha-id')));
  $('#li-captcha')?.addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('#brand-home').onclick = (e) => {
    e.preventDefault();
    showScreen('screen-intro');
  };

  $('#li-pass')?.addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('#rg-pass')?.addEventListener('keydown', (e) => e.key === 'Enter' && doRegister());
  $('#rd-code')?.addEventListener('keydown', (e) => e.key === 'Enter' && doRedeem());

  // 全局播报倍速：原生语音用 rate，服务端音频用 playbackRate，两条通路都生效
  const speedSel = $('#inp-speed');
  if (speedSel) {
    const saved = Number(localStorage.getItem('jmkt-speed') || 1);
    const init = [0.75, 1, 1.25, 1.5].includes(saved) ? saved : 1;
    speedSel.value = String(init);
    Tts.setSpeed(init);
    const applySpeed = (v) => {
      Tts.setSpeed(v);
      localStorage.setItem('jmkt-speed', String(v));
      // 已存在的回放音频同步调速
      $$('audio').forEach((a) => {
        try { a.playbackRate = v; } catch {}
      });
    };
    speedSel.addEventListener('change', () => applySpeed(Number(speedSel.value) || 1));
  }

  $('#auth-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('#auth-tabs .tab').forEach((t) => t.classList.toggle('active', t === btn));
    $('#pane-login').style.display = btn.dataset.tab === 'login' ? '' : 'none';
    $('#pane-register').style.display = btn.dataset.tab === 'register' ? '' : 'none';
  });

  // 站内所有 data-goto 跳转
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.goto;

    // 已登录用户点击「登录/注册」入口：不再跳登录页，明确提示已登录
    if (target === 'screen-auth' && S.user) {
      toast(`您已登录（${S.user.email}）`, 'ok', 3000);
      showScreen('screen-account');
      return;
    }

    if (target === 'screen-auth') {
      showScreen('screen-auth');
      if (a.dataset.tab) $(`#auth-tabs .tab[data-tab="${a.dataset.tab}"]`)?.click();
      return;
    }
    // 离开后台时清掉 #admin，避免下次刷新又进后台
    if (target !== 'screen-admin' && location.hash === '#admin') {
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch {}
    }
    showScreen(target);
  });

  $('#inp-city')?.addEventListener('change', (e) => {
    S.city = e.target.value;
    const hint = $('#city-hint');
    if (hint) hint.textContent = S.cities[S.city]?.note || '';
  });

  $('#btn-quit').onclick = async () => {
    if (!confirm('确定要结束考试并立即评分吗？未作答的题目将按 0 分计算。')) return;
    // 1) 先立中止标记：后续所有 await 点都会立刻退出，不再继续播报/录音
    S.examAborted = true;
    // 2) 停掉正在播放的录音（原生语音 + 服务端音频）
    await Tts.stopNow();
    // 3) 停掉正在进行的录音
    if (S.recording) {
      try {
        S.recording.asr?.stop();
      } catch {}
      await S.recording.rec.stop().catch(() => {});
      S.recording = null;
    }
    setRecState(false, '已结束');
    Object.keys(S.marks).forEach((k) => {
      if (S.marks[k] !== 'done') S.marks[k] = 'done';
    });
    await doScore();
  };

  $('#btn-again').onclick = () => {
    S.lastReport = null;
    showScreen('screen-intro');
    startExam({ offline: false });
  };
  $('#btn-home').onclick = async () => {
    await Tts.stopNow();
    showScreen('screen-intro');
  };
  $('#btn-review').onclick = showAnswerReview;
  $('#btn-print').onclick = () => window.print();

  window.addEventListener('beforeunload', () => {
    Tts.cancel();
    S.micStream?.getTracks().forEach((t) => t.stop());
  });

  // 支持直接访问 /#admin 进入后台（含已在站内切换 hash 的情况）
  const openAdminIfHash = () => {
    if (location.hash === '#admin') showScreen('screen-admin');
  };
  window.addEventListener('hashchange', openAdminIfHash);
  if (location.hash === '#admin') setTimeout(openAdminIfHash, 200);
}

(async function init() {
  Tts.init();
  bind();
  // 调试/自动化测试入口
  window.__exam = { Tts, S, showScreen };
  await runEnvCheck();
  await refreshMe();

  if (!isAsrSupported()) {
    toast(
      '当前浏览器不支持语音识别，将使用「纯声学评分」模式（依据流利度／语速／发声时长评分）。推荐使用 Chrome 或 Edge。',
      'warn',
      8000
    );
  }

  const mics = await listMicrophones();
  S.micDeviceId = mics[0]?.deviceId || null;
})();
