#!/usr/bin/env node
/**
 * Macierz jobów profilu głosu: slugi/uuidy z wejścia workflow albo N ostatnich odcinków.
 * Cały odcinek trafia do jednego joba, bo VAD i embeddingi potrzebują ciągłego audio.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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

const matrix = episodes
  .filter((episode) => episode.audioUrl)
  .map((episode) => ({ id: episode.id, slug: episode.slug, audioUrl: episode.audioUrl }));

const target = process.env.OUT ?? 'ids.txt';
writeFileSync(target, matrix.map((episode) => `${episode.id}\t${episode.audioUrl}`).join('\n') + (matrix.length ? '\n' : ''));
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `count=${matrix.length}\n`);
console.log(`odcinków: ${matrix.length} → ${target}`);
