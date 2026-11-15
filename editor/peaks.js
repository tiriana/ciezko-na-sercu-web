// Waveform: odczyt plików z `data/peaks` i rysowanie okna czasu (zoom, przewijanie),
// z siatką, znacznikami granic utworów i kreską odtwarzania. Dane to 20 słupków na
// sekundę z CI, więc przy dużym zbliżeniu słupki są prostokątami — tyle mają pliki.

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

const COLORS = {
  wave: 'rgba(118, 106, 94, 0.65)',
  played: 'rgba(200, 16, 46, 0.68)',
  grid: 'rgba(120, 110, 100, 0.18)',
  label: 'rgba(232, 234, 237, 0.45)',
  marker: 'rgba(111, 179, 255, 0.55)',
  markerReviewed: 'rgba(110, 231, 168, 0.9)',
  playhead: 'rgba(255, 120, 120, 0.95)',
};

const timeSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

const fmtClock = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const clampView = (view, durationSec) => {
  const duration = durationSec > 0 ? durationSec : view.span;
  const span = Math.min(duration, Math.max(2, view.span));
  const start = Math.min(Math.max(0, view.start), Math.max(0, duration - span));
  return { start, span };
};

export const drawWaveform = (canvas, options) => {
  const { peaks, perSec, durationSec, view, positionSec, markers = [] } = options;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!peaks || !peaks.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('brak waveformu — czasy wpisujemy ręcznie', 8, height / 2);
    return;
  }

  const duration = durationSec > 0 ? durationSec : peaks.length / perSec;
  const range = clampView(view, duration);
  const xOf = (time) => ((time - range.start) / range.span) * width;
  const timeOf = (x) => range.start + (x / width) * range.span;

  // Siatka czasu: krok dobieramy tak, żeby etykiety nie nachodziły na siebie.
  const step = timeSteps.find((value) => (value / range.span) * width >= 80) ?? timeSteps.at(-1);
  ctx.fillStyle = COLORS.grid;
  ctx.font = '10px ui-monospace, monospace';
  for (let time = Math.ceil(range.start / step) * step; time < range.start + range.span; time += step) {
    const x = Math.round(xOf(time));
    ctx.fillRect(x, 0, 1, height);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(fmtClock(time), x + 3, height - 4);
    ctx.fillStyle = COLORS.grid;
  }

  const middle = height / 2;
  const amplitude = Math.max(1, middle - 8);
  const base = range.start * perSec;
  const perPixel = (range.span * perSec) / width;

  const bars = (color) => {
    ctx.fillStyle = color;
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor(base + x * perPixel);
      const to = Math.max(from + 1, Math.floor(base + (x + 1) * perPixel));
      let peak = 0;
      for (let index = from; index < to && index < peaks.length; index += 1) {
        if (peaks[index] > peak) peak = peaks[index];
      }
      const size = Math.max(0.5, (peak / 255) * amplitude);
      ctx.fillRect(x, middle - size, 1, size * 2);
    }
  };

  bars(COLORS.wave);
  if (Number.isFinite(positionSec) && positionSec > range.start) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.min(width, xOf(positionSec)), height);
    ctx.clip();
    bars(COLORS.played);
    ctx.restore();
  }

  // Znaczniki granic utworów: pionowa kreska na początku, delikatny daszek na końcu.
  for (const marker of markers) {
    if (marker.time < range.start || marker.time > range.start + range.span) continue;
    const x = Math.round(xOf(marker.time)) + 0.5;
    ctx.fillStyle = marker.reviewed ? COLORS.markerReviewed : COLORS.marker;
    ctx.fillRect(x, 0, 1, height);
    ctx.beginPath();
    ctx.arc(x, marker.kind === 'start' ? 5 : height - 5, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (Number.isFinite(positionSec) && positionSec >= range.start && positionSec <= range.start + range.span) {
    const x = Math.round(xOf(positionSec)) + 0.5;
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x, 0, 1.5, height);
  }
};
