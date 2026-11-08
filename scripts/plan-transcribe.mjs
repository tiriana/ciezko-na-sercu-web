#!/usr/bin/env node
/**
 * Zamienia wejście workflow (slugi/uuidy, opcjonalny limit) na macierz jobów
 * transkrypcji. Puste wejście = wszystkie odcinki z katalogu.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const wanted = String(process.env.EPISODES ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const limit = Number.parseInt(process.env.LIMIT ?? '0', 10) || 0;

const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

let episodes = catalog.episodes;
if (wanted.length > 0) {
  episodes = wanted.map((key) => {
    const episode = byKey.get(key);
    if (!episode) {
      console.error(`Nieznany odcinek: ${key}`);
      process.exit(1);
    }
    return episode;
  });
}
if (limit > 0) episodes = episodes.slice(0, limit);

// Jeden job na 45 min audio: przy 4 wątkach w Actions odcinek 2-godzinny nie zmieściłby
// się w limicie 6 h, a krótkie kawałki dają przewidywalny czas. Każdy odcinek ma co
// najmniej 1:55, więc ostatni kawałek zawsze tniemy pełną długością — ffmpeg kończy
// na końcu pliku, więc nie płacimy za nieistniejące audio.
const CHUNK_SEC = 2700;
const MIN_EPISODE_SEC = 115 * 60;

const durationOf = (episode) => {
  const transcript = new URL(`../data/transcripts/${episode.id}.json`, import.meta.url);
  if (!existsSync(transcript)) return 0;
  const windows = JSON.parse(readFileSync(transcript, 'utf8')).windows ?? [];
  return windows.reduce((max, window) => Math.max(max, window.end ?? 0), 0);
};

const matrix = [];
for (const episode of episodes) {
  const duration = Math.max(durationOf(episode), MIN_EPISODE_SEC);
  const parts = Math.ceil(duration / CHUNK_SEC);
  for (let part = 0; part < parts; part += 1) {
    matrix.push({
      id: episode.id,
      slug: episode.slug,
      audioUrl: episode.audioUrl,
      part,
      start: part * CHUNK_SEC,
      length: CHUNK_SEC,
    });
  }
}
const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(output, `count=${matrix.length}\n`);
}
console.log(`${matrix.length} odcinków do transkrypcji`);
