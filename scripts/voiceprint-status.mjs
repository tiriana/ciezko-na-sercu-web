#!/usr/bin/env node
/**
 * Postęp profilu głosu: ile odcinków jest przerobionych, ile czeka i ile jest
 * pominiętych przez ręczne oznaczenia „ok”.
 */
import { readFileSync } from 'node:fs';

import { frozenEpisodes } from './frozen.mjs';
import { readLedger } from './voiceprint-ledger.mjs';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const ledger = readLedger();
const frozen = frozenEpisodes();
const withAudio = catalog.episodes.filter((episode) => episode.audioUrl);

const done = withAudio.filter((episode) => ledger.episodes[episode.id]);
const auto = withAudio.filter((episode) => !ledger.episodes[episode.id] && !frozen.has(episode.id));
const skipped = withAudio.filter((episode) => !ledger.episodes[episode.id] && frozen.has(episode.id));

const percent = withAudio.length === 0 ? 100 : Math.round((done.length / withAudio.length) * 100);
console.log(`Profil głosu: ${done.length}/${withAudio.length} odcinków (${percent}%)`);
console.log(`  czeka: ${auto.length}`);
console.log(`  pominięte z „ok”: ${skipped.length}`);

const added = Object.values(ledger.episodes).reduce((sum, entry) => sum + (entry.added ?? 0), 0);
const extended = Object.values(ledger.episodes).reduce((sum, entry) => sum + (entry.extended ?? 0), 0);
console.log(`  dodane wejścia: ${added}, wydłużone: ${extended}`);

if (auto.length > 0) {
  console.log('\nNajnowsze czekające:');
  for (const episode of auto.slice(0, 10)) console.log(`  ${episode.slug}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    '### Profil głosu',
    '',
    `- przerobione: **${done.length}/${withAudio.length}** (${percent}%)`,
    `- czeka: ${auto.length}`,
    `- pominięte z „ok”: ${skipped.length}`,
    `- dodane wejścia: ${added}, wydłużone: ${extended}`,
    '',
  ].join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
