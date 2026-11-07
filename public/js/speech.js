 

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const AsrStatus = {
  UNKNOWN: 'unknown',
  READY: 'ready',
  UNSUPPORTED: 'unsupported',
  DENIED: 'denied',
  NETWORK_FAIL: 'network-fail',
  OK: 'ok',
};

export function isAsrSupported() {
  return Boolean(SR);
}

export class Asr {
  constructor({ lang = 'en-US', maxAlternatives = 3 } = {}) {
    this.lang = lang;
    this.maxAlternatives = maxAlternatives;
    this.recognition = null;
    this.active = false;
    this.finals = [];        
    this.interim = '';       
    this.status = isAsrSupported() ? AsrStatus.UNKNOWN : AsrStatus.UNSUPPORTED;
    this.lastError = null;
    this.onUpdate = null;    
    this.onStatus = null;    
  }

  _setStatus(s, detail) {
    this.status = s;
    this.lastError = detail || null;
    try {
      this.onStatus?.(s, detail);
    } catch {}
  }

  get transcript() {
    return this.finals.join(' ').replace(/\s+/g, ' ').trim();
  }

  get liveText() {
    return (this.transcript + ' ' + this.interim).trim();
  }

  start() {
    if (!isAsrSupported()) {
      this._setStatus(AsrStatus.UNSUPPORTED);
      return false;
    }
    if (this.active) return true;

    this.finals = [];
    this.interim = '';

    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = this.maxAlternatives;
    this.recognition = rec;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = (res[0]?.transcript || '').trim();
        if (!txt) continue;
        if (res.isFinal) {
          
          this.finals.push(txt);
          this._setStatus(AsrStatus.OK);
        } else {
          interim += (interim ? ' ' : '') + txt;
        }
      }
      this.interim = interim;
      try {
        this.onUpdate?.(this.transcript, interim);
      } catch {}
    };

    rec.onerror = (e) => {
      const err = e?.error || 'unknown';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this._setStatus(AsrStatus.DENIED, '麦克风/语音识别权限被拒绝');
        this.active = false;
      } else if (err === 'network') {
        this._setStatus(AsrStatus.NETWORK_FAIL, '语音识别服务不可达（可能无外网或被网络策略拦截）');
        this.active = false;
      } else if (err === 'no-speech') {
        
      } else if (err === 'aborted') {
        
      } else {
        this._setStatus(AsrStatus.NETWORK_FAIL, `语音识别异常：${err}`);
      }
    };

    rec.onend = () => {
      
      if (this.active) {
        try {
          rec.start();
        } catch {
          setTimeout(() => {
            if (this.active) {
              try {
                rec.start();
              } catch {}
            }
          }, 260);
        }
      }
    };

    this.active = true;
    try {
      rec.start();
      this._setStatus(AsrStatus.READY);
    } catch (e) {
      this.active = false;
      this._setStatus(AsrStatus.NETWORK_FAIL, e.message);
      return false;
    }
    return true;
  }

  stop() {
    this.active = false;
    try {
      this.recognition?.stop();
    } catch {}
    try {
      this.recognition?.abort?.();
    } catch {}
    this.recognition = null;
    return this.transcript;
  }
}

 

export function normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

 
export function alignWords(reference, hypothesis) {
  const a = normalizeWords(reference);
  const b = normalizeWords(hypothesis);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const hit = new Array(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    if (dp[i][j] === dp[i - 1][j - 1] + cost) {
      if (cost === 0) hit[i - 1] = true;
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  const missed = a.filter((_, k) => !hit[k]);
  return { refWords: a, heardWords: b, hit, missed, accuracy: n ? hit.filter(Boolean).length / n : 0 };
}
