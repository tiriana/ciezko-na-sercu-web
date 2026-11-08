#!/usr/bin/env node
/**
 * Przelicza czasy tematów na segmentach transkryptu.
 *
 * Port `snapTopics` z taggera: temat, który wypada w wypowiedzi, zostaje; temat
 * wskazujący blok muzyczny dostaje początek segmentu, którego treść pokrywa się
 * z opisem (po rdzeniach wyrazów, więc polska odmiana nie przeszkadza).
 *
 * Użycie: node scripts/snap-topics.mjs [slug|uuid ...]   (bez argumentów = wszystkie)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STOPWORDS = new Set([
  'oraz', 'albo', 'czyli', 'tego', 'tych', 'tym', 'takze', 'ktore', 'ktory', 'ktora',
  'bylo', 'byla', 'byli', 'jest', 'jego', 'jej', 'ich', 'niz', 'przez', 'przy', 'czy',
  'tak', 'nie', 'sie', 'dla', 'aby', 'gdy', 'gdzie', 'jak', 'kiedy', 'potem', 'teraz',
  'tez', 'juz', 'jeszcze', 'bardzo', 'mniej', 'wiecej', 'miedzy', 'przed',
]);

const fold = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase();

const stems = (value) => {
  const words = fold(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return [...new Set(words.map((word) => (word.length > 5 ? word.slice(0, 5) : word)))];
};

const overlap = (left, right) => left.filter((stem) => right.has(stem)).length;

export function snapTopics(topics, segments, durationSec, options = {}) {
  const windowSec = options.windowSec ?? 300;
  const maxShiftSec = options.maxShiftSec ?? 900;
  const prepared = segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => ({ start: segment.start, end: segment.end, stems: new Set(stems(segment.text)) }));

  const tolerance = 3;
  const insideSpeech = (time) =>
    prepared.some((segment) => time >= segment.start - tolerance && time <= segment.end + tolerance);

  const result = [];
  const moved = [];
  // Każdy temat liczymy niezależnie od pozostałych: wynik zależy wyłącznie od tematów
  // i segmentów, więc powtórny przebieg nic nie zmienia. Jedyne wyjątkiem jest czas
  // zajęty przez inny temat — wtedy zostawiamy pierwotny, zamiast dublować znacznik.
  const placed = new Set(topics.filter((topic) => insideSpeech(topic.time)).map((topic) => topic.time));

  topics.forEach((topic) => {
    if (insideSpeech(topic.time)) {
      result.push(topic);
      return;
    }

    const wanted = stems(topic.topic);
    const accepted = wanted.length >= 2 ? Math.max(2, Math.ceil(wanted.length * 0.34)) : 1;
    let best = null;

    for (const pass of [windowSec, Number.POSITIVE_INFINITY]) {
      for (const candidate of prepared) {
        const distance = Math.abs(candidate.start - topic.time);
        if (distance > pass) continue;
        const score = overlap(wanted, candidate.stems);
        if (score < accepted) continue;
        const better = !best || score > best.score || (score === best.score && distance < best.distance);
        if (better) best = { start: candidate.start, score, distance };
      }
      if (best) break;
    }

    if (best) {
      let start = best.start;
      for (;;) {
        const previous = prepared.find((segment) => segment.end >= start - 10 && segment.start < start);
        if (!previous || previous.start === start) break;
        if (overlap(wanted, previous.stems) < 1) break;
        start = previous.start;
      }
      best.start = start;
    }

    if (!best) {
      const nearest = prepared.reduce((acc, segment) => {
        const distance = Math.abs(segment.start - topic.time);
        return !acc || distance < acc.distance ? { start: segment.start, distance } : acc;
      }, null);
      if (nearest && nearest.distance <= 60 && !placed.has(nearest.start)) {
        placed.add(nearest.start);
        moved.push({ from: topic.time, to: nearest.start, topic: topic.topic });
        result.push({ ...topic, time: nearest.start });
        return;
      }
      result.push(topic);
      return;
    }

    const candidate = Math.max(0, Math.min(durationSec, best.start));
    if (Math.abs(candidate - topic.time) > maxShiftSec || placed.has(candidate)) {
      result.push(topic);
      return;
    }
    placed.add(candidate);
    if (Math.abs(candidate - topic.time) >= 0.5) moved.push({ from: topic.time, to: candidate, topic: topic.topic });
    result.push({ ...topic, time: candidate });
  });

  return { topics: result, moved };
}

import { frozenEpisodes } from './frozen.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const root = process.cwd();
const catalog = readJson(path.join(root, 'data/catalog.json'));
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const wanted = process.argv.slice(2);
const targets = wanted.length > 0 ? wanted.map((key) => byKey.get(key)).filter(Boolean) : catalog.episodes;
if (wanted.length > 0 && targets.length !== wanted.length) {
  console.error('Nieznany odcinek w argumentach.');
  process.exit(1);
}

// Odcinki z choć jednym znacznikiem „ok” są przejrzane przez redakcję — automat ich nie rusza.
const frozen = frozenEpisodes(root);
const skippedFrozen = targets.filter((entry) => frozen.has(entry.id)).length;

let changedFiles = 0;
let changedTopics = 0;
for (const entry of targets.filter((item) => !frozen.has(item.id))) {
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
  if (!episode.topics?.length || !transcript.segments?.length) continue;

  const durationSec = Math.max(
    episode.durationSec ?? 0,
    transcript.windows?.reduce((max, window) => Math.max(max, window.end ?? 0), 0) ?? 0
  );
  // Transkrypt gęsty nie odcina muzyki, więc segment może zaczynać się w środku
  // utworu. Temat nie może tam trafić — inaczej nachodzi na blok muzyczny.
  const trackSpans = (episode.tracks ?? []).map((track) => ({
    start: track.start,
    end: track.end ?? track.start + (track.durationSec ?? 0),
  }));
  const insideTrack = (time) => trackSpans.some((span) => time >= span.start - 1 && time < span.end - 1);
  const segments = (transcript.segments ?? []).filter((segment) => !insideTrack(segment.start));

  const input = episode.topics.map((topic) => ({ time: topic.start, topic: topic.label }));
  const { topics: snapped, moved } = snapTopics(input, segments, durationSec);
  if (moved.length === 0) continue;

  // Koniec tematu to najbliższy późniejszy start jakiejkolwiek pozycji programu
  // (utworu albo tematu), dokładnie jak w `reconcileTimeline` taggera. Inaczej po
  // przesunięciu temat nachodziłby na blok muzyczny.
  const starts = [...(episode.tracks ?? []).map((track) => track.start), ...snapped.map((topic) => topic.time)].sort(
    (left, right) => left - right
  );
  const nextStartAfter = (start) => starts.find((value) => value > start) ?? durationSec;

  episode.topics = episode.topics.map((topic, index) => {
    const start = snapped[index].time;
    return { ...topic, start, end: nextStartAfter(start) };
  });
  writeFileSync(episodeFile, `${JSON.stringify(episode, null, 2)}\n`);
  changedFiles += 1;
  changedTopics += moved.length;
  console.log(`${entry.slug}: ${moved.length} tematów przesuniętych`);
}

if (skippedFrozen > 0) console.log(`pominięte odcinki z oznaczeniami „ok”: ${skippedFrozen}`);
console.log(`przesunięto ${changedTopics} tematów w ${changedFiles} odcinkach`);
