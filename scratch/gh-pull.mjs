import fs from 'node:fs';
import path from 'node:path';

const TOKEN = (process.env.GH_TOKEN || '').trim();
const REPO = 'Leo-hw276/gd-english-exam';
const BRANCH = 'main';
const ROOT = path.resolve(import.meta.dirname, '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node scratch/gh-pull.mjs <文件...>');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gd-pull' };

for (const rel of files) {
  const p = rel.replace(/\\/g, '/');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${p}?ref=${BRANCH}`, { headers });
  if (r.status !== 200) {
    console.log(`✗ ${p} 读取失败 HTTP ${r.status}`);
    continue;
  }
  const meta = await r.json();
  const content = Buffer.from(meta.content, 'base64');
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const old = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  fs.writeFileSync(abs, content);
  const delta = old ? `${old.length} → ${content.length}` : `新增 ${content.length}`;
  console.log(`✓ ${p}  ${delta} 字节`);
}
