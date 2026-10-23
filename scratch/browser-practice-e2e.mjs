/**
 * 单句精练 全链路浏览器测试：
 *   进入页面 → 模型就绪 → 播放(Kokoro) → 录音(假麦克风) → 识别(Whisper) → 本地对比
 * 同时检查：顶栏文字颜色 / 无管理后台入口 / 管理后台数据按钮存在
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  →  ' + extra : ''}`);
};

const profile = path.resolve('.chrome-profile-e2e2');
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {}
  await sleep(300);
}
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE });
await sleep(2500);

/* ---- 界面检查 ---- */
const topbarColor = await evalJs(`getComputedStyle(document.querySelector('.topnav a')).color`);
ok('顶栏导航文字为深色', !/255, 255, 255/.test(topbarColor), topbarColor);
const navText = await evalJs(`document.querySelector('.topnav').textContent`);
ok('顶栏无「管理后台」入口', !navText.includes('管理后台'), navText.trim().replace(/\s+/g, ' '));
const hasDataBtns = await evalJs(
  `Boolean(document.querySelector('#btn-admin-export') && document.querySelector('#btn-admin-import') && document.querySelector('#btn-admin-clear'))`
);
ok('管理后台有 导出/导入/清空 按钮', hasDataBtns);

/* ---- 进入单句精练（必须点真实导航按钮，showScreen 是模块内函数拿不到） ---- */
await evalJs(`document.querySelector('[data-goto="screen-practice"]')?.click(); 'ok'`);
await sleep(1500);

// 等模型就绪（Kokoro 已缓存，Whisper 也要下载，最多 5 分钟）
const t0 = Date.now();
let status = '';
while (Date.now() - t0 < 300000) {
  status = (await evalJs(`document.querySelector('#pm-status')?.textContent || ''`)) || '';
  if (/就绪/.test(status)) break;
  await sleep(3000);
}
ok('模型加载完成', /就绪/.test(status), status);

const modelsOk = await evalJs(
  `Boolean(window.__practiceState?.tts || document.querySelector('#pm-status').textContent.includes('Kokoro TTS ✅'))`
);
ok('Kokoro TTS 就绪', modelsOk, status);

/* ---- 播放（TTS） ---- */
await evalJs(`document.querySelector('#pg-play')?.click(); 'clicked'`);
let playStatus = '';
const tp = Date.now();
while (Date.now() - tp < 60000) {
  playStatus = (await evalJs(`document.querySelector('#pg-status')?.textContent || ''`)) || '';
  if (/已用|无可用/.test(playStatus)) break;
  await sleep(2000);
}
ok('TTS 播放（Kokoro 本地合成）', /Kokoro 本地生成/.test(playStatus), playStatus);

/* ---- 录音 + 识别 ---- */
await evalJs(`document.querySelector('#pg-record')?.click(); 'rec-start'`);
await sleep(4000); // 假麦克风会输出噪音音频
await evalJs(`document.querySelector('#pg-record')?.click(); 'rec-stop'`);
let recStatus = '';
const t1 = Date.now();
while (Date.now() - t1 < 120000) {
  recStatus = (await evalJs(`document.querySelector('#pg-status')?.textContent || ''`)) || '';
  if (/识别完成|未能识别|录音太短/.test(recStatus)) break;
  await sleep(2000);
}
ok('录音→识别流程完成', /识别完成|未能识别/.test(recStatus), recStatus);

const transcript = await evalJs(`document.querySelector('#pg-transcript')?.textContent || ''`);
console.log('      识别文本:', JSON.stringify(transcript.slice(0, 80)));

/* ---- 截图 ---- */
await send('Page.captureScreenshot', {}).then((r) => {
  fs.mkdirSync('scratch/shots', { recursive: true });
  fs.writeFileSync('scratch/shots/practice-final.png', Buffer.from(r.data, 'base64'));
});

ws.close();
chrome.kill();
await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
