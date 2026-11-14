 

import { S, $, $$, esc, toast, showScreen } from './app.js';

let adminReady = false;
let currentClientIp = '';
let currentPeer = '';

const ADMIN_SECTIONS = [
  { key: 'overview', label: '数据概览', index: '01', cards: ['card-overview'] },
  { key: 'ai', label: 'AI 与语音', index: '02', cards: ['card-ai-config'] },
  { key: 'security', label: '安全与封禁', index: '03', cards: ['card-security', 'card-ban'] },
  { key: 'content', label: '公告与通知', index: '04', cards: ['card-notices', 'card-abnormal', 'card-urgent'] },
  { key: 'pricing', label: '定价设置', index: '05', cards: ['card-pricing'] },
  { key: 'verify', label: '验证与邮件', index: '06', cards: ['card-turnstile', 'card-brevo'] },
  { key: 'codes', label: '兑换码', index: '07', cards: ['card-codes'] },
  { key: 'users', label: '用户管理', index: '08', cards: ['card-users'] },
  { key: 'logs', label: '流水日志', index: '09', cards: ['card-logs'] },
  { key: 'audit', label: '安全审计', index: '10', cards: ['card-activity'] },
  { key: 'tickets', label: '工单反馈', index: '11', cards: ['card-tickets'] },
];

const IP_SOURCE_LABEL = {
  socket: '直连',
  'cf-connecting-ip': 'Cloudflare',
  'x-forwarded-for': '反向代理 XFF',
  'x-real-ip': '反向代理 X-Real-IP',
  'true-client-ip': '反向代理 True-Client-IP',
  'x-vercel-forwarded-for': 'Vercel',
  'proxy-fallback': '代理回退',
  unknown: '未知',
};

function setupAdminShell() {
  const nav = $('#admin-nav');
  const main = $('#admin-main');
  if (!nav || !main || nav.dataset.ready === '1') return;
  nav.dataset.ready = '1';
  let saved = '';
  try { saved = localStorage.getItem('jmkt.admin.panel') || ''; } catch {}
  const startKey = ADMIN_SECTIONS.some((s) => s.key === saved) ? saved : 'overview';

  for (const sec of ADMIN_SECTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.panel = sec.key;
    btn.innerHTML = `<span class="idx">${sec.index}</span><span>${sec.label}</span>`;
    btn.addEventListener('click', () => showAdminPanel(sec.key));
    nav.appendChild(btn);

    const box = document.createElement('div');
    box.className = 'admin-section';
    box.dataset.panelContent = sec.key;
    for (const id of sec.cards) {
      const el = document.getElementById(id);
      if (el) box.appendChild(el);
    }
    main.appendChild(box);
  }

  showAdminPanel(startKey);
}

function showAdminPanel(key) {
  const sec = ADMIN_SECTIONS.find((s) => s.key === key);
  if (!sec) return;
  try { localStorage.setItem('jmkt.admin.panel', key); } catch {}
  $$('#admin-nav button').forEach((b) => {
    const on = b.dataset.panel === key;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('#admin-main .admin-section').forEach((box) => {
    box.classList.toggle('active', box.dataset.panelContent === key);
  });
}

function renderClientInfo(client) {
  if (!client) return;
  currentClientIp = client.ip || '';
  const src = IP_SOURCE_LABEL[client.source] || client.source || '未知';
  const state = client.whitelisted ? '已加入白名单' : '未加入白名单';
  const info = `当前登录 IP：${client.ip || '—'} · 识别来源：${src} · ${state}`;
  const side = $('#admin-client-info');
  if (side) side.textContent = info;
  const box = $('#wl-current');
  if (box) box.textContent = info;
}

function renderWhitelist(list) {
  const box = $('#wl-list');
  if (!box) return;
  const rows = list || [];
  box.innerHTML = rows.length
    ? rows
        .map(
          (w) => `<div class="nt-row">
              <span class="grow"><b>${esc(w.ip)}</b> <span class="muted">${esc(w.note || '')}</span><div class="muted">${new Date(w.at).toLocaleString('zh-CN')}</div></span>
              <button class="btn sm ghost" data-wl-del="${esc(w.id)}">移除</button>
            </div>`
        )
        .join('')
    : '<p class="muted">暂无白名单</p>';
  $$('#wl-list [data-wl-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/api/admin/notices', { action: 'removeWhitelistById', id: btn.dataset.wlDel });
      await loadBanned();
      toast('已移出白名单', 'ok');
    };
  });
}

function renderTrustedProxies(list) {
  const box = $('#tp-list');
  if (!box) return;
  const rows = list || [];
  box.innerHTML = rows.length
    ? rows
        .map(
          (w) => `<div class="nt-row">
              <span class="grow"><b>${esc(w.ip)}</b> <span class="muted">${esc(w.note || '')}</span></span>
              <button class="btn sm ghost" data-tp-del="${esc(w.id)}">移除</button>
            </div>`
        )
        .join('')
    : '<p class="muted">暂无（默认只信任 Cloudflare 与内网地址）</p>';
  $$('#tp-list [data-tp-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/api/admin/notices', { action: 'removeTrustedProxyById', id: btn.dataset.tpDel });
      await loadBanned();
      toast('已移除可信代理', 'ok');
    };
  });
}

async function addTrustedProxy() {
  const ip = $('#tp-ip')?.value.trim();
  const note = $('#tp-note')?.value.trim();
  const hint = $('#tp-hint');
  if (!ip) {
    if (hint) hint.textContent = '请输入代理 IP / 网段';
    return;
  }
  try {
    const d = await api('/api/admin/notices', { action: 'addTrustedProxy', ip, note });
    if (!d.ok) {
      if (hint) hint.textContent = d.reason || '添加失败';
      return;
    }
    if (hint) hint.textContent = '已添加，重新检测即可看到真实 IP';
    toast('已加入可信代理', 'ok');
    await loadBanned();
    await checkClientIp();
  } catch (e) {
    if (hint) hint.textContent = '添加失败：' + e.message;
  }
}

async function checkClientIp() {
  const out = $('#ip-check-out');
  if (out) out.textContent = '检测中…';
  try {
    const d = await api('/api/admin/ip-check', undefined, 'GET');
    const lines = [
      `识别 IP：${d.ip || '—'}`,
      `识别来源：${IP_SOURCE_LABEL[d.source] || d.source || '未知'}`,
      `直连对端：${d.peer || '—'}（${d.trustedProxy ? '可信代理' : '非代理'}）`,
      `状态：${d.whitelisted ? '白名单' : '非白名单'} / ${d.banned ? '已封禁' : '未封禁'}`,
      `时间：${d.at}`,
      '',
      '请求头：',
    ];
    for (const [k, v] of Object.entries(d.headers || {})) {
      lines.push(`  ${k}: ${v || '(无)'}`);
    }
    if (!d.trustedProxy && (d.headers?.['cf-connecting-ip'] || d.headers?.['x-forwarded-for'])) {
      lines.push('', `提示：对端 ${d.peer} 不是可信代理，但请求带有转发头。`, '若该对端是平台/机房的反向代理，请把它加入下方「可信代理」。');
    }
    if (out) out.textContent = lines.join('\n');
    currentPeer = d.peer || '';
    if (currentPeer) {
      const input = $('#tp-ip');
      if (input && !input.value) input.value = currentPeer;
    }
  } catch (e) {
    if (out) out.textContent = '检测失败：' + e.message;
  }
}

async function addWhitelist() {
  const hint = $('#wl-hint');
  const ip = $('#wl-ip').value.trim();
  const note = $('#wl-note').value.trim();
  if (!ip) {
    if (hint) hint.textContent = '请输入要加入白名单的 IP / 网段';
    return;
  }
  try {
    const d = await api('/api/admin/notices', { action: 'addWhitelist', ip, note });
    if (d.added) {
      if (hint) hint.textContent = '已加入白名单';
      $('#wl-ip').value = '';
      $('#wl-note').value = '';
      toast(`已将 ${ip} 加入白名单`, 'ok');
    } else {
      if (hint) hint.textContent = d.reason || '加入失败';
      toast(d.reason || '加入失败', 'bad', 4000);
    }
    renderWhitelist(d.whitelist || []);
  } catch (e) {
    if (hint) hint.textContent = '加入失败';
    toast('加入白名单失败：' + e.message, 'bad', 5000);
  }
}

async function api(path, body, method = 'POST') {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(path, opt);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务返回异常（${res.status}）`);
  }
  if (res.status >= 400 || data.ok === false) {
    const e = new Error(data.error || `请求失败（${res.status}）`);
    e.status = res.status;
    throw e;
  }
  return data;
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '—');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—');

 

 
async function loadAdminCaptcha() {
  const img = $('#ad-captcha-img');
  const idEl = $('#ad-captcha-id');
  try {
    const d = await api('/api/captcha', undefined, 'GET');
    if (img) { img.innerHTML = d.svg || ''; img.style.cursor = 'pointer'; }
    if (idEl) idEl.value = d.id || '';
  } catch {
    if (img) img.innerHTML = '<span style="font-size:11px;color:#888">加载失败，点击重试</span>';
  }
}

async function adminLogin() {
  const pw = $('#cfg-pass').value;
  const captchaId = $('#ad-captcha-id')?.value || '';
  const captchaCode = ($('#ad-captcha')?.value || '').trim();
  if (!pw) return toast('请输入密码', 'warn');
  if (!captchaCode) return toast('请输入图形验证码', 'warn');
  const btn = $('#btn-admin-login');
  const old = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '登录中…';
  }
  try {
    await api('/api/admin/login', { account: 'admin', password: pw, captchaId, captchaCode });
    $('#cfg-pass').value = '';
    
    
    $('#admin-login-card').style.display = 'none';
    $('#admin-panel').style.display = '';
    adminReady = true;
    toast('已进入后台', 'ok');
    await loadOverview();
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      toast('密码或验证码不正确', 'bad', 5000);
    } else {
      toast('登录请求失败：' + e.message + '（部署平台首次访问较慢，请稍后重试）', 'bad', 7000);
    }
    
    if ($('#ad-captcha')) $('#ad-captcha').value = '';
    loadAdminCaptcha();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || '确认';
    }
  }
}

 

async function loadOverview() {
  try {
    const d = await api('/api/admin/overview', undefined, 'GET');
    $('#admin-login-card').style.display = 'none';
    $('#admin-panel').style.display = '';
    adminReady = true;
    renderClientInfo(d.client);
    renderWhitelist(d.settings?.ipWhitelist || []);

    
    const st = d.stats || {};
    $('#admin-stats').innerHTML = `
      <div class="stat"><div class="k">注册用户</div><div class="v">${st.users ?? 0}</div></div>
      <div class="stat"><div class="k">月卡会员</div><div class="v">${st.proUsers ?? 0}</div></div>
      <div class="stat"><div class="k">累计考试次数</div><div class="v">${st.attempts ?? 0}</div></div>
      <div class="stat"><div class="k">兑换码</div><div class="v">${st.codesUsed ?? 0} / ${st.codes ?? 0}</div></div>
      <div class="stat"><div class="k">估算营收</div><div class="v">¥${st.revenueEstimate ?? 0}</div></div>`;

    
    const s = d.settings;
    const sources = s.sources || {};

    $('#cfg-base').value = s.apiBase || '';
    $('#cfg-key').placeholder = s.apiKeySet ? `已配置（${s.apiKeyHint}）— 留空则不改动` : 'sk-...';
    $('#cfg-key').value = '';
    $('#cfg-tpaper').value = s.paperTemperature ?? 0.85;
    $('#cfg-tscore').value = s.scoreTemperature ?? 0.2;
    fillModelSelect(s.availableModels || [], s.model);
    fillRegionSelect(s.examRegion);
    renderSecurity(s.security);
    saveNotices().catch(() => {});
    loadBanned().catch(() => {});
  loadAdminTickets().catch(() => {});

    const srcBox = $('#cfg-env-source');
    if (srcBox) {
      const done = (v) => (v === 'db' ? '已配置' : '未配置');
      srcBox.textContent = `接口地址：${done(sources.apiBase)}　密钥：${done(sources.apiKey)}　模型：${done(
        sources.model
      )}`;
    }

    
    const p = s.pricing || {};
    $('#cfg-free').value = p.freeTrials ?? 1;
    $('#cfg-peruse').value = p.perUse?.price ?? 1;
    $('#cfg-monthly').value = p.monthly?.price ?? 19.9;
    $('#cfg-days').value = p.monthly?.days ?? 30;
    $('#cfg-peruse-desc').value = p.perUse?.desc || '';
    $('#cfg-monthly-desc').value = p.monthly?.desc || '';
    $('#cfg-free-note').value = p.freeTrialNote || '';
    $('#cfg-source').value = p.sourceNote || '';
    $('#cfg-card-buy').value = s.cardBuyUrl || '';
    renderBrevoForm(s.brevo || {});
    renderUrgentNotice(s.urgentNotice || {});
    renderTurnstileForm(s);
    renderSpeechForm(s.speechApi || {});
    renderEpayForm(d.epay || s.epay || {});
    renderImagePreview(p.sourceImage || '');

    renderCodes(d.codes || []);
    renderUsers(d.users || []);
    renderLogs(d.logs || []);
  } catch (e) {
    $('#admin-login-card').style.display = '';
    $('#admin-panel').style.display = 'none';
    if (e.status !== 401) toast('读取后台数据失败：' + e.message, 'bad', 5000);
  }
}

const CUSTOM_MODEL = '__custom__';

 
function currentModel() {
  const sel = $('#cfg-model');
  const custom = $('#cfg-model-custom');
  if (sel && sel.value === CUSTOM_MODEL) return (custom?.value || '').trim();
  return (sel?.value || '').trim();
}

 
function fillModelSelect(models, current) {
  const sel = $('#cfg-model');
  const custom = $('#cfg-model-custom');
  const listBox = $('#cfg-model-list');
  if (!sel) return;

  const arr = Array.from(new Set((models || []).filter(Boolean)));
  const cur = String(current || '').trim();
  
  if (cur && cur !== CUSTOM_MODEL && !arr.includes(cur)) arr.unshift(cur);

  const opts = [`<option value="">（请选择模型）</option>`];
  for (const m of arr) opts.push(`<option value="${esc(m)}">${esc(m)}</option>`);
  opts.push(`<option value="${CUSTOM_MODEL}">✏️ 自定义模型名…</option>`);
  sel.innerHTML = opts.join('');

  if (cur === CUSTOM_MODEL || !cur) {
    sel.value = cur === CUSTOM_MODEL ? CUSTOM_MODEL : '';
    if (custom) {
      custom.style.display = cur === CUSTOM_MODEL ? '' : 'none';
      if (cur === CUSTOM_MODEL) custom.value = custom.dataset.last || '';
    }
  } else {
    sel.value = cur;
    if (custom) custom.style.display = 'none';
  }

  if (listBox) {
    listBox.textContent = arr.length ? `共 ${arr.length} 个可用模型（可点击上方下拉框选择）` : '暂无模型列表，点「拉取模型列表」获取';
  }
  const hint = $('#cfg-model-hint');
  if (hint && arr.length) hint.textContent = `共 ${arr.length} 个可用模型`;
}

 
function bindModelSelect() {
  const sel = $('#cfg-model');
  const custom = $('#cfg-model-custom');
  if (!sel || !custom) return;
  sel.addEventListener('change', () => {
    if (sel.value === CUSTOM_MODEL) {
      custom.dataset.last = custom.value || '';
      custom.style.display = '';
      custom.focus();
    } else {
      custom.style.display = 'none';
    }
  });
}

function fillRegionSelect(current) {
  const sel = $('#cfg-region');
  const cities = S.cities || {};
  const entries = Object.entries(cities);
  sel.innerHTML = entries.length
    ? entries.map(([k, v]) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(v.name)}</option>`).join('')
    : `<option value="${esc(current || 'jiangmen')}">${esc(current || 'jiangmen')}</option>`;
}

 

async function fetchModels() {
  const hint = $('#cfg-model-hint');
  hint.textContent = '正在拉取…';
  try {
    const d = await api('/api/admin/models', {
      apiBase: $('#cfg-base').value.trim(),
      apiKey: $('#cfg-key').value.trim() || undefined,
    });
    fillModelSelect(d.models, currentModel() || S.cfg?.model);
    hint.textContent = `拉取成功，共 ${d.count} 个模型`;
    toast(`获取到 ${d.count} 个模型`, 'ok');
  } catch (e) {
    hint.textContent = '拉取失败';
    toast('获取模型列表失败：' + e.message, 'bad', 6000);
  }
}

async function testConn() {
  const hint = $('#cfg-save-hint');
  hint.textContent = '测试中，请稍候…';
  try {
    
    const d = await api('/api/admin/test', {
      apiBase: $('#cfg-base').value.trim() || undefined,
      apiKey: $('#cfg-key').value.trim() || undefined,
      model: currentModel() || undefined,
    });
    const failedStep = (d.steps || []).find((x) => x.ok === false);
    if (d.ok === false || failedStep) {
      const why = failedStep ? `${failedStep.step}: ${failedStep.error || '失败'}` : d.error || d.stage || '失败';
      hint.textContent = '连通失败';
      toast('连通测试失败：' + why, 'bad', 8000);
      return;
    }
    hint.textContent = `连通正常 · ${d.ms}ms · ${d.model}`;
    toast(`模型连通正常（${d.ms}ms）`, 'ok', 4000);
  } catch (e) {
    hint.textContent = '连通失败';
    toast('连通测试失败：' + e.message, 'bad', 6000);
  }
}

async function saveApi() {
  const hint = $('#cfg-save-hint');
  const body = {
    apiBase: $('#cfg-base').value.trim(),
    model: currentModel(),
    examRegion: $('#cfg-region').value,
    paperTemperature: Number($('#cfg-tpaper').value),
    scoreTemperature: Number($('#cfg-tscore').value),
    
    speechApi: {
      apiBase: $('#cfg-speech-base')?.value.trim() || '',
      apiKey: $('#cfg-speech-key')?.value.trim() || '',
      ttsModel: currentSelectVal('cfg-speech-tts-model'),
      ttsVoice: $('#cfg-speech-tts-voice')?.value.trim() || 'alloy',
      asrModel: currentSelectVal('cfg-speech-asr-model'),
    },
  };
  const key = $('#cfg-key').value.trim();
  if (key) body.apiKey = key;
  try {
    await api('/api/admin/settings', body);
    hint.textContent = '已保存';
    toast('接口配置已保存', 'ok');
    $('#cfg-key').value = '';
    if ($('#cfg-speech-key')) $('#cfg-speech-key').value = '';
    await loadOverview();
  } catch (e) {
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

 
function currentSelectVal(id) {
  const sel = document.getElementById(id);
  return sel ? sel.value : '';
}

 

 

function renderEpayForm(e) {
  const el = (id) => document.getElementById(id);
  const pid = el('cfg-epay-pid');
  const key = el('cfg-epay-key');
  const base = el('cfg-epay-base');
  const types = el('cfg-epay-types');
  const on = el('cfg-epay-enabled');
  const hint = el('cfg-epay-hint');
  if (pid) pid.value = e?.pid || '';
  if (key) key.value = '';
  if (base) base.value = e?.apiBase || 'https://pay.521cd.cn/xpay/epay';
  if (on) on.checked = Boolean(e?.enabled);
  if (types) {
    const cur = (e?.types || ['alipay', 'wxpay']).join(',');
    types.value = [...types.options].some((o) => o.value === cur) ? cur : 'alipay,wxpay';
  }
  if (hint) hint.textContent = e?.hasKey ? '已设置密钥（留空则不修改）' : '未设置密钥';
}

async function saveEpay() {
  const hint = $('#cfg-epay-hint');
  const types = ($('#cfg-epay-types')?.value || 'alipay,wxpay').split(',').filter(Boolean);
  try {
    const d = await api('/api/admin/notices', {
      action: 'saveEpay',
      pid: $('#cfg-epay-pid')?.value.trim() || '',
      key: $('#cfg-epay-key')?.value.trim() || '',
      apiBase: $('#cfg-epay-base')?.value.trim() || '',
      enabled: Boolean($('#cfg-epay-enabled')?.checked),
      types,
    });
    if (!d.ok) {
      if (hint) hint.textContent = d.error || '保存失败';
      return;
    }
    if (hint) hint.textContent = d.epay.enabled ? '已启用' : '已保存（未启用）';
    toast('支付配置已保存', 'ok');
    await loadOverview();
  } catch (e) {
    if (hint) hint.textContent = '保存失败：' + e.message;
  }
}

function renderSpeechForm(sp) {
  const el = (id) => document.getElementById(id);
  const base = el('cfg-speech-base');
  const key = el('cfg-speech-key');
  const hint = el('cfg-speech-key-hint');
  const ttsM = el('cfg-speech-tts-model');
  const ttsV = el('cfg-speech-tts-voice');
  const asrM = el('cfg-speech-asr-model');
  if (base) base.value = sp.apiBase || '';
  if (key) key.value = '';
  if (hint) hint.textContent = sp.apiKeySet ? `已设置：${sp.apiKeyHint}（留空则不修改）` : '未设置（将使用主 API Key）';
  if (ttsV) ttsV.value = sp.ttsVoice || 'alloy';
  
  fillSpeechSelect(ttsM, sp.ttsModel || 'tts-1');
  fillSpeechSelect(asrM, sp.asrModel || 'whisper-1');
}

function fillSpeechSelect(sel, current) {
  if (!sel) return;
  
  let found = false;
  for (const opt of sel.options) {
    if (opt.value === current) { found = true; break; }
  }
  if (!found && current) {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = current;
    sel.insertBefore(o, sel.firstChild);
  }
  sel.value = current;
}

async function fetchSpeechModels() {
  const hint = $('#cfg-speech-model-hint');
  hint.textContent = '拉取中…';
  try {
    let base = $('#cfg-speech-base')?.value.trim() || $('#cfg-base')?.value.trim() || '';
    if (!base) { hint.textContent = '请先填写 API 地址'; return; }
    const key = $('#cfg-speech-key')?.value.trim() || $('#cfg-key')?.value.trim() || '';
    const d = await api('/api/admin/speech-models', { apiBase: base, apiKey: key });
    if (!d.ok) { hint.textContent = d.error || '拉取失败'; return; }
    const list = d.models || [];
    if (!list.length) { hint.textContent = '未找到可用模型'; return; }
    
    const ttsSel = $('#cfg-speech-tts-model');
    const asrSel = $('#cfg-speech-asr-model');
    const curTts = ttsSel?.value || '';
    const curAsr = asrSel?.value || '';
    const ttsModels = list.filter((m) => /tts|speech|audio.*gen/i.test(m));
    const asrModels = list.filter((m) => /whisper|asr|transcri|audio/i.test(m));
    
    const ttsOpts = ttsModels.length ? ttsModels : list;
    const asrOpts = asrModels.length ? asrModels : list;
    if (ttsSel) {
      ttsSel.innerHTML = ttsOpts.map((m) => `<option value="${m}">${m}</option>`).join('');
      if (ttsOpts.includes(curTts)) ttsSel.value = curTts;
    }
    if (asrSel) {
      asrSel.innerHTML = asrOpts.map((m) => `<option value="${m}">${m}</option>`).join('');
      if (asrOpts.includes(curAsr)) asrSel.value = curAsr;
    }
    hint.textContent = `找到 ${list.length} 个模型（TTS ${ttsOpts.length} · ASR ${asrOpts.length}）`;
  } catch (e) {
    hint.textContent = '拉取失败：' + e.message;
  }
}

async function saveSpeech() {
  
  return saveApi();
}

 
async function testSpeech() {
  const out = $('#cfg-speech-test-out');
  if (out) out.textContent = '正在测试…';
  try {
    const d = await api('/api/admin/speech-test', {});
    const lines = (d.steps || []).map((s) => {
      const name = s.step === 'tts' ? '朗读 /audio/speech' : '转写 /audio/transcriptions';
      if (s.ok) {
        return `✓ ${name} 正常${s.bytes ? `（返回 ${s.bytes} 字节音频）` : ''}${s.sample ? `（返回：${s.sample.slice(0, 60)}）` : ''}`;
      }
      return `✗ ${name} 失败${s.status ? `（HTTP ${s.status}）` : ''}：${s.error || '未知错误'}`;
    });
    if (d.error) lines.unshift(`✗ ${d.error}`);
    if (d.hint) lines.push('', d.hint);
    if (out) out.textContent = lines.join('\n');
    toast(d.ok ? '语音接口均可用' : '语音接口有问题，请看下方结果', d.ok ? 'ok' : 'warn', 5000);
  } catch (e) {
    if (out) out.textContent = '测试失败：' + e.message;
    toast('测试失败：' + e.message, 'bad', 5000);
  }
}

async function useLocalSpeech() {
  const hint = $('#cfg-speech-model-hint');
  try {
    await api('/api/admin/settings', { clearSpeech: true });
    if (hint) hint.textContent = '已改用本地合成';
    toast('已改用本地 Edge-TTS 合成', 'ok');
    await loadOverview();
  } catch (e) {
    if (hint) hint.textContent = '操作失败';
    toast('操作失败：' + e.message, 'bad', 5000);
  }
}

 

function renderUrgentNotice(un) {
  const el = (id) => document.getElementById(id);
  const on = el('cfg-urgent-on');
  const title = el('cfg-urgent-title');
  const body = el('cfg-urgent-body');
  const hint = el('cfg-urgent-hint');
  if (on) on.checked = Boolean(un.enabled);
  if (title) title.value = un.title || '';
  if (body) body.value = un.body || '';
  if (hint) hint.textContent = un.id ? `当前通知 ID：${un.id}` : '尚未发布';
}

async function saveUrgentNotice() {
  const hint = $('#cfg-urgent-hint');
  try {
    await api('/api/admin/settings', {
      urgentNotice: {
        enabled: $('#cfg-urgent-on').checked,
        title: $('#cfg-urgent-title').value.trim(),
        body: $('#cfg-urgent-body').value.trim(),
      },
    });
    hint.textContent = '已保存';
    toast('紧急通知已更新', 'ok');
    await loadOverview();
  } catch (e) {
    hint.textContent = '保存失败';
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

 

function renderTurnstileForm(s) {
  const site = document.getElementById('cfg-ts-site');
  const secret = document.getElementById('cfg-ts-secret');
  const hint = document.getElementById('cfg-ts-secret-hint');
  if (site) site.value = s.turnstileSiteKey || '';
  if (secret) secret.value = '';
  if (hint) hint.textContent = s.turnstileSecretSet ? '已设置（留空则不修改）' : '尚未设置';
}

async function saveTurnstile() {
  const hint = $('#cfg-ts-hint');
  try {
    await api('/api/admin/settings', {
      turnstile: {
        siteKey: $('#cfg-ts-site').value.trim(),
        secretKey: $('#cfg-ts-secret').value.trim(),
      },
    });
    hint.textContent = '已保存';
    toast('人机验证设置已保存', 'ok');
    await loadOverview();
  } catch (e) {
    hint.textContent = '保存失败';
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

 
function renderBrevoForm(b) {
  $('#cfg-brevo-on').checked = Boolean(b.enabled);
  $('#cfg-brevo-from').value = b.senderEmail || '';
  $('#cfg-brevo-name').value = b.senderName || '';
  $('#cfg-brevo-key').value = '';
  $('#cfg-brevo-key-hint').textContent = b.apiKeySet ? `已设置：${b.apiKeyHint}（留空则不修改）` : '尚未设置';
}

async function saveBrevo() {
  const hint = $('#cfg-brevo-hint');
  try {
    await api('/api/admin/settings', {
      brevo: {
        enabled: $('#cfg-brevo-on').checked,
        apiKey: $('#cfg-brevo-key').value.trim(),
        senderEmail: $('#cfg-brevo-from').value.trim(),
        senderName: $('#cfg-brevo-name').value.trim(),
      },
    });
    hint.textContent = '已保存';
    toast('邮箱验证码设置已保存', 'ok');
    const h = await api('/api/health', undefined, 'GET');
    S.emailVerify = Boolean(h.emailVerify);
    await loadOverview();
  } catch (e) {
    hint.textContent = '保存失败';
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

async function savePricing() {
  const hint = $('#cfg-price-hint');
  try {
    await api('/api/admin/settings', {
      pricing: {
        freeTrials: Number($('#cfg-free').value) || 0,
        freeTrialNote: $('#cfg-free-note').value,
        perUse: { ...(S.pricing?.perUse || {}), price: Number($('#cfg-peruse').value) || 0, desc: $('#cfg-peruse-desc').value },
        monthly: { ...(S.pricing?.monthly || {}), price: Number($('#cfg-monthly').value) || 0, days: Number($('#cfg-days').value) || 30, desc: $('#cfg-monthly-desc').value },
        sourceNote: $('#cfg-source').value,
        sourceImage: currentImage || '',
      },
      cardBuyUrl: $('#cfg-card-buy').value.trim(),
    });
    hint.textContent = '已保存';
    toast('定价已更新，前台收费页立即生效', 'ok');
    
    const h = await api('/api/health', undefined, 'GET');
    S.pricing = h.pricing;
    await loadOverview();
  } catch (e) {
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

 

async function saveSecurity() {
  const hint = $('#sec-hint');
  const body = {
    security: {
      registrationOff: Boolean($('#sec-register-off')?.checked),
      loginOff: Boolean($('#sec-login-off')?.checked),
      speechOff: Boolean($('#sec-speech-off')?.checked),
    },
  };
  try {
    await api('/api/admin/settings', body);
    if (hint) hint.textContent = '已保存';
    toast('安全开关已更新，立即生效', 'ok');
  } catch (e) {
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

function renderSecurity(sec) {
  const s = sec || {};
  if ($('#sec-register-off')) $('#sec-register-off').checked = Boolean(s.registrationOff);
  if ($('#sec-login-off')) $('#sec-login-off').checked = Boolean(s.loginOff);
  if ($('#sec-speech-off')) $('#sec-speech-off').checked = Boolean(s.speechOff);
}

 

async function saveNotices() {
  const d = await api('/api/admin/notices', { action: 'list' });
  renderNoticeLists(d);
}

function renderNoticeLists(d) {
  const anns = d.announcements || [];
  const abs = d.abnormal || [];
  $('#nt-list').innerHTML = anns.length
    ? anns
        .map(
          (a) =>
            `<div class="nt-row">
              <span class="grow"><b>${esc(a.title)}</b> <span class="muted">${esc(a.level)}</span><div class="muted">${esc(a.body)}</div></span>
              <button class="btn sm ghost" data-nt-toggle="${a.id}" data-active="${a.active}">${a.active ? '停用' : '启用'}</button>
              <button class="btn sm ghost" data-nt-del="${a.id}">删除</button>
            </div>`
        )
        .join('')
    : '<p class="muted">暂无公告</p>';
  $('#ab-list').innerHTML = abs.length
    ? abs
        .map(
          (a) =>
            `<div class="ab-row">
              <span class="grow"><b>${esc(a.type)}：${esc(a.value)}</b> <span class="muted">${esc(a.reason)}</span>${a.note ? `<div class="muted">${esc(a.note)}</div>` : ''}</span>
              <button class="btn sm ghost" data-ab-toggle="${a.id}" data-active="${a.active}">${a.active ? '停用' : '启用'}</button>
              <button class="btn sm ghost" data-ab-del="${a.id}">删除</button>
            </div>`
        )
        .join('')
    : '<p class="muted">暂无异常公示</p>';

  $$('#nt-list [data-nt-toggle]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/admin/notices', { action: 'toggleAnnouncement', id: b.dataset.ntToggle, active: b.dataset.active !== 'true' });
      await saveNotices();
    };
  });
  $$('#nt-list [data-nt-del]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/admin/notices', { action: 'removeAnnouncement', id: b.dataset.ntDel });
      await saveNotices();
    };
  });
  $$('#ab-list [data-ab-toggle]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/admin/notices', { action: 'toggleAbnormal', id: b.dataset.abToggle, active: b.dataset.active !== 'true' });
      await saveNotices();
    };
  });
  $$('#ab-list [data-ab-del]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/admin/notices', { action: 'removeAbnormal', id: b.dataset.abDel });
      await saveNotices();
    };
  });
}

async function addAnnouncement() {
  const hint = $('#nt-hint');
  try {
    await api('/api/admin/notices', {
      action: 'addAnnouncement',
      title: $('#nt-title').value,
      body: $('#nt-body').value,
      level: $('#nt-level').value,
    });
    if (hint) hint.textContent = '已发布';
    $('#nt-title').value = '';
    $('#nt-body').value = '';
    await saveNotices();
    toast('公告已发布，登录页立即展示', 'ok');
  } catch (e) {
    toast('发布失败：' + e.message, 'bad', 5000);
  }
}

async function addAbnormal() {
  const hint = $('#ab-hint');
  try {
    await api('/api/admin/notices', {
      action: 'addAbnormal',
      type: $('#ab-type').value,
      value: $('#ab-value').value,
      reason: $('#ab-reason').value,
    });
    if (hint) hint.textContent = '已公示';
    $('#ab-value').value = '';
    $('#ab-reason').value = '';
    await saveNotices();
    toast('公示已发布', 'ok');
  } catch (e) {
    toast('发布失败：' + e.message, 'bad', 5000);
  }
}

 

async function loadAdminTickets() {
  const box = $('#tk-admin-list');
  if (!box) return;
  box.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const d = await api('/api/admin/tickets', undefined, 'GET');
    const filter = $('#tk-admin-filter')?.value ?? 'open';
    const arr = (d.tickets || []).filter((t) => !filter || (filter === 'open' ? t.status !== 'closed' : t.status === 'closed'));
    if (!arr.length) {
      box.innerHTML = '<p class="muted">暂无工单</p>';
      return;
    }
    box.innerHTML = arr
      .map((t) => {
        const open = t.status !== 'closed';
        const badge = open ? '<span class="pill warn">处理中</span>' : '<span class="pill ok">已结束</span>';
        return `<div class="nt-row">
            <span class="grow">
              <b>${esc(t.title)}</b> ${badge}
              <div class="muted">${esc(t.email || '')}　·　${new Date(t.createdAt).toLocaleString('zh-CN')}　·　${(t.replies || []).length} 条回复</div>
              <div class="muted">${esc(String(t.body).slice(0, 90))}</div>
            </span>
            <button class="btn sm ghost" data-tk-adm="${esc(t.id)}">处理</button>
          </div>`;
      })
      .join('');
    $$('#tk-admin-list [data-tk-adm]').forEach((btn) => {
      btn.onclick = () => openAdminTicket(btn.dataset.tkAdm);
    });
  } catch (e) {
    box.innerHTML = `<p class="muted">加载失败：${esc(e.message)}</p>`;
  }
}

async function openAdminTicket(id) {
  let t;
  try {
    const d = await api('/api/admin/tickets?id=' + encodeURIComponent(id), undefined, 'GET');
    t = d.ticket;
  } catch (e) {
    return toast('读取失败：' + e.message, 'bad', 5000);
  }
  const open = t.status !== 'closed';
  const replies = (t.replies || [])
    .map(
      (r) => `<div class="nt-row"><span class="grow"><b>${r.by === 'admin' ? '管理员' : '用户'}</b>
        <div style="white-space:pre-wrap">${esc(r.text)}</div>
        <div class="muted">${new Date(r.at).toLocaleString('zh-CN')}</div></span></div>`
    )
    .join('');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="urgent-box" style="max-width:620px">
    <div class="urgent-head"><span class="urgent-dot"></span><h2 class="urgent-title">${esc(t.title)}</h2></div>
    <div class="urgent-body">
      <div class="muted">${esc(t.email || '')}　·　${new Date(t.createdAt).toLocaleString('zh-CN')}　·　${open ? '处理中' : '已结束'}</div>
      <div style="white-space:pre-wrap;margin-top:10px">${esc(t.body)}</div>
      <div style="margin-top:14px;border-top:1px solid #e4e7ec;padding-top:12px">${replies || '<p class="muted">暂无回复</p>'}</div>
      ${open ? '<textarea id="tk-admin-reply" rows="3" placeholder="回复内容…" style="width:100%;margin-top:12px;box-sizing:border-box"></textarea>' : ''}
    </div>
    <div class="urgent-foot" style="gap:8px">
      ${open ? '<button class="btn" id="tk-admin-send">回复</button><button class="btn ghost" id="tk-admin-close">结束工单</button>' : '<button class="btn ghost" id="tk-admin-reopen">重审</button>'}
      <button class="btn ghost" id="tk-admin-back">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('#tk-admin-back').onclick = close;
  const act = async (payload) => {
    try {
      await api('/api/admin/tickets', { id: t.id, ...payload });
      close();
      toast('已处理', 'ok');
      await loadAdminTickets();
    } catch (e) {
      toast('操作失败：' + e.message, 'bad', 5000);
    }
  };
  mask.querySelector('#tk-admin-send')?.addEventListener('click', () => {
    const text = (mask.querySelector('#tk-admin-reply')?.value || '').trim();
    if (!text) return toast('请输入回复内容', 'warn');
    act({ action: 'reply', text });
  });
  mask.querySelector('#tk-admin-close')?.addEventListener('click', () => act({ action: 'close' }));
  mask.querySelector('#tk-admin-reopen')?.addEventListener('click', () => act({ action: 'reopen' }));
}

async function loadBanned() {
  const d = await api('/api/admin/notices', { action: 'listBanned' });
  renderBanned(d.banned || []);
  renderWhitelist(d.whitelist || []);
  renderTrustedProxies(d.trustedProxies || []);
  renderScriptGuard(d.scriptGuard || {});
}

function renderBanned(list) {
  const box = $('#ban-list');
  if (!box) return;
  box.innerHTML = list.length
    ? list
        .map((b) => {
          const tag = b.auto
            ? '<span class="muted" style="color:#b54708">自动封禁</span>'
            : '<span class="muted">手动封禁</span>';
          return `<div class="nt-row">
              <span class="grow"><b>${esc(b.ip)}</b> ${tag} <span class="muted">${esc(b.note || '')}</span><div class="muted">${new Date(b.at).toLocaleString('zh-CN')}</div></span>
              <button class="btn sm ghost" data-unban="${b.id}">解封</button>
            </div>`;
        })
        .join('')
    : '<p class="muted">暂无封禁记录</p>';
  $$('#ban-list [data-unban]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/api/admin/notices', { action: 'removeBannedById', id: btn.dataset.unban });
      await loadBanned();
      toast('已解封', 'ok');
    };
  });
}

 
function renderScriptGuard(g) {
  const cb = $('#sg-enabled');
  if (!cb) return;
  cb.checked = g.enabled !== false;
  $('#sg-max').value = g.scriptMax ?? 5;
  $('#sg-window').value = g.windowMin ?? 10;
  const hint = $('#sg-hint');
  if (hint) {
    hint.textContent =
      g.enabled === false
        ? '已关闭：不再自动封禁脚本访问'
        : `${g.windowMin ?? 10} 分钟内脚本访问超过 ${g.scriptMax ?? 5} 次自动封禁该 IP`;
  }
}

async function saveScriptGuard() {
  const hint = $('#sg-hint');
  try {
    const d = await api('/api/admin/notices', {
      action: 'saveScriptGuard',
      enabled: $('#sg-enabled').checked,
      scriptMax: Number($('#sg-max').value) || 5,
      windowMin: Number($('#sg-window').value) || 10,
    });
    renderScriptGuard(d.scriptGuard || {});
    toast(d.message || '已保存', 'ok');
  } catch (e) {
    if (hint) hint.textContent = '保存失败';
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

async function banIp() {
  const hint = $('#ban-hint');
  const ip = $('#ban-ip').value.trim();
  const note = $('#ban-note').value.trim();
  if (!ip) {
    if (hint) hint.textContent = '请输入要封禁的 IP';
    return;
  }
  try {
    const d = await api('/api/admin/notices', { action: 'banIp', ip, note });
    if (hint) hint.textContent = d.added ? '已封禁' : d.reason || '该 IP 已在封禁列表中';
    if (d.added) {
      $('#ban-ip').value = '';
      $('#ban-note').value = '';
      toast(`已封禁 ${ip}`, 'ok');
    } else {
      toast(d.reason || '封禁失败', 'bad', 4000);
    }
    await loadBanned();
  } catch (e) {
    toast('封禁失败：' + e.message, 'bad', 5000);
  }
}

 
let currentImage = '';

function renderImagePreview(url) {
  currentImage = url || '';
  const img = $('#cfg-img-preview');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = '';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

async function uploadImage() {
  const file = $('#cfg-img-file')?.files?.[0];
  const hint = $('#cfg-img-hint');
  if (!file) {
    toast('请先选择一张图片', 'warn');
    return;
  }
  if (file.size > 3 * 1024 * 1024) {
    toast('图片超过 3MB，请压缩后再上传', 'bad', 6000);
    return;
  }
  if (hint) hint.textContent = '上传中…';
  try {
    const dataUrl = await fileToDataUrl(file);
    const d = await api('/api/admin/upload', { dataUrl });
    renderImagePreview(d.url);
    if (hint) hint.textContent = `已上传（${(d.bytes / 1024).toFixed(0)}KB），点「保存定价」后生效`;
    toast('图片已上传，记得点「保存定价」', 'ok');
  } catch (e) {
    if (hint) hint.textContent = '上传失败';
    toast('上传失败：' + e.message, 'bad', 6000);
  }
}

 

async function clearUsers() {
  const hint = $('#cfg-user-hint');
  const first = confirm(
    '危险操作\n\n这会删除【所有注册用户】以及他们的登录状态，且不可撤销。\n\n建议先点「导出用户数据」做个备份。\n\n确定继续吗？'
  );
  if (!first) return;
  const typed = prompt('请输入 CLEAR（全大写）以确认清空所有用户：');
  if (typed !== 'CLEAR') {
    toast('已取消（确认词不正确）', 'warn');
    return;
  }
  try {
    const r = await api('/api/admin/users', { action: 'clear', confirm: 'CLEAR' });
    toast(r.message, 'ok', 6000);
    if (hint) hint.textContent = r.message;
    await loadOverview();
  } catch (e) {
    toast('清空失败：' + e.message, 'bad', 6000);
  }
}

function renderCodes(codes) {
  const tb = $('#cfg-code-table tbody');
  if (!tb) return;
  if (!codes.length) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">还没有兑换码，点击上方「生成兑换码」创建。</td></tr>';
    return;
  }
  tb.innerHTML = codes
    .map(
      (c) => `<tr>
      <td><code class="code">${esc(c.code)}</code></td>
      <td>${c.type === 'monthly' ? '月卡天数' : '次卡次数'}</td>
      <td class="num">${c.value}${c.type === 'monthly' ? ' 天' : ' 次'}</td>
      <td>${
        c.disabled
          ? '<span class="tag bad">已作废</span>'
          : c.usedBy
          ? `<span class="tag warn">已使用</span>`
          : '<span class="tag ok">未使用</span>'
      }</td>
      <td class="muted" style="font-size:12px">${c.usedAt ? fmtTime(c.usedAt) : '—'}</td>
      <td class="muted" style="font-size:12px">${esc(c.note || '')}</td>
      <td>${
        c.usedBy || c.disabled
          ? ''
          : `<button class="btn ghost sm" data-code-disable="${esc(c.code)}">作废</button>`
      }</td>
    </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-code-disable]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`确定作废兑换码 ${b.dataset.codeDisable}？`)) return;
      await api('/api/admin/codes', { action: 'disable', code: b.dataset.codeDisable });
      toast('已作废', 'ok');
      await loadOverview();
    };
  });
}

async function genCodes() {
  const hint = $('#cfg-code-hint');
  hint.textContent = '生成中…';
  try {
    const d = await api('/api/admin/codes', {
      type: $('#cfg-code-type').value,
      value: Number($('#cfg-code-value').value) || 1,
      count: Number($('#cfg-code-count').value) || 1,
      prefix: $('#cfg-code-prefix').value.trim() || 'JMKT',
      note: $('#cfg-code-note').value.trim(),
    });
    hint.textContent = d.message;
    toast(d.message, 'ok');
    renderCodes(d.codes || []);
  } catch (e) {
    hint.textContent = '生成失败';
    toast('生成失败：' + e.message, 'bad', 5000);
  }
}

async function exportCodes() {
  try {
    const d = await api('/api/admin/codes', undefined, 'GET');
    const rows = (d.codes || []).filter((c) => !c.usedBy && !c.disabled);
    if (!rows.length) return toast('没有未使用的兑换码', 'warn');
    const csv =
      '\uFEFF兑换码,类型,额度,备注,生成时间\n' +
      rows
        .map((c) => [c.code, c.type === 'monthly' ? `月卡${c.value}天` : `次卡${c.value}次`, c.value, c.note || '', fmtTime(c.createdAt)].join(','))
        .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `兑换码-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${rows.length} 个未使用兑换码`, 'ok');
  } catch (e) {
    toast('导出失败：' + e.message, 'bad', 5000);
  }
}

 

function renderUsers(users) {
  const tb = $('#cfg-user-table tbody');
  if (!tb) return;
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">还没有注册用户。</td></tr>';
    return;
  }
  tb.innerHTML = users
    .map(
      (u) => `<tr>
      <td>${esc(u.email)}${u.disabled ? ' <span class="tag bad">已停用</span>' : ''}</td>
      <td class="num">${u.credits} 次</td>
      <td class="num">${u.freeLeft}</td>
      <td>${u.proActive ? `剩 ${u.proDaysLeft} 天` : '—'}</td>
      <td class="num">${u.usedCount}</td>
      <td class="nowrap">
        <button class="btn ghost sm" data-u-add-credit="${esc(u.id)}">+1 次</button>
        <button class="btn ghost sm" data-u-add-day="${esc(u.id)}">+30 天</button>
        <button class="btn ghost sm" data-u-reset="${esc(u.id)}">重置免费</button>
        <button class="btn ghost sm" data-u-disable="${esc(u.id)}" data-cur="${u.disabled ? 1 : 0}">${u.disabled ? '启用' : '停用'}</button>
        <button class="btn ghost sm" data-u-del="${esc(u.id)}">删除</button>
      </td>
    </tr>`
    )
    .join('');

  tb.querySelectorAll('[data-u-add-credit]').forEach((b) => {
    b.onclick = () => userAction({ id: b.dataset.uAddCredit, addCredits: 1 }, '已加 1 次');
  });
  tb.querySelectorAll('[data-u-add-day]').forEach((b) => {
    b.onclick = () => userAction({ id: b.dataset.uAddDay, addDays: 30 }, '已加 30 天会员');
  });
  tb.querySelectorAll('[data-u-reset]').forEach((b) => {
    b.onclick = () => userAction({ id: b.dataset.uReset, resetFree: true }, '已重置免费次数');
  });
  tb.querySelectorAll('[data-u-disable]').forEach((b) => {
    b.onclick = () => userAction({ id: b.dataset.uDisable, disabled: b.dataset.cur !== '1' }, '已更新状态');
  });
  tb.querySelectorAll('[data-u-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确定删除该用户？此操作不可恢复。')) return;
      try {
        await api('/api/admin/users', { action: 'delete', id: b.dataset.uDel });
        toast('用户已删除', 'ok');
        await loadOverview();
      } catch (e) {
        toast('删除失败：' + e.message, 'bad');
      }
    };
  });
}

async function userAction(patch, msg) {
  try {
    const d = await api('/api/admin/users', patch);
    toast(msg, 'ok');
    renderUsers(d.users || []);
  } catch (e) {
    toast('操作失败：' + e.message, 'bad');
  }
}

 

function renderLogs(logs) {
  const tb = $('#cfg-log-table tbody');
  if (!tb) return;
  tb.innerHTML = logs.length
    ? logs
        .map(
          (l) => `<tr>
        <td class="muted" style="font-size:12px">${fmtTime(l.at)}</td>
        <td><span class="tag">${esc(l.action)}</span></td>
        <td class="muted" style="font-size:12px">${esc(l.detail || '')}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">暂无日志。</td></tr>';
}

 

const fmtKind = (k) => ({ login: '登录', register: '注册', read: '朗读', blocked: '拦截', visit: '访问', score: '评分', paper: '组卷', 'admin-login': '管理员登录' }[k] || k);

function renderActivity(events) {
  const tb = $('#act-table tbody');
  if (!tb) return;
  if (!events || !events.length) {
    tb.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center">暂无记录</td></tr>';
    return;
  }
  tb.innerHTML = events.map((e) => {
    const cls = e.action === 'fail' ? ' style="color:#ef4444"' : e.kind === 'blocked' ? ' style="color:#f59e0b"' : '';
    const srcLabel = e.ipSource ? IP_SOURCE_LABEL[e.ipSource] || e.ipSource : '';
    const ipTitle = e.peerIp && e.peerIp !== e.ip ? `直连对端：${e.peerIp}` : '';
    return `<tr>
      <td>${fmtTime(e.at)}</td>
      <td>${esc(fmtKind(e.kind))}</td>
      <td${cls}>${esc(e.action || '')}</td>
      <td>${esc(e.email || e.userId || '')}</td>
      <td title="${esc(ipTitle)}"><div>${esc(e.ip || '')}</div>${srcLabel ? `<div class="muted" style="font-size:11px">${esc(srcLabel)}</div>` : ''}</td>
      <td>${esc(e.geo || '')}</td>
      <td>${esc(e.browser || '')}</td>
      <td>${esc(e.os || '')}</td>
      <td>${esc(e.detail || e.text || '').slice(0, 60)}</td>
    </tr>`;
  }).join('');
}

async function queryActivity() {
  try {
    const d = await api('/api/admin/activity', {
      kind: $('#act-kind')?.value || '',
      q: $('#act-search')?.value?.trim() || '',
      limit: 300,
    });
    renderActivity(d.events || []);
    toast(`查询到 ${(d.events || []).length} 条记录`, 'ok', 2000);
  } catch (e) {
    toast('查询失败：' + e.message, 'bad');
  }
}

async function activityStats() {
  try {
    const d = await api('/api/admin/activity', { action: 'stats', since: Date.now() - 24 * 3600_000 });
    const s = d.stats || {};
    const box = $('#act-stats-box');
    if (!box) return;
    box.style.display = '';
    let html = `<b>24 小时统计</b>：共 ${s.total} 条 · 登录 ${s.logins} · 注册 ${s.registers} · 朗读 ${s.reads} · 疑似机器人 ${s.bots}`;
    if (s.topIps?.length) {
      html += '<br>高频 IP：' + s.topIps.slice(0, 5).map((x) => `${esc(x.key)}（${x.count} 次${x.bots ? '，含 ' + x.bots + ' 次机器人' : ''}）`).join('、');
    }
    box.innerHTML = html;
  } catch (e) {
    toast('统计失败：' + e.message, 'bad');
  }
}

async function clearActivity() {
  if (!confirm('确定清空全部审计日志？此操作不可恢复。')) return;
  try {
    const d = await api('/api/admin/activity', { action: 'clear' });
    toast(`已清空 ${d.cleared} 条日志`, 'ok');
    renderActivity([]);
    const box = $('#act-stats-box');
    if (box) box.style.display = 'none';
  } catch (e) {
    toast('清空失败：' + e.message, 'bad');
  }
}

 

function bind() {
  setupAdminShell();
  $('#btn-admin-login')?.addEventListener('click', adminLogin);
  $('#cfg-pass')?.addEventListener('keydown', (e) => e.key === 'Enter' && adminLogin());
  $('#ad-captcha-img')?.addEventListener('click', loadAdminCaptcha);
  loadAdminCaptcha();
  $('#btn-admin-refresh')?.addEventListener('click', () => loadOverview().then(() => toast('已刷新', 'ok', 1500)));
  bindModelSelect();
  $('#btn-brevo-save')?.addEventListener('click', saveBrevo);
  $('#btn-urgent-save')?.addEventListener('click', saveUrgentNotice);
  $('#btn-ts-save')?.addEventListener('click', saveTurnstile);
  $('#btn-speech-save')?.addEventListener('click', saveSpeech);
  $('#btn-speech-models')?.addEventListener('click', fetchSpeechModels);
  $('#btn-epay-save')?.addEventListener('click', saveEpay);
  $('#btn-speech-test')?.addEventListener('click', testSpeech);
  $('#btn-speech-local')?.addEventListener('click', useLocalSpeech);
  $('#btn-admin-models')?.addEventListener('click', fetchModels);
  $('#btn-admin-test')?.addEventListener('click', testConn);
  $('#btn-admin-save')?.addEventListener('click', saveApi);
  $('#btn-admin-save-price')?.addEventListener('click', savePricing);
  $('#btn-admin-save-security')?.addEventListener('click', saveSecurity);
  $('#btn-nt-add')?.addEventListener('click', addAnnouncement);
  $('#btn-ab-add')?.addEventListener('click', addAbnormal);
  $('#btn-ban-add')?.addEventListener('click', banIp);
  $('#btn-wl-add')?.addEventListener('click', addWhitelist);
  $('#btn-ip-check')?.addEventListener('click', checkClientIp);
  $('#btn-tp-add')?.addEventListener('click', addTrustedProxy);
  $('#btn-tk-admin-refresh')?.addEventListener('click', loadAdminTickets);
  $('#tk-admin-filter')?.addEventListener('change', loadAdminTickets);
  $('#btn-wl-self')?.addEventListener('click', () => {
    if (!currentClientIp) return toast('尚未获取到当前 IP，请刷新后重试', 'warn');
    const input = $('#wl-ip');
    if (input) input.value = currentClientIp;
  });
  $('#btn-sg-save')?.addEventListener('click', saveScriptGuard);
  $('#btn-admin-clear')?.addEventListener('click', clearUsers);
  $('#btn-admin-img-upload')?.addEventListener('click', uploadImage);
  $('#btn-admin-img-clear')?.addEventListener('click', () => {
    renderImagePreview('');
    const f = $('#cfg-img-file');
    if (f) f.value = '';
    const hint = $('#cfg-img-hint');
    if (hint) hint.textContent = '已清除，点「保存定价」后生效';
  });
  $('#btn-admin-gen')?.addEventListener('click', genCodes);
  $('#btn-admin-export')?.addEventListener('click', exportCodes);

  
  $('#btn-act-query')?.addEventListener('click', queryActivity);
  $('#btn-act-stats')?.addEventListener('click', activityStats);
  $('#btn-act-clear')?.addEventListener('click', clearActivity);
  $('#act-search')?.addEventListener('keydown', (e) => e.key === 'Enter' && queryActivity());
}

bind();


window.addEventListener('jmkt:auth', (e) => {
  if (e.detail?.admin) {
    loadOverview();
  } else {
    adminReady = false;
    $('#admin-login-card').style.display = '';
    $('#admin-panel').style.display = 'none';
  }
});


document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto="screen-admin"]');
  if (a && (adminReady || S.isAdmin)) setTimeout(loadOverview, 50);
});


(async () => {
  try {
    const d = await api('/api/auth/me', undefined, 'GET');
    if (d.admin) await loadOverview();
    else {
      const h = await fetch('/api/health').then((r) => r.json());
      const hint = $('#admin-first-hint');
      if (hint && h.adminPasswordSet === false) {
        hint.textContent = '尚未设置管理员密码：在上方输入任意 6 位以上密码并填写验证码，即可完成首次设置，请务必记住。';
      }
    }
  } catch {}
})();
