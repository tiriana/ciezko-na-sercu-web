// Waveform z nagrania: ffmpeg czyta mp3 strumieniem (range requests), więc plik nie
// ląduje na dysku. Ten sam kod liczy podgląd na żywo w edytorze i pliki `data/peaks`
// dla wersji online.

import { spawn } from 'node:child_process';

const SAMPLE_RATE = 2000; // z tego redukujemy do `perSec` (maksimum z próbek)

export const peaksFromAudio = (audioUrl, { perSec = 20, sampleRate = SAMPLE_RATE } = {}) =>
  new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioUrl, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-']);
    const peaks = [];
    const perBucket = sampleRate / perSec;
    let peak = 0;
    let samples = 0;
    let leftover = Buffer.alloc(0);
    let errorText = '';

    // Bierzemy maksimum z próbek, bo uśrednianie zgubiłoby transjenty i waveform
    // kłamałby o cichych fragmentach.
    const take = (buffer) => {
      for (let offset = 0; offset + 2 <= buffer.length; offset += 2) {
        const value = Math.abs(buffer.readInt16LE(offset)) / 32768;
        if (value > peak) peak = value;
        samples += 1;
        if (samples >= perBucket) {
          peaks.push(Math.min(255, Math.round(peak * 255)));
          peak = 0;
          samples = 0;
        }
      }
    };

    ffmpeg.stdout.on('data', (chunk) => {
      const buffer = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buffer.length - (buffer.length % 2);
      leftover = buffer.subarray(usable);
      take(buffer.subarray(0, usable));
    });
    ffmpeg.stdout.on('error', reject);
    ffmpeg.stderr.on('error', () => {});
    ffmpeg.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
      if (errorText.length > 4000) errorText = errorText.slice(-4000);
    });
    ffmpeg.on('exit', (_code, signal) => {
      if (signal) reject(new Error(`ffmpeg przerwany (${signal})`));
    });
    ffmpeg.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('brak ffmpeg w PATH') : error));
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(errorText.trim() || `ffmpeg zakończył się kodem ${code}`));
      if (peaks.length === 0) return reject(new Error('ffmpeg nie zwrócił dźwięku'));
      // Audycja jest zmiksowana cicho (szczyty ~-8 dBFS), więc bez normalizacji waveform
      // byłby płaski: skalujemy do najgłośniejszego miejsca i podnosimy wykładnikiem,
      // bo słupek ma pokazywać głośność czytelnie, nie wiernie w skali liniowej.
      const loudest = peaks.reduce((max, value) => (value > max ? value : max), 1);
      resolve(Uint8Array.from(peaks, (value) => Math.round(255 * (value / loudest) ** 0.6)));
    });
  });

/** Waveform musi być w skali odtwarzacza (nagłówek mp3 bywa krótszy niż realne audio),
 * inaczej kreska i znaczniki rozjeżdżają się ku końcowi audycji. */
export const resample = (peaks, scale) => {
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-6) return peaks;
  const length = Math.max(1, Math.round(peaks.length * scale));
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = peaks[Math.min(peaks.length - 1, Math.round(index / scale))] ?? 0;
  }
  return out;
};
