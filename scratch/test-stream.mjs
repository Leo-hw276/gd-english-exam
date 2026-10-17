// 密钥一律来自环境变量（可写在 .env，已 gitignore），绝不硬编码在代码里
const KEY = process.env.EXAM_API_KEY;
if (!KEY) {
  console.error('缺少 EXAM_API_KEY 环境变量。请在项目根目录建 .env 并写入 EXAM_API_KEY=sk-xxx');
  process.exit(1);
}
const BASE = 'https://api.hcnsec.cn/v1';

const PROMPT = `为主题「校园生活」命制广东省中考英语听说考试的三段听力对话，只输出 JSON：
{ "chooseInfo": [ { "script": [{"spk":"W","en":"..."},{"spk":"M","en":"..."}],
  "questions": [ {"q":"...","options":["...","...","..."],"answerIndex":0,"evidence":"..."},
                 {"q":"...","options":["...","...","..."],"answerIndex":1,"evidence":"..."} ] } ] }
要求：恰好 3 段，每段恰好 2 题，每段 script 40-70 词。`;

/* 1. 非流式、不带 response_format、单独一个请求 */
async function plain() {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: PROMPT }],
      temperature: 0.8,
      max_tokens: 2000,
    }),
  });
  const t = await r.text();
  console.log(`[plain] ${r.status} ${((Date.now() - t0) / 1000).toFixed(1)}s len=${t.length} :: ${t.slice(0, 200)}`);
}
await plain();
console.log('');

/* 2. 流式 */
async function streamed() {
  const t0 = Date.now();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'DeepSeek-V4-Flash',
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0.8,
        max_tokens: 2000,
        stream: true,
      }),
      signal: ctl.signal,
    });
    console.log(`[stream] status=${r.status} headers after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!r.ok) {
      console.log('   ERR:', (await r.text()).slice(0, 300));
      return;
    }
    let acc = '';
    let firstAt = null;
    let n = 0;
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      if (firstAt === null) firstAt = Date.now();
      acc += dec.decode(chunk, { stream: true });
      n++;
    }
    console.log(`   first byte after ${((firstAt - t0) / 1000).toFixed(1)}s, done ${((Date.now() - t0) / 1000).toFixed(1)}s chunks=${n} bytes=${acc.length}`);
    const text = acc
      .split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => {
        try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; }
      })
      .join('');
    console.log('   content len:', text.length);
    console.log('   head:', text.slice(0, 180).replace(/\n/g, ' '));
  } catch (e) {
    console.log('   THROW', e.message);
  } finally {
    clearTimeout(to);
  }
}
await streamed();
