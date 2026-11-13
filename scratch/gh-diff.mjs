import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = (process.env.GH_TOKEN || '').trim();
const REPO = 'Leo-hw276/gd-english-exam';
const BRANCH = 'main';
const ROOT = path.resolve(import.meta.dirname, '..');

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'gd-diff',
};

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const refRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers });
const ref = await refRes.json();
const headSha = ref.object.sha;

const commitRes = await fetch(`https://api.github.com/repos/${REPO}/git/commits/${headSha}`, { headers });
const commit = await commitRes.json();
const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${commit.tree.sha}?recursive=1`, { headers });
const tree = await treeRes.json();

const remote = new Map();
for (const e of tree.tree || []) {
  if (e.type === 'blob') remote.set(e.path, e.sha);
}

const localFiles = git(['-c', 'core.quotepath=false', 'ls-files']).split('\n').filter(Boolean);

function blobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const same = [];
const differ = [];
const onlyLocal = [];
const onlyRemote = [];

for (const rel of localFiles) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const sha = blobSha(fs.readFileSync(abs));
  const p = rel.replace(/\\/g, '/');
  if (!remote.has(p)) onlyLocal.push(p);
  else if (remote.get(p) === sha) same.push(p);
  else differ.push(p);
}
for (const p of remote.keys()) {
  if (!localFiles.map((f) => f.replace(/\\/g, '/')).includes(p)) onlyRemote.push(p);
}

console.log(`远端 HEAD: ${headSha.slice(0, 10)}  「${(commit.message || '').split('\n')[0]}」`);
console.log(`远端文件 ${remote.size} 个 / 本地 ${localFiles.length} 个\n`);
console.log(`相同: ${same.length}`);
console.log(`不同: ${differ.length}${differ.length ? '\n  ' + differ.join('\n  ') : ''}`);
console.log(`仅本地有: ${onlyLocal.length}${onlyLocal.length ? '\n  ' + onlyLocal.join('\n  ') : ''}`);
console.log(`仅远端有: ${onlyRemote.length}${onlyRemote.length ? '\n  ' + onlyRemote.join('\n  ') : ''}`);
