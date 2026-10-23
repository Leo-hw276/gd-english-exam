/**
 * 评分链路实测：用一份「高分考生」的模拟作答调用 /api/score
 * 目的：验证三路并行 AI 评分 → 30 分制换算 → 档位判定是否合理。
 */
const BASE = 'http://127.0.0.1:8777';
const fs = await import('node:fs');

// ---- 1. 建号并登录 ----
const email = `score${Date.now()}@example.com`;
const reg = await fetch(BASE + '/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'score123456', name: '高分考生' }),
});
const { token } = await reg.json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
console.log('账号:', email);

// ---- 2. 取试卷（内置示例卷，内容稳定）----
const pr = await fetch(BASE + '/api/paper', { method: 'POST', headers: H, body: JSON.stringify({ offline: true }) });
const { paper } = await pr.json();
console.log('话题:', paper.topic);

// ---- 3. 构造「高分考生」作答 ----
const now = Date.now();
function goodMetrics(sec) {
  return {
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
  };
}

// 朗读：直接用范文原文（满分内容）
const readAloudAns = { transcript: paper.readAloud.passage, metrics: goodMetrics(48) };

// 听选信息：选正确选项（题目结构为 { q, options, answerIndex, evidence }）
const chooseInfo = paper.chooseInfo.map((seg) =>
  seg.questions.map((q) => ({
    transcript: q.options?.[q.answerIndex] || q.options?.[0] || '',
    metrics: goodMetrics(5),
  }))
);

// 回答问题：用 answer / keyPoints 字段
const answerQuestions = paper.answerQuestions.questions.map((q) => ({
  transcript: [q.answer, ...(q.keyPoints || [])].filter(Boolean).join(' '),
  metrics: goodMetrics(6),
}));

// 信息转述：直接用独白原文（内容覆盖满分）
const retellAns = { transcript: paper.retell.script, metrics: goodMetrics(55) };

// 询问信息：用参考问句
const askQuestions = paper.askQuestions.map((a) => ({ transcript: a.reference || a.en || '', metrics: goodMetrics(6) }));

console.log('\n作答准备完毕，开始调用 /api/score（三路并行 AI 评分，约需 40–90 秒）…\n');
const t0 = Date.now();

const sr = await fetch(BASE + '/api/score', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    paper: {
      topic: paper.topic,
      readAloud: paper.readAloud,
      chooseInfo: paper.chooseInfo,
      answerQuestions: paper.answerQuestions,
      retell: paper.retell,
      askQuestions: paper.askQuestions,
    },
    answers: { readAloud: readAloudAns, chooseInfo, answerQuestions, retell: retellAns, askQuestions },
  }),
});

const text = await sr.text();
let r;
try {
  r = JSON.parse(text);
} catch {
  console.log('非 JSON 响应:', text.slice(0, 500));
  process.exit(1);
}

if (r.ok === false) {
  console.log('FAIL 评分接口:', r.error);
  process.exit(1);
}

console.log(`PASS  评分完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log('  总分 :', r.total, '/ 30   →', r.grade?.label);
console.log('  模型 :', r.model);
console.log('  分部 :', JSON.stringify(r.breakdown));

const sum = Object.values(r.breakdown || {}).reduce((a, b) => a + b, 0);
console.log(`  算术校验: 各分部之和 = ${sum.toFixed(1)}，总分 = ${r.total} → ${Math.abs(sum - r.total) < 0.11 ? 'PASS 一致' : 'FAIL 不一致'}`);

// 关键结论
const checks = [
  ['总分在 0–30 之间', r.total >= 0 && r.total <= 30],
  ['朗读得分为正（满分内容）', (r.breakdown?.readAloud || 0) > 3],
  ['听选信息得分为正', (r.breakdown?.chooseInfo || 0) > 4],
  ['信息转述得分为正', (r.breakdown?.retell || 0) > 3],
  ['朗读有分档', Boolean(r.detail?.readAloud?.band)],
  ['转述有三维度', Boolean(r.detail?.retell?.content && r.detail?.retell?.fluency)],
  ['询问信息有参考问句', Boolean(r.detail?.askQuestions?.[0]?.reference)],
];
console.log('');
checks.forEach(([n, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`));

if (r.warnings?.length) console.log('\n  提示:', r.warnings.join('；'));

fs.writeFileSync('scratch/score-report.json', JSON.stringify(r, null, 2), 'utf8');
console.log('\n完整报告已存至 scratch/score-report.json');
