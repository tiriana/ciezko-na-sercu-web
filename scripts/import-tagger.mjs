import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [workDir, outputDir = 'data/episodes', transcriptsDir = 'data/transcripts'] = process.argv.slice(2);
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
    updatedAt: episode.updatedAt ?? undefined,
    durationSec: episode.durationSec == null ? null : Math.round(episode.durationSec),
    summary: episode.summary ?? null,
    topics: (episode.topics ?? []).map((topic) => ({
      start: Math.round(topic.time),
      // Koniec policzony w taggerze; brak = strona wyprowadzi go z następnej pozycji.
      end: topic.end == null ? undefined : Math.round(topic.end),
      label: topic.topic,
    })),
    tags: (episode.tags ?? []).map((tag) => ({
      id: tag.id,
      label: tag.label,
      type: tag.type ?? 'editorial',
      source: tag.source ?? 'profile',
      at: tag.at == null ? undefined : Math.round(tag.at),
    })),
    tracks: (episode.tracks ?? []).map((track) => ({
      start: Math.round(track.start),
      end: track.end == null ? undefined : Math.round(track.end),
      durationSec: Math.round(track.durationSec),
      artist: track.artist,
      title: track.title,
      album: track.album ?? null,
      confidence: track.confidence ?? null,
      sources: parseSources(track.source ?? ''),
      links: [],
    })),
    quotes: [...quotes.values()].sort((a, b) => a.start - b.start),
    credits: (episode.credits ?? []).map((credit) => ({
      role: credit.role,
      name: credit.name,
      time: Math.round(credit.time ?? 0),
      quote: credit.quote ?? '',
    })),
  };
};

await mkdir(resolve(outputDir), { recursive: true });
await mkdir(resolve(transcriptsDir), { recursive: true });

const entries = await readdir(workDir, { withFileTypes: true });
let imported = 0;
let transcripts = 0;

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

  // Transkrypty są danymi audycji, więc leżą w repo strony razem z opracowaniem,
  // a nie w repozytorium narzędzia, które je policzyło. Tagger nazywa odcinek swoim
  // identyfikatorem, więc przepisujemy go na uuid z katalogu (oryginał zostaje w sourceId).
  const transcriptJson = join(workDir, entry.name, 'transcript.json');
  try {
    const transcript = JSON.parse(await readFile(transcriptJson, 'utf8'));
    await writeFile(
      resolve(join(transcriptsDir, `${id}.json`)),
      `${JSON.stringify({ ...transcript, sourceId: transcript.episodeId, episodeId: id }, null, 2)}\n`
    );
    transcripts += 1;
  } catch {
    // brak transkryptu to nie błąd: etap mógł nie zostać uruchomiony
  }

  const transcriptText = join(workDir, entry.name, 'transcript.txt');
  try {
    await stat(transcriptText);
    await copyFile(resolve(transcriptText), resolve(join(transcriptsDir, `${id}.txt`)));
    transcripts += 1;
  } catch {
    // jak wyżej
  }
}

console.log(`${imported} opracowań -> ${outputDir}`);
console.log(`${transcripts} plików transkryptów -> ${transcriptsDir}`);
