/** 验证码端到端测试：大小写混合 + 大小写敏感校验 */
const BASE = process.env.SITE || 'http://127.0.0.1:8777';
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

async function getCaptcha(retries = 5) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(BASE + '/api/captcha');
    if (r.ok) {
      const j = await r.json();
      const glyphs = [...String(j.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
      if (glyphs.length) return { id: j.id, glyphs, answer: glyphs.join(''), svg: j.svg };
    }
    // 被限流或异常：等一会再试
    await new Promise((res) => setTimeout(res, 2200));
  }
  throw new Error('无法获取验证码（可能被限流）');
}

const tryLogin = async (captchaId, captchaCode) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrongpass', captchaId, captchaCode }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

/* 1. 抽样检查字符构成 */
let withUpper = 0, withLower = 0, withDigit = 0, sizes = new Set();
const samples = [];
for (let i = 0; i < 15; i++) {
  const c = await getCaptcha();
  sizes.add(c.answer.length);
  samples.push(c.answer);
  if (/[A-Z]/.test(c.answer)) withUpper++;
  if (/[a-z]/.test(c.answer)) withLower++;
  if (/[0-9]/.test(c.answer)) withDigit++;
}
console.log('样本:', samples.join('  '));
ok('每个验证码都是 4 位', sizes.size === 1 && sizes.has(4), [...sizes].join(','));
ok('全部含大写字母', withUpper === 15, `${withUpper}/15`);
ok('全部含小写字母', withLower === 15, `${withLower}/15`);
ok('全部含数字', withDigit === 15, `${withDigit}/15`);

/* 2. 正确答案 → 验证码通过（错误密码，所以报的是密码错误而不是验证码错误） */
const c1 = await getCaptcha();
const r1 = await tryLogin(c1.id, c1.answer);
ok('输入完全正确的验证码 → 通过校验',
  r1.status === 401 && /邮箱或密码错误/.test(r1.json?.error || ''),
  `${r1.status} ${r1.json?.error}`);

/* 3. 故意改变大小写 → 应被拒绝 */
const c2 = await getCaptcha();
const swapped = c2.answer === c2.answer.toUpperCase() ? c2.answer.toLowerCase() : c2.answer.toUpperCase();
const r2 = await tryLogin(c2.id, swapped);
ok('大小写写错 → 拒绝并提示大小写',
  r2.status === 400 && /大小写/.test(r2.json?.error || ''),
  `${r2.status} ${r2.json?.error}`);

/* 4. 完全错误的字符 → 拒绝 */
const c3 = await getCaptcha();
const bad = 'ZZZZ'.slice(0, c3.answer.length);
const r3 = await tryLogin(c3.id, bad === c3.answer ? 'YYYY' : bad);
ok('字符错误 → 拒绝', r3.status === 400 && /验证码不正确|大小写/.test(r3.json?.error || ''), `${r3.status} ${r3.json?.error}`);

/* 5. 一次性：同一 id 第二次使用必须失败 */
const c5 = await getCaptcha();
await tryLogin(c5.id, c5.answer);
const again = await tryLogin(c5.id, c5.answer);
ok('验证码一次性（重复使用被拒）', again.status === 400 && /过期/.test(again.json?.error || ''), `${again.status} ${again.json?.error}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
