/**
 * 广东省初中学业水平考试（中考）英语听说考试 —— 权威考试蓝图
 *
 * 依据（均为各地市教育局官方文件，已联网核实）：
 *  - 东莞市教育局《东莞市初中学业水平考试英语听说考试说明》
 *  - 珠海市教育局《珠海市初中学业水平考试英语听说考试方案（试行）》
 *  - 茂名市教育局《茂名市初中学业水平考试英语听说考试方案》
 *  - 广州市中考听说考试题型分值表
 *
 * 结构：三大题 / 五小节 / 14 小题 / 满分 30 分 / 考试时长约 20 分钟
 */

export const EXAM = {
  name: '广东省中考英语听说考试（人机对话）',
  totalScore: 30,
  totalItems: 14,
  durationMin: 20,

  parts: [
    {
      id: 'readAloud',
      order: 1,
      major: '一、模仿朗读',
      section: '',
      title: '模仿朗读',
      items: 1,
      score: 6,
      perItem: 6,
      // 人机对话录音时间分配（东莞/珠海官方）
      timing: { prepareSec: 30, recordSec: 70 },
      task:
        '屏幕呈现一段长度为 60–80 个词的英语短文，播放短文录音 1 遍。考生有 30 秒准备时间，在 70 秒内模仿朗读短文。',
      goal:
        '考查语音能力，包括语音、语调是否正确、自然，语气是否恰当，是否具备较强的模仿能力。',
      rubric: [
        { band: 'A', score: '6', desc: '能连贯地朗读，语音、语调正确，有节奏感、有感情。' },
        { band: 'B', score: '4.5–5.5', desc: '朗读较连贯，语音、语调和节奏较好，有个别错误。' },
        { band: 'C', score: '3–4', desc: '朗读不够流畅，语音、语调和节奏等有一些错误，但不影响理解。' },
        { band: 'D', score: '1–2.5', desc: '朗读不连贯，语音、语调和节奏等有很多错误，影响理解。' },
        { band: 'E', score: '0.5', desc: '只读出短文中的一两个句子，语音、语调很差。' },
        { band: 'F', score: '0', desc: '没有朗读或仅说一些与考试无关的话。' },
      ],
    },
    {
      id: 'chooseInfo',
      order: 2,
      major: '二、信息获取',
      section: '第一节 听选信息',
      title: '听选信息',
      items: 6,
      score: 9,
      perItem: 1.5,
      timing: { readSec: 10, playTimes: 2, recordSec: 8 },
      task:
        '屏幕呈现中文题目要求及英文问题和 3 个备选答案，共播放三段对话或独白录音，每段各播放两遍。各段播放前有 10 秒阅题时间；每段播放后有两个问题，请根据所听到的问题和括号内的提示，在 8 秒内选择正确的信息口头回答。',
      goal: '考查听取信息的能力，包括获取主旨要义、关键信息、说话者意图，以及通过回答问题转达信息的能力。',
      rubric: [
        {
          band: '满分',
          score: '1.5/题',
          desc: '以是否有效交际作为评分的主要参照，简单和完整回答皆可，只要回答是正确的，就可以给满分。',
        },
        { band: '部分', score: '按比例', desc: '回答了部分信息按比例给分。' },
        { band: '零分', score: '0', desc: '回答的信息与答案毫不相关，给零分；回答信息错误得零分。' },
      ],
    },
    {
      id: 'answerQuestions',
      order: 3,
      major: '二、信息获取',
      section: '第二节 回答问题',
      title: '回答问题',
      items: 4,
      score: 6,
      perItem: 1.5,
      timing: { readSec: 15, playTimes: 2, recordSec: 8 },
      task:
        '屏幕呈现中文题目要求及 4 个英语问题，播放一段对话或独白 2 遍。录音播放前有 15 秒阅读 4 个问题；录音播放后，每题在 8 秒内口头回答。',
      goal: '考查听懂信息、筛选信息和传达信息的能力。',
      rubric: [
        {
          band: '满分',
          score: '1.5/题',
          desc: '简单和完整回答皆可，只要回答正确即给满分；完整回答时若出现不影响意思表达的语法错误不扣分。',
        },
        { band: '扣分', score: '−0.5', desc: '出现比较大的语法错误或发音错误酌情扣 0.5 分。' },
        { band: '零分', score: '0', desc: '回答信息错误得零分。' },
      ],
    },
    {
      id: 'retell',
      order: 4,
      major: '三、信息转述及询问',
      section: '第一节 信息转述',
      title: '信息转述',
      items: 1,
      score: 6,
      perItem: 6,
      timing: { readSec: 15, playTimes: 2, prepareSec: 50, recordSec: 60 },
      task:
        '屏幕呈现中文题目要求及信息要点记录（含表格、图表、思维导图等），录音播放 2 遍。考生有 15 秒读题时间，根据录音在 50 秒内做准备，在 60 秒内口头转述短文，包含全部要点。',
      goal: '考查听取信息、记录信息的能力，对话题知识及情景的理解能力，组织文段的语篇能力和表达过程中的策略能力。',
      rubric: [
        {
          band: 'A',
          score: '6',
          desc: '内容：描述具体、丰富、包含所有内容要点，能围绕内容适当发挥。准确性：语音清晰准确，语调正确自然；语言结构正确；得体性好，基本没有语法错误。流畅性：词汇丰富，句子通顺，上下文连贯，表达清楚，语流基本没有错误。',
        },
        {
          band: 'B',
          score: '5–5.5',
          desc: '内容：描述不够全面（欠缺一个内容要点）。准确性：语音基本准确，语调基本正确；结构基本正确，少许语法错误但不影响理解。流畅性：词汇较丰富，句子较通顺，有少量语言和语音错误，语流不太顺畅。',
        },
        {
          band: 'C',
          score: '4–4.5',
          desc: '内容：描述过于简单（欠缺两个内容要点），词语少。准确性：语音语调较差，结构较简单，多处语法错误，有些影响理解。流畅性：词语贫乏，上下文不够连贯，语言和语流错误较多。',
        },
        {
          band: 'D',
          score: '2.5–3.5',
          desc: '内容：描述过于简单（欠缺三个内容要点），词语过少。准确性：语音语调差，句子无条理，较多语法错误，影响理解。流畅性：语言不规范，上下文不够连贯，错误较多。',
        },
        {
          band: 'E',
          score: '1–2',
          desc: '内容：描述偏离内容要点（欠缺四个内容要点），词语非常少。准确性：语音语调很差，语言错误多，影响理解。流畅性：语言非常不规范，上下文不连贯，错误很多。',
        },
        { band: 'F', score: '0.5', desc: '内容：欠缺五个内容要点，言而无物。思维紊乱，语言错误很多，影响理解。' },
        { band: 'G', score: '0', desc: '考生一言不发。' },
      ],
    },
    {
      id: 'askQuestions',
      order: 5,
      major: '三、信息转述及询问',
      section: '第二节 询问信息',
      title: '询问信息',
      items: 2,
      score: 3,
      perItem: 1.5,
      timing: { prepareSec: 15, recordSec: 8 },
      task:
        '屏幕呈现中文题目要求及 2 个中文问题，每题考生有 15 秒准备时间，在 8 秒内用英语翻译问句（口头提问）。',
      goal: '考查语言组织能力、口头翻译能力，以及根据情景和提示口头提问的能力。',
      rubric: [
        {
          band: '评分要素',
          score: '内容完整性 0.75 + 语言准确性 0.75',
          desc: '每小题从内容完整性及语言准确性两个方面进行评分，两个要素各占一半分值。',
        },
        { band: '内容', score: '0.75', desc: '问句所承载的信息要点是否完整、是否问到了指定的内容。' },
        { band: '语言', score: '0.75', desc: '疑问句结构是否正确、时态语态用词是否准确、语序是否规范。' },
      ],
    },
  ],
};

/** 题号分配：与官方"全卷 14 小题"一致 */
export const ITEM_NUMBERING = {
  readAloud: [1],
  chooseInfo: [1, 2, 3, 4, 5, 6],
  answerQuestions: [7, 8, 9, 10],
  retell: [11],
  askQuestions: [12, 13],
};

/**
 * 各考区「人机对话」录音时间参数
 *
 * 广东省各市题型、分值、题量完全一致（三大题 五小节 14 小题 30 分），
 * 但**准备时长与播放遍数**由各市自行规定，因此做成可切换的预设。
 *
 * readAloud.playTimes  模仿朗读录音播放遍数
 * readAloud.prepareSec 模仿朗读准备时间
 * readAloud.recordSec  模仿朗读录音时间
 * retell.prepareSec    信息转述准备时间
 * retell.recordSec     信息转述录音时间
 */
export const CITY_PROFILES = {
  jiangmen: {
    name: '江门市',
    note: '模仿朗读播放录音 2 遍，准备 50 秒后朗读。',
    readAloud: { playTimes: 2, prepareSec: 50, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 60 },
  },
  guangzhou: {
    name: '广州市',
    note: '模仿朗读听短文一遍，准备 50 秒，50 秒内朗读。',
    readAloud: { playTimes: 1, prepareSec: 50, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 50 },
  },
  foshan: {
    name: '佛山市',
    note: '模仿朗读听短文一遍，准备 50 秒后朗读。',
    readAloud: { playTimes: 1, prepareSec: 50, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 60 },
  },
  zhuhai: {
    name: '珠海市',
    note: '模仿朗读播放 1 遍，准备 30 秒，70 秒内朗读。',
    readAloud: { playTimes: 1, prepareSec: 30, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 60 },
  },
  dongguan: {
    name: '东莞市',
    note: '模仿朗读听短文一遍，准备 30 秒，70 秒内朗读。',
    readAloud: { playTimes: 1, prepareSec: 30, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 50 },
  },
  maoming: {
    name: '茂名市',
    note: '模仿朗读播放 1 遍，准备 50 秒后朗读。',
    readAloud: { playTimes: 1, prepareSec: 50, recordSec: 70 },
    retell: { prepareSec: 50, recordSec: 50 },
  },
  qingyuan: {
    name: '清远市',
    note: '模仿朗读准备 50 秒，60 秒内朗读。',
    readAloud: { playTimes: 1, prepareSec: 50, recordSec: 60 },
    retell: { prepareSec: 60, recordSec: 60 },
  },
};

export const DEFAULT_CITY = 'jiangmen';

export function cityProfile(id) {
  return CITY_PROFILES[id] || CITY_PROFILES[DEFAULT_CITY];
}

export const SCORE_TABLE = {
  readAloud: 6,
  chooseInfo: 9,
  answerQuestions: 6,
  retell: 6,
  askQuestions: 3,
};

export function partById(id) {
  return EXAM.parts.find((p) => p.id === id);
}

/* ------------------------------------------------------------------ *
 * 组卷（Paper generation）提示词
 * ------------------------------------------------------------------ */

export const PAPER_SYSTEM_PROMPT = `你是一位资深的广东省初中学业水平考试（中考）英语听说考试命题专家，长期参与"人机对话"听说考试的命题与阅卷定标。

你必须严格按照《广东省中考英语听说考试》的官方题型、题量、分值、词数要求命题，只输出 JSON，不要输出任何解释文字、不要使用 Markdown 代码块。

题材要求：紧扣《义务教育英语课程标准》话题项目表，贴近初中生日常生活（如校园生活、家庭、朋友、健康饮食、运动、旅行、志愿服务、兴趣爱好、环境保护、节日、动物、科技与生活、安全、劳动实践等），语言难度相当于人教版/沪教牛津版九年级水平，句子不宜过难，词汇不超纲。`;

/** 课标话题项目表（用于在服务端预先确定话题，保证两次并行组卷内容一致） */
export const TOPIC_POOL = [
  '校园生活与学习',
  '家庭与亲情',
  '朋友与交往',
  '健康饮食与运动',
  '兴趣爱好与课余生活',
  '旅行与交通',
  '志愿服务与公益',
  '环境保护与低碳生活',
  '传统节日与文化',
  '动物与自然',
  '科技与日常生活',
  '安全与自我保护',
  '劳动实践与家务',
  '梦想与未来职业',
  '家乡与城市介绍',
  '读书与图书馆',
];

export function pickTopic(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return TOPIC_POOL[Math.abs(h) % TOPIC_POOL.length];
}

const commonHead = ({ topic, difficulty, seed }) => `话题：${topic}（全套试题必须统一围绕这个话题展开，情景自然、贴近初中生生活）
难度：${difficulty}（对标九年级下学期中考水平）
随机种子：${seed}（请在选材、人名、情景上体现差异化，不要与常见真题重复）`;

/** 组卷第一批：模仿朗读 + 信息获取第一节（听选信息） */
export function buildPaperPromptPartA({ topic, difficulty = '标准', seed }) {
  return `请命制广东省中考英语听说考试的以下部分。

${commonHead({ topic, difficulty, seed })}

1) readAloud（模仿朗读，1 小题，6 分）
   - passage：一段 **110–120 个英文单词**的短文，语言自然、适合朗读，含一定语调变化（陈述句、疑问句、并列句混合）。
   - 不要在文中加入任何中文或音标提示。

2) chooseInfo（听选信息，6 小题，每题 1.5 分，共 9 分）
   - 共 **恰好 3 段**对话或独白（script），每段对应 **恰好 2 个**问题。
   - 每段 script 为 40–70 词的对话（用 W/M 两个说话人交替）或独白。
   - 题型为「一问两答」：每题的 options 恰好 **2 个简短选项**（每个 1–4 词），
     如 {"q":"Where is he going?","options":["Restaurant","School"],"answerIndex":0}。
     考生听录音后口头说出其中一个选项，系统比对匹配。
   - answerIndex 为 0 或 1，且必须与 script 内容严格一致。
   - evidence：从 script 中原文摘录能支撑答案的一句英文。

【输出 JSON 结构（字段名严格遵守）】
{
  "readAloud": { "passage": "..." },
  "chooseInfo": [
    { "script": [ {"spk":"W","en":"..."}, {"spk":"M","en":"..."} ],
      "questions": [
        { "q": "...", "options": ["...","..."], "answerIndex": 0, "evidence": "..." },
        { "q": "...", "options": ["...","..."], "answerIndex": 1, "evidence": "..." }
      ] }
  ]
}

再次强调：只输出一个 JSON 对象；chooseInfo 恰好 3 段，每段恰好 2 题，每题恰好 2 个选项。`;
}

/** 组卷第二批：回答问题 + 信息转述 + 询问信息 */
export function buildPaperPromptPartB({ topic, difficulty = '标准', seed }) {
  return `请命制广东省中考英语听说考试的以下部分。

${commonHead({ topic, difficulty, seed })}
注意：本批次的「回答问题」与「信息转述」两段录音必须是**两条不同的录音材料**（可以是同一话题下的两个不同情景）。

1) answerQuestions（回答问题，4 小题，每题 1.5 分，共 6 分）
   - script：一段 **110–140 词**的独白或对话，信息密度足够回答 4 个问题。
   - 4 个问题用一般疑问句/特殊疑问句混合，答案都能在 script 中直接找到（简短作答即可）。
   - 每题给出 answer（参考答案，简短形式）和 keyPoints（该题必须体现的信息要点数组，1–3 个）。

2) retell（信息转述，1 小题，6 分）
   - script：一段 **130–160 词**的独白，叙述一件完整的事或有条理地介绍一个人/一项计划。
   - 必须能自然拆分为 **恰好 4 个内容要点**。
   - outline：恰好 4 个要点提示，每个要点写成「思维导图节点」形式= 一个简短问句 + 冒号 + 答案提示，
     例如 "Where is he going?: A restaurant"。顺序与 script 一致，考生照着导图逐点转述。
   - starter：转述开头句（英文，如 "Today Amy will tell us ..."）。
   - referenceRetell：一段 60–90 词的完整英文转述范文，覆盖全部 4 个要点。

3) askQuestions（询问信息，2 小题，每题 1.5 分，共 3 分）
   - 恰好 2 个 **中文问句**（cn），围绕上面 retell 的情景，要求学生现场翻译成英语提问。
   - reference：标准英文问句。
   - mustInclude：该问句必须包含的关键英文要素数组（如 ["your home", "far from", "the TV station"]）。

【输出 JSON 结构（字段名严格遵守）】
{
  "answerQuestions": {
    "script": "...",
    "questions": [ { "q": "...", "answer": "...", "keyPoints": ["..."] } ]
  },
  "retell": {
    "script": "...",
    "outline": ["...","...","...","..."],
    "starter": "...",
    "referenceRetell": "..."
  },
  "askQuestions": [ { "cn": "...", "reference": "...", "mustInclude": ["..."] } ]
}

再次强调：只输出一个 JSON 对象；answerQuestions.questions 恰好 4 题；retell.outline 恰好 4 项；askQuestions 恰好 2 项。`;
}

/* ------------------------------------------------------------------ *
 * 评分（Scoring）提示词
 * ------------------------------------------------------------------ */

export const SCORE_SYSTEM_PROMPT = `你是广东省中考英语听说考试（人机对话）的资深评卷员，严格依据官方评分标准定标给分。

关键事实，你必须理解：
- 系统已用语音识别把你听到的考生语音转写成文本（transcript）。识别系统对发音标准的英语识别率高，对发音错误、吞音、连读不当的语音会出现识别偏差。**转写文本与参考文本的差异，是判断语音准确性最重要的证据之一。**
- 系统同时提供了音频声学指标（acoustic metrics），请用它判断流利性：
  * durationMs 录音总时长；speechMs 实际发声时长；voicedRatio = speechMs/durationMs 为发声占比（过低说明长时间沉默或未作答）。
  * pauseCount 停顿次数（≥300ms 的静音段）；longestPauseMs 最长停顿；meanPauseMs 平均停顿。
  * wordsPerMinute 语速（初中生正常朗读 110–150 wpm；转述 90–130 wpm 属正常）。
  * 若 transcript 为空或 voicedRatio 极低（<0.1），应判定为"未作答/一言不发"，按官方标准给 0 分或最低档。- 学生如果只是简单回答（不需要完整句），只要信息正确就要给满分，不得因句子不完整扣分。
- **识别容错原则（重要）**：语音识别本身不完美，下列差异**必须视为识别误差，不得扣分**：
  * 同音/近音词替换（如 there/their、think/sink、walk/work）；
  * 单复数、冠词、时态等细小的识别偏差（如 a/the、is/are、-s 丢失）；
  * 专有名词、数字、生僻词被识别成别的词；
  * 一句话被拆成两段或漏识别一两个虚词（to/of/in 等）。
  只有当**整句意思错误、关键信息（人/物/时间/地点/数字）明显答错或完全没答**时才扣分。
- **重要：识别服务不可用时的判定规则。** 当 transcript 为空、但 voicedRatio 较高（≥0.3）且 speechMs 接近正常作答所需时长时，
  说明这是「语音识别服务不可用」而不是「考生没开口」。此时不得按 0 分处理，应当只依据声学指标评定流畅度与节奏：
  时长与语速正常、停顿少、发声连贯 → 给 C 档及以上（朗读 3–4.5 分）；并说明「本次未能获取语音转写，评分仅依据音频特征」。
  只有在 voicedRatio 极低（<0.1）且 speechMs 很短时，才判定为未作答给 0 分。
- 不影响意思表达的语法错误不扣分；出现比较大的语法错误或发音错误酌情扣 0.5 分。
- 回答信息错误得零分。

只输出 JSON，不要输出任何解释文字、不要使用 Markdown 代码块。所有分数必须落在给定区间内，且必须保留一位小数。评分要有区分度：不要给所有人满分，也不要刻意压分。`;

function fmtMetrics(m) {
  if (!m) return '（无可用的音频指标）';
  const r = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : '—');
  return [
    `录音总时长=${r(m.durationMs)}ms`,
    `实际发声时长=${r(m.speechMs)}ms`,
    `发声占比=${r(m.voicedRatio)}`,
    `停顿次数=${m.pauseCount ?? '—'}`,
    `最长停顿=${r(m.longestPauseMs)}ms`,
    `平均停顿=${r(m.meanPauseMs)}ms`,
    `语速=${r(m.wordsPerMinute)}词/分`,
    `平均音量=${r(m.meanRms)}`,
  ].join('，');
}

export function buildReadAloudScorePrompt({ passage, transcript, metrics }) {
  const wordCount = passage.trim().split(/\s+/).filter(Boolean).length;
  // 正常朗读 110–150 wpm → 估计读完这篇应耗时多久
  const expectMs = Math.round((wordCount / 130) * 60000);
  const speechMs = Number(metrics?.speechMs) || 0;
  const voicedRatio = Number(metrics?.voicedRatio) || 0;
  const durRatio = expectMs ? speechMs / expectMs : 0;
  const asrMissing =
    !String(transcript || '').trim() && voicedRatio >= 0.3 && durRatio >= 0.55;
  const asrNote = asrMissing
    ? `\n【识别服务提示】转写为空，但考生实际发声 ${Math.round(speechMs / 1000)} 秒、发声占比 ${Math.round(
        voicedRatio * 100
      )}%，与正常读完本文约需 ${Math.round(expectMs / 1000)} 秒相当 —— 这属于「语音识别不可用」，不是「未开口」。` +
      `请按声学指标评定流畅度与节奏，给出 C 档及以上的合理分数，不要判 0 分。`
    : '';

  return `【第一部分：模仿朗读（满分 6 分）】

朗读原文（考生屏幕上看到并应模仿朗读的短文，共 ${wordCount} 词）：
"""${passage}"""

考生语音识别转写（transcript）：
"""${transcript?.trim() || '（识别结果为空）'}"""
${asrNote}
音频声学指标：${fmtMetrics(metrics)}

【官方评分标准（档次分）】
A 档 6 分：能连贯地朗读，语音、语调正确，有节奏感、有感情。
B 档 4.5–5.5 分：朗读较连贯，语音、语调和节奏较好，有个别错误。
C 档 3–4 分：朗读不够流畅，语音、语调和节奏等有一些错误，但不影响理解。
D 档 1–2.5 分：朗读不连贯，语音、语调和节奏等有很多错误，影响理解。
E 档 0.5 分：只读出短文中的一两个句子，语音、语调很差。
F 档 0 分：没有朗读或仅说一些与考试无关的话。

【判分要求】
1. 先把转写文本与原文做逐词对照，找出漏读、替换、增读的词。
2. 结合语速与停顿判断连贯性：语速过慢（<90 wpm）、停顿过多、发声占比低都要降档。
3. 三个维度分别打分（合计必须等于 score）：
   - pronunciation 语音（含音素准确度）满分 2.5
   - intonation 语调与节奏 满分 1.5
   - fluency 流利度 满分 2.0
4. 必须给出考生读错/漏读的具体单词，并给出针对性发音提示（中文说明，可含音标）。

【输出 JSON】
{
  "band": "A|B|C|D|E|F",
  "score": 数字（0–6，一位小数）,
  "dimensions": {
    "pronunciation": { "score": 数字, "max": 2.5, "comment": "中文点评" },
    "intonation":    { "score": 数字, "max": 1.5, "comment": "中文点评" },
    "fluency":       { "score": 数字, "max": 2.0, "comment": "中文点评" }
  },
  "wordAnalysis": {
    "missed": ["漏读的单词"],
    "mispronounced": [ { "word": "单词", "heardAs": "识别成的词", "tip": "发音要点（中文+音标）" } ],
    "accuracy": 数字（0–1，逐词正确率）
  },
  "overall": "总体评语（中文，80 字以内，先表扬再指出问题）",
  "suggestions": ["可操作的改进建议 1", "建议 2", "建议 3"]
}`;
}

export function buildInfoScorePrompt({ paper, answers }) {
  const blocks = [];

  paper.chooseInfo.forEach((seg, si) => {
    blocks.push(`■ 听选信息 第 ${si + 1} 段录音原文：\n${seg.script.map((l) => `${l.spk}: ${l.en}`).join('\n')}`);
    seg.questions.forEach((q, qi) => {
      const n = si * 2 + qi + 1;
      const a = answers.chooseInfo?.[si]?.[qi] || {};
      blocks.push(
        `  【第 ${n} 题】问题：${q.q}\n` +
          `    三个备选：${q.options.map((o, i) => `(${i + 1}) ${o}`).join(' / ')}\n` +
          `    正确答案：${q.options[q.answerIndex]}（依据原文：${q.evidence}）\n` +
          `    考生语音识别转写："""${a.transcript?.trim() || '（空——未作答）'}"""\n` +
          `    音频指标：${fmtMetrics(a.metrics)}`
      );
    });
  });

  blocks.push(`\n■ 回答问题 录音原文：\n${paper.answerQuestions.script}`);
  paper.answerQuestions.questions.forEach((q, qi) => {
    const n = 7 + qi;
    const a = answers.answerQuestions?.[qi] || {};
    blocks.push(
      `  【第 ${n} 题】问题：${q.q}\n` +
        `    参考答案：${q.answer}\n` +
        `    必须体现的信息要点：${(q.keyPoints || []).join('；')}\n` +
        `    考生语音识别转写："""${a.transcript?.trim() || '（空——未作答）'}"""\n` +
        `    音频指标：${fmtMetrics(a.metrics)}`
    );
  });

  return `【第二部分：信息获取（共 15 分）】

第一节 听选信息（6 小题，每题 1.5 分，共 9 分）
第二节 回答问题（4 小题，每题 1.5 分，共 6 分）

${blocks.join('\n\n')}

【官方评分原则】
- 以是否有效交际作为评分的主要参照，简单和完整回答皆可，只要回答是正确的，就可以给满分。
- 回答了部分信息按比例给分（如只答对一半要点给一半分）。
- 回答的信息与答案毫不相关，给零分；回答信息错误得零分。
- 完整回答时若出现不影响意思表达的语法错误不扣分。
- 出现比较大的语法错误或发音错误酌情扣 0.5 分。
- 注意：考生说的答案与标准选项措辞不同但意思相同（如 "In Australia." vs "Australia"）应判正确给满分。

【判分要求】
- 每题先给 verdict：correct（正确）/ partial（部分正确）/ wrong（错误）/ blank（未作答）。
- correct → 1.5 分；partial → 0.5 或 1.0 分；wrong / blank → 0 分。
  * 唯一例外：verdict 为 correct 且存在明显较大语法或发音错误时，给 1.0 分并在 comment 中说明。

【输出 JSON】
{
  "chooseInfo": [
    { "index": 1, "verdict": "correct|partial|wrong|blank", "score": 1.5, "heard": "考生实际说的是什么", "expected": "参考答案", "comment": "中文点评" }
  ],
  "answerQuestions": [
    { "index": 7, "verdict": "...", "score": 1.5, "heard": "...", "expected": "...", "missingPoints": ["漏掉的信息要点"], "comment": "中文点评" }
  ],
  "overall": "本部分总体评语（中文，80 字以内）",
  "suggestions": ["建议 1", "建议 2"]
}
其中 chooseInfo 必须恰好 6 项（index 1–6），answerQuestions 必须恰好 4 项（index 7–10）。`;
}

export function buildRetellAskScorePrompt({ paper, answers }) {
  const outline = paper.retell.outline.map((o, i) => `  要点${i + 1}：${o}`).join('\n');
  const r = answers.retell || {};
  const asks = paper.askQuestions
    .map((q, i) => {
      const a = answers.askQuestions?.[i] || {};
      return (
        `  【第 ${12 + i} 题】中文提示：${q.cn}\n` +
        `    参考英文问句：${q.reference}\n` +
        `    必须包含的关键要素：${(q.mustInclude || []).join(' / ')}\n` +
        `    考生语音识别转写："""${a.transcript?.trim() || '（空——未作答）'}"""\n` +
        `    音频指标：${fmtMetrics(a.metrics)}`
      );
    })
    .join('\n\n');

  return `【第三部分：信息转述及询问（共 9 分）】

第一节 信息转述（1 小题，6 分）
原始录音材料：
"""${paper.retell.script}"""

五个内容要点（转述必须覆盖全部 5 点）：
${outline}

转述开头句提示：${paper.retell.starter}
参考范文（60–90 词）：${paper.retell.referenceRetell}

考生语音识别转写：
"""${r.transcript?.trim() || '（空——未作答）'}"""
音频声学指标：${fmtMetrics(r.metrics)}

【官方评分标准（整体评分法与要素评分法相结合，从内容、准确性、流畅性三方面定档）】
A 档 6 分：内容描述具体、丰富、包含所有要点，能适当发挥；语音清晰准确、语调正确自然，语言结构正确，基本无语法错误；词汇丰富，句子通顺，上下文连贯，语流基本无错误。
B 档 5–5.5 分：欠缺一个内容要点，词语数量不足；语音基本准确，语调基本正确，结构基本正确，少许语法错误但不影响理解；词汇较丰富，句子较通顺，有少量语言和语音错误，语流不太顺畅。
C 档 4–4.5 分：欠缺两个内容要点，词语少；语音语调较差，结构较简单，多处语法错误，有些影响理解；词语贫乏，上下文不够连贯，语言和语流错误较多。
D 档 2.5–3.5 分：欠缺三个内容要点，词语过少；语音语调差，句子无条理，较多语法错误，影响理解；语言不规范，上下文不够连贯，错误较多。
E 档 1–2 分：欠缺四个内容要点，词语非常少；语音语调很差，语言错误多，影响理解；语言非常不规范，上下文不连贯，错误很多。
F 档 0.5 分：欠缺五个内容要点，言而无物；思维紊乱，语言错误很多，影响理解；词不达意，错误很多。
G 档 0 分：考生一言不发。

【判分要求 —— 信息转述】
1. 先逐条判断 5 个内容要点是否被覆盖，列出 coveredPoints 与 missingPoints。**要点数量是定档的第一决定因素。**
2. 三个维度分别打分（合计必须等于 score）：
   - content 内容 满分 3.0（按覆盖要点数量给分：5 点 3.0，4 点 2.4，3 点 1.8，2 点 1.2，1 点 0.6，0 点 0）
   - accuracy 语言准确性 满分 1.5
   - fluency 流畅性 满分 1.5
   最后把三维度之和与官方档次区间核对，把最终 score 调整到与 band 一致的区间内（例如 band 为 B，score 必须落在 5.0–5.5）。
3. 若考生一言不发（转写为空且发声占比 < 0.1），band 必须是 G，score 为 0。

第二节 询问信息（2 小题，每题 1.5 分，共 3 分）
${asks}

【判分要求 —— 询问信息】
每小题从"内容完整性"（0.75 分）与"语言准确性"（0.75 分）两方面独立打分，两者之和为该题得分（保留一位小数）。
- 内容完整性：是否问到了中文提示指定的全部信息要素，漏掉关键要素要扣分。
- 语言准确性：疑问句结构（助动词/疑问词位置/语序）、时态、用词是否准确。若只是陈述句加问号、或语序错误导致歧义，要明显扣分。
- 未作答给 0 分。

【输出 JSON】
{
  "retell": {
    "band": "A|B|C|D|E|F|G",
    "score": 数字（0–6，一位小数，必须落在该 band 的区间内）,
    "content":  { "score": 数字, "max": 3.0, "coveredPoints": ["已覆盖的要点"], "missingPoints": ["缺失的要点"], "comment": "中文点评" },
    "accuracy": { "score": 数字, "max": 1.5, "comment": "中文点评" },
    "fluency":  { "score": 数字, "max": 1.5, "comment": "中文点评" },
    "grammarErrors": [ { "error": "考生说的原句", "correction": "正确说法", "explain": "中文说明" } ],
    "overall": "总体评语（中文，100 字以内）",
    "suggestions": ["建议 1", "建议 2", "建议 3"]
  },
  "askQuestions": [
    { "index": 12, "contentScore": 0.75, "languageScore": 0.75, "score": 1.5,
      "heard": "考生实际说的英文", "reference": "参考英文问句", "comment": "中文点评" }
  ],
  "overall": "本部分总体评语（中文，80 字以内）",
  "suggestions": ["建议 1", "建议 2"]
}
其中 askQuestions 必须恰好 2 项（index 12、13）。`;
}

/* ------------------------------------------------------------------ *
 * 离线兜底试卷（当 API 不可用时仍可完整练习）
 * ------------------------------------------------------------------ */

export const FALLBACK_PAPER = {
  topic: '志愿服务与校园生活',
  offline: true,
  readAloud: {
    passage:
      'Last Saturday our class took part in a volunteer activity at the city park. We met at the school gate at eight in the morning and walked there together. Some students picked up rubbish, and others watered the flowers. An old man thanked us and said the park looked much more beautiful. I felt tired but very happy.',
  },
  chooseInfo: [
    {
      script: [
        { spk: 'W', en: 'Hi, Tom. You look tired today. What did you do last night?' },
        { spk: 'M', en: 'I stayed up late to finish my science report. I only slept for five hours.' },
        { spk: 'W', en: 'That is too bad. You should go to bed earlier tonight.' },
        { spk: 'M', en: 'You are right. I will finish my homework before dinner.' },
      ],
      questions: [
        {
          q: 'What did Tom do last night?',
          options: ['He watched a film.', 'He wrote a report.', 'He played football.'],
          answerIndex: 1,
          evidence: 'I stayed up late to finish my science report.',
        },
        {
          q: 'How long did Tom sleep?',
          options: ['Five hours.', 'Eight hours.', 'Ten hours.'],
          answerIndex: 0,
          evidence: 'I only slept for five hours.',
        },
      ],
    },
    {
      script: [
        { spk: 'M', en: 'Excuse me, how much is this blue schoolbag?' },
        { spk: 'W', en: 'It is one hundred and twenty yuan. The red one is only eighty yuan.' },
        { spk: 'M', en: 'I prefer the blue one. It looks stronger. Do you have a bigger size?' },
        { spk: 'W', en: 'Yes, here you are. It is the last one in our shop.' },
      ],
      questions: [
        {
          q: 'How much is the red schoolbag?',
          options: ['80 yuan.', '120 yuan.', '200 yuan.'],
          answerIndex: 0,
          evidence: 'The red one is only eighty yuan.',
        },
        {
          q: 'Why does the boy choose the blue schoolbag?',
          options: ['It is cheaper.', 'It looks stronger.', 'It is smaller.'],
          answerIndex: 1,
          evidence: 'I prefer the blue one. It looks stronger.',
        },
      ],
    },
    {
      script: [
        { spk: 'W', en: 'Welcome to our school library. It has more than ten thousand books.' },
        { spk: 'M', en: 'Great! Where can I find books about animals?' },
        { spk: 'W', en: 'They are on the second floor, next to the reading room.' },
        { spk: 'M', en: 'Can I borrow four books at a time?' },
        { spk: 'W', en: 'Sorry, you can only borrow three, and you must return them in two weeks.' },
      ],
      questions: [
        {
          q: 'Where are the books about animals?',
          options: ['On the first floor.', 'On the second floor.', 'On the third floor.'],
          answerIndex: 1,
          evidence: 'They are on the second floor, next to the reading room.',
        },
        {
          q: 'How many books can a student borrow at a time?',
          options: ['Two.', 'Three.', 'Four.'],
          answerIndex: 1,
          evidence: 'you can only borrow three',
        },
      ],
    },
  ],
  answerQuestions: {
    script:
      'Hi, everyone. I am Lily, and I would like to tell you about our school volunteer club. The club started three years ago, and now it has about sixty members. We usually meet on Friday afternoons in Room 305. Every month we do one activity outside school. In March, we visited the Old People\'s Home and sang songs for them. In April, we helped to clean the beach near our city. Some of us also teach young children English on Sunday mornings. Joining the club has changed me a lot. I used to be shy, but now I can talk to strangers easily. If you want to help others and make new friends, please come to Room 305 this Friday.',
    questions: [
      {
        q: 'When did the school volunteer club start?',
        answer: 'Three years ago.',
        keyPoints: ['three years ago'],
      },
      {
        q: 'How many members does the club have now?',
        answer: 'About sixty.',
        keyPoints: ['about sixty'],
      },
      {
        q: 'What did the members do in March?',
        answer: 'They visited the Old People\'s Home and sang songs for them.',
        keyPoints: ["visited the Old People's Home", 'sang songs'],
      },
      {
        q: 'How has joining the club changed Lily?',
        answer: 'She used to be shy, but now she can talk to strangers easily.',
        keyPoints: ['used to be shy', 'can talk to strangers easily'],
      },
    ],
  },
  retell: {
    script:
      'Hello, I am Amy. Today I will tell you about our class plan for Mother\'s Day. Mother\'s Day falls on the second Sunday in May. It is a special day for us to say thank you and I love you to our dearest mums. Mother\'s Day is coming in five days, and my classmates and I have many good ideas. Lily is going to make a card with nice pictures for her mum. Peter is going to do all the chores so that his mum can have a good rest. As for me, I am going to send my mum some beautiful flowers and two books, because she loves reading very much. I believe our mums will be very happy.',
    outline: [
      'Mother\'s Day / It is coming.',
      'When / It falls on the second Sunday in May.',
      'Lily / make a card with nice pictures.',
      'Peter / do all the chores, let his mum have a rest.',
      'Amy / send flowers and two books.',
    ],
    starter: 'Today Amy will tell us',
    referenceRetell:
      'Today Amy will tell us about her class plan for Mother\'s Day. Mother\'s Day falls on the second Sunday in May, and it is a special day to say thank you to our mums. It is coming in five days. Lily is going to make a card with nice pictures for her mum. Peter is going to do all the chores so that his mum can have a good rest. As for Amy, she is going to send her mum some beautiful flowers and two books, because her mum loves reading very much. Amy believes their mums will be very happy.',
  },
  askQuestions: [
    {
      cn: '你经常帮你妈妈做家务吗？',
      reference: 'Do you often help your mother do the housework?',
      mustInclude: ['often', 'help your mother', 'housework'],
    },
    {
      cn: '你妈妈喜欢读什么类型的书？',
      reference: 'What kind of books does your mother like reading?',
      mustInclude: ['what kind of books', 'your mother', 'like reading'],
    },
  ],
};
