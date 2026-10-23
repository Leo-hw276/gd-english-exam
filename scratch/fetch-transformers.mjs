/**
 * 下载 transformers.js（UMD 版）到 public/vendor/ 并确认导出的全局变量名。
 * 自托管的原因：动态 import 从 CDN 拿 UMD 包会失败，且国内直连 CDN 不稳定。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.env.TF_VERSION || '3.3.2';
const OUT = path.resolve('public', 'vendor');
fs.mkdirSync(OUT, { recursive: true });

const SOURCES = [
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}/dist/transformers.min.js`,
  `https://unpkg.com/@huggingface/transformers@${VERSION}/dist/transformers.min.js`,
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}`,
];

async function fetchRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      console.log(`   第 ${i + 1} 次失败：${e.message}`);
      if (i === tries - 1) throw e;
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
}

let code = null;
let used = '';
for (const u of SOURCES) {
  try {
    console.log('尝试', u);
    const t = await fetchRetry(u);
    // UMD 包应该会挂一个全局变量
    if (t.length > 200000 && /transformers/i.test(t)) {
      code = t;
      used = u;
      break;
    }
    console.log('   内容不符合预期，长度', t.length);
  } catch (e) {
    console.log('   跳过：', e.message);
  }
}

if (!code) {
  console.error('全部来源都失败');
  process.exit(1);
}

const file = path.join(OUT, 'transformers.min.js');
fs.writeFileSync(file, code, 'utf8');
console.log(`\n已保存到 ${file}（${(code.length / 1024).toFixed(0)} KB）来源：${used}`);

// 探测 UMD 全局变量名
const head = code.slice(0, 400);
const tail = code.slice(-600);
console.log('\n--- 开头 ---\n' + head.replace(/\n/g, ' ').slice(0, 300));
console.log('\n--- 结尾 ---\n' + tail.replace(/\n/g, ' ').slice(-300));

const candidates = ['transformers', 'Transformers', 'HuggingFace', 'hf'];
for (const c of candidates) {
  const re = new RegExp(`(\\b${c}\\b\\s*=|globalThis\\.${c}|window\\.${c})`);
  if (re.test(code.slice(-4000))) console.log('结尾出现全局赋值:', c);
}
const m = code.match(/globalThis\[["']([\w$]+)["']\]\s*=/);
if (m) console.log('检测到 globalThis[...] 赋值：', m[1]);
