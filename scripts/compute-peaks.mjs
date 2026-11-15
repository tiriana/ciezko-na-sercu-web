#!/usr/bin/env node
/**
 * Waveform dla wersji online edytora: `data/peaks/<uuid>.bin` (1 bajt na słupek)
 * i `data/peaks/index.json`. Uruchamiane w CI, bo przeglądarka nie może czytać
 * nagrania (static.prsa.pl nie daje CORS, a AnalyserNode wymaga odtwarzania).
 *
 * Użycie: node scripts/compute-peaks.mjs [--all | <id>…]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { peaksFromAudio, resample } from './lib/peaks.mjs';
import { mediaDurationOf } from './lib/timeline.mjs';

const DATA = 'data';
const PEAKS = join(DATA, 'peaks');
const INDEX = join(PEAKS, 'index.json');
const PER_SEC = 20;

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

const catalog = await readJson(join(DATA, 'catalog.json'), { episodes: [] });
const index = await readJson(INDEX, { version: 1, perSec: PER_SEC, episodes: {} });
index.version = 1;
index.perSec = PER_SEC;
index.episodes = index.episodes ?? {};

const wanted = process.argv.slice(2);
const episodes = wanted.some((value) => value !== '--all')
  ? catalog.episodes.filter((episode) => wanted.includes(episode.id))
  : catalog.episodes;

if (!episodes.length) {
  console.error('compute-peaks: nie znalazłem odcinków do policzenia');
  process.exit(1);
}

await mkdir(PEAKS, { recursive: true });
let done = 0;
let skipped = 0;

for (const episode of episodes) {
  const entry = index.episodes[episode.id];
  const file = join(PEAKS, `${episode.id}.bin`);
  const fresh = entry?.audioUrl === episode.audioUrl && entry?.perSec === PER_SEC;
  if (fresh) {
    try {
      await readFile(file);
      skipped += 1;
      continue;
    } catch {}
  }

  const raw = await peaksFromAudio(episode.audioUrl, { perSec: PER_SEC });
  // Nagłówek mp3 bywa krótszy niż realne audio — waveform musi być w skali odtwarzacza.
  const mediaDuration = await mediaDurationOf(episode.audioUrl);
  const duration = mediaDuration > 0 ? mediaDuration : raw.length / PER_SEC;
  const resampled = resample(raw, mediaDuration > 0 ? mediaDuration / (raw.length / PER_SEC) : 1);

  await writeFile(file, resampled);
  index.episodes[episode.id] = {
    audioUrl: episode.audioUrl,
    perSec: PER_SEC,
    durationSec: Math.round(duration * 100) / 100,
    slots: resampled.length,
  };
  done += 1;
  console.log(`${episode.id}: ${resampled.length} słupków (${(resampled.length / 1024).toFixed(1)} kB)`);
}

await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`);
console.log(`policzone: ${done}, pominięte (aktualne): ${skipped}`);
