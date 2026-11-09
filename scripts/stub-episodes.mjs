#!/usr/bin/env node
/**
 * Tworzy zaślepki opracowań dla odcinków, które są już w katalogu, ale nie mają
 * jeszcze `data/episodes/<id>.json`. Dzięki temu wpis pojawia się na stronie
 * od razu po wykryciu, a tracklista i wejścia dochodzą po transkrypcji.
 *
 * Użycie: node scripts/stub-episodes.mjs [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');

const catalog = JSON.parse(readFileSync(path.join(root, 'data', 'catalog.json'), 'utf8'));
const episodesDir = path.join(root, 'data', 'episodes');
const existing = new Set(
  readdirSync(episodesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
);

// Data lokalna, bo audycja jest środowa także wtedy, gdy w UTC jest jeszcze wtorek.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());

let created = 0;
for (const episode of catalog.episodes) {
  if (existing.has(episode.id)) continue;
  const stub = {
    version: 1,
    id: episode.id,
    analyzedAt: today,
    durationSec: episode.durationSec ?? null,
    summary: null,
    topics: [],
    tags: [],
    tracks: [],
    quotes: [],
    credits: [],
  };
  created += 1;
  if (dryRun) {
    console.log(`zaślepka (dry-run): ${episode.slug}`);
    continue;
  }
  writeFileSync(path.join(episodesDir, `${episode.id}.json`), `${JSON.stringify(stub, null, 2)}\n`);
  console.log(`zaślepka: ${episode.slug}`);
}

console.log(`${created} zaślepek opracowań${dryRun ? ' (dry-run)' : ''}`);
