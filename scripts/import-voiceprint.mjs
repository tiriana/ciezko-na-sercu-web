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

const mergeIntoOverride = (path, added) => {
  const current = existsSync(path)
    ? readJson(path)
    : { version: 1, tracks: [], topics: [], addTracks: [], addTopics: [] };
  const existing = current.addTopics ?? [];
  const fresh = added.filter(
    (topic) => !existing.some((other) => Math.abs(other.start - topic.start) < COVER_TOLERANCE_SEC)
  );
  if (fresh.length === 0) return 0;
  const next = {
    version: current.version ?? 1,
    tracks: current.tracks ?? [],
    topics: current.topics ?? [],
    addTracks: current.addTracks ?? [],
    addTopics: [...existing, ...fresh].sort((left, right) => left.start - right.start),
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return fresh.length;
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

  const fresh = [];
  const talkOver = [];
  for (const cluster of clusters) {
    const hit = items.find((item) => overlap(item, cluster) > COVER_TOLERANCE_SEC);
    if (hit?.kind === 'utwór') talkOver.push({ cluster, hit });
    else if (!hit) fresh.push({ label: labelFor(id, cluster), start: round(cluster.start), end: round(cluster.end) });
  }

  const label = episode.slug ?? id.slice(0, 8);
  console.log(`${label}: klastrów ${clusters.length}, nowych wejść ${fresh.length}, po muzyce ${talkOver.length}`);
  for (const topic of fresh.slice(0, 8)) console.log(`  + ${topic.start}–${topic.end} (${Math.round(topic.end - topic.start)} s) ${topic.label}`);
  for (const { cluster, hit } of talkOver.slice(0, 5)) {
    console.log(`  ! ${cluster.start}–${cluster.end} mówienie w utworze: ${hit.name}`);
  }

  if (write && fresh.length > 0) {
    const added = mergeIntoOverride(`data/overrides/${id}.json`, fresh);
    totalAdded += added;
    console.log(`  zapisano ${added} do data/overrides/${id}.json`);
  }
}

if (!write) console.log('\nTryb sprawdzania — dodaj --write, żeby zapisać.');
else console.log(`\nZapisano ${totalAdded} wejść.`);
