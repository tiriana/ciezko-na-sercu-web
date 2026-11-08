#!/usr/bin/env node
/**
 * Przytula koniec utworu do początku mowy z transkryptu.
 *
 * `end` utworu pochodzi z segmentacji muzyka/mowa, więc często sięga daleko w
 * wypowiedź prowadzącego. Transkrypt (po VAD) zawiera już tylko mowę, więc
 * pierwszy segment po metadanym końcu utworu wyznacza realną granicę.
 *
 * Użycie: node scripts/snap-boundaries.mjs [--report] [slug|uuid ...]
 *   --report  tylko raport, bez zapisu (bez argumentów = wszystkie odcinki)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const round2 = (value) => Math.round(value * 100) / 100;

export function snapBoundaries(tracks, topics, segments, options = {}) {
  const minGapSec = options.minGapSec ?? 2;
  const leadInSec = options.leadInSec ?? 5;
  const minTailSec = options.minTailSec ?? 30;
  const maxCorrectionSec = options.maxCorrectionSec ?? 120;
  const topicToleranceSec = options.topicToleranceSec ?? 0.5;

  const speech = segments.filter((segment) => segment.text?.trim().length > 0);

  const nextTracks = [];
  const movedTopics = [];
  const corrections = [];
  const skipped = [];
  let fixed = 0;
  let tooLarge = 0;
  let unresolved = 0;

  const nextTopics = topics.map((topic) => ({ ...topic }));
  const oldEnds = [];

  for (const track of tracks) {
    const oldEnd = track.end;
    const nominalEnd = track.start + (track.durationSec ?? 0);
    // Bez `durationSec` nie ma punktu odniesienia, a różnica <= 2 s to szum.
    if (typeof oldEnd !== 'number' || !(track.durationSec > 0) || oldEnd - nominalEnd <= minGapSec) {
      nextTracks.push(track);
      continue;
    }

    const candidate = speech.find(
      (segment) =>
        segment.start >= track.start + leadInSec &&
        segment.start < oldEnd &&
        segment.start >= nominalEnd - leadInSec
    );

    const newEnd = candidate ? round2(candidate.start) : null;
    // Nie schodzimy w środek utworu: 30 s to najkrótszy sensowny kawałek muzyki.
    // Brak kandydata albo zbyt krótki utwór zostają do decyzji człowieka.
    if (newEnd === null || newEnd < track.start + minTailSec) {
      unresolved += 1;
      nextTracks.push(track);
      continue;
    }

    // Dużej korekty nie stosujemy automatycznie — najczęściej znaczy, że brakuje
    // fragmentu transkryptu albo metadane utworu są błędne. Trafia do etapu 2.
    if (oldEnd - newEnd > maxCorrectionSec) {
      tooLarge += 1;
      skipped.push({ oldEnd, newEnd, artist: track.artist, title: track.title, delta: round2(oldEnd - newEnd) });
      nextTracks.push(track);
      continue;
    }

    nextTracks.push({ ...track, end: newEnd });
    oldEnds.push({ oldEnd, newEnd });
    corrections.push({ oldEnd, newEnd, artist: track.artist, title: track.title, delta: round2(oldEnd - newEnd) });
    fixed += 1;
  }

  // Temat zaczynający się na starej granicy zostaje przy niej: po skróceniu
  // utworu musimy przesunąć go razem z nim, inaczej powstaje dziura w osi czasu.
  // W granicy tolerancji może siedzieć kilka wpisów stojących tuż po sobie —
  // przesuwamy tylko pierwszy, inaczej dwa dostałyby ten sam start i nachodziły.
  for (const move of oldEnds) {
    const match = topics
      .map((topic, index) => ({ topic, index }))
      .filter(({ topic }) => Math.abs(topic.start - move.oldEnd) <= topicToleranceSec)
      .sort((left, right) => left.topic.start - right.topic.start)[0];
    if (!match) continue;
    nextTopics[match.index].start = move.newEnd;
    movedTopics.push({ from: match.topic.start, to: move.newEnd, label: match.topic.label });
  }

  return { tracks: nextTracks, topics: nextTopics, fixed, tooLarge, unresolved, corrections, skipped, movedTopics };
}

import { frozenEpisodes } from './frozen.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const wanted = args.filter((arg) => arg !== '--report');

const root = process.cwd();
const catalog = readJson(path.join(root, 'data/catalog.json'));
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const targets = wanted.length > 0 ? wanted.map((key) => byKey.get(key)).filter(Boolean) : catalog.episodes;
if (wanted.length > 0 && targets.length !== wanted.length) {
  console.error('Nieznany odcinek w argumentach.');
  process.exit(1);
}

// Odcinki z choć jednym znacznikiem „ok” są przejrzane przez redakcję — automat ich nie rusza.
const frozen = frozenEpisodes(root);
const skippedFrozen = targets.filter((entry) => frozen.has(entry.id));
const writable = targets.filter((entry) => !frozen.has(entry.id));

const rows = [];
const allCorrections = [];
const allSkipped = [];
let changedFiles = 0;
let changedTracks = 0;
let changedTopics = 0;
let totalTooLarge = 0;
let totalUnresolved = 0;

for (const entry of writable) {
  const episodeFile = path.join(root, 'data/episodes', `${entry.id}.json`);
  const transcriptFile = path.join(root, 'data/transcripts', `${entry.id}.json`);
  let episode;
  let transcript;
  try {
    episode = readJson(episodeFile);
    transcript = readJson(transcriptFile);
  } catch {
    continue;
  }
  if (!episode.tracks?.length || !transcript.segments?.length) continue;

  const result = snapBoundaries(episode.tracks, episode.topics ?? [], transcript.segments);
  totalTooLarge += result.tooLarge;
  totalUnresolved += result.unresolved;
  if (result.fixed + result.tooLarge + result.unresolved === 0) continue;

  rows.push({
    id: entry.id,
    fixed: result.fixed,
    tooLarge: result.tooLarge,
    unresolved: result.unresolved,
  });
  for (const correction of result.corrections) allCorrections.push({ id: entry.id, ...correction });
  for (const item of result.skipped) allSkipped.push({ id: entry.id, ...item });

  if (result.fixed === 0 || reportOnly) continue;

  // Pliki bez zmian nie są dotykane w ogóle — JSON ma zostać bajt w bajt,
  // bo repo porównuje całe pliki i każdy zapis to szum w diffie.
  episode.tracks = result.tracks;
  episode.topics = result.topics;
  writeFileSync(episodeFile, `${JSON.stringify(episode, null, 2)}\n`);
  changedFiles += 1;
  changedTracks += result.fixed;
  changedTopics += result.movedTopics.length;
  console.log(`${entry.slug}: ${result.fixed} utworów, ${result.movedTopics.length} tematów`);
}

if (reportOnly) {
  console.log('odcinek                               naprawione  za duża korekta  nierozwiązane');
  rows.forEach((row) => {
    console.log(
      `${row.id}  ${String(row.fixed).padStart(10)}  ${String(row.tooLarge).padStart(15)}  ` +
        String(row.unresolved).padStart(13)
    );
  });
  console.log(
    `Razem: naprawione=${rows.reduce((sum, row) => sum + row.fixed, 0)}  ` +
      `za duża korekta=${totalTooLarge}  nierozwiązane=${totalUnresolved}`
  );
}

const largest = [...allCorrections].sort((left, right) => right.delta - left.delta).slice(0, 10);
if (largest.length > 0) {
  console.log('\nnajwiększe korekty (stary koniec -> nowy koniec):');
  largest.forEach((item) => {
    console.log(
      `  ${item.id}  ${item.artist ?? '?'} — ${item.title ?? '?'}  ` +
        `${item.oldEnd} -> ${item.newEnd}  (-${item.delta})`
    );
  });
}

// Do decyzji człowieka potrzebne są przede wszystkim korekty, których nie zastosowano:
// wśród zastosowanych największe są po prostu te tuż pod progiem.
const largestSkipped = [...allSkipped].sort((left, right) => right.delta - left.delta).slice(0, 10);
if (largestSkipped.length > 0) {
  console.log('\nnajwiększe pominięte korekty (do etapu 2):');
  largestSkipped.forEach((item) => {
    console.log(
      `  ${item.id}  ${item.artist ?? '?'} — ${item.title ?? '?'}  ` +
        `${item.oldEnd} -> ${item.newEnd}  (-${item.delta})`
    );
  });
}

if (skippedFrozen.length > 0) {
  console.log(`pominięte odcinki z oznaczeniami „ok”: ${skippedFrozen.length}`);
}

if (!reportOnly) {
  console.log(`przycięto ${changedTracks} utworów w ${changedFiles} odcinkach, przesunięto ${changedTopics} tematów`);
}
