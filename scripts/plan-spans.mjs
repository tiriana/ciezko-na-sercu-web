#!/usr/bin/env node
// Wybiera odcinki do policzenia bloków mowy (VAD). Puste wejście = wszystkie,
// które jeszcze nie mają artefaktu; `EPISODES` pozwala wskazać konkretne.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { frozenEpisodes } from './frozen.mjs';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const wanted = String(process.env.EPISODES ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const limit = Number.parseInt(process.env.LIMIT ?? '0', 10) || 0;
const force = process.env.FORCE === 'true';

const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const frozen = frozenEpisodes();
const artifactPath = (id) => join('data', 'artifacts', id, 'speech-spans.json');

// Odcinek można wskazać uuidem, slugiem albo przedrostkiem uuid (wygodne w dispatchu).
const findEpisode = (key) => {
  const exact = byKey.get(key);
  if (exact) return exact;
  const matches = catalog.episodes.filter((episode) => episode.id.startsWith(key));
  return matches.length === 1 ? matches[0] : null;
};

let episodes = wanted.length > 0
  ? wanted.map((key) => {
      const episode = findEpisode(key);
      if (!episode) {
        console.error(`Nieznany odcinek: ${key}`);
        process.exit(1);
      }
      return episode;
    })
  : catalog.episodes.filter((episode) => !existsSync(artifactPath(episode.id)) && !frozen.has(episode.id));

episodes = episodes.filter((episode) => episode.audioUrl);
if (limit > 0) episodes = episodes.slice(0, limit);

const matrix = episodes.map((episode) => ({
  id: episode.id,
  slug: episode.slug,
  audioUrl: episode.audioUrl,
  out: artifactPath(episode.id),
}));

const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(output, `count=${matrix.length}\n`);
  appendFileSync(output, `ids=${episodes.map((episode) => episode.id).join(',')}\n`);
}
console.log(`${matrix.length} odcinków do policzenia bloków mowy`);
for (const episode of episodes) console.log(`  ${episode.slug}`);
