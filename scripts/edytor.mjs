#!/usr/bin/env node
/**
 * Lokalny edytor osi czasu: przeglądarka + zapis do data/overrides i data/titles.json.
 * Uruchomienie: npm run edytor (http://localhost:4330).
 *
 * Edytuje wyłącznie warstwę poprawek, więc kolejny import z taggera niczego nie kasuje.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 4330);
const CACHE = join(ROOT, '.cache');
const PEAKS = join(CACHE, 'peaks');
const PEAKS_PER_SEC = 100; // 1 słupek = 10 ms
const SAMPLE_RATE = 2000; // z tego redukujemy do PEAKS_PER_SEC (max z 20 próbek)

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const normalize = (value) => (value ?? '').normalize('NFC').trim().toLowerCase();
const same = (left, right) => right === undefined || normalize(left) === normalize(right);

const loadCatalog = () => readJson(join(DATA, 'catalog.json'), { episodes: [] });
const ALIASES_PATH = join(DATA, 'aliases.json');
const TAG_TYPES = ['artist', 'person', 'work', 'event', 'concert', 'place', 'theme', 'editorial'];
const loadAliasFile = async () => {
  const file = await readJson(ALIASES_PATH, { version: 1, aliases: {}, types: {}, dismissed: [] });
  return { aliases: file.aliases ?? {}, types: file.types ?? {}, dismissed: file.dismissed ?? [] };
};
const loadAliases = async () => (await loadAliasFile()).aliases;

const resolveAlias = (label, aliases) => {
  let current = label;
  for (let step = 0; step < 5; step++) {
    const next = aliases[current];
    if (!next || next === current) break;
    current = next;
  }
  return current;
};

const foldWords = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Etykiety z odcinków plus nazwy z creditsów: alias może celować w każdą z nich.
const collectLabels = async () => {
  const episodes = await loadEpisodes();
  const labels = new Map();
  for (const episode of episodes.values()) {
    if (!episode) continue;
    for (const tag of episode.tags ?? []) {
      const current = labels.get(tag.label) ?? { label: tag.label, type: tag.type, episodes: new Set() };
      current.episodes.add(episode.id);
      labels.set(tag.label, current);
    }
    for (const credit of episode.credits ?? []) {
      const current = labels.get(credit.name) ?? { label: credit.name, type: 'person', episodes: new Set() };
      current.episodes.add(episode.id);
      labels.set(credit.name, current);
    }
  }
  return labels;
};

const aliasCandidates = (labels, aliases, dismissed) => {
  const people = [...labels.values()].filter((item) => item.type === 'person' && resolveAlias(item.label, aliases) === item.label);
  const out = [];
  for (const shorter of people) {
    for (const longer of people) {
      if (longer.label.length <= shorter.label.length + 3) continue;
      if (!` ${foldWords(longer.label)} `.includes(` ${foldWords(shorter.label)} `)) continue;
      if (dismissed.some((pair) => pair.from === shorter.label && pair.to === longer.label)) continue;
      out.push({ from: shorter.label, to: longer.label });
    }
  }
  return out;
};

const aliasProblems = (aliases, labels) => {
  const problems = [];
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias === target) problems.push(`${alias}: alias wskazuje sam na siebie`);
    if (resolveAlias(target, aliases) !== target) problems.push(`${target}: łańcuch aliasów tworzy pętlę`);
    if (!labels.has(target)) problems.push(`${alias}: nie ma takiej etykiety jak ${target}`);
  }
  return problems;
};
const loadTitles = () => readJson(join(DATA, 'titles.json'), { version: 1, titles: {} });
const loadOverrides = async () => {
  const map = new Map();
  let names = [];
  try {
    names = (await readdir(join(DATA, 'overrides'))).filter((name) => name.endsWith('.json'));
  } catch {
    return map;
  }
  for (const name of names) {
    map.set(name.replace(/\.json$/, ''), await readJson(join(DATA, 'overrides', name), null));
  }
  return map;
};

const loadEpisodes = async () => {
  const map = new Map();
  let names = [];
  try {
    names = (await readdir(join(DATA, 'episodes'))).filter((name) => name.endsWith('.json'));
  } catch {
    return map;
  }
  for (const name of names) {
    map.set(name.replace(/\.json$/, ''), await readJson(join(DATA, 'episodes', name), null));
  }
  return map;
};

/** Wartości efektywne: to samo, co widzi strona po nałożeniu poprawek. */
const applyOverrides = (episode, override) => {
  if (!episode) return null;
  const result = structuredClone(episode);
  // Indeks w pliku odcinka: jedyny stabilny identyfikator, bo ten sam utwór bywa
  // rozpoznany dwa razy (te same artist/title/album).
  result.tracks = result.tracks.map((track, index) => ({ ...track, _index: index }));
  for (const fix of override?.tracks ?? []) {
    const track = result.tracks.find(
      (candidate) => same(candidate.artist, fix.artist) && same(candidate.title, fix.title) && same(candidate.album, fix.album)
    );
    if (!track) continue;
    if (fix.start !== undefined) track.start = fix.start;
    if (fix.durationSec !== undefined) track.durationSec = fix.durationSec;
    if (fix.newArtist !== undefined) track.artist = fix.newArtist;
    if (fix.newTitle !== undefined) track.title = fix.newTitle;
    if (fix.newAlbum !== undefined) track.album = fix.newAlbum;
  }
  result.tracks = result.tracks.filter(
    (track) =>
      !(override?.tracks ?? []).some(
        (fix) => fix.hide && same(track.artist, fix.artist) && same(track.title, fix.title) && same(track.album, fix.album)
      )
  );
  for (const fix of override?.topics ?? []) {
    const topic = result.topics.find((candidate) => candidate.start === fix.time && same(candidate.label, fix.label));
    if (!topic) continue;
    if (fix.start !== undefined) topic.start = fix.start;
    if (fix.newLabel) topic.label = fix.newLabel;
  }
  result.topics = result.topics.filter(
    (topic) => !(override?.topics ?? []).some((fix) => fix.hide && fix.time === topic.start && same(topic.label, fix.label))
  );
  return result;
};

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('za duże'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/** Szczyty głośności do waveformu: ffmpeg czyta nagranie strumieniem z URL (range
 * requests), więc plik na dysku nie jest potrzebny. Wynik leży w `.cache/peaks`. */
const peaksInFlight = new Map();

const computePeaks = (audioUrl) =>
  new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioUrl, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-']);
    const peaks = [];
    const perBucket = SAMPLE_RATE / PEAKS_PER_SEC; // 20 próbek = 10 ms
    let peak = 0;
    let samples = 0;
    let leftover = Buffer.alloc(0);
    let errorText = '';

    // Bierzemy maksimum z próbek, bo przeliczanie ich na jeden słupek uśrednianiem
    // zgubiłoby transjenty i waveform kłamałby o cichych fragmentach.
    const take = (buffer) => {
      for (let offset = 0; offset + 2 <= buffer.length; offset += 2) {
        const value = Math.abs(buffer.readInt16LE(offset)) / 32768;
        if (value > peak) peak = value;
        samples += 1;
        if (samples === perBucket) {
          peaks.push(Math.min(255, Math.round(peak * 255)));
          peak = 0;
          samples = 0;
        }
      }
    };

    const onData = (chunk) => {
      const buffer = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buffer.length - (buffer.length % 2);
      leftover = buffer.subarray(usable);
      take(buffer.subarray(0, usable));
    };

    ffmpeg.stdout.on('data', onData);
    ffmpeg.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
      if (errorText.length > 4000) errorText = errorText.slice(-4000);
    });
    ffmpeg.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('brak ffmpeg w PATH') : error));
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(errorText.trim() || `ffmpeg zakończył się kodem ${code}`));
      if (peaks.length === 0) return reject(new Error('ffmpeg nie zwrócił dźwięku'));
      // Audycja jest zmiksowana cicho (szczyty ~-8 dBFS), więc bez normalizacji waveform
      // byłby płaski. Skalujemy do najgłośniejszego miejsca i podnosimy wykładnikiem,
      // bo słupek ma pokazywać głośność czytelnie, nie wiernie w skali liniowej.
      const loudest = peaks.reduce((max, value) => (value > max ? value : max), 1);
      resolve(Uint8Array.from(peaks, (value) => Math.round(255 * (value / loudest) ** 0.6)));
    });
  });

// Adres nagrania w nazwie pliku: podmiana audioUrl w katalogu unieważnia cache.
const peaksFile = (id, audioUrl) => join(PEAKS, `${id}-${createHash('sha1').update(audioUrl).digest('hex').slice(0, 8)}.bin`);

const loadPeaks = async (id, audioUrl) => {
  try {
    const cached = await readFile(peaksFile(id, audioUrl));
    if (cached.length > 0) return cached;
  } catch {}
  const running = peaksInFlight.get(id);
  if (running) return running;
  const job = (async () => {
    const data = await computePeaks(audioUrl);
    await mkdir(PEAKS, { recursive: true });
    await writeFile(peaksFile(id, audioUrl), data);
    return data;
  })().finally(() => peaksInFlight.delete(id));
  peaksInFlight.set(id, job);
  return job;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(ROOT, 'scripts', 'edytor.html'), 'utf8'));
      return;
    }

    if (url.pathname === '/api/peaks') {
      const id = url.searchParams.get('id');
      const catalog = await loadCatalog();
      const entry = catalog.episodes.find((item) => item.id === id);
      if (!entry) return json(res, 404, { error: 'nie ma takiego odcinka' });
      if (!entry.audioUrl) return json(res, 503, { error: 'katalog nie ma adresu nagrania dla tego odcinka' });
      try {
        const data = await loadPeaks(id, entry.audioUrl);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
          'x-peaks-per-second': String(PEAKS_PER_SEC),
          'cache-control': 'no-store',
        });
        res.end(data);
        return;
      } catch (error) {
        return json(res, 503, { error: `nie udało się policzyć waveformu: ${error.message}` });
      }
    }

    if (url.pathname === '/api/tags') {
      const [labels, file] = await Promise.all([collectLabels(), loadAliasFile()]);
      json(res, 200, {
        aliases: file.aliases,
        types: file.types,
        dismissed: file.dismissed,
        candidates: aliasCandidates(labels, file.aliases, file.dismissed),
        tags: [...labels.values()]
          .map((item) => ({
            label: item.label,
            type: file.types[resolveAlias(item.label, file.aliases)] ?? item.type,
            originalType: item.type,
            count: item.episodes.size,
            canonical: resolveAlias(item.label, file.aliases),
          }))
          .sort((left, right) => left.label.localeCompare(right.label, 'pl')),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/aliases') {
      const payload = JSON.parse(await readBody(req));
      const aliases = {};
      for (const [from, to] of Object.entries(payload.aliases ?? {})) {
        const key = String(from).trim();
        const value = String(to).trim();
        if (key && value && key !== value) aliases[key] = value;
      }
      const types = {};
      for (const [label, type] of Object.entries(payload.types ?? {})) {
        const key = String(label).trim();
        if (key && TAG_TYPES.includes(type)) types[key] = type;
      }
      const dismissed = (payload.dismissed ?? []).filter((pair) => pair?.from && pair?.to);
      const labels = await collectLabels();
      const problems = aliasProblems(aliases, labels);
      if (problems.length > 0) return json(res, 400, { error: problems.join('; ') });
      await writeJson(ALIASES_PATH, { version: 1, aliases, types, dismissed });
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/episodes') {
      const catalog = await loadCatalog();
      const titles = await loadTitles();
      const episodes = await loadEpisodes();
      json(res, 200, {
        episodes: catalog.episodes
          .map((entry) => ({
            id: entry.id,
            slug: entry.slug,
            date: entry.date,
            originalTitle: entry.title,
            displayTitle: titles.titles?.[entry.id]?.title ?? entry.title,
            audioUrl: entry.audioUrl,
            edited: episodes.has(entry.id),
          }))
          .sort((a, b) => (a.date < b.date ? 1 : -1)),
      });
      return;
    }

    if (url.pathname === '/api/episode') {
      const id = url.searchParams.get('id');
      const catalog = await loadCatalog();
      const entry = catalog.episodes.find((item) => item.id === id);
      if (!entry) return json(res, 404, { error: 'nie ma takiego odcinka' });
      const overrides = await loadOverrides();
      const episodes = await loadEpisodes();
      const titles = await loadTitles();
      json(res, 200, {
        id,
        slug: entry.slug,
        audioUrl: entry.audioUrl,
        durationSec: entry.durationSec ?? null,
        originalTitle: entry.title,
        title: titles.titles?.[id]?.title ?? '',
        hasEpisode: episodes.has(id),
        tracks: applyOverrides(episodes.get(id), overrides.get(id))?.tracks ?? [],
        topics: applyOverrides(episodes.get(id), overrides.get(id))?.topics ?? [],
        original: {
          tracks: (episodes.get(id)?.tracks ?? []).map((track, index) => ({ ...track, _index: index })),
          topics: episodes.get(id)?.topics ?? [],
        },
        raw: overrides.get(id) ?? null,
        addTracks: overrides.get(id)?.addTracks ?? [],
        addTopics: overrides.get(id)?.addTopics ?? [],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const payload = JSON.parse(await readBody(req));
      const id = payload.id;
      if (!id) return json(res, 400, { error: 'brak id' });

      const catalog = await loadCatalog();
      const entry = catalog.episodes.find((item) => item.id === id);
      if (!entry) return json(res, 404, { error: 'nie ma takiego odcinka' });

      const overrides = await loadOverrides();
      const previous = overrides.get(id) ?? { version: 1, tracks: [], topics: [], credits: { rename: {} } };
      // Nowe wpisy zastępują pasujące, reszta poprzednich poprawek zostaje — inaczej
      // zapis jednego wiersza kasowałby wcześniejsze korekty.
      const sameTrack = (left, right) =>
        normalize(left.artist) === normalize(right.artist) &&
        normalize(left.title) === normalize(right.title) &&
        normalize(left.album ?? '') === normalize(right.album ?? '');
      const tracks = [...previous.tracks];
      for (const fix of payload.tracks ?? []) {
        const index = tracks.findIndex((existing) => sameTrack(existing, fix));
        if (index >= 0) tracks[index] = fix;
        else tracks.push(fix);
      }
      const sameTopic = (left, right) => left.time === right.time && normalize(left.label) === normalize(right.label);
      const topics = [...(previous.topics ?? [])];
      for (const fix of payload.topics ?? []) {
        const index = topics.findIndex((existing) => sameTopic(existing, fix));
        if (index >= 0) topics[index] = fix;
        else topics.push(fix);
      }
      const next = {
        version: 1,
        tracks,
        topics,
        addTracks: payload.addTracks ?? previous.addTracks ?? [],
        addTopics: payload.addTopics ?? previous.addTopics ?? [],
        credits: previous.credits ?? { rename: {} },
      };
      const empty =
        next.tracks.length === 0 &&
        next.topics.length === 0 &&
        next.addTracks.length === 0 &&
        next.addTopics.length === 0;
      const overridePath = join(DATA, 'overrides', `${id}.json`);
      if (empty) {
        const { rm } = await import('node:fs/promises');
        await rm(overridePath, { force: true });
      } else {
        await writeJson(overridePath, next);
      }

      const titles = await loadTitles();
      const title = (payload.title ?? '').trim();
      if (title.length > 0 && title !== entry.title) {
        titles.titles = titles.titles ?? {};
        titles.titles[id] = {
          title,
          kind: 'unofficial',
          originalTitle: entry.title,
          note: 'Tytuł redakcyjny ustawiony ręcznie w edytorze.',
        };
      } else if (titles.titles?.[id]) {
        delete titles.titles[id];
      }
      await writeJson(join(DATA, 'titles.json'), titles);

      json(res, 200, { ok: true, cleared: empty });
      return;
    }

    json(res, 404, { error: 'nie ma takiej ścieżki' });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Edytor: http://localhost:${PORT}`);
  console.log('Zapisuje do data/overrides i data/titles.json — potem: npm run build');
});
