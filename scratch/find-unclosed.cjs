// 用真正的 JS 解析器定位未闭合块：逐个顶层块切片尝试解析
const fs = require('fs');
const src = fs.readFileSync('server.mjs', 'utf8');
const lines = src.split('\n');

// 找到所有「顶层函数/语句起始」的候选位置（列 0 开始且不是空行/注释）
const starts = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^(async\s+)?function\s|c^const\s|^let\s|^import\s|^\/\*/.test(l.trim()) && /^\S/.test(l)) {
    starts.push(i);
  }
}

// 二分：找出最小的不以 '}' 结尾的前缀片段
function balanced(text) {
  // 用 Function 构造做粗略语法检查（只检查括号/花括号配对）
  let d = 0, s = null, t = false, lc = false, bc = false, e = false, re = false, prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lc) { if (c === '\n') lc = false; continue; }
    if (bc) { if (c === '*' && n === '/') { bc = false; i++; } continue; }
    if (t) { if (e) { e = false; continue; } if (c === '\\') { e = true; continue; } if (c === '`') t = false; continue; }
    if (s) { if (e) { e = false; continue; } if (c === '\\') { e = true; continue; } if (c === s) s = null; continue; }
    if (c === '/' && n === '/') { lc = true; continue; }
    if (c === '/' && n === '*') { bc = true; i++; continue; }
    if (c === '`') { t = true; continue; }
    if (c === "'" || c === '"') { s = c; continue; }
    if ('{(['.includes(c)) d++;
    if ('})]'.includes(c)) d--;
    prev = c;
  }
  return d;
}

// 逐段累加，找到第一个使深度回到 0 的行（顶层单元边界），记录深度异常的位置
let lastZero = 0;
let bad = -1;
for (let i = 0; i < lines.length; i++) {
  const d = balanced(lines.slice(0, i + 1).join('\n'));
  if (d === 0) lastZero = i + 1;
  if (d < 0 && bad < 0) bad = i + 1;
}
console.log('最后一个深度归零的行:', lastZero, '/', lines.length);
if (bad > 0) console.log('首次出现负深度:', bad);
console.log('文件末尾深度:', balanced(src));
console.log('--- 从第', lastZero, '行开始的内容 ---');
console.log(lines.slice(lastZero, lastZero + 15).map((l, k) => (lastZero + k + 1) + ': ' + l).join('\n'));
