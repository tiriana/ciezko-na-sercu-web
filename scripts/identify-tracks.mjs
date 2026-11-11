#!/usr/bin/env node
/**
 * Rozpoznaje utwory Shazamem w blokach muzyki. Blok to dopełnienie okien mowy
 * z transkryptu, więc drugi model VAD nie jest potrzebny — mowa jest już
 * oznaczona przez whispera. Z każdego bloku bierzemy do trzech 12-sekundowych
 * próbek wyciętych z mp3 po HTTP (range requests), a pierwszy trafiony utwór
 * zostaje wpisany do `data/episodes/<id>.json`.
 *
 *   node scripts/identify-tracks.mjs [--episodes <id|slug,...>] [--limit N] [--force] [--write]
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Shazam } from 'node-shazam';

const run = promisify(execFile);

const MIN_MUSIC_SEC = 45;
const PROBE = { probeSec: 12, leadInSec: 12, tailSec: 10, maxProbes: 3 };
const POSITIONS = [0.15, 0.5, 0.85];
const SHAZAM_DELAY_MS = 1200;
const RETRY = { attempts: 4, baseDelayMs: 5000 };
const CONFIDENCE = 'średnia';

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

const write = args.has('write');
const force = args.has('force');
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const round = (value) => Math.round(value * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const catalog = await readJson('data/catalog.json');
const byKey = new Map();
for (const episode of catalog.episodes) {
  byKey.set(episode.id, episode);
  for (const slug of episode.slugs ?? [episode.slug]) byKey.set(slug, episode);
}

const episodeFiles = (await readdir('data/episodes')).filter((name) => name.endsWith('.json'));

const selected = [];
if (wanted.length > 0) {
  for (const key of wanted) {
    const episode = byKey.get(key);
    if (!episode) {
      console.error(`Nieznany odcinek: ${key}`);
      process.exit(1);
    }
    selected.push(episode);
  }
} else {
  for (const name of episodeFiles) {
    const episode = byKey.get(name.replace(/\.json$/, ''));
    if (episode) selected.push(episode);
  }
}

const musicBlocks = (windows, duration) => {
  const blocks = [];
  let cursor = 0;
  for (const window of [...windows].sort((left, right) => left.start - right.start)) {
    if (window.start - cursor >= MIN_MUSIC_SEC) blocks.push({ start: round(cursor), end: round(window.start) });
    cursor = Math.max(cursor, window.end);
  }
  if (duration - cursor >= MIN_MUSIC_SEC) blocks.push({ start: round(cursor), end: round(duration) });
  return blocks;
};

const planProbes = (block) => {
  const length = block.end - block.start;
  if (length <= PROBE.probeSec) return [{ start: block.start, end: block.end }];

  const leadIn = Math.min(PROBE.leadInSec, length * 0.2);
  const tail = Math.min(PROBE.tailSec, length * 0.2);
  const usableStart = block.start + leadIn;
  const room = block.end - tail - usableStart - PROBE.probeSec;

  if (room <= 0) {
    const start = block.start + (length - PROBE.probeSec) / 2;
    return [{ start: round(start), end: round(start + PROBE.probeSec) }];
  }

  return POSITIONS.slice(0, PROBE.maxProbes).map((position) => {
    const start = usableStart + room * position;
    return { start: round(start), end: round(start + PROBE.probeSec) };
  });
};

// Katalog nie zna długości nowych odcinków, a bez niej ostatni blok muzyki po
// pożegnaniu wypadałby z zasięgu. ffprobe czyta nagłówek mp3 po HTTP i odpowiada
// w ułamek sekundy, więc nie ściąga całego nagrania.
const probeDuration = async (url) => {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url,
  ]);
  return Number.parseFloat(stdout.trim()) || 0;
};

const extractClip = async (url, start, seconds, file) => {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start), '-t', String(seconds),
    '-i', url,
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', file,
  ]);
};

const shazam = new Shazam();

// Shazam odpowiada stroną HTML zamiast JSON-em, gdy uzna, że zapytań jest za dużo;
// blokada mija po kilkunastu sekundach, więc ponawiamy z dłuższym oddechem.
// Brak dopasowania nie jest awarią i nie jest ponawiany.
const recognize = async (file) => {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY.attempts; attempt += 1) {
    try {
      return await shazam.recognise(file, 'en-US');
    } catch (error) {
      lastError = error;
      if (attempt < RETRY.attempts) await sleep(RETRY.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
};

const metadata = (sections, field) => {
  for (const section of sections ?? []) {
    for (const entry of section.metadata ?? []) {
      if (entry.title === field && entry.text) return entry.text;
    }
  }
  return null;
};

const work = await mkdtemp(join(tmpdir(), 'cns-shazam-'));
let processed = 0;

try {
  for (const entry of selected) {
    if (limit > 0 && processed >= limit) break;

    const episodePath = `data/episodes/${entry.id}.json`;
    let episode;
    try {
      episode = await readJson(episodePath);
    } catch {
      console.log(`— ${entry.slug}: brak opracowania`);
      continue;
    }
    if ((episode.tracks ?? []).length > 0 && !force) {
      console.log(`— ${entry.slug}: ${episode.tracks.length} utworów już jest`);
      continue;
    }

    const transcript = await readJson(`data/transcripts/${entry.id}.json`).catch(() => null);
    if (!transcript) {
      console.log(`— ${entry.slug}: brak transkryptu`);
      continue;
    }

    const windows = transcript.windows ?? [];
    const duration = entry.durationSec ?? (await probeDuration(entry.audioUrl)) ?? windows.at(-1)?.end ?? 0;
    if (duration <= 0) {
      console.log(`— ${entry.slug}: nieznana długość nagrania`);
      continue;
    }

    const blocks = musicBlocks(windows, duration);
    const tracks = [];
    let probes = 0;

    for (const block of blocks) {
      let found = null;
      for (const probe of planProbes(block)) {
        const clip = join(work, `${entry.id}-${Math.round(probe.start)}.wav`);
        try {
          await extractClip(entry.audioUrl, probe.start, probe.end - probe.start, clip);
          const response = await recognize(clip);
          probes += 1;
          const track = response?.track;
          if (track?.title) {
            found = track;
            break;
          }
        } catch (error) {
          probes += 1;
          console.error(`   ${entry.slug}@${Math.round(probe.start)}: ${error.message}`);
        } finally {
          await rm(clip, { force: true });
        }
        await sleep(SHAZAM_DELAY_MS);
      }

      if (!found) {
        if (block.end - block.start > 0) console.log(`   bez trafienia: ${block.start}–${block.end}`);
        continue;
      }

      tracks.push({
        start: block.start,
        end: block.end,
        durationSec: round(block.end - block.start),
        artist: found.subtitle?.trim() || null,
        title: found.title.trim(),
        album: metadata(found.sections, 'Album'),
        confidence: CONFIDENCE,
        sources: ['shazam'],
        links: [],
      });
    }

    console.log(`${write ? '+' : '·'} ${entry.slug}: ${tracks.length}/${blocks.length} bloków, ${probes} próbek`);
    for (const track of tracks) console.log(`   ${track.start}–${track.end}  ${track.artist ?? '?'} — ${track.title}`);

    if (write && tracks.length > 0) {
      episode.tracks = tracks.sort((left, right) => left.start - right.start);
      await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
    }
    processed += 1;
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

if (!write) console.log('\nBez --write nic nie zapisano.');
