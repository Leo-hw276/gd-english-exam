/**
 * 浏览器实测：单句精练页 + 手机布局 + 收费页配图
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
const PORT = 9335;
const OUT = path.resolve('docs', 'img');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.chrome-profile3')}`,
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
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

let pass = 0;
let fail = 0;
const check = (l, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${String(ok ? 'PASS' : 'FAIL').padEnd(5)} ${l}${extra ? '  →  ' + extra : ''}`);
};

async function shot(name) {
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(cssContentSize.width, 1440),
      height: Math.min(cssContentSize.height, 5000),
      scale: 1,
    },
  });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  📷', name + '.png');
}

console.log('=== 单句精练页 ===');
await send('Page.navigate', { url: BASE });
await sleep(3000);

// 进入单句精练
await js(`document.querySelector('[data-goto="screen-practice"]').click()`);
await sleep(1500);

check('单句精练页已激活', await js(`document.getElementById('screen-practice').classList.contains('active')`));
const sentence = await js(`document.querySelector('#pg-sentence').textContent`);
check('已展示英文句子', Boolean(sentence) && /[a-zA-Z]/.test(sentence), String(sentence).slice(0, 55));
check('显示主题标签', String(await js(`document.querySelector('#pg-topic').textContent`)).includes('主题'));
check('进度条已出现（模型开始加载）', await js(`document.querySelector('#pm-progress').style.display !== 'none'`));
const pmText = await js(`document.querySelector('#pm-text').textContent`);
console.log('        进度：', String(pmText).slice(0, 80));
check('有音色选择（含英音选项）', (await js(`document.querySelectorAll('#pg-voice option').length`)) >= 6);
check('有语速滑块且默认 0.85', (await js(`document.querySelector('#pg-rate').value`)) === '0.85');
check('播放范文按钮存在', await js(`!!document.querySelector('#pg-play')`));
check('开始录音按钮存在', await js(`!!document.querySelector('#pg-start')`));
check('提交评分按钮默认禁用', await js(`document.querySelector('#pg-submit').disabled === true`));
await shot('11-practice');

// 换一句
const before = await js(`document.querySelector('#pg-sentence').textContent`);
await js(`document.querySelector('#pg-next').click()`);
await sleep(600);
const after = await js(`document.querySelector('#pg-sentence').textContent`);
check('换一句生效', before !== after, String(after).slice(0, 40));

// 播放范文（headless 无音频输出，只验证不抛错、状态更新）
await js(`document.querySelector('#pg-play').click()`);
await sleep(3000);
const st = await js(`document.querySelector('#pg-status').textContent`);
check('点击播放后状态更新', Boolean(st) && st !== '准备就绪', String(st).slice(0, 50));

// 录音开始 → 停止
await js(`document.querySelector('#pg-start').click()`);
await sleep(1800);
check('录音已开始（停止按钮出现）', await js(`!document.querySelector('#pg-stop').classList.contains('hidden')`));
await shot('12-recording');
await js(`document.querySelector('#pg-stop').click()`);
await sleep(2500);
check('停止录音后回到开始态', await js(`document.querySelector('#pg-start').classList.contains('hidden') === false`));
check('生成了录音回放链接', await js(`!document.querySelector('#pg-play-rec').classList.contains('hidden')`));

console.log('\n=== 收费页配图 ===');
await js(`document.querySelector('[data-goto="screen-pricing"]').click()`);
await sleep(1200);
const hasImg = await js(`!!document.querySelector('#price-source img.price-source-img')`);
check('收费页渲染定价配图', hasImg);
await shot('13-pricing-img');

console.log('\n=== 手机布局（375×812）===');
await send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 812,
  deviceScaleFactor: 2,
  mobile: true,
});
await sleep(800);
await js(`document.querySelector('[data-goto="screen-practice"]').click()`);
await sleep(1200);
const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('手机端无横向溢出', overflow <= 1, `溢出 ${overflow}px`);
const navOk = await js(`(() => { const n = document.querySelector('.topnav'); return n.scrollWidth <= n.clientWidth + 2 || getComputedStyle(n).overflowX === 'auto'; })()`);
check('顶部导航在手机端可横向滚动', navOk);
await shot('14-mobile-practice');

await js(`document.querySelector('[data-goto="screen-intro"]').click()`);
await sleep(1000);
const overflow2 = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('首页手机端无横向溢出', overflow2 <= 1, `溢出 ${overflow2}px`);
await shot('15-mobile-intro');

console.log('\n' + '='.repeat(50));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log(`控制台错误：${errors.length} 条`);
errors.slice(0, 6).forEach((e) => console.log('  ⚠️', String(e).split('\n')[0].slice(0, 160)));

ws.close();
chrome.kill();
await sleep(400);
process.exit(fail === 0 ? 0 : 1);
