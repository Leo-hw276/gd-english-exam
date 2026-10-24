const fs = require('fs');
const src = fs.readFileSync('server.mjs', 'utf8');
let depth = 0, inStr = null, inTmpl = false, inLineC = false, inBlockC = false, esc = false;
const lines = src.split('\n');
let report = [];
for (let ln = 0; ln < lines.length; ln++) {
  const line = lines[ln];
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1];
    if (inLineC) break;
    if (inBlockC) { if (c === '*' && n === '/') { inBlockC = false; i++; } continue; }
    if (inTmpl) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === '`') inTmpl = false; continue; }
    if (inStr) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLineC = true; continue; }
    if (c === '/' && n === '*') { inBlockC = true; i++; continue; }
    if (c === '`') { inTmpl = true; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if ('{(['.includes(c)) depth++;
    if ('})]'.includes(c)) depth--;
  }
  inLineC = false;
  if (depth < 0) { console.log('负深度 @L' + (ln + 1) + ': ' + line.trim().slice(0, 120)); break; }
}
console.log('最终深度:', depth);
