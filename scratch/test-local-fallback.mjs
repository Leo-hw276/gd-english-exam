/**
 * 验证「AI 不可用 → 本地降级评分」通道：
 *  临时把 API Key 改成无效值 → 调用 /api/score → 应该拿到完整报告而不是报错，且额度不被扣。
 */
import '../data/env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const AD = process.env.ADMIN_PASSWORD || 'jmkt-admin-2026';

const j = async (path, body, method = 'POST', headers = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json() };
};

// 1) 管理员登录
const al = await j('/api/admin/login', { password: AD });
const adminH = { Authorization: 'Bearer ' + al.j.token };
console.log('PASS  管理员登录');

// 2) 备份并写入无效 Key
const ov0 = await j('/api/admin/overview', undefined, 'GET', adminH);
const goodKey = null; // 后台不回显明文，稍后用正确 Key 覆盖回去
const base = ov0.j.settings.apiBase;
const model = ov0.j.settings.model;

await j('/api/admin/settings', { apiKey: 'sk-invalid-key-for-fallback-test' }, 'POST', adminH);
console.log('PASS  已临时写入无效 API Key（用于强制 AI 失败）');

// 3) 建号
const email = `fallback${Date.now()}@example.com`;
const reg = await j('/api/auth/register', { email, password: 'fb123456', name: '降级测试' });
const userH = { Authorization: 'Bearer ' + reg.j.token };
console.log('PASS  注册 →', reg.j.user.freeLeft, '次免费');

// 3.5) 领一张 5 次卡，便于验证「失败不扣费」
const codes = await j('/api/admin/codes', { type: 'credits', value: 5, count: 1, note: 'fallback-test' }, 'POST', adminH);
await j('/api/redeem', { code: codes.j.created[0].code }, 'POST', userH);
const me0 = await j('/api/auth/me', undefined, 'GET', userH);
console.log('PASS  兑换后额度：次卡', me0.j.user.credits, '次 · 免费', me0.j.user.freeLeft, '次');

// 4) 取示例卷
const pr = await j('/api/paper', { offline: true }, 'POST', userH);
const paper = pr.j.paper;

// 5) 构造作答（用正确的 answerIndex 字段）
const mk = (sec) => ({
  durationMs: sec * 1000,
  speechMs: Math.round(sec * 780),
  voicedRatio: 0.78,
  pauseCount: 1,
  longestPauseMs: 400,
  meanPauseMs: 400,
  meanRms: 0.05,
  peakRms: 0.2,
  noiseFloor: 0.002,
  wordsPerMinute: 128,
});

const payload = {
  paper: {
    topic: paper.topic,
    readAloud: paper.readAloud,
    chooseInfo: paper.chooseInfo,
    answerQuestions: paper.answerQuestions,
    retell: paper.retell,
    askQuestions: paper.askQuestions,
  },
  answers: {
    readAloud: { transcript: paper.readAloud.passage, metrics: mk(48) },
    chooseInfo: paper.chooseInfo.map((s) => s.questions.map((q) => ({ transcript: q.options[q.answerIndex], metrics: mk(5) }))),
    answerQuestions: paper.answerQuestions.questions.map((q) => ({ transcript: q.answer, metrics: mk(6) })),
    retell: { transcript: paper.retell.script, metrics: mk(55) },
    askQuestions: paper.askQuestions.map((a) => ({ transcript: a.reference, metrics: mk(6) })),
  },
};

console.log('\n调用 /api/score（AI 必然失败 → 应走本地降级）…\n');
const t0 = Date.now();
const sr = await j('/api/score', payload, 'POST', userH);
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · HTTP ${sr.status}`);

if (sr.status !== 200 || sr.j.ok === false) {
  console.log('FAIL  评分接口报错：', sr.j.error?.slice(0, 300));
} else {
  const r = sr.j;
  console.log(`PASS  仍然拿到了完整报告`);
  console.log('  总分  :', r.total, '/ 30 →', r.grade?.label);
  console.log('  模式  :', r.scoringMode, '(local = 全部本地评分)');
  console.log('  分部  :', JSON.stringify(r.breakdown));
  const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
  console.log(`  算术  : 各分部之和 ${sum.toFixed(1)} vs 总分 ${r.total} → ${Math.abs(sum - r.total) < 0.11 ? 'PASS 一致' : 'FAIL'}`);
  console.log('  额度  :', JSON.stringify(r.quotaAfter));
  console.log('  提示  :');
  (r.warnings || []).forEach((w) => console.log('    ·', w.slice(0, 120)));

  const checks = [
    ['返回了报告而非错误', sr.status === 200],
    ['评分模式为 local', r.scoringMode === 'local'],
    ['总分在合理区间（高分作答应 > 18）', r.total > 18],
    ['朗读得分 > 3', r.breakdown.readAloud > 3],
    ['听选信息得分 > 6', r.breakdown.chooseInfo > 6],
    ['回答问题得分 > 4', r.breakdown.answerQuestions > 4],
    ['转述得分 > 3', r.breakdown.retell > 3],
    ['询问信息得分 > 1.5', r.breakdown.askQuestions > 1.5],
    ['有分档', Boolean(r.detail?.readAloud?.band)],
    ['报告标注了降级原因', (r.warnings || []).length === 3],
  ];
  console.log('');
  checks.forEach(([n, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`));
}

// 6) 恢复正确 Key
// 密钥一律来自环境变量（可写在 .env，已 gitignore），绝不硬编码在代码里
const KEY = process.env.EXAM_API_KEY;
if (!KEY) {
  console.error('缺少 EXAM_API_KEY 环境变量。请在项目根目录建 .env 并写入 EXAM_API_KEY=sk-xxx');
  process.exit(1);
}
await j('/api/admin/settings', { apiKey: KEY, apiBase: base, model }, 'POST', adminH);
console.log('\nPASS  已恢复正确的 API Key');
