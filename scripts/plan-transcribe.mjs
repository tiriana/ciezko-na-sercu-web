#!/usr/bin/env node
/**
 * Zamienia wejście workflow (slugi/uuidy, opcjonalny limit) na macierz jobów
 * transkrypcji. Puste wejście = wszystkie odcinki z katalogu.
 *
 * Długość audio czytamy z pliku przez ffprobe (range request), bo transkrypt
 * kończy się tam, gdzie kończy się mowa — odcinek z muzycznym outro byłby ucięty.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CHUNK_SEC = 2700;
const MIN_EPISODE_SEC = 115 * 60;
const PROBE_TIMEOUT_MS = 30_000;

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const wanted = String(process.env.EPISODES ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const limit = Number.parseInt(process.env.LIMIT ?? '0', 10) || 0;
const force = process.env.FORCE === 'true';
const wantedParams = {
  maxLen: Number(process.env.MAX_LEN ?? '20'),
  splitOnWord: process.env.SPLIT_ON_WORD !== 'false',
  vad: process.env.VAD === 'true',
};

const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const readTranscript = (id) => {
  try {
    return JSON.parse(readFileSync(new URL(`../data/transcripts/${id}.json`, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
};

// Odcinek jest „zrobiony", gdy jego transkrypt powstał z tymi samymi parametrami.
const isDone = (episode) => {
  const transcript = readTranscript(episode.id);
  const params = transcript?.params;
  if (!params) return false;
  return (
    params.maxLen === wantedParams.maxLen &&
    params.splitOnWord === wantedParams.splitOnWord &&
    params.vad === wantedParams.vad
  );
};

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
if (wanted.length === 0 && !force) {
  const done = episodes.filter(isDone).length;
  episodes = episodes.filter((episode) => !isDone(episode));
  console.log(`pominięto ${done} odcinków już zrobionych tymi parametrami`);
}
if (limit > 0) episodes = episodes.slice(0, limit);

const probeDuration = async (url) => {
  if (!url) return 0;
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
      { timeout: PROBE_TIMEOUT_MS }
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : 0;
  } catch {
    return 0;
  }
};

const transcriptEnd = (episode) => {
  try {
    const transcript = JSON.parse(readFileSync(new URL(`../data/transcripts/${episode.id}.json`, import.meta.url), 'utf8'));
    return (transcript.windows ?? []).reduce((max, window) => Math.max(max, window.end ?? 0), 0);
  } catch {
    return 0;
  }
};

const matrix = [];
for (const episode of episodes) {
  const probed = await probeDuration(episode.audioUrl);
  const known = Math.max(probed, transcriptEnd(episode));
  const duration = Math.max(known, MIN_EPISODE_SEC);
  const parts = Math.ceil(duration / CHUNK_SEC);
  for (let part = 0; part < parts; part += 1) {
    matrix.push({
      id: episode.id,
      slug: episode.slug,
      audioUrl: episode.audioUrl,
      part,
      start: part * CHUNK_SEC,
      length: CHUNK_SEC,
    });
  }
  console.log(`${episode.slug}: ${Math.round(duration / 60)} min -> ${parts} kawałków`);
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(output, `count=${matrix.length}\n`);
}
console.log(`${matrix.length} jobów transkrypcji`);
