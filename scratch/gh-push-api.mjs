/**
 * 通过 GitHub REST API 推送整个仓库（不依赖 git 的网络栈）。
 *
 * 为什么需要它：
 *   直连 github.com:443 做 git push 时，大体积传输经常被中途重置
 *   （curl 55 Send failure / RPC failed），而 api.github.com 一直稳定。
 *   本脚本把每个文件作为 blob 上传，再组装成 tree + commit + ref，
 *   效果与 git push 完全等价（提交历史、文件内容都一致）。
 *
 * 用法：
 *   $env:GH_TOKEN='ghp_xxx'; node scratch/gh-push-api.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = (process.env.GH_TOKEN || '').trim();
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = process.env.GH_REPO || 'Leo-hw276/gd-english-exam';
const BRANCH = process.env.GH_BRANCH || 'main';
const R = `/repos/${REPO}`; // 所有 git 数据接口都在这个前缀下
const MSG =
  process.env.GH_MESSAGE ||
  execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const api = async (p, init = {}, retries = 3) => {
  for (let i = 0; i <= retries; i++) {
    try {
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
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (r.status >= 500 && i < retries) {
        await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
        continue;
      }
      return { status: r.status, body, text };
    } catch (e) {
      if (i === retries) throw e;
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    }
  }
};

/* ---------- 0. 确认仓库与令牌 ---------- */
const repo = await api(`/repos/${REPO}`);
if (repo.status !== 200) {
  console.error(`无法访问 ${REPO}：HTTP ${repo.status} ${repo.body?.message || ''}`);
  process.exit(1);
}
console.log(`仓库：${repo.body.html_url}  (${repo.body.private ? '私有' : '公开'})`);

// 全新的空仓库上 Git Data API 会返回 409 "Git Repository is empty"，
// 必须先用 Contents API 落一个初始提交，之后 blob/tree/commit 才能用。
// 注意：不能用 repo.size 判断（它按 KB 取整、且有延迟），要直接看有没有 ref。
const refsNow = await api(R + '/git/refs');
const isEmptyRepo = refsNow.status === 200 && (refsNow.body || []).length === 0;

if (isEmptyRepo) {
  console.log('仓库为空 → 先用 Contents API 创建初始提交…');
  const seed = await api(`${R}/contents/.gitignore`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: 初始化仓库',
      content: Buffer.from('# 由部署脚本初始化\n').toString('base64'),
    }),
  });
  if (seed.status !== 201 && seed.status !== 200) {
    console.error(`  ✗ 初始化失败：${seed.status} ${seed.body?.message || ''}`);
    process.exit(1);
  }
  console.log('  ✓ 初始提交已建立');
} else {
  console.log(`仓库已有分支：${(refsNow.body || []).map((r) => r.ref).join(', ') || '(读取失败，继续尝试)'}`);
}

/* ---------- 1. 取出所有已跟踪文件 ---------- */
// core.quotepath=false 让含中文的文件名以 UTF-8 原样输出，而不是 "\346\234\213..." 这种转义
const files = git(['-c', 'core.quotepath=false', 'ls-files']).split('\n').filter(Boolean);
console.log(`待上传文件：${files.length} 个`);

// 只上传与上一次提交一致的内容（工作区已 commit，保证一致性）
const dirty = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) {
  console.log('提示：工作区有未提交改动，将先自动提交');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: 同步']);
}

/* ---------- 2. 上传 blob ---------- */
const entries = [];
let done = 0;
const CONC = 2; // 并发别太高，避免触发次级限流
let idx = 0;

async function worker() {
  while (idx < files.length) {
    const i = idx++;
    const rel = files[i];
    const abs = path.join(ROOT, rel);
    const buf = fs.readFileSync(abs);
    const isBinary = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip)$/i.test(rel);
    const content = buf.toString('base64');
    const res = await api(R + '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'base64' }),
    });
    if (res.status !== 201) {
      console.error(`  ✗ blob 失败 ${rel}: ${res.status} ${res.body?.message || ''}`);
      process.exit(1);
    }
    entries.push({ path: rel.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: res.body.sha });
    done++;
    if (done % 8 === 0 || done === files.length) {
      console.log(`  已上传 ${done}/${files.length}${isBinary ? ' (含二进制)' : ''}`);
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));

/* ---------- 3. 组装 tree ---------- */
console.log('\n组装文件树…');
const tree = await api(R + '/git/trees', {
  method: 'POST',
  body: JSON.stringify({ tree: entries }),
});
if (tree.status !== 201) {
  console.error(`  ✗ 创建 tree 失败：${tree.status} ${tree.body?.message || ''}`);
  process.exit(1);
}
console.log(`  ✓ tree ${tree.body.sha.slice(0, 10)}（${tree.body.tree.length} 项）`);

/* ---------- 4. 创建 commit ---------- */
const refRes = await api(R + `/git/ref/heads/${BRANCH}`);
const parents = refRes.status === 200 ? [refRes.body.object.sha] : [];
console.log(`创建 commit（${parents.length ? '基于 ' + parents[0].slice(0, 10) : '首个提交'}）…`);

const commit = await api(R + '/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message: MSG,
    tree: tree.body.sha,
    parents,
    author: { name: 'Lieo456le', email: 'Lieo456le@gmail.com' },
    committer: { name: 'Lieo456le', email: 'Lieo456le@gmail.com' },
  }),
});
if (commit.status !== 201) {
  console.error(`  ✗ 创建 commit 失败：${commit.status} ${commit.body?.message || ''}`);
  process.exit(1);
}
console.log(`  ✓ commit ${commit.body.sha.slice(0, 10)}`);

/* ---------- 5. 指向分支 ---------- */
if (parents.length) {
  const up = await api(R + `/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.body.sha, force: true }),
  });
  if (up.status !== 200) {
    console.error(`  ✗ 更新分支失败：${up.status} ${up.body?.message || ''}`);
    process.exit(1);
  }
  console.log(`  ✓ 分支 ${BRANCH} 已更新`);
} else {
  const cr = await api(R + '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.body.sha }),
  });
  if (cr.status !== 201) {
    console.error(`  ✗ 创建分支失败：${cr.status} ${cr.body?.message || ''}`);
    process.exit(1);
  }
  console.log(`  ✓ 分支 ${BRANCH} 已创建（默认分支）`);
}

/* ---------- 6. 补充仓库元信息 ---------- */
await api(`/repos/${REPO}`, {
  method: 'PATCH',
  body: JSON.stringify({
    description:
      '广东中考英语听说（人机对话）在线模拟系统 · 江门考区 · DeepSeek 自动组卷与 30 分制 AI 评分 · 含管理员后台与会员兑换码',
    homepage: '',
    has_issues: true,
    has_wiki: false,
    has_projects: false,
  }),
});
await api(R + '/topics', {
  method: 'PUT',
  headers: { Accept: 'application/vnd.github.mercy-preview+json' },
  body: JSON.stringify({
    names: ['gaokao', 'english', 'listening-speaking', 'deepseek', 'nodejs', 'education', 'zhongkao', 'jiangmen'],
  }),
});

const final = await api(`/repos/${REPO}`);
console.log(`\n✅ 推送成功！`);
console.log(`   ${final.body.html_url}   ${final.body.private ? '私有' : '公开'}   ${(final.body.size / 1024).toFixed(1)} MB`);
console.log(`   默认分支：${final.body.default_branch}`);
console.log(`   文件数：${entries.length}`);
