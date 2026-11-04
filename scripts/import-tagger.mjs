import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [workDir, outputDir = 'data/episodes'] = process.argv.slice(2);
if (!workDir) {
  console.error('usage: node scripts/import-tagger.mjs <tagger work/episodes> [out]');
  process.exit(1);
}

// Kluczem jest uuid odcinka z katalogu; katalog zna też historyczne slugi, więc dopasowanie
// łapie opracowania zrobione przed zmianą tytułu. Data zostaje jako ostatnia deska ratunku.
const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const bySlug = new Map();
const byDate = new Map();
for (const episode of catalog.episodes) {
  for (const slug of episode.slugs ?? []) bySlug.set(slug, episode.id);
  byDate.set(episode.date, [...(byDate.get(episode.date) ?? []), episode.id]);
}

function catalogIdFor(episode) {
  const byExactSlug = bySlug.get(episode.episodeId);
  if (byExactSlug) return byExactSlug;
  const candidates = byDate.get(episode.date) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

const parseSources = (source) =>
  source
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

const isoDate = (date) => date.toISOString().slice(0, 10);

const toContract = (episode, analyzedAt, id) => {
  const quotes = new Map();
  for (const track of episode.tracks ?? []) {
    if (!track.quote) continue;
    const start = track.announcementTime ?? track.start;
    quotes.set(`${start}|${track.quote}`, { start: Math.round(start), text: track.quote });
  }

  return {
    version: 1,
    id,
    analyzedAt,
    durationSec: episode.durationSec == null ? null : Math.round(episode.durationSec),
    summary: episode.summary ?? null,
    topics: (episode.topics ?? []).map((topic) => ({
      start: Math.round(topic.time),
      label: topic.topic,
    })),
    tracks: (episode.tracks ?? []).map((track) => ({
      start: Math.round(track.start),
      durationSec: Math.round(track.durationSec),
      artist: track.artist,
      title: track.title,
      album: track.album ?? null,
      confidence: track.confidence ?? null,
      sources: parseSources(track.source ?? ''),
      links: [],
    })),
    quotes: [...quotes.values()].sort((a, b) => a.start - b.start),
  };
};

await mkdir(resolve(outputDir), { recursive: true });

const entries = await readdir(workDir, { withFileTypes: true });
let imported = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const file = join(workDir, entry.name, 'episode.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  const episode = JSON.parse(raw);
  const analyzedAt = isoDate((await stat(file)).mtime);
  const id = catalogIdFor(episode);
  if (!id) {
    console.warn(`pominięto ${entry.name}: brak odcinka w katalogu`);
    continue;
  }
  const target = join(outputDir, `${id}.json`);
  await writeFile(resolve(target), `${JSON.stringify(toContract(episode, analyzedAt, id), null, 2)}\n`);
  imported += 1;
}

console.log(`${imported} opracowań -> ${outputDir}`);
