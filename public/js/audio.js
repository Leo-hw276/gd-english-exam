/**
 * audio.js —— 语音合成（播放考试录音）、录音与声学指标分析
 *
 * 考试系统需要：
 *  1. 用 TTS 播放「模仿朗读」范文与听力材料（模仿真实考场录音）
 *  2. 采集考生作答音频，并实时分析声学指标，为流利度评分提供客观依据
 */

/* ==================================================================
 *  1. 语音合成 —— TTS 自动降级
 *
 *  优先：浏览器原生 speechSynthesis（en-US / en-GB 音色）
 *  降级：服务端 /api/tts（Edge-TTS），用户无感知
 *  自检时分别标注状态。
 * ================================================================== */

const PREFERRED_EN = [
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

const PREFERRED_ZH = [
  'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
  'Microsoft Yunxi Online (Natural) - Chinese (Mainland)',
  'Microsoft Huihui - Chinese (Simplified, PRC)',
  'Microsoft Yaoyao - Chinese (Simplified, PRC)',
  'Google 普通话（中国大陆）',
  'Tingting',
  'Mei-Jia',
  'Sinji',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 中文播报文案（与 app.js 的 SAY 保持一致）
const SAY_RECORD_START = '开始录音。';
const SAY_RECORD_DONE = '录音结束。';

export const Tts = {
  _voices: [],
  _mode: 'unknown', // 'native' | 'server' | 'none'（仅用于状态展示）
  _speed: 1,        // 全局倍速
  _audio: null,     // 服务端音频对象（必须能被 stopNow 中止）
  _token: 0,        // 中止令牌：每次 stopNow 自增，旧朗读自动作废

  init() {
    const synth = window.speechSynthesis;
    if (!synth) {
      this._mode = 'server';
      return;
    }
    const load = () => {
      this._voices = synth.getVoices() || [];
      // 音量列表异步加载：加载到就绪后重新判定模式
      if (this._voices.length && this._mode !== 'native') this._mode = 'native';
    };
    load();
    synth.onvoiceschanged = load;
    // 有些浏览器首帧拿不到音色，稍后再取一次
    setTimeout(load, 400);
    setTimeout(load, 1500);
    if (this._voices.length) this._mode = 'native';
  },

  mode() {
    return this._mode;
  },

  setSpeed(s) {
    this._speed = Math.max(0.25, Math.min(3, Number(s) || 1));
  },
  getSpeed() {
    return this._speed;
  },

  available() {
    return this._mode !== 'none';
  },

  statusText() {
    if (this._mode === 'native') {
      return `语音合成：浏览器本地语音（${this._enVoice()?.name || 'en-US'}）`;
    }
    if (this._mode === 'server') return '语音合成：服务端音频';
    return '语音合成：不可用';
  },

  voices() {
    if (!this._voices.length) {
      try {
        this._voices = window.speechSynthesis?.getVoices() || [];
      } catch {}
    }
    return this._voices;
  },

  _enVoice() {
    return this._pickFrom(PREFERRED_EN, 'en');
  },
  _zhVoice() {
    return this._pickFrom(PREFERRED_ZH, 'zh');
  },

  _pickFrom(preferred, prefix) {
    const all = this.voices();
    if (!all.length) return null;
    for (const n of preferred) {
      const v = all.find((x) => x.name === n);
      if (v) return v;
    }
    const hit = all.filter((v) => new RegExp(`^${prefix}([-_]|$)`, 'i').test(v.lang || ''));
    return hit[0] || all.find((v) => new RegExp(prefix, 'i').test(v.lang || '')) || null;
  },

  /** 兼容旧调用 */
  pickVoice() {
    return this._enVoice();
  },

  /** 文本是否含中文 */
  isZh(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
  },

  /**
   * 朗读一段文本，真正读完才 resolve。
   * 降级链：浏览器原生 → 服务端 /api/tts → 静默跳过（不阻塞考试流程）
   * 中文用中文音色，英文用英文音色。
   */
  async speak(text, { rate, pitch = 1, lang } = {}) {
    if (!text) return;
    const speed = rate ?? this._speed;
    const useLang = lang || (this.isZh(text) ? 'zh' : 'en');
    const token = this._token;

    // 1) 原生
    if (window.speechSynthesis) {
      const ok = await this._speakNative(text, { rate: speed, pitch, lang: useLang, token });
      if (ok) {
        this._mode = 'native';
        return;
      }
      if (token !== this._token) return; // 已被中止
    }

    // 2) 服务端（Edge-TTS）
    const ok2 = await this._speakServer(text, { speed, lang: useLang, token });
    if (ok2) {
      this._mode = 'server';
      return;
    }
    if (token === this._token) {
      // 两条通路都失败：本次跳过，但下次仍会重新先试原生（不永久降级）
      this._mode = window.speechSynthesis ? 'native' : 'none';
    }
  },

  /**
   * 原生 speechSynthesis 朗读
   * @returns {Promise<boolean>} 是否真的播放成功
   */
  _speakNative(text, { rate = 0.95, pitch = 1, lang = 'en', token = 0 } = {}) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) return resolve(false);

      const str = String(text);
      const words = str.trim().split(/\s+/).filter(Boolean).length;
      // 中文按字数估时长
      const estMs = lang === 'zh' ? Math.max(4000, str.length * 320) : Math.max(6000, words * 600);

      let done = false;
      let started = false;
      let hardCap = null;
      let poll = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(hardCap);
        resolve(ok);
      };

      const go = () => {
        const u = new SpeechSynthesisUtterance(str);
        const voice = lang === 'zh' ? this._zhVoice() : this._enVoice();
        if (voice) u.voice = voice;
        u.lang = voice?.lang || (lang === 'zh' ? 'zh-CN' : 'en-US');
        u.rate = rate;
        u.pitch = pitch;
        u.volume = 1;

        u.onstart = () => {
          started = true;
        };
        u.onend = () => finish(true);
        u.onerror = () => finish(false);

        try {
          synth.speak(u);
        } catch {
          finish(false);
          return;
        }

        // 看门狗：800ms 内既没开始也没排队 → 视为失败，触发降级
        setTimeout(() => {
          if (done || started) return;
          if (synth.speaking || synth.pending) return;
          try {
            synth.resume();
          } catch {}
          setTimeout(() => {
            if (done || started) return;
            if (synth.speaking || synth.pending) return;
            finish(false);
          }, 500);
        }, 800);
      };

      hardCap = setTimeout(() => finish(started), estMs + 15000);
      poll = setInterval(() => {
        if (done) return;
        if (token !== this._token) return finish(false); // 被 stopNow 中止
        if (synth.speaking || synth.pending) return;
        // 已开始且结束 → 正常收尾
        if (started) return finish(true);
      }, 250);

      // Chrome 已知问题：cancel() 紧跟 speak() 会丢句，先等一下
      if (synth.speaking || synth.pending) {
        try {
          synth.cancel();
        } catch {}
        setTimeout(go, 120);
      } else {
        go();
      }
    });
  },

  /** 服务端 edge-tts 朗读（失败自动重试 2 次） */
  async _speakServer(text, { speed = 1, lang = 'en', token = 0 } = {}) {
    if (!text) return false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await this._speakServerOnce(text, { speed, lang, token });
      if (ok || token !== this._token) return ok;
      if (attempt < 3) await sleep(350 * attempt);
    }
    return false;
  },

  _speakServerOnce(text, { speed = 1, lang = 'en', token = 0 } = {}) {
    return new Promise(async (resolve) => {
      if (!text) return resolve(false);
      const voice = lang === 'zh' ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural';
      try {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }),
        });
        if (!r.ok) {
          console.warn('[tts] 服务端合成失败:', r.status);
          return resolve(false);
        }
        const blob = await r.blob();
        if (token !== this._token) return resolve(false);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this._audio = audio;
        audio.playbackRate = speed;
        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (this._audio === audio) this._audio = null;
        };
        audio.onended = () => {
          cleanup();
          resolve(true);
        };
        audio.onerror = () => {
          cleanup();
          resolve(false);
        };
        await audio.play();
        if (token !== this._token) {
          try {
            audio.pause();
          } catch {}
          cleanup();
          resolve(false);
        }
      } catch (e) {
        console.warn('[tts] 服务端请求失败:', e.message);
        resolve(false);
      }
    });
  },

  cancel() {
    this._token++;
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  },

  /** 立刻停止所有朗读（含服务端音频），供提前交卷/切屏使用 */
  async stopNow() {
    this._token++;
    const synth = window.speechSynthesis;
    try {
      synth?.cancel();
    } catch {}
    if (this._audio) {
      try {
        this._audio.pause();
        this._audio.currentTime = 0;
      } catch {}
      this._audio = null;
    }
    if (!synth) return;
    for (let i = 0; i < 12; i++) {
      if (!synth.speaking && !synth.pending) return;
      try {
        synth.cancel();
      } catch {}
      await sleep(60);
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

/**
 * 播放 3~4 秒的「滴滴」提示音序列（模拟考场倒计时），
 * 每 500ms 滴一声，最后一声频率升高表示开始。
 * @param {(progress01:number) => void} [onTick] 进度回调（0→1）
 * @param {number} [totalMs=3500] 总时长
 */
export async function countdownBeeps({ onTick, totalMs = 3500 } = {}) {
  const INTERVAL = 500;
  const count = Math.round(totalMs / INTERVAL);
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    await beep({ freq: isLast ? 1200 : 800, durMs: isLast ? 200 : 110, gain: 0.1 });
    onTick?.((i + 1) / count);
    if (!isLast) await new Promise((r) => setTimeout(r, INTERVAL - 140));
  }
}

/**
 * 完整录音前准备序列：
 *  1. 滴滴倒计时（3.5s）+ 进度条
 *  2. TTS 播报 "Please start recording now."
 *  3. 播报结束后 resolve → 调用方打开麦克风
 */
export async function recordingPrepare({ onProgress } = {}) {
  await countdownBeeps({ onTick: (p) => onProgress?.(p * 0.7), totalMs: 3500 });
  onProgress?.(0.75);
  await Tts.speak(SAY_RECORD_START, { rate: Tts.getSpeed() });
  onProgress?.(1);
}

/**
 * 录音结束后的播报序列
 */
export async function recordingFinish() {
  await stopCue();
  await Tts.speak(SAY_RECORD_DONE, { rate: Tts.getSpeed() });
}

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
