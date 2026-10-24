/** 验证：考试中途结束能立即停止播报/录音；TTS 多次调用不降级 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'http://127.0.0.1:8777';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-t3')}`,
  '--no-first-run',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) console.log('  JS异常:', r.exceptionDetails.text?.slice(0, 200));
  return r?.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: SITE + '/' });
await sleep(3500);

/* 注册 */
const email = `ex_test_${Date.now()}@example.com`;
let reg = false;
for (let attempt = 1; attempt <= 5 && !reg; attempt++) {
  const cap = await ev(`(async()=>{
    document.querySelector('#btn-auth-open')?.click();
    await new Promise(r=>setTimeout(r,1500));
    document.querySelector('#auth-tabs .tab[data-tab="register"]')?.click();
    await new Promise(r=>setTimeout(r,2000));
    const img=document.querySelector('#rg-captcha-img');
    const grab=()=>[...String(img?.innerHTML||'').matchAll(/<text[^>]*>([^<]+)<\\/text>/g)].map(m=>m[1]).join('');
    let g=grab();
    if(!g){ img?.click(); await new Promise(r=>setTimeout(r,1800)); g=grab(); }
    return g;
  })()`);
  if (!cap) { console.log(`  验证码为空，重试 ${attempt}/5`); await sleep(4000); continue; }
  reg = await ev(`(async()=>{
    document.querySelector('#rg-email').value=${JSON.stringify(email)} + '_' + Math.floor(Math.random()*1e6);
    document.querySelector('#rg-pass').value='test123456';
    document.querySelector('#rg-captcha').value=${JSON.stringify(cap)};
    document.querySelector('#btn-register')?.click();
    await new Promise(r=>setTimeout(r,2600));
    return !document.querySelector('#user-chip')?.classList.contains('hidden');
  })()`);
  if (!reg) { console.log(`  注册失败，重试 ${attempt}/5`); await sleep(3000); }
}
ok('注册登录成功', Boolean(reg));

/* TTS 多次调用不降级 */
const ttsModes = await ev(`(async()=>{
  const T=window.__exam?.Tts;
  if(!T) return {err:'Tts 未暴露'};
  const logs=[];
  for(let i=0;i<3;i++){
    const before=T.mode();
    await T.speak('测试语音第'+i+'句。', {rate:1});
    logs.push(before+' -> '+T.mode());
  }
  return logs;
})().catch(e=>String(e))`);
console.log('  TTS 三次调用模式:', JSON.stringify(ttsModes));
ok('TTS 未在首次失败后永久降级', Array.isArray(ttsModes) && ttsModes.every((m) => !String(m).endsWith('none')), JSON.stringify(ttsModes));

/* 开考 */
const started = await ev(`(async()=>{
  document.querySelector('#btn-offline')?.click();
  await new Promise(r=>setTimeout(r,1200));
  return { screen:[...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0],
           nav:document.querySelector('#nav-current')?.textContent||'' };
})()`);
ok('进入考试页（内置卷）', started?.screen === 'screen-exam', JSON.stringify(started));

/* 等到开始录音 */
let recOn = false;
for (let i = 0; i < 95; i++) {
  const st = await ev(`(()=>({ badge:document.querySelector('#recbadge')?.classList.contains('on')||false,
                              btn:!document.querySelector('#btn-stoprec')?.classList.contains('hidden'),
                              phase:document.querySelector('#stage-phase')?.textContent||'' }))()`);
  if (st?.badge) { recOn = true; break; }
  if (i % 15 === 0) console.log(`  ...等待中(${i}s) 阶段=${st?.phase}`);
  await sleep(1000);
}
ok('考试流程进入录音状态', recOn);

/* 中途结束考试 */
const quit = await ev(`(async()=>{
  window.confirm = () => true;
  document.querySelector('#btn-quit')?.click();
  await new Promise(r=>setTimeout(r,600));
  return { recActive: !!document.querySelector('#recbadge')?.classList.contains('on'),
           playing: (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) || false,
           overlay: Boolean(document.querySelector('.overlay')) };
})()`);
ok('结束后录音已停止', quit?.recActive === false, JSON.stringify(quit));
ok('结束后无语音仍在播放', quit?.playing === false);
ok('结束后进入评分', Boolean(quit?.overlay));

/* 等评分结束，检查不会继续跑后续题目 */
await sleep(12000);
const after = await ev(`(()=>({ screen:[...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0],
                                   nav:document.querySelector('#nav-current')?.textContent||'',
                                   recActive: !!document.querySelector('#recbadge')?.classList.contains('on') }))()`);
ok('评分后不再有录音活动', after?.recActive === false, JSON.stringify(after));
ok('流程没有继续推进到后面的题', !/第\s*(7|8|9|10|11|12|13)\s*题/.test(after?.nav || ''), after?.nav);

ws.close(); chrome.kill(); await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
