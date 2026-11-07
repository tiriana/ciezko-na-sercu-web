import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [workDir, outputDir = 'data/episodes', transcriptsDir = 'data/transcripts'] = process.argv.slice(2);
const insightsDir = process.env.RAT_INSIGHTS_DIR ?? join(workDir, '..', '..', 'insights');
if (!workDir) {
  console.error('usage: node scripts/import-tagger.mjs <tagger work/episodes> [out]');
  process.exit(1);
}

// Kluczem jest uuid odcinka z katalogu; katalog zna też historyczne slugi, więc dopasowanie
// łapie opracowania zrobione przed zmianą tytułu. Data zostaje jako ostatnia deska ratunku.
const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const bySlug = new Map();
const byDate = new Map();
const byTitle = new Map();
for (const episode of catalog.episodes) {
  for (const slug of episode.slugs ?? []) bySlug.set(slug, episode.id);
  byDate.set(episode.date, [...(byDate.get(episode.date) ?? []), episode.id]);
  const key = episode.title.normalize('NFC').trim().toLowerCase();
  byTitle.set(key, [...(byTitle.get(key) ?? []), episode.id]);
}

const normalize = (value) => (value ?? '').normalize('NFC').trim().toLowerCase();

function catalogIdFor(episode) {
  const byExactSlug = bySlug.get(episode.episodeId);
  if (byExactSlug) return byExactSlug;

  // Tagger ucina identyfikator do 70 znaków, więc slug z katalogu bywa dłuższy.
  const byPrefix = [...bySlug.entries()].filter(([slug]) => slug.startsWith(episode.episodeId));
  if (byPrefix.length === 1) return byPrefix[0][1];

  const byExactTitle = byTitle.get(normalize(episode.title)) ?? [];
  if (byExactTitle.length === 1) return byExactTitle[0];

  const candidates = byDate.get(episode.date) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

const parseSources = (source) =>
  source
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

const isoDate = (date) => date.toISOString().slice(0, 10);

// Ta sama reguła co tagId w src/lib/tags.ts: id tagu musi być identyczny po obu stronach.
const tagId = (label) =>
  label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Przywołania z rozmowy idą do tagów: festiwal to wydarzenie, koncert ma własną grupę,
// książka i film to dzieła. Koncerty bierzemy po zespole, bo tytuł bywa zdaniem.
const MENTION_KINDS = {
  festival: { type: 'event', label: (m) => m.title },
  concert: { type: 'concert', label: (m) => m.author || m.title, prefix: 'koncert-' },
  book: { type: 'work', label: (m) => m.title },
  film: { type: 'work', label: (m) => m.title },
};

const mentionTag = (mention) => {
  const kind = MENTION_KINDS[mention.type];
  const label = kind.label(mention);
  return {
    id: `${kind.prefix ?? ''}${tagId(label)}`,
    label,
    type: kind.type,
    source: 'transcript',
    at: mention.at == null ? undefined : Math.round(mention.at),
  };
};

// Pogłębione opracowanie z taggera (scripts/opencode-insights.sh): lepsze streszczenie
// oraz fakty spoza tracklisty. Goście dołączają do creditsów, bo to ta sama rola na stronie.
async function readInsights(sourceId) {
  try {
    return JSON.parse(await readFile(join(insightsDir, `${sourceId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Stałe obsady nie wynikają z rozpoznawania: audycję prowadzi Jarek Szubrycht, a wydaje
// Mariusz Owczarek. Wyjątki (zastępstwo) przychodzą z taggera i wtedy nie dopisujemy nikogo.
const HOST = 'Jarek Szubrycht';
const PUBLISHER = 'Mariusz Owczarek';

const withHouseCredits = (credits) => {
  const next = [...credits];
  const hasOtherHost = next.some((credit) => credit.role === 'prowadzący' && credit.name !== HOST);
  if (!hasOtherHost && !next.some((credit) => credit.role === 'prowadzący')) {
    next.push({ role: 'prowadzący', name: HOST, time: 0, quote: '' });
  }
  const hasPublisher = next.some((credit) => credit.role === 'wydawca' || credit.role === 'producent');
  if (!hasPublisher) next.push({ role: 'wydawca', name: PUBLISHER, time: 0, quote: '' });
  return next;
};

const creditsToTags = (credits) =>
  credits
    .filter((credit) => credit.name === HOST || credit.name === PUBLISHER)
    .map((credit) => ({ id: tagId(credit.name), label: credit.name, type: 'person', source: 'credits' }));

const toContract = (episode, analyzedAt, id, insights) => {
  const houseCredits = withHouseCredits([
    ...(episode.credits ?? []).map((credit) => ({
      role: credit.role,
      name: credit.name,
      time: Math.round(credit.time ?? 0),
      quote: credit.quote ?? '',
    })),
  ]);
  const quotes = new Map();
  for (const track of episode.tracks ?? []) {
    if (!track.quote) continue;
    const start = track.announcementTime ?? track.start;
    quotes.set(`${start}|${track.quote}`, { start: Math.round(start), text: track.quote });
  }

  const guestCredits = (insights?.guests ?? []).map((guest) => ({
    role: 'gość',
    name: guest.name,
    time: Math.round(guest.at ?? 0),
    quote: '',
  }));

  return {
    version: 1,
    id,
    analyzedAt,
    updatedAt: episode.updatedAt ?? undefined,
    durationSec: episode.durationSec == null ? null : Math.round(episode.durationSec),
    summary: insights?.summary ?? episode.summary ?? null,
    topics: (episode.topics ?? []).map((topic) => ({
      start: Math.round(topic.time),
      // Koniec policzony w taggerze; brak = strona wyprowadzi go z następnej pozycji.
      end: topic.end == null ? undefined : Math.round(topic.end),
      label: topic.topic,
    })),
    tags: [
      ...(episode.tags ?? []).map((tag) => ({
        id: tag.id,
        label: tag.label,
        type: tag.type ?? 'editorial',
        source: tag.source ?? 'profile',
        at: tag.at == null ? undefined : Math.round(tag.at),
      })),
      ...(insights?.guests ?? []).map((guest) => ({
        id: tagId(guest.name),
        label: guest.name,
        type: 'person',
        source: 'credits',
        at: guest.at == null ? undefined : Math.round(guest.at),
      })),
      ...(insights?.mentions ?? []).filter((mention) => MENTION_KINDS[mention.type]).map(mentionTag),
      ...creditsToTags(houseCredits),
    ].filter((tag, index, all) => all.findIndex((other) => other.id === tag.id) === index),
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
    credits: [...houseCredits, ...guestCredits],
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
  const insights = await readInsights(entry.name);
  const target = join(outputDir, `${id}.json`);
  await writeFile(resolve(target), `${JSON.stringify(toContract(episode, analyzedAt, id, insights), null, 2)}\n`);
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
