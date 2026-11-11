#!/usr/bin/env node
// Jednorazowa naprawa czasów: dane liczymy w czasie dekodowanego audio, a odtwarzacz
// mierzy pozycję nagłówkiem mp3, który w plikach Polskiego Radia jest krótszy
// (np. 6893,21 s vs 6909,05 s). Przeliczamy wszystkie czasy na skalę odtwarzacza,
// żeby player nie musiał nic wiedzieć o nagłówku.
//
// Odcinki opracowane ręcznie pomijamy: ich znaczniki powstały przy głupim playerze,
// więc już są w dobrej skali, a ruszenie ich zepsułoby Twoją pracę.
//
//   node scripts/fix-timeline.mjs [--dry-run] [--limit N] [--episodes <uuid8,...>] [--concurrency N]

import { readFile, writeFile } from 'node:fs/promises';

import { timelineFor } from './lib/timeline.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    index += 1;
  } else args.set(token.slice(2), 'true');
}

const dryRun = args.has('dry-run');
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const concurrency = Number.parseInt(args.get('concurrency') ?? '4', 10) || 4;
const wanted = String(args.get('episodes') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const round = (value) => Math.round(value * 100) / 100;
const scaleTime = (value, scale) => (Number.isFinite(value) ? round(value * scale) : value);

const reviewed = JSON.parse(await readFile('data/reviewed.json', 'utf8'));
const handEdited = new Set(Object.keys(reviewed.episodes ?? {}));

const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
let targets = catalog.episodes.filter((entry) => !handEdited.has(entry.id));
if (wanted.length > 0) targets = targets.filter((entry) => wanted.some((prefix) => entry.id.startsWith(prefix)));
if (limit > 0) targets = targets.slice(0, limit);

const convert = (episode, scale, timeline) => {
  episode.audioDurationSec = timeline.realDuration;
  episode.durationSec = timeline.mediaDuration;
  for (const track of episode.tracks ?? []) {
    track.start = scaleTime(track.start, scale);
    if (Number.isFinite(track.end)) track.end = scaleTime(track.end, scale);
    if (Number.isFinite(track.durationSec)) track.durationSec = round(track.durationSec * scale);
  }
  for (const topic of episode.topics ?? []) {
    topic.start = scaleTime(topic.start, scale);
    if (Number.isFinite(topic.end)) topic.end = scaleTime(topic.end, scale);
  }
  for (const tag of episode.tags ?? []) {
    if (Number.isFinite(tag.at)) tag.at = scaleTime(tag.at, scale);
  }
  for (const quote of episode.quotes ?? []) {
    quote.start = scaleTime(quote.start, scale);
  }
  for (const credit of episode.credits ?? []) {
    if (Number.isFinite(credit.time)) credit.time = scaleTime(credit.time, scale);
  }
  episode.updatedAt = new Date().toISOString();
  return episode;
};

const convertOverrides = (override, scale) => {
  for (const fix of override.tracks ?? []) {
    if (Number.isFinite(fix.start)) fix.start = scaleTime(fix.start, scale);
    if (Number.isFinite(fix.end)) fix.end = scaleTime(fix.end, scale);
    if (Number.isFinite(fix.durationSec)) fix.durationSec = round(fix.durationSec * scale);
  }
  for (const fix of override.addTracks ?? []) {
    if (Number.isFinite(fix.start)) fix.start = scaleTime(fix.start, scale);
    if (Number.isFinite(fix.end)) fix.end = scaleTime(fix.end, scale);
    if (Number.isFinite(fix.durationSec)) fix.durationSec = round(fix.durationSec * scale);
  }
  for (const fix of [...(override.topics ?? []), ...(override.addTopics ?? [])]) {
    if (Number.isFinite(fix.time)) fix.time = scaleTime(fix.time, scale);
    if (Number.isFinite(fix.start)) fix.start = scaleTime(fix.start, scale);
    if (Number.isFinite(fix.end)) fix.end = scaleTime(fix.end, scale);
  }
  return override;
};

const processEpisode = async (entry) => {
  const episodePath = `data/episodes/${entry.id}.json`;
  let episode;
  try {
    episode = JSON.parse(await readFile(episodePath, 'utf8'));
  } catch {
    return `${entry.id.slice(0, 8)}: brak pliku odcinka — pominięty`;
  }
  if (Number.isFinite(episode.audioDurationSec) && episode.audioDurationSec > 0) {
    return `${entry.id.slice(0, 8)}: już przeliczony (${episode.durationSec} s) — pominięty`;
  }
  if (!entry.audioUrl) return `${entry.id.slice(0, 8)}: brak audioUrl — pominięty`;

  const timeline = await timelineFor(entry.audioUrl, entry.id);
  if (!(timeline.scale > 0)) return `${entry.id.slice(0, 8)}: nie udało się zmierzyć czasu — pominięty`;
  if (Math.abs(timeline.scale - 1) < 1e-6) return `${entry.id.slice(0, 8)}: skala 1 — bez zmian`;

  convert(episode, timeline.scale, timeline);

  let overrideNote = '';
  try {
    const overridePath = `data/overrides/${entry.id}.json`;
    const override = JSON.parse(await readFile(overridePath, 'utf8'));
    convertOverrides(override, timeline.scale);
    if (!dryRun) await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`);
    overrideNote = ' + overrides';
  } catch {
    // brak pliku poprawek to normalna sytuacja
  }

  if (!dryRun) await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
  return `${entry.id.slice(0, 8)}: skala ${timeline.scale} (${timeline.mediaDuration} z ${timeline.realDuration} s), utwory ${(episode.tracks ?? []).length}${overrideNote}`;
};

console.log(`Odcinków do przeliczenia: ${targets.length} (pominięte ręczne: ${handEdited.size})`);
if (dryRun) console.log('— próba na sucho, nic nie zapisuję');

let cursor = 0;
let done = 0;
const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
  while (cursor < targets.length) {
    const entry = targets[cursor];
    cursor += 1;
    try {
      console.log(await processEpisode(entry));
    } catch (error) {
      console.log(`${entry.id.slice(0, 8)}: BŁĄD ${error.message}`);
    }
    done += 1;
    if (done % 10 === 0) console.log(`— postęp ${done}/${targets.length}`);
  }
});
await Promise.all(workers);
console.log('gotowe');
