#!/usr/bin/env node
/**
 * Lista odcinków do policzenia profilu głosu: `EPISODES` z wejścia workflow,
 * inaczej wszystkie (z limitem). Odcinki z ręcznymi oznaczeniami „ok” wypadają,
 * dopóki nie ustawisz FORCE=true.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { frozenEpisodes } from './frozen.mjs';
import { processedEpisodes } from './voiceprint-ledger.mjs';

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

const done = processedEpisodes();
const pending = episodes.filter((episode) => !done.has(episode.id));
if (pending.length > 0) console.log(`pominięto ${episodes.length - pending.length} odcinków już przerobionych`);
episodes = pending;

if (!force) {
  const frozen = frozenEpisodes();
  const skipped = episodes.filter((episode) => frozen.has(episode.id));
  if (skipped.length > 0) console.log(`pominięto ${skipped.length} odcinków z oznaczeniami „ok” (FORCE=true obejmuje)`);
  episodes = episodes.filter((episode) => !frozen.has(episode.id));
}

if (limit > 0) episodes = episodes.slice(0, limit);

const rows = episodes
  .filter((episode) => episode.audioUrl)
  .map((episode) => `${episode.id}\t${episode.audioUrl}`);
writeFileSync('ids.txt', rows.join('\n') + (rows.length ? '\n' : ''));

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `count=${rows.length}\n`);
console.log(`odcinków: ${rows.length} → ids.txt`);
