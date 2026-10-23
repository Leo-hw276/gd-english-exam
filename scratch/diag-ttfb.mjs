/**
 * 测量网关在「大 prompt」下的首字节耗时（TTFB）与总耗时。
 * 目的：确认 EXAM_LLM_STALL_MS（停滞看门狗）设多少才既不被慢响应误杀、
 *       又能在网关真的挂住时及时断开、触发本地降级。
 */
import '../data/env.mjs';

const KEY = process.env.EXAM_API_KEY;
const BASE = (process.env.EXAM_API_BASE || '').replace(/\/$/, '');
const MODEL = process.env.EXAM_MODEL || 'DeepSeek-V4.1-Flash';
if (!KEY || !BASE) {
  console.error('缺少 EXAM_API_KEY / EXAM_API_BASE');
  process.exit(1);
}

const body = (n) => {
  const filler = 'The students are talking about their school life and the coming sports meeting. '.repeat(
    Math.ceil(n / 82)
  ).slice(0, n);
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是中考英语听说考试评分员，只输出 JSON。' },
      {
        role: 'user',
        content: `请对下面这段朗读作答评分，输出 JSON：{"score":5.5,"band":"A"}\n\n【参考原文】${filler}\n\n【考生朗读】${filler.slice(0, n / 2)}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 400,
    stream: true,
  };
};

async function measure(label, n) {
  const ctl = new AbortController();
  const hard = setTimeout(() => ctl.abort(), 120000);
  const t0 = Date.now();
  let ttfb = null;
  let chunks = 0;
  let bytes = 0;
  let firstErr = '';
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body(n)),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.log(`FAIL  ${label.padEnd(22)} HTTP ${r.status}  ${t.slice(0, 120)}`);
      clearTimeout(hard);
      return;
    }
    const dec = new TextDecoder();
    for await (const ch of r.body) {
      bytes += ch.length;
      const s = dec.decode(ch, { stream: true });
      for (const line of s.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          const o = JSON.parse(p);
          if (o.error && !firstErr) firstErr = JSON.stringify(o.error).slice(0, 140);
          if (o.choices?.[0]?.delta?.content) {
            chunks++;
            if (ttfb === null) ttfb = Date.now() - t0;
          }
        } catch {}
      }
    }
    clearTimeout(hard);
    const total = Date.now() - t0;
    console.log(
      `PASS  ${label.padEnd(22)} TTFB ${String(ttfb ?? '-').padStart(6)}ms  总 ${String(total).padStart(6)}ms  分片 ${chunks}  ${firstErr ? '流内错误:' + firstErr : ''}`
    );
  } catch (e) {
    clearTimeout(hard);
    console.log(`FAIL  ${label.padEnd(22)} ${e.message}  (${Date.now() - t0}ms)`);
  }
}

console.log('=== 网关大 prompt 响应特性 ===\n');
await measure('小 prompt 500 字符', 500);
await new Promise((r) => setTimeout(r, 800));
await measure('中 prompt 3000 字符', 3000);
await new Promise((r) => setTimeout(r, 800));
await measure('大 prompt 9000 字符', 9000);
await new Promise((r) => setTimeout(r, 800));
await measure('超大 prompt 16000 字符', 16000);
console.log('\n（TTFB 明显大于 25s 说明需要调大 EXAM_LLM_STALL_MS）');
