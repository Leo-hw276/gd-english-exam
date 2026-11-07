 

const COLORS = {
  idle: '#98a2b3',
  bar: '#6172f3',
  barDone: '#3538cd',
  silent: '#e4e7ec',
};

function setupCanvas(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 64;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

 
export function drawWave(canvas, levels, opts = {}) {
  if (!canvas) return;
  const { progress = null, height = 64, threshold = 0.08 } = opts;
  const { ctx, w, h } = setupCanvas(canvas, height);
  const data = Array.isArray(levels) && levels.length ? levels : new Array(80).fill(0);

  const mid = h / 2;
  const gap = data.length > 160 ? 1 : 2;
  const bw = Math.max(1.2, w / data.length - gap);

  data.forEach((raw, i) => {
    const v = Math.max(0, Math.min(1, raw || 0));
    const x = (i * w) / data.length;
    const bh = Math.max(2, v * (h - 4));
    const y = mid - bh / 2;

    const passed = progress === null || i / data.length <= progress;
    if (v < threshold) ctx.fillStyle = COLORS.silent;
    else if (passed) ctx.fillStyle = progress === null ? COLORS.bar : COLORS.barDone;
    else ctx.fillStyle = '#c7d0e8';

    ctx.beginPath();
    const r = Math.min(bw / 2, 1.6);
    ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
    ctx.fill();
  });

  
  ctx.fillStyle = 'rgba(152,162,179,0.28)';
  ctx.fillRect(0, mid - 0.5, w, 1);

  
  if (progress !== null && progress > 0 && progress < 1) {
    const x = progress * w;
    ctx.fillStyle = '#3538cd';
    ctx.fillRect(x - 1, 0, 2, h);
  }
}

 
export function bindWavePlayer(canvas, audio) {
  if (!canvas || !audio) return;
  const levels = canvas.__levels || [];
  const render = () => {
    const d = audio.duration;
    const p = d && isFinite(d) ? Math.max(0, Math.min(1, audio.currentTime / d)) : 0;
    drawWave(canvas, levels, { progress: p, height: canvas.__h || 64 });
  };
  audio.addEventListener('timeupdate', render);
  audio.addEventListener('loadedmetadata', render);
  audio.addEventListener('seeked', render);
  audio.addEventListener('play', render);
  audio.addEventListener('pause', render);
  audio.addEventListener('ended', () => {
    canvas.__levels && drawWave(canvas, canvas.__levels, { progress: 1, height: canvas.__h || 64 });
  });

  canvas.style.cursor = 'pointer';
  canvas.title = '点击波形可跳转播放位置';
  canvas.addEventListener('click', (e) => {
    const d = audio.duration;
    if (!d || !isFinite(d)) return;
    const rect = canvas.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * d;
    render();
  });

  render();
}

 
export function waveHtml(id, levels, { height = 64, label = '' } = {}) {
  const flat = !levels || !levels.some((v) => v > 0.08);
  return `
    <div class="wavestrip">
      ${label ? `<div class="wavelabel">${label}</div>` : ''}
      <div class="wavewrap">
        <canvas id="${id}-canvas" class="wavecanvas" data-height="${height}"></canvas>
        ${flat ? '<div class="waveempty">（这段没有采集到有效人声）</div>' : ''}
      </div>
    </div>`;
}

 
export function mountWaves(root = document) {
  const canvases = [...root.querySelectorAll('.wavecanvas')];
  canvases.forEach((c) => (c.__h = Number(c.dataset.height) || 64));
  const redraw = () => canvases.forEach((c) => c.__levels && drawWave(c, c.__levels, { height: c.__h }));
  window.addEventListener('resize', redraw);
  return redraw;
}
