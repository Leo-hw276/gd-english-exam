/**
 * 端到端验证脚本（无头 Chrome + DevTools Protocol，零依赖）
 *
 * 覆盖：
 *  1. 首页 / 收费页 / 注册页 / 账户页 / 管理后台 —— 逐个检查并截图
 *  2. 真实考试流程：注册 → 载入示例卷 → 模仿朗读（播放2遍 / 准备50s / 录音）→ 点「结束录音」提前答完
 *  3. 评分 → 30 分制成绩报告 → 作答原文与波形回看
 *  全程收集控制台错误与未捕获异常，任何一条都会让结果变成 FAIL。
 *
 * 用法：
 *   node server.mjs --port 8777        # 另开一个终端先启动服务
 *   node scratch/browser-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PORT = 9333;
const OUT = path.resolve('docs', 'img');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 启动浏览器 ---------------- */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.chrome-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('浏览器 CDP 未能启动');
}
await waitCdp();

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);

let msgId = 0;
const pending = new Map();
const errors = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('异常: ' + (d.exception?.description || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('控制台: ' + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const js = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

async function shot(name) {
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(cssContentSize.width, 1440),
      height: Math.min(cssContentSize.height, 4200),
      scale: 1,
    },
  });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  📷', name + '.png');
}

/** 轮询等待条件成立 */
async function until(label, expr, timeoutMs, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return true;
    await sleep(every);
  }
  console.log(`  ⏱ 等待超时：${label}（${Math.round((Date.now() - t0) / 1000)}s）`);
  return false;
}

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  →  ' + extra : ''}`);
};

/* ================= 1. 各页面 ================= */
console.log('=== 1. 首页 ===');
await send('Page.navigate', { url: BASE });
await sleep(3500);
check('页面标题正确', (await js('document.title')).includes('听说'), await js('document.title'));
check('服务端接口正常', (await js("document.querySelector('#pill-api').textContent")).includes('正常'));
check('试卷结构 5 小节', (await js("document.querySelectorAll('#spec-body tr').length")) === 5);
check('考区下拉已填充', (await js("document.querySelector('#inp-city').options.length")) >= 7, (await js("document.querySelector('#inp-city').value")));
check('默认考区为江门', (await js("document.querySelector('#city-hint').textContent")).includes('50'));
await shot('01-intro');

console.log('\n=== 2. 收费标准页 ===');
await js(`document.querySelector('[data-goto="screen-pricing"]').click()`);
await sleep(900);
check('三档价格卡片', (await js("document.querySelectorAll('#price-grid .price-card').length")) === 3);
check('展示定价来源', (await js("document.querySelector('#price-source').textContent")).includes('定价来源'));
await shot('02-pricing');

console.log('\n=== 3. 注册页 ===');
await js(`document.querySelector('#btn-auth-open').click()`);
await sleep(600);
await js(`document.querySelector('#auth-tabs .tab[data-tab="register"]').click()`);
await sleep(400);
check('注册页显示赠送提示', (await js("document.querySelector('#reg-gift').textContent")).includes('新用户福利'));
await shot('03-register');

/* ================= 2. 注册 ================= */
console.log('\n=== 4. 注册并进入考试 ===');
const email = `e2e${Date.now()}@example.com`;
await js(`
  document.querySelector('#rg-name').value='考生小李';
  document.querySelector('#rg-email').value='${email}';
  document.querySelector('#rg-pass').value='exam123456';
  document.querySelector('#btn-register').click();
`);
await sleep(2600);
check('注册成功并赠送免费次数', (await js("document.querySelector('#uc-quota')?.textContent || ''")).includes('免费'), await js("document.querySelector('#uc-quota')?.textContent"));
await shot('04-logged-in');

console.log('\n=== 5. 我的账户页 ===');
await js(`document.querySelector('[data-goto="screen-account"]').click()`);
await sleep(900);
check('账户页显示额度信息', (await js("document.querySelector('#acc-body').textContent")).includes('次卡剩余'));
await shot('05-account');

console.log('\n=== 6. 管理后台 ===');
await js(`document.querySelector('[data-goto="screen-admin"]').click()`);
await sleep(700);
const adminPw = process.env.ADMIN_PASSWORD || 'jmkt-admin-2026';
await js(`document.querySelector('#ad-pass').value='${adminPw}'; document.querySelector('#btn-admin-login').click();`);
await sleep(2500);
const panelOpen = await until('后台展开', `document.querySelector('#admin-panel').style.display !== 'none'`, 15000, 800);
check('管理员登录成功', panelOpen);
if (panelOpen) {
  check('已拉取到可用模型列表', (await js("document.querySelector('#ad-model').options.length")) >= 1, (await js("document.querySelector('#ad-model').options.length + ' 个'")));
  check('用户表有数据', (await js("document.querySelectorAll('#ad-user-table tbody tr').length")) >= 1);
  await shot('06-admin');
}

/* ================= 3. 考试 ================= */
console.log('\n=== 7. 完整考试流程（假麦克风）===');
await js(`document.querySelector('#brand-home').click()`);
await sleep(600);
await js(`document.querySelector('#btn-offline').click()`);
check('进入「一、模仿朗读」', await until('模仿朗读', `document.querySelector('#stage-ttl')?.textContent.includes('模仿朗读')`, 30000));
console.log('  当前阶段:', await js("document.querySelector('#stage-phase').textContent + ' | ' + (document.querySelector('#playstate')?.textContent || '')"));
await shot('07-exam-readaloud');

console.log('\n--- 等待：录音播放 2 遍 → 准备 50 秒 → 自动开始录音 ---');
const recStarted = await until(
  '录音开始',
  `!!document.querySelector('#btn-stoprec') && !document.querySelector('#btn-stoprec').classList.contains('hidden')`,
  200000,
  1500
);
check('江门时长走完并自动开始录音', recStarted);
check('「结束录音」按钮出现', recStarted && (await js("document.querySelector('#btn-stoprec').textContent")).includes('结束录音'));
await sleep(3500);
await shot('08-recording');

await js(`document.querySelector('#btn-stoprec').click()`);
check('点击后立即提前结束录音', await until('提前结束', `document.querySelector('#reclabel').textContent.includes('提前结束')`, 15000, 400));

console.log('\n--- 结束并评分 ---');
await js(`document.querySelector('#btn-quit').click()`);
const scored = await until('成绩报告出现', `document.querySelector('#screen-report').classList.contains('active')`, 300000, 2000);
check('评分完成并展示报告', scored);
if (scored) {
  const total = await js(`document.querySelector('#rp-total').textContent`);
  const grade = await js(`document.querySelector('#rp-grade').textContent`);
  const rows = await js(`document.querySelectorAll('#rp-breakdown .brk-row').length`);
  check('总分在 0–30 之间', Number(total) >= 0 && Number(total) <= 30, `${total}/30 · ${grade}`);
  check('五个分项齐全', rows === 5);
  await shot('09-report');

  await js(`document.querySelector('#btn-review').click()`);
  await sleep(1200);
  check('作答回看弹窗正常', (await js(`document.querySelectorAll('.overlay .wave-card').length`)) >= 1);
  await shot('10-review');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log(`控制台错误与未捕获异常：${errors.length} 条`);
errors.slice(0, 10).forEach((e) => console.log('  ⚠️', e.split('\n')[0].slice(0, 180)));
console.log('截图目录：' + OUT);

ws.close();
chrome.kill();
await sleep(400);
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
