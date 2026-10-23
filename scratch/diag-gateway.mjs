// 诊断：网关流式调用在不同 prompt 长度下是否稳定
import '../data/env.mjs';

// 密钥一律来自环境变量（可写在 .env，已 gitignore），绝不硬编码在代码里
const KEY = process.env.EXAM_API_KEY;
if (!KEY) {
  console.error('缺少 EXAM_API_KEY 环境变量。请在项目根目录建 .env 并写入 EXAM_API_KEY=sk-xxx');
  process.exit(1);
}
const BASE = 'https://api.hcnsec.cn/v1';
const MODEL = 'DeepSeek-V4.1-Flash';

async function call(label, userLen, maxTokens = 2048) {
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(userLen / 45)).slice(0, userLen);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are a JSON-only assistant. Reply with a single JSON object.' },
          { role: 'user', content: `请返回 {"ok":true,"len":${userLen}}。以下内容仅用于测试长度：\n${filler}` },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: true,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.log(`FAIL  ${label}  HTTP ${res.status}  (${Date.now() - t0}ms)  ${t.slice(0, 200)}`);
      return false;
    }
    let content = '';
    const dec = new TextDecoder();
    let buf = '';
    for await (const c of res.body) {
      buf += dec.decode(c, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          const j = JSON.parse(p);
          if (j.error) {
            console.log(`FAIL  ${label}  流内错误: ${JSON.stringify(j.error).slice(0, 200)}`);
            return false;
          }
          content += j.choices?.[0]?.delta?.content || '';
        } catch {}
      }
    }
    console.log(`PASS  ${label}  ${content.length} 字符  (${Date.now() - t0}ms)  ${content.slice(0, 60).replace(/\n/g, ' ')}`);
    return true;
  } catch (e) {
    console.log(`FAIL  ${label}  异常 ${e.message}`);
    return false;
  }
}

console.log('=== 网关稳定性诊断 ===\n');
await call('短 prompt (200 字符)', 200);
await new Promise((r) => setTimeout(r, 1200));
await call('中 prompt (2000 字符)', 2000);
await new Promise((r) => setTimeout(r, 1200));
await call('长 prompt (8000 字符)', 8000);
await new Promise((r) => setTimeout(r, 1200));
await call('超长 prompt (20000 字符)', 20000, 4096);
await new Promise((r) => setTimeout(r, 1200));
await call('长 prompt + 大 max_tokens (12000/8192)', 12000, 8192);

console.log('\n=== 串行小请求快速连打 5 次（探测限流）===');
for (let i = 1; i <= 5; i++) {
  await call(`连打 #${i}`, 300, 256);
}
