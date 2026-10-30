/**
 * admin.js —— 管理员后台
 *
 * 功能：
 *  · 配置 AI 接口（v1 地址 / API Key / 拉取模型列表 / 选择模型 / 连通性测试）
 *  · 设置定价（免费次数、次卡单价、月卡单价与天数、说明文案）→ 实时展示在「收费标准」页
 *  · 生成兑换码（次卡次数 / 月卡天数，随机字母+数字），作废、导出 CSV
 *  · 用户管理（加次数、加天数、重置免费次数、停用、删除、改密码）
 *  · 数据概览与流水日志
 */

import { S, $, $$, esc, toast, showScreen } from './app.js';

let adminReady = false;

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

/* ------------------------------------------------------------------ *
 *  登录
 * ------------------------------------------------------------------ */

async function adminLogin() {
  const pw = $('#cfg-pass').value;
  if (!pw) return toast('请输入密码', 'warn');
  const btn = $('#btn-admin-login');
  const old = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '登录中…';
  }
  try {
    await api('/api/admin/login', { account: 'admin', password: pw });
    $('#cfg-pass').value = '';
    // 登录已成功：先把面板打开（配置卡片是静态 HTML，立刻可见可用），
    // 再去读数据。这样即使部署平台冷启动慢、读取超时，也不会看不到接口配置。
    $('#admin-login-card').style.display = 'none';
    $('#admin-panel').style.display = '';
    adminReady = true;
    toast('已进入后台', 'ok');
    await loadOverview();
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      toast('密码不正确', 'bad', 5000);
    } else {
      toast('登录请求失败：' + e.message + '（部署平台首次访问较慢，请稍后重试）', 'bad', 7000);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || '确认';
    }
  }
}

/* ------------------------------------------------------------------ *
 *  读取概览
 * ------------------------------------------------------------------ */

async function loadOverview() {
  try {
    const d = await api('/api/admin/overview', undefined, 'GET');
    $('#admin-login-card').style.display = 'none';
    $('#admin-panel').style.display = '';
    adminReady = true;

    // 统计
    const st = d.stats || {};
    $('#admin-stats').innerHTML = `
      <div class="stat"><div class="k">注册用户</div><div class="v">${st.users ?? 0}</div></div>
      <div class="stat"><div class="k">月卡会员</div><div class="v">${st.proUsers ?? 0}</div></div>
      <div class="stat"><div class="k">累计考试次数</div><div class="v">${st.attempts ?? 0}</div></div>
      <div class="stat"><div class="k">兑换码</div><div class="v">${st.codesUsed ?? 0} / ${st.codes ?? 0}</div></div>
      <div class="stat"><div class="k">估算营收</div><div class="v">¥${st.revenueEstimate ?? 0}</div></div>`;

    // 接口配置（网站后台是唯一配置入口，数据库为权威来源）
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

    const srcBox = $('#cfg-env-source');
    if (srcBox) {
      const done = (v) => (v === 'db' ? '已配置' : '未配置');
      srcBox.textContent = `接口地址：${done(sources.apiBase)}　密钥：${done(sources.apiKey)}　模型：${done(
        sources.model
      )}`;
    }

    // 定价
    const p = s.pricing || {};
    $('#cfg-free').value = p.freeTrials ?? 2;
    $('#cfg-peruse').value = p.perUse?.price ?? 2.9;
    $('#cfg-monthly').value = p.monthly?.price ?? 29.9;
    $('#cfg-days').value = p.monthly?.days ?? 30;
    $('#cfg-peruse-desc').value = p.perUse?.desc || '';
    $('#cfg-monthly-desc').value = p.monthly?.desc || '';
    $('#cfg-free-note').value = p.freeTrialNote || '';
    $('#cfg-source').value = p.sourceNote || '';
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

function fillModelSelect(models, current) {
  // ad-model 是可输入文本框 + datalist：既能下拉选，也能手填模型名
  const input = $('#cfg-model');
  const list = $('#cfg-model-list');
  if (current && !models.includes(current)) models = [current, ...models];
  if (list) {
    list.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
  }
  if (input && document.activeElement !== input) {
    input.value = current || input.value || '';
  }
  const hint = $('#cfg-model-hint');
  if (hint) hint.textContent = models.length ? `共 ${models.length} 个可用模型` : '';
}

function fillRegionSelect(current) {
  const sel = $('#cfg-region');
  const cities = S.cities || {};
  const entries = Object.entries(cities);
  sel.innerHTML = entries.length
    ? entries.map(([k, v]) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(v.name)}</option>`).join('')
    : `<option value="${esc(current || 'jiangmen')}">${esc(current || 'jiangmen')}</option>`;
}

/* ------------------------------------------------------------------ *
 *  接口配置
 * ------------------------------------------------------------------ */

async function fetchModels() {
  const hint = $('#cfg-model-hint');
  hint.textContent = '正在拉取…';
  try {
    const d = await api('/api/admin/models', {
      apiBase: $('#cfg-base').value.trim(),
      apiKey: $('#cfg-key').value.trim() || undefined,
    });
    fillModelSelect(d.models, $('#cfg-model').value || S.cfg?.model);
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
    // 传当前输入框的值：改了还没保存也能直接测
    const d = await api('/api/admin/test', {
      apiBase: $('#cfg-base').value.trim() || undefined,
      apiKey: $('#cfg-key').value.trim() || undefined,
      model: $('#cfg-model').value.trim() || undefined,
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
    model: $('#cfg-model').value,
    examRegion: $('#cfg-region').value,
    paperTemperature: Number($('#cfg-tpaper').value),
    scoreTemperature: Number($('#cfg-tscore').value),
  };
  const key = $('#cfg-key').value.trim();
  if (key) body.apiKey = key;
  try {
    await api('/api/admin/settings', body);
    hint.textContent = '已保存';
    toast('接口配置已保存', 'ok');
    $('#cfg-key').value = '';
    await loadOverview();
  } catch (e) {
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

/* ------------------------------------------------------------------ *
 *  定价
 * ------------------------------------------------------------------ */

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
    });
    hint.textContent = '已保存';
    toast('定价已更新，前台收费页立即生效', 'ok');
    // 同步到本地状态，前台收费页立刻刷新
    const h = await api('/api/health', undefined, 'GET');
    S.pricing = h.pricing;
    await loadOverview();
  } catch (e) {
    toast('保存失败：' + e.message, 'bad', 5000);
  }
}

/* ------------------------------------------------------------------ *
 *  安全管控（紧急开关）
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  公告栏 & 账号异常公示（管理员）
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  定价说明配图
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ *
 *  用户数据：导出 / 导入 / 一键清空
 * ------------------------------------------------------------------ */

async function exportUsers() {
  const hint = $('#cfg-user-hint');
  try {
    const d = await api('/api/admin/users', { action: 'export' });
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = URL.createObjectURL(blob);
    a.download = `users-backup-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (hint) hint.textContent = `已导出 ${d.users?.length || 0} 个用户`;
    toast(`已导出 ${d.users?.length || 0} 个用户（含密码哈希，请妥善保管）`, 'ok', 6000);
  } catch (e) {
    toast('导出失败：' + e.message, 'bad', 6000);
  }
}

async function importUsers(e) {
  const file = e.target.files?.[0];
  const hint = $('#cfg-user-hint');
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const n = Array.isArray(data) ? data.length : data?.users?.length || 0;
    if (!n) throw new Error('文件里没有用户数据');
    const mode = confirm(
      `即将导入 ${n} 个用户。\n\n点「确定」= 合并（同邮箱覆盖，其余保留）\n点「取消」= 取消导入`
    )
      ? 'merge'
      : null;
    if (!mode) {
      if (hint) hint.textContent = '已取消';
      return;
    }
    if (hint) hint.textContent = '导入中…';
    const r = await api('/api/admin/users', { action: 'import', mode, data });
    toast(r.message, 'ok', 6000);
    if (hint) hint.textContent = r.message;
    await loadOverview();
  } catch (err) {
    toast('导入失败：' + err.message, 'bad', 7000);
    if (hint) hint.textContent = '导入失败';
  } finally {
    e.target.value = '';
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

/* ------------------------------------------------------------------ *
 *  用户管理
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  日志
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  安全审计日志
 * ------------------------------------------------------------------ */

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
    return `<tr>
      <td>${fmtTime(e.at)}</td>
      <td>${esc(fmtKind(e.kind))}</td>
      <td${cls}>${esc(e.action || '')}</td>
      <td>${esc(e.email || e.userId || '')}</td>
      <td>${esc(e.ip || '')}</td>
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

/* ------------------------------------------------------------------ *
 *  绑定
 * ------------------------------------------------------------------ */

function bind() {
  $('#btn-admin-login')?.addEventListener('click', adminLogin);
  $('#cfg-pass')?.addEventListener('keydown', (e) => e.key === 'Enter' && adminLogin());
  $('#btn-admin-refresh')?.addEventListener('click', () => loadOverview().then(() => toast('已刷新', 'ok', 1500)));
  $('#btn-admin-models')?.addEventListener('click', fetchModels);
  $('#btn-admin-test')?.addEventListener('click', testConn);
  $('#btn-admin-save')?.addEventListener('click', saveApi);
  $('#btn-admin-save-price')?.addEventListener('click', savePricing);
  $('#btn-admin-save-security')?.addEventListener('click', saveSecurity);
  $('#btn-nt-add')?.addEventListener('click', addAnnouncement);
  $('#btn-ab-add')?.addEventListener('click', addAbnormal);
  $('#btn-admin-export')?.addEventListener('click', exportUsers);
  $('#btn-admin-import')?.addEventListener('click', () => $('#cfg-import-file')?.click());
  $('#cfg-import-file')?.addEventListener('change', importUsers);
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

  // 活动日志
  $('#btn-act-query')?.addEventListener('click', queryActivity);
  $('#btn-act-stats')?.addEventListener('click', activityStats);
  $('#btn-act-clear')?.addEventListener('click', clearActivity);
  $('#act-search')?.addEventListener('keydown', (e) => e.key === 'Enter' && queryActivity());
}

bind();

// 登录态变化时自动加载 / 卸载后台
window.addEventListener('jmkt:auth', (e) => {
  if (e.detail?.admin) {
    loadOverview();
  } else {
    adminReady = false;
    $('#admin-login-card').style.display = '';
    $('#admin-panel').style.display = 'none';
  }
});

// 进入后台时若已登录，自动拉数据
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto="screen-admin"]');
  if (a && (adminReady || S.isAdmin)) setTimeout(loadOverview, 50);
});

// 首次进入显示提示
(async () => {
  try {
    const d = await api('/api/auth/me', undefined, 'GET');
    if (d.admin) await loadOverview();
    else {
      const h = await fetch('/api/health').then((r) => r.json());
      const hint = $('#admin-first-hint');
      if (hint) hint.textContent = '初始状态尚未设置管理员密码：在下方输入任意 6 位以上密码即可完成首次设置，请务必记住。';
    }
  } catch {}
})();
