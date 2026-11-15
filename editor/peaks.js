import { loadBinary, loadJson } from './source.js';

const bins = new Map();
let index = null;

/** Spis plików waveformu pozwala nie pytać o nieistniejące pliki — 404 na każde
 * kliknięcie odcinka byłoby tylko szumem w konsoli. */
const loadIndex = async () => {
  if (index === null) index = (await loadJson('data/peaks/index.json').catch(() => null)) ?? { episodes: {} };
  return index;
};

export const peaksMeta = async (id) => {
  const list = await loadIndex();
  return list.episodes?.[id] ?? null;
};

export const loadPeaks = async (id) => {
  if (bins.has(id)) return bins.get(id);
  if (!(await peaksMeta(id))) return null;
  const data = await loadBinary(`data/peaks/${id}.bin`);
  bins.set(id, data);
  return data;
};

export const drawWaveform = (canvas, peaks, perSec, durationSec, positionSec) => {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!peaks || !peaks.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('brak waveformu — czasy wpisujemy ręcznie', 8, height / 2);
    return;
  }

  const total = durationSec > 0 ? durationSec : peaks.length / perSec;
  const step = 2;
  ctx.fillStyle = 'rgba(120, 200, 255, 0.55)';
  for (let x = 0; x < width; x += step) {
    const from = Math.floor((x / width) * total * perSec);
    const to = Math.max(from + 1, Math.floor(((x + step) / width) * total * perSec));
    let loudest = 0;
    for (let at = from; at < to && at < peaks.length; at += 1) {
      if (peaks[at] > loudest) loudest = peaks[at];
    }
    const bar = Math.max(1, (loudest / 255) * (height - 6));
    ctx.fillRect(x, height - bar, step - 1, bar);
  }

  if (positionSec > 0) {
    const x = (positionSec / total) * width;
    ctx.fillStyle = 'rgba(255, 120, 120, 0.9)';
    ctx.fillRect(x, 0, 1.5, height);
  }
};
