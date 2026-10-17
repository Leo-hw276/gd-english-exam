/**
 * 一键创建 GitHub 公开仓库并推送当前项目。
 *
 * 用法（令牌只放在环境变量里，绝不写进任何文件）：
 *   $env:GH_TOKEN='ghp_xxx'; node scratch/gh-push.mjs
 *   或： GH_TOKEN=ghp_xxx node scratch/gh-push.mjs [仓库名]
 *
 * 流程：校验令牌 → 创建公开仓库（已存在则复用）→ git remote → git push
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量。用法： $env:GH_TOKEN=\'ghp_xxx\'; node scratch/gh-push.mjs');
  process.exit(1);
}
const NAME = process.argv[2] || 'gd-english-exam';
const ROOT = path.resolve(import.meta.dirname, '..');
const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();

/* ---------- 1. 校验令牌 ---------- */
const api = async (p, init = {}) => {
  const r = await fetch('https://api.github.com' + p, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gd-english-exam',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
};

console.log('① 校验令牌…');
const me = await api('/user');
if (me.status !== 200) {
  console.error(`   ✗ 令牌无效（HTTP ${me.status}）：${me.json?.message || me.text.slice(0, 120)}`);
  console.error('   请到 https://github.com/settings/tokens 重新生成：');
  console.error('   · Classic 令牌：勾选 repo 权限');
  console.error('   · Fine-grained 令牌：Resource owner 选自己，Repository access 选 All repositories，');
  console.error('     Permissions 里 Administration = Read and write、Contents = Read and write');
  process.exit(1);
}
const owner = me.json.login;
console.log(`   ✓ 已认证为 ${owner}（${me.json.name || ''}）`);

/* ---------- 2. 创建仓库（已存在则直接复用） ---------- */
console.log(`② 检查仓库 ${owner}/${NAME}…`);
let repoUrl = `https://github.com/${owner}/${NAME}.git`;
let htmlUrl = `https://github.com/${owner}/${NAME}`;

const existing = await api(`/repos/${owner}/${NAME}`);
if (existing.status === 200) {
  htmlUrl = existing.json.html_url;
  repoUrl = existing.json.clone_url || repoUrl;
  console.log(`   · 仓库已存在（${existing.json.private ? '私有' : '公开'}，size=${existing.json.size}）→ 直接推送`);
} else {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: NAME,
      description:
        '广东中考英语听说（人机对话）在线模拟系统 · 江门考区 · DeepSeek 自动组卷与 30 分制 AI 评分 · 含管理员后台与会员兑换码',
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    }),
  });
  if (created.status === 201) {
    repoUrl = created.json.clone_url;
    htmlUrl = created.json.html_url;
    console.log(`   ✓ 已创建：${htmlUrl}`);
  } else {
    console.error(`   ✗ 仓库不存在且无权创建（HTTP ${created.status}）：${created.json?.message || ''}`);
    console.error('   所需权限：' + (created.headers?.get('x-accepted-github-permissions') || 'administration=write'));
    console.error('   👉 最简单的办法：到 https://github.com/new 手动建一个空的公开仓库，');
    console.error(`      名字填 ${NAME}，不要勾选 Add a README，然后重新运行本脚本。`);
    process.exit(1);
  }
}

/* ---------- 3. 提交与推送 ---------- */
console.log('③ 整理提交…');
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  git(['init', '-q']);
  git(['branch', '-M', 'main']);
}
git(['config', 'user.email', 'Lieo456le@gmail.com']);
git(['config', 'user.name', 'Lieo456le']);
git(['add', '-A']);
const dirty = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT }).status !== 0;
if (dirty) {
  git(['commit', '-q', '-m', 'chore: 更新']);
  console.log('   ✓ 已提交新改动');
} else {
  console.log('   · 没有未提交的改动');
}

const remotes = git(['remote']);
if (!remotes.split('\n').includes('origin')) git(['remote', 'add', 'origin', repoUrl]);
else git(['remote', 'set-url', 'origin', repoUrl]);

console.log('④ 推送到 GitHub…');
const push = spawnSync('git', ['push', '-u', 'origin', 'HEAD:main', '--force'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // 用令牌走 HTTP 头认证，避免把令牌写进 remote URL / .git/config
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://github.com/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
  },
});

if (push.status === 0) {
  console.log(`\n✅ 推送成功！`);
  console.log(`   仓库地址：${htmlUrl}`);
  console.log(`   仓库设置：${existing.status === 200 ? '沿用现有设置（请确认 Visibility = Public）' : '已创建为公开仓库'}`);
} else {
  console.error('   ✗ 推送失败：');
  console.error((push.stderr || '').split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'));
  process.exit(1);
}
