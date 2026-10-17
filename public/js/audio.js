/**
 * audio.js —— 语音合成（播放考试录音）、录音与声学指标分析
 *
 * 考试系统需要：
 *  1. 用 TTS 播放「模仿朗读」范文与听力材料（模仿真实考场录音）
 *  2. 采集考生作答音频，并实时分析声学指标，为流利度评分提供客观依据
 */

/* ==================================================================
 *  1. 语音合成 —— 播放考试录音
 * ================================================================== */

const PREFERRED_VOICES = [
  'Microsoft Aria Online (Natural) - English (United States)',
  'Microsoft Jenny Online (Natural) - English (United States)',
  'Microsoft Guy Online (Natural) - English (United States)',
  'Google US English',
  'Microsoft Zira - English (United States)',
  'Microsoft David - English (United States)',
  'Samantha',
  'Karen',
  'Daniel',
];

export const Tts = {
  _voices: [],

  init() {
    if (!('speechSynthesis' in window)) return;
    const load = () => {
      this._voices = window.speechSynthesis.getVoices() || [];
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  },

  available() {
    return 'speechSynthesis' in window;
  },

  voices() {
    if (!this._voices.length) this._voices = window.speechSynthesis.getVoices() || [];
    return this._voices;
  },

  pickVoice() {
    const all = this.voices();
    if (!all.length) return null;
    const byName = (n) => all.find((v) => v.name === n);
    for (const n of PREFERRED_VOICES) {
      const v = byName(n);
      if (v) return v;
    }
    const en = all.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
    return (
      en.find((v) => /en[-_]US/i.test(v.lang)) ||
      en[0] ||
      all.find((v) => /en/i.test(v.lang || '')) ||
      null
    );
  },

  /**
   * 朗读一段英文，返回 Promise（真正读完才 resolve）
   *
   * 注意：部分浏览器 speechSynthesis 的 onend 事件不可靠（有时不触发），
   * 而录音一旦开始、朗读却还在继续，就会出现「我已经开始答题了它还在读」的串音。
   * 因此这里用三重保险确保「读完才返回」：
   *   ① onend / onerror
   *   ② 轮询 synth.speaking / synth.pending 连续两次空闲
   *   ③ 按词数估算的硬上限兜底
   * 并且每次开始前都先 cancel()，杜绝多条语音叠着读。
   */
  speak(text, { rate = 0.95, pitch = 1 } = {}) {
    return new Promise((resolve) => {
      if (!this.available() || !text) return resolve();
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
      } catch {}

      const str = String(text);
      const words = str.trim().split(/\s+/).filter(Boolean).length;

      const u = new SpeechSynthesisUtterance(str);
      u.lang = 'en-US';
      u.rate = rate;
      u.pitch = pitch;
      u.volume = 1;
      const v = this.pickVoice();
      if (v) {
        u.voice = v;
        u.lang = v.lang || 'en-US';
      }

      let settled = false;
      let idle = 0;
      let poll = null;
      let hardCap = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(hardCap);
        resolve();
      };

      u.onend = finish;
      u.onerror = finish;

      // 硬上限：英文朗读约 400ms/词（rate=1），留足余量
      hardCap = setTimeout(finish, Math.max(12000, words * 620 + 8000));

      // 轮询兜底：连续两次确认引擎已空闲即视为读完
      poll = setInterval(() => {
        if (settled) return;
        if (synth.speaking || synth.pending) {
          idle = 0;
        } else if (++idle >= 2) {
          finish();
        }
      }, 250);

      try {
        synth.speak(u);
      } catch {
        finish();
      }
    });
  },

  cancel() {
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  },

  /** 立刻停止朗读并等待引擎真正静音（录音前务必调用） */
  async stopNow() {
    this.cancel();
    const synth = window.speechSynthesis;
    if (!synth) return;
    for (let i = 0; i < 24; i++) {
      if (!synth.speaking && !synth.pending) return;
      await new Promise((r) => setTimeout(r, 60));
    }
  },
};

/* ==================================================================
 *  2. 提示音（模拟考场「开始录音」提示音）
 * ================================================================== */

let sharedCtx = null;
export function audioCtx() {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new AC();
  }
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

export function beep({ freq = 880, durMs = 130, gain = 0.09 } = {}) {
  return new Promise((resolve) => {
    try {
      const ctx = audioCtx();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.012);
      g.gain.setValueAtTime(gain, ctx.currentTime + durMs / 1000 - 0.03);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + durMs / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + durMs / 1000 + 0.02);
      setTimeout(resolve, durMs + 40);
    } catch {
      resolve();
    }
  });
}

export const startCue = () => beep({ freq: 920, durMs: 140 });
export const stopCue = () => beep({ freq: 620, durMs: 180 });

/* ==================================================================
 *  3. 麦克风 & 录音
 * ================================================================== */

export async function listMicrophones() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

/** 申请麦克风权限并返回 MediaStream */
export async function openMic(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持录音（需要 HTTPS 或 localhost 环境）');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
};

/**
 * Recorder —— 录音 + 实时声学指标
 *
 * 指标说明（全部为评分提供客观证据）：
 *  durationMs    录音总时长
 *  speechMs      判定为「发声」的时长（RMS 高于自适应噪声门限）
 *  voicedRatio   发声占比 = speechMs / durationMs
 *  pauseCount    ≥300ms 的内部停顿次数
 *  longestPauseMs / meanPauseMs
 *  meanRms       发声段的平均音量
 *  levels        实时电平序列（用于界面波形）
 */
export class Recorder {
  constructor(stream) {
    this.stream = stream;
    this.frames = [];       // 每 50ms 一个 RMS
    this.levelSeq = [];
    this.chunks = [];
    this.blob = null;
    this.blobUrl = null;
    this.metrics = null;
    this._timer = null;
    this._active = false;
    this.onTick = null;     // (level01) => void
  }

  static pickMime() {
    const list = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const m of list) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
      } catch {}
    }
    return '';
  }

  start() {
    if (this._active) return;
    this._active = true;
    this.frames = [];
    this.levelSeq = [];
    this.chunks = [];
    this._t0 = performance.now();

    const ctx = audioCtx();
    this.ctx = ctx;
    this.srcNode = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.srcNode.connect(this.analyser);
    this._buf = new Float32Array(this.analyser.fftSize);

    // MediaRecorder（用于回放考生自己的作答）
    try {
      const mime = Recorder.pickMime();
      this.mr = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
      this.mr.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.mr.start(250);
    } catch {
      this.mr = null;
    }

    this._timer = setInterval(() => this._sample(), 50);
  }

  _sample() {
    if (!this._active) return;
    let rms = 0;
    try {
      this.analyser.getFloatTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
      rms = Math.sqrt(sum / this._buf.length);
    } catch {
      rms = 0;
    }
    this.frames.push(rms);

    // 电平映射到 0..1（用于界面）
    const lvl = Math.min(1, Math.pow(rms / 0.22, 0.6));
    this.levelSeq.push(lvl);
    this.onTick?.(lvl);
  }

  elapsedMs() {
    return this._active ? performance.now() - this._t0 : 0;
  }

  /**
   * 把实时电平序列压缩成 n 个点的包络，用于绘制波形图。
   * 直接复用录音时采集的 RMS 数据，无需解码音频，任何浏览器都能画。
   */
  envelope(n = 150) {
    const src = this.levelSeq.length
      ? this.levelSeq
      : this.frames.map((v) => Math.min(1, v / 0.22));
    if (!src.length) return new Array(n).fill(0);
    const out = new Array(n).fill(0);
    const step = src.length / n;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      let m = 0;
      for (let k = a; k < b && k < src.length; k++) m = Math.max(m, src[k]);
      out[i] = m;
    }
    return out;
  }

  /** 结束录音，返回 { blob, blobUrl, metrics, envelope } */
  async stop() {
    if (!this._active) {
      return { blob: null, blobUrl: null, metrics: this.metrics, envelope: this.envelope() };
    }
    this._active = false;
    clearInterval(this._timer);
    this._timer = null;

    if (this.mr && this.mr.state !== 'inactive') {
      await new Promise((resolve) => {
        this.mr.onstop = resolve;
        try {
          this.mr.stop();
        } catch {
          resolve();
        }
        setTimeout(resolve, 1200);
      });
    }

    try {
      this.srcNode?.disconnect();
      this.analyser?.disconnect();
    } catch {}

    if (this.chunks.length) {
      this.blob = new Blob(this.chunks, { type: this.chunks[0].type || 'audio/webm' });
      this.blobUrl = URL.createObjectURL(this.blob);
    }

    this.metrics = this._computeMetrics();
    return { blob: this.blob, blobUrl: this.blobUrl, metrics: this.metrics, envelope: this.envelope() };
  }

  _computeMetrics() {
    const FRAME_MS = 50;
    const f = this.frames;
    const durationMs = f.length * FRAME_MS;
    if (!f.length) {
      return {
        durationMs: 0, speechMs: 0, voicedRatio: 0, pauseCount: 0,
        longestPauseMs: 0, meanPauseMs: 0, meanRms: 0, peakRms: 0,
      };
    }

    // 自适应噪声门限：取 RMS 分布的 20 分位作为环境噪声，再乘以 2.6
    const sorted = [...f].sort((a, b) => a - b);
    const noise = percentile(sorted, 0.2);
    const peak = sorted[sorted.length - 1];
    let th = Math.max(0.009, noise * 2.6);
    if (th > peak * 0.5) th = peak * 0.5; // 极安静环境下避免门限过高

    const voiced = f.map((v) => v > th);
    const voicedCount = voiced.filter(Boolean).length;
    const speechMs = voicedCount * FRAME_MS;

    // 统计「发声段之间」的静音段（≥300ms = 6 帧）
    const pauses = [];
    let run = 0;
    let seenVoice = false;
    for (let i = 0; i < voiced.length; i++) {
      if (!voiced[i]) {
        run++;
      } else {
        if (seenVoice && run >= 6) pauses.push(run * FRAME_MS);
        run = 0;
        seenVoice = true;
      }
    } // 结尾的静音不计入停顿

    const voicedRms = f.filter((v) => v > th);
    const meanRms = voicedRms.length ? voicedRms.reduce((a, b) => a + b, 0) / voicedRms.length : 0;

    return {
      durationMs,
      speechMs,
      voicedRatio: Math.round((speechMs / durationMs) * 1000) / 1000,
      pauseCount: pauses.length,
      longestPauseMs: pauses.length ? Math.max(...pauses) : 0,
      meanPauseMs: pauses.length ? Math.round(pauses.reduce((a, b) => a + b, 0) / pauses.length) : 0,
      meanRms: Math.round(meanRms * 10000) / 10000,
      peakRms: Math.round(peak * 10000) / 10000,
      noiseFloor: Math.round(noise * 10000) / 10000,
    };
  }
}

/** 由转写文本补全语速指标 */
export function attachWpm(metrics, transcript) {
  if (!metrics) return metrics;
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(metrics.speechMs, 1) / 60000;
  return { ...metrics, wordCount: words, wordsPerMinute: Math.round(words / minutes) };
}

/* ==================================================================
 *  4. 麦克风试音
 * ================================================================== */

export async function micTest(ms = 4000, onLevel) {
  const stream = await openMic();
  const rec = new Recorder(stream);
  rec.onTick = onLevel || null;
  rec.start();
  await new Promise((r) => setTimeout(r, ms));
  const out = await rec.stop();
  stream.getTracks().forEach((t) => t.stop());
  return { metrics: out.metrics, envelope: out.envelope, blobUrl: out.blobUrl };
}
