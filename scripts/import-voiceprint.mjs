#!/usr/bin/env node
/**
 * Zamienia bloki mowy prowadzącego z profilu głosu na brakujące wejścia.
 *
 * Bloki rozdzielone krótką pauzą to jedno wejście, więc sklejamy je do klastrów.
 * Wpisujemy tylko te, które leżą w luce między pozycjami programu — mówienie
 * w trakcie utworu wymaga przycięcia utworu, więc trafia do raportu, nie do danych.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CLUSTER_GAP_SEC = 6;
const MIN_CLUSTER_SEC = 2;
const COVER_TOLERANCE_SEC = 1;
const DEFAULT_LABEL = '#TODO - opisz wejście';

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

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const round = (value) => Math.round(value * 100) / 100;

const clustersOf = (spans) => {
  const host = spans
    .filter((span) => span.speaker === 'prowadzacy')
    .sort((left, right) => left.start - right.start);
  const clusters = [];
  for (const span of host) {
    const last = clusters.at(-1);
    if (last && span.start - last.end <= CLUSTER_GAP_SEC) last.end = Math.max(last.end, span.end);
    else clusters.push({ start: span.start, end: span.end });
  }
  return clusters.filter((cluster) => cluster.end - cluster.start >= MIN_CLUSTER_SEC);
};

const overlap = (left, right) => Math.min(left.end, right.end) - Math.max(left.start, right.start);

const itemsOf = (episode) => {
  const items = [
    ...(episode.tracks ?? []).map((track) => ({
      kind: 'utwór',
      start: track.start,
      end: track.end ?? track.start + (track.durationSec ?? 0),
      name: `${track.artist} — ${track.title}`,
    })),
    ...(episode.topics ?? []).map((topic) => ({
      kind: 'wejście',
      start: topic.start,
      end: topic.end ?? topic.start,
      name: topic.label ?? '',
    })),
  ].sort((left, right) => left.start - right.start);
  for (const item of items) {
    if (!item.end || item.end <= item.start) {
      const next = items.find((other) => other.start > item.start);
      item.end = next ? next.start : item.start;
    }
  }
  return items;
};

const emptyOverride = () => ({ version: 1, tracks: [], topics: [], addTracks: [], addTopics: [] });

const mergeIntoOverride = (path, added, moved) => {
  const current = existsSync(path) ? readJson(path) : emptyOverride();
  const existing = current.addTopics ?? [];
  const fresh = added.filter(
    (topic) => !existing.some((other) => Math.abs(other.start - topic.start) < COVER_TOLERANCE_SEC)
  );
  const movedFixes = moved.map(({ topic, start }) => ({ time: topic.start, label: topic.label, start: round(start) }));
  const isNew = movedFixes.some(
    (fix) => !(current.topics ?? []).some((other) => other.time === fix.time && other.label === fix.label)
  );
  if (fresh.length === 0 && !isNew) return 0;
  const next = {
    version: current.version ?? 1,
    tracks: current.tracks ?? [],
    topics: [...(current.topics ?? []), ...movedFixes.filter(
      (fix) => !(current.topics ?? []).some((other) => other.time === fix.time && other.label === fix.label)
    )],
    addTracks: current.addTracks ?? [],
    addTopics: [...existing, ...fresh].sort((left, right) => left.start - right.start),
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return fresh.length + movedFixes.length;
};

const write = args.has('write');
const transcriptDir = args.get('transcripts') ?? 'data/transcripts';
const MAX_LABEL = 90;

const labelFor = (id, cluster) => {
  try {
    const transcript = readJson(`${transcriptDir}/${id}.json`);
    const text = (transcript.segments ?? [])
      .filter((segment) => segment.start < cluster.end && segment.end > cluster.start)
      .map((segment) => String(segment.text ?? '').trim())
      .filter(Boolean)
      .join(' ');
    if (!text) return DEFAULT_LABEL;
    const flat = text.replace(/\s+/g, ' ').replace(/[„”"]/g, '"').trim();
    if (flat.length <= MAX_LABEL) return flat;
    const cut = flat.slice(0, MAX_LABEL);
    const boundary = cut.lastIndexOf(' ');
    return `${cut.slice(0, boundary > 40 ? boundary : MAX_LABEL)}…`;
  } catch {
    return DEFAULT_LABEL;
  }
};

const files = process.argv.slice(2).filter((token) => token.endsWith('.json') && !token.startsWith('--'));
if (files.length === 0) {
  console.error('Podaj pliki profilu głosu: node scripts/import-voiceprint.mjs [--write] <plik.json>…');
  process.exit(2);
}

let totalAdded = 0;
for (const file of files) {
  const voiceprint = readJson(file);
  const id = voiceprint.episodeId;
  const episodePath = `data/episodes/${id}.json`;
  if (!existsSync(episodePath)) {
    console.error(`${id}: brak ${episodePath}`);
    continue;
  }
  const episode = readJson(episodePath);
  const items = itemsOf(episode);
  const clusters = clustersOf(voiceprint.spans ?? []);

  // Klastr mowy przecięty granicą istniejącego wejścia to dwie różne sprawy.
  const topicItems = items.filter((item) => item.kind === 'wejście');
  const pieces = [];
  for (const cluster of clusters) {
    let spans = [cluster];
    for (const topic of topicItems) {
      spans = spans.flatMap((span) => {
        const cut = overlap(span, topic);
        if (cut <= COVER_TOLERANCE_SEC) return [span];
        const parts = [];
        if (topic.start - span.start >= MIN_CLUSTER_SEC) {
          parts.push({ start: span.start, end: Math.min(span.end, topic.start), mergeInto: topic });
        }
        if (span.end - topic.end >= MIN_CLUSTER_SEC) parts.push({ start: Math.max(span.start, topic.end), end: span.end });
        return parts;
      });
    }
    pieces.push(...spans);
  }

  // Wejście nie może wchodzić w utwór: cofamy je najwyżej do końca muzyki.
  const clampToTracks = (start, end) => {
    const track = items.find((item) => item.kind === 'utwór' && overlap(item, { start, end }) > COVER_TOLERANCE_SEC);
    return track && track.end > start ? track.end : start;
  };

  const fresh = [];
  const moved = [];
  const talkOver = [];
  for (const piece of pieces) {
    const adjacent = piece.mergeInto && Math.abs(piece.end - piece.mergeInto.start) <= COVER_TOLERANCE_SEC ? piece.mergeInto : null;
    if (adjacent) {
      const topic = (episode.topics ?? []).find((candidate) => candidate.start === adjacent.start);
      if (topic) moved.push({ topic, start: clampToTracks(piece.start, piece.end) });
      continue;
    }
    const hit = items.find((item) => overlap(item, piece) > COVER_TOLERANCE_SEC);
    if (!hit) {
      fresh.push({ label: labelFor(id, piece), start: round(piece.start), end: round(piece.end) });
      continue;
    }
    if (hit.kind === 'wejście') {
      // Mowa zaczyna się przed istniejącym wejściem: to samo wejście, tylko dłuższe.
      if (piece.start < hit.start - COVER_TOLERANCE_SEC) {
        const topic = (episode.topics ?? []).find((candidate) => candidate.start === hit.start);
        if (topic) moved.push({ topic, start: clampToTracks(piece.start, piece.end) });
      }
      continue;
    }
    const sameKey = (episode.tracks ?? []).filter(
      (track) => track.artist === hit.name.split(' — ')[0] && track.start === hit.start
    );
    const track = sameKey[0];
    const nearEnd = piece.start - track.start <= track.end - piece.end;
    const trim = nearEnd ? { end: round(piece.start) } : { start: round(piece.end) };
    const remaining = nearEnd ? piece.start - track.start : track.end - piece.end;
    if (remaining < 5) {
      talkOver.push({ cluster: piece, hit, reason: 'utwór zostałby krótszy niż 5 s' });
      continue;
    }
    talkOver.push({ cluster: piece, hit, trim });
    fresh.push({ label: labelFor(id, piece), start: round(piece.start), end: round(piece.end) });
  }

  const label = episode.slug ?? id.slice(0, 8);
  console.log(`${label}: klastrów ${clusters.length}, nowych wejść ${fresh.length}, wydłużonych ${moved.length}, po muzyce ${talkOver.length}`);
  for (const topic of fresh.slice(0, 8)) console.log(`  + ${topic.start}–${topic.end} (${Math.round(topic.end - topic.start)} s) ${topic.label}`);
  for (const { topic, start } of moved.slice(0, 8)) console.log(`  → ${topic.start} cofam do ${round(start)} (${Math.round(topic.start - start)} s) ${(topic.label ?? '').slice(0, 50)}`);
  for (const { cluster, hit } of talkOver.slice(0, 5)) {
    console.log(`  ! ${cluster.start}–${cluster.end} mówienie w utworze: ${hit.name}`);
  }

  if (write && (fresh.length > 0 || moved.length > 0)) {
    const added = mergeIntoOverride(`data/overrides/${id}.json`, fresh, moved);
    totalAdded += added;
    console.log(`  zapisano ${added} do data/overrides/${id}.json`);
  }
}

if (!write) console.log('\nTryb sprawdzania — dodaj --write, żeby zapisać.');
else console.log(`\nZapisano ${totalAdded} wejść.`);
