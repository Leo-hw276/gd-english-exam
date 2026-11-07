/**
 * 一次性工具：移除项目源码中的注释（JS / CSS / HTML）。
 * 关键点：正确识别字符串、模板字面量、正则字面量，避免误删 https:// 之类内容。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/DeepSeek Harness/gd-english';

const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await', 'default', 'extends',
]);

export function stripJs(src) {
  let i = 0;
  const out = [];
  let lastWord = '';
  let prevKind = ''; // id | num | str | re | end | punct

  const push = (s) => out.push(s);

  function scanString(q) {
    push(src[i]);
    i++;
    while (i < src.length) {
      const d = src[i];
      if (d === '\\') {
        push(d);
        i++;
        if (i < src.length) {
          push(src[i]);
          i++;
        }
        continue;
      }
      push(d);
      i++;
      if (d === q) break;
    }
    lastWord = '';
    prevKind = 'str';
  }

  function scanTemplate() {
    push(src[i]);
    i++;
    while (i < src.length) {
      const d = src[i];
      if (d === '\\') {
        push(d);
        i++;
        if (i < src.length) {
          push(src[i]);
          i++;
        }
        continue;
      }
      if (d === '`') {
        push(d);
        i++;
        break;
      }
      if (d === '$' && src[i + 1] === '{') {
        push('${');
        i += 2;
        scanCode(true);
        continue;
      }
      push(d);
      i++;
    }
    lastWord = '';
    prevKind = 'str';
  }

  function scanRegex() {
    push(src[i]);
    i++;
    let inClass = false;
    while (i < src.length) {
      const d = src[i];
      if (d === '\\') {
        push(d);
        i++;
        if (i < src.length) {
          push(src[i]);
          i++;
        }
        continue;
      }
      if (d === '[') inClass = true;
      else if (d === ']') inClass = false;
      else if (d === '/' && !inClass) {
        push(d);
        i++;
        break;
      } else if (d === '\n') break;
      push(d);
      i++;
    }
    while (i < src.length && /[a-zA-Z]/.test(src[i])) {
      push(src[i]);
      i++;
    }
    lastWord = '';
    prevKind = 're';
  }

  function scanWord() {
    let w = '';
    while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
      w += src[i];
      push(src[i]);
      i++;
    }
    lastWord = w;
    prevKind = 'id';
  }

  function isRegexStart() {
    if (REGEX_PREV_WORDS.has(lastWord)) return true;
    return !(prevKind === 'id' || prevKind === 'num' || prevKind === 'str' || prevKind === 're' || prevKind === 'end');
  }

  function scanCode(stopOnBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const c2 = src[i + 1];

      if (c === '/' && c2 === '/') {
        i += 2;
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        push(' ');
        continue;
      }
      if (c === "'" || c === '"') {
        scanString(c);
        continue;
      }
      if (c === '`') {
        scanTemplate();
        continue;
      }
      if (c === '/') {
        if (isRegexStart()) scanRegex();
        else {
          push(c);
          i++;
          lastWord = '';
          prevKind = 'punct';
        }
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        scanWord();
        continue;
      }
      if (/[0-9]/.test(c)) {
        push(c);
        i++;
        lastWord = '';
        prevKind = 'num';
        continue;
      }
      if (stopOnBrace) {
        if (c === '{') {
          depth++;
          push(c);
          i++;
          lastWord = '';
          prevKind = 'punct';
          continue;
        }
        if (c === '}') {
          if (depth === 0) {
            push(c);
            i++;
            lastWord = '';
            prevKind = 'end';
            return;
          }
          depth--;
          push(c);
          i++;
          lastWord = '';
          prevKind = 'punct';
          continue;
        }
      }
      if (c === ')' || c === ']' || c === '}') {
        push(c);
        i++;
        lastWord = '';
        prevKind = 'end';
        continue;
      }
      if ((c === '+' || c === '-') && c2 === c) {
        push(c);
        push(c2);
        i += 2;
        lastWord = '';
        prevKind = 'end';
        continue;
      }
      push(c);
      i++;
      if (!/\s/.test(c)) {
        lastWord = '';
        prevKind = 'punct';
      }
    }
  }

  scanCode(false);
  return out.join('');
}

export function stripCss(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      out += q;
      i++;
      while (i < src.length) {
        const d = src[i];
        out += d;
        i++;
        if (d === '\\') {
          if (i < src.length) {
            out += src[i];
            i++;
          }
          continue;
        }
        if (d === q) break;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export function stripHtml(src) {
  let out = '';
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    if (lower.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (lower.startsWith('<script', i)) {
      const end = lower.indexOf('</script>', i);
      if (end === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, end + 9);
      i = end + 9;
      continue;
    }
    if (lower.startsWith('<style', i)) {
      const end = lower.indexOf('</style>', i);
      if (end === -1) {
        out += src.slice(i);
        break;
      }
      const block = src.slice(i, end + 8);
      out += block.replace(/<style([^>]*)>([\s\S]*?)<\/style>/i, (m, attrs, body) => `<style${attrs}>${stripCss(body)}</style>`);
      i = end + 8;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function collect(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'uploads' || name === 'tts-cache') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) collect(full, acc);
    else acc.push(full);
  }
  return acc;
}

export function runAll() {
const targets = [
  path.join(ROOT, 'server.mjs'),
  ...collect(path.join(ROOT, 'data')).filter((f) => f.endsWith('.mjs')),
  ...collect(path.join(ROOT, 'public')).filter((f) => /\.(js|html|css)$/.test(f)),
];

let changed = 0;
for (const f of targets) {
  const src = fs.readFileSync(f, 'utf8');
  let out;
  if (f.endsWith('.mjs') || f.endsWith('.js')) out = stripJs(src);
  else if (f.endsWith('.css')) out = stripCss(src);
  else if (f.endsWith('.html')) out = stripHtml(src);
  else continue;
  if (out !== src) {
    fs.writeFileSync(f, out, 'utf8');
    changed++;
    console.log(`  处理 ${path.relative(ROOT, f)}  ${src.length} -> ${out.length} 字节`);
  }
}
console.log(`完成：${changed}/${targets.length} 个文件已移除注释`);
}

const invoked = String(process.argv[1] || '').split(String.fromCharCode(92)).join('/');
if (invoked.endsWith('scratch/strip-comments.mjs')) runAll();
