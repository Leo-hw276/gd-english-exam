const fs = require('fs');
const src = fs.readFileSync('server.mjs', 'utf8');

// 用真实 JS 解析器判断：把文件按顶层单元切分，逐段试解析
const vm = require('vm');

// 方案：用 Function 包装整体，捕获语法错误
try {
  new vm.Script(src, { filename: 'server.mjs' });
  console.log('语法正常（vm.Script 通过）');
} catch (e) {
  console.log('语法错误:', e.message);
  const stack = String(e.stack || '');
  console.log(stack.split('\n').slice(0, 6).join('\n'));
}

// 统计反引号
let bt = 0, dq = 0;
for (const ch of src) {
  if (ch === '`') bt++;
  if (ch === '"') dq++;
}
console.log('反引号总数:', bt, '(偶数=成对)', ' 双引号:', dq);

// 逐行累计反引号，找出计数为奇数的行区间
const lines = src.split('\n');
let open = false;
const oddLines = [];
for (let i = 0; i < lines.length; i++) {
  let n = 0;
  for (const ch of lines[i]) if (ch === '`') n++;
  if (n % 2 === 1) {
    oddLines.push({ line: i + 1, text: lines[i].trim().slice(0, 110), open });
    open = !open;
  }
}
console.log('\n含奇数个反引号的行（模板串起止）:');
for (const o of oddLines) console.log('  L' + o.line + (o.open ? ' [开] ' : ' [闭] ') + o.text);
