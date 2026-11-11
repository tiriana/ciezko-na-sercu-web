#!/usr/bin/env node
/**
 * Lokalny edytor osi czasu: przeglądarka + zapis do data/overrides i data/titles.json.
 * Uruchomienie: npm run edytor (http://localhost:4330).
 *
 * Edytuje wyłącznie warstwę poprawek, więc kolejny import z taggera niczego nie kasuje.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile, rename, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mediaDurationOf } from './lib/timeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(process.env.EDITOR_DATA_DIR ?? join(ROOT, 'data'));
const PORT = Number(process.env.PORT ?? 4330);
const CACHE = resolve(process.env.EDITOR_CACHE_DIR ?? join(ROOT, '.cache'));
const LOG = join(CACHE, 'edytor.log');
const PEAKS = join(CACHE, 'peaks');
const PEAKS_PER_SEC = 100; // 1 słupek = 10 ms
const SAMPLE_RATE = 2000; // z tego redukujemy do PEAKS_PER_SEC (max z 20 próbek)

const log = async (message, error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error ?? '');
  const text = `[${new Date().toISOString()}] ${message}${detail ? `\n${detail}` : ''}\n`;
  process.stderr.write(text);
  await mkdir(CACHE, { recursive: true }).catch(() => {});
  await appendFile(LOG, text).catch(() => {});
};

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    // Uszkodzony plik (np. zapis przerwany restartem) nie może udawać „brak danych”,
    // bo następny zapis nadpisałby go pustką. Zostawiamy kopię i mówimy o tym głośno.
    if (error.code === 'ENOENT') return fallback;
    if (error.code !== 'ENOENT') {
      const copy = `${path}.uszkodzony`;
      await writeFile(copy, `${await readFile(path, 'utf8')}\n`).catch(() => {});
      await log(`Nie da się odczytać ${path} — kopia w ${copy}`, error);
    }
    throw error;
  }
};

// Zapis przez plik tymczasowy: przerwany restart zostawia albo starą, albo nową wersję,
// nigdy uciętą w połowie.
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

const normalize = (value) => (value ?? '').normalize('NFC').trim().toLowerCase();
const same = (left, right) => right === undefined || normalize(left) === normalize(right);
const reviewKeyOf = (kind, object) => {
  if (kind === 'topic') {
    const label = normalize(object.label);
    return label ? `p:${label}` : `p:${Number(object.start).toFixed(2)}`;
  }
  const name = [normalize(object.artist), normalize(object.title)].filter(Boolean).join('|');
  return name ? `t:${name}` : `t:${Number(object.start).toFixed(2)}`;
};

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
  } catch (error) {
    if (error.code === 'ENOENT') return map;
    throw error;
  }
  for (const name of names) {
    const path = join(DATA, 'overrides', name);
    const value = await readJson(path, null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`nieprawidłowy plik poprawek: ${path}`);
    }
    for (const field of ['tracks', 'topics', 'addTracks', 'addTopics']) {
      if (value[field] !== undefined && !Array.isArray(value[field])) {
        throw new TypeError(`pole ${field} nie jest tablicą w ${path}`);
      }
    }
    map.set(name.replace(/\.json$/, ''), value);
  }
  return map;
};

const loadEpisodes = async () => {
  const map = new Map();
  let names = [];
  try {
    names = (await readdir(join(DATA, 'episodes'))).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return map;
    throw error;
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
    // `end` podmienia granicę utworu, gdy redakcja przecięła go ręcznie (to samo pole
    // czyta src/lib/data.ts); bez tego edytor po przeładowaniu liczyłby koniec z durationSec.
    if (fix.end !== undefined) track.end = fix.end;
    if (fix.newArtist !== undefined) track.artist = fix.newArtist;
    if (fix.newTitle !== undefined) track.title = fix.newTitle;
    if (fix.newAlbum !== undefined) track.album = fix.newAlbum;
  }
  result.tracks = result.tracks.filter(
    (track) =>
      !(override?.tracks ?? []).some(
        (fix) =>
          fix.hide &&
          same(track.artist, fix.artist) &&
          same(track.title, fix.title) &&
          same(track.album, fix.album) &&
          (fix.start === undefined || Math.abs(track.start - fix.start) < 0.01)
      )
  );
  for (const fix of override?.topics ?? []) {
    const topic = result.topics.find((candidate) => candidate.start === fix.time && same(candidate.label, fix.label));
    if (!topic) continue;
    if (fix.start !== undefined) topic.start = fix.start;
    if (fix.end !== undefined) topic.end = fix.end;
    if (fix.newLabel) topic.label = fix.newLabel;
  }
  result.topics = result.topics.filter(
    (topic) => !(override?.topics ?? []).some((fix) => fix.hide && fix.time === topic.start && same(topic.label, fix.label))
  );
  return result;
};

// Podgląd pliku edytora: przeglądarka dostaje zdarzenie SSE i odświeża się sama,
// zamiast czekać, aż ktoś zgasi serwer. Restart procesu (node --watch) nie psuje
// niczego, bo klienci to zwykłe odpowiedzi HTTP — po restarcie EventSource łączy się
// ponownie i dostaje świeży stan pliku.
const HTML_PATH = join(ROOT, 'scripts', 'edytor.html');
const events = new Set();
let htmlMtime = 0;

const readHtmlMtime = async () => {
  try {
    htmlMtime = (await stat(HTML_PATH)).mtimeMs;
  } catch {}
  return htmlMtime;
};

const broadcastChange = () => {
  const payload = `event: change\ndata: ${JSON.stringify({ mtime: htmlMtime })}\n\n`;
  for (const client of events) {
    try {
      client.write(payload);
    } catch {
      events.delete(client);
    }
  }
};

let watchTimer = 0;
const watcher = watch(dirname(HTML_PATH), { persistent: false }, (_event, filename) => {
  // Zmiana przez zapis atomowy podmienia plik na nowy i wywołuje rename — stąd filtr
  // po nazwie zamiast po typie zdarzenia.
  if (filename && filename !== 'edytor.html') return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    await readHtmlMtime();
    broadcastChange();
  }, 150);
});
watcher.on('error', (error) => console.error('podgląd edytora:', error.message));
readHtmlMtime();

// Puls co 25 s trzyma połączenie przy życiu i usuwa te, które już nie odpowiadają.
const heartbeat = setInterval(() => {
  for (const client of events) {
    try {
      client.write(': puls\n\n');
    } catch {
      events.delete(client);
    }
  }
}, 25_000);
heartbeat.unref();

// ——— Stan „ok” znaczników ———
// To dorobek redakcji, nie cache: leży w `data/`, więc trafia do commita i jedzie
// z projektem na inną maszynę. Klucze są po etykietach, więc zmiana etykiety
// osieroca znacznik — świadomy koszt czytelnego pliku.
const REVIEWED_PATH = join(DATA, 'reviewed.json');
let reviewedQueue = Promise.resolve();

const readReviewed = () => readJson(REVIEWED_PATH, { version: 1, episodes: {} });

// Zapis jednego znacznika to odczyt-modyfikacja-zapis, więc kolejka trzyma spójność,
// gdy dwie karty klikają jednocześnie.
const updateReviewed = (mutate) => {
  const job = reviewedQueue.then(async () => {
    const data = await readReviewed();
    data.version = 1;
    data.episodes = data.episodes ?? {};
    const result = mutate(data);
    await mkdir(dirname(REVIEWED_PATH), { recursive: true });
    await writeFile(REVIEWED_PATH, `${JSON.stringify(data, null, 2)}\n`);
    return result;
  });
  reviewedQueue = job.catch(() => {});
  return job;
};

// Odpowiedź może już być zamknięta (klient zerwał, albo nagłówek poszedł wcześniej) —
// wtedy writeHead rzuca ERR_HTTP_HEADERS_SENT i wywracał cały proces.
const json = (res, status, value) => {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  } catch (error) {
    console.error('odpowiedź:', error.message);
    res.destroy();
  }
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > 1_000_000) {
        tooLarge = true;
        data = '';
      }
    });
    req.on('end', () => (tooLarge ? reject(new Error('za duże żądanie')) : resolve(data)));
    req.on('error', reject);
  });

const validateSavePayload = (payload) => {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value) => typeof value === 'string';
  const optionalString = (value) => value === undefined || value === null || string(value);
  const optionalNumber = (value) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
  const optionalBoolean = (value) => value === undefined || typeof value === 'boolean';
  const array = (value) => value === undefined || Array.isArray(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!record(payload)) return 'treść musi być obiektem JSON';
  if (typeof payload.id !== 'string' || !uuid.test(payload.id)) return 'id odcinka ma nieprawidłowy format';
  if (!optionalString(payload.title)) return 'title musi być tekstem';
  for (const key of ['tracks', 'topics', 'addTracks', 'addTopics']) {
    if (!array(payload[key])) return `${key} musi być tablicą`;
  }
  for (const [index, track] of (payload.tracks ?? []).entries()) {
    if (!record(track)) return `tracks[${index}] musi być obiektem`;
    for (const field of ['artist', 'title', 'newArtist', 'newTitle', 'album', 'newAlbum']) {
      if (!optionalString(track[field])) return `tracks[${index}].${field} musi być tekstem`;
    }
    for (const field of ['start', 'durationSec', 'end']) {
      if (!optionalNumber(track[field])) return `tracks[${index}].${field} musi być liczbą`;
    }
    if (!optionalBoolean(track.hide)) return `tracks[${index}].hide musi być wartością logiczną`;
  }
  for (const [index, topic] of (payload.topics ?? []).entries()) {
    if (!record(topic)) return `topics[${index}] musi być obiektem`;
    if (typeof topic.label !== 'string') return `topics[${index}].label musi być tekstem`;
    if (typeof topic.time !== 'number' || !Number.isFinite(topic.time)) return `topics[${index}].time musi być liczbą`;
    for (const field of ['time', 'start', 'end']) {
      if (!optionalNumber(topic[field])) return `topics[${index}].${field} musi być liczbą`;
    }
    if (!optionalString(topic.newLabel)) return `topics[${index}].newLabel musi być tekstem`;
    if (!optionalBoolean(topic.hide)) return `topics[${index}].hide musi być wartością logiczną`;
  }
  for (const [index, track] of (payload.addTracks ?? []).entries()) {
    if (!record(track)) return `addTracks[${index}] musi być obiektem`;
    if (!string(track.artist) || !string(track.title)) return `addTracks[${index}] wymaga tekstowych pól artist i title`;
    if (!optionalString(track.album)) return `addTracks[${index}].album musi być tekstem`;
    if (typeof track.start !== 'number' || !Number.isFinite(track.start)) return `addTracks[${index}].start musi być liczbą`;
    if (!optionalNumber(track.durationSec)) return `addTracks[${index}].durationSec musi być liczbą`;
    if (!optionalBoolean(track.unrecognized)) return `addTracks[${index}].unrecognized musi być wartością logiczną`;
  }
  for (const [index, topic] of (payload.addTopics ?? []).entries()) {
    if (!record(topic)) return `addTopics[${index}] musi być obiektem`;
    if (typeof topic.label !== 'string') return `addTopics[${index}].label musi być tekstem`;
    if (typeof topic.start !== 'number' || !Number.isFinite(topic.start)) return `addTopics[${index}].start musi być liczbą`;
    if (!optionalNumber(topic.end)) return `addTopics[${index}].end musi być liczbą`;
  }
  return null;
};

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

    // Zerwany strumień (ubity ffmpeg, przerwane połączenie) inaczej kończył się
    // nieobsłużonym zdarzeniem 'error' i wywalał serwer.
    ffmpeg.stdout.on('error', (error) => reject(error));
    ffmpeg.stderr.on('error', () => {});
    ffmpeg.on('exit', (code, signal) => {
      if (signal) reject(new Error(`ffmpeg przerwany (${signal})`));
    });
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

// Waveform musi być w skali odtwarzacza (nagłówek mp3 bywa krótszy niż realne audio),
// inaczej kreska i znaczniki rozjeżdżają się ku końcowi audycji. `v2` unieważnia cache
// policzony w starej skali.
const resample = (peaks, scale) => {
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-6) return peaks;
  const length = Math.max(1, Math.round(peaks.length * scale));
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = peaks[Math.min(peaks.length - 1, Math.round(index / scale))] ?? 0;
  }
  return out;
};

// Adres nagrania w nazwie pliku: podmiana audioUrl w katalogu unieważnia cache.
const peaksFile = (id, audioUrl) => join(PEAKS, `${id}-${createHash('sha1').update(audioUrl).digest('hex').slice(0, 8)}-v2.bin`);

const loadPeaks = async (id, audioUrl) => {
  try {
    const cached = await readFile(peaksFile(id, audioUrl));
    if (cached.length > 0) return cached;
  } catch {}
  const running = peaksInFlight.get(id);
  if (running) return running;
  const job = (async () => {
    const data = await computePeaks(audioUrl);
    const mediaDuration = await mediaDurationOf(audioUrl);
    const realDuration = data.length / PEAKS_PER_SEC;
    const data2 = resample(data, mediaDuration > 0 && realDuration > 0 ? mediaDuration / realDuration : 1);
    await mkdir(PEAKS, { recursive: true });
    await writeFile(peaksFile(id, audioUrl), data2);
    return data2;
  })().finally(() => peaksInFlight.delete(id));
  peaksInFlight.set(id, job);
  return job;
};

const handleRequest = async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname === '/') {
      // Bez tego przeglądarka trzyma starą wersję edytora i nowe skróty „nie działają”.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(join(ROOT, 'scripts', 'edytor.html'), 'utf8'));
      return;
    }

    // Szybka sonda dla karty, która straciła SSE: lekka, bez czytania danych.
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), pid: process.pid });
    }

    if (url.pathname === '/api/reviewed' && req.method === 'GET') {
      await reviewedQueue;
      const data = await readReviewed();
      const id = url.searchParams.get('id');
      if (!id) return json(res, 200, { version: 1, episodes: data.episodes ?? {} });
      return json(res, 200, { version: 1, id, reviewed: data.episodes?.[id] ?? {} });
    }

    if (url.pathname === '/api/reviewed' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req));
      const id = String(payload.id ?? '');
      if (!id) return json(res, 400, { error: 'brak id odcinka' });
      const markers = payload.markers && typeof payload.markers === 'object' ? payload.markers : null;
      const key = String(payload.key ?? '');
      if (!markers && !key) return json(res, 400, { error: 'brak klucza znacznika' });
      const reviewed = await updateReviewed((data) => {
        // `markers` zastępuje cały zestaw odcinka (cofnięcie), `key` zmienia jeden wpis.
        const next = markers
          ? Object.fromEntries(Object.entries(markers).filter(([, value]) => value).map(([name]) => [name, true]))
          : { ...(data.episodes[id] ?? {}) };
        if (!markers) {
          if (payload.reviewed) next[key] = true;
          else delete next[key];
        }
        if (Object.keys(next).length > 0) data.episodes[id] = next;
        else delete data.episodes[id];
        return next;
      });
      return json(res, 200, { ok: true, id, reviewed });
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ mtime: htmlMtime })}\n\n`);
      events.add(res);
      // Bez tego zamknięta karta zostawia wpis i każde odświeżenie mnoży klientów.
      res.on('close', () => events.delete(res));
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

    if (url.pathname === '/api/progress' && req.method === 'GET') {
      const [catalog, episodes, overrides] = await Promise.all([loadCatalog(), loadEpisodes(), loadOverrides()]);
      await reviewedQueue;
      const reviewed = await readReviewed();
      const progress = {};
      for (const entry of catalog.episodes) {
        const override = overrides.get(entry.id) ?? {};
        const effective = applyOverrides(episodes.get(entry.id), override);
        const tracks = [...(effective?.tracks ?? []), ...(override.addTracks ?? [])];
        const topics = [...(effective?.topics ?? []), ...(override.addTopics ?? [])];
        const markers = [
          ...tracks.map((track) => ({ kind: 'track', object: track })),
          ...topics.map((topic) => ({ kind: 'topic', object: topic })),
        ];
        const marks = reviewed.episodes?.[entry.id] ?? {};
        progress[entry.id] = {
          total: markers.length,
          ok: markers.filter((marker) => marks[reviewKeyOf(marker.kind, marker.object)] === true).length,
        };
      }
      json(res, 200, progress);
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
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        await log('nieprawidłowe żądanie /api/save', error);
        return json(res, 400, { ok: false, error: `nieprawidłowy JSON: ${error.message}` });
      }
      const validation = validateSavePayload(payload);
      if (validation) {
        const error = new TypeError(validation);
        await log('nieprawidłowe żądanie /api/save', error);
        return json(res, 400, { ok: false, error: validation });
      }
      const { id } = payload;

      const catalog = await loadCatalog();
      const entry = catalog.episodes.find((item) => item.id === id);
      if (!entry) return json(res, 400, { ok: false, error: 'nie ma takiego odcinka' });

      const overrides = await loadOverrides();
      const previous = overrides.get(id) ?? { version: 1, tracks: [], topics: [], credits: { rename: {} } };
      // Nowe wpisy zastępują pasujące, reszta poprzednich poprawek zostaje — inaczej
      // zapis jednego wiersza kasowałby wcześniejsze korekty.
      const sameTrack = (left, right) =>
        normalize(left.artist) === normalize(right.artist) &&
        normalize(left.title) === normalize(right.title) &&
        normalize(left.album ?? '') === normalize(right.album ?? '');
      // Edytor wysyła `null`, gdy pole zostanie wyczyszczone (album bywa `null` już
      // w danych odcinka), a schemat strony przyjmuje tylko tekst albo brak pola —
      // bez tego zapis wywalał build.
      const compact = (fix) => Object.fromEntries(Object.entries(fix).filter(([, value]) => value !== null && value !== undefined));
      const tracks = [...previous.tracks];
      for (const incoming of payload.tracks ?? []) {
        const fix = compact(incoming);
        const index = tracks.findIndex((existing) => sameTrack(existing, fix));
        if (index >= 0) tracks[index] = fix;
        else tracks.push(fix);
      }
      const sameTopic = (left, right) => left.time === right.time && normalize(left.label) === normalize(right.label);
      const topics = [...(previous.topics ?? [])];
      for (const incoming of payload.topics ?? []) {
        const fix = compact(incoming);
        const index = topics.findIndex((existing) => sameTopic(existing, fix));
        if (index >= 0) topics[index] = fix;
        else topics.push(fix);
      }
      const next = {
        version: 1,
        tracks,
        topics,
        addTracks: (payload.addTracks ?? previous.addTracks ?? []).map(compact),
        addTopics: (payload.addTopics ?? previous.addTopics ?? []).map(compact),
        credits: previous.credits ?? { rename: {} },
      };
      const empty =
        next.tracks.length === 0 &&
        next.topics.length === 0 &&
        next.addTracks.length === 0 &&
        next.addTopics.length === 0;
      const overridePath = join(DATA, 'overrides', `${id}.json`);
      if (empty) {
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
    await log(`błąd żądania ${req.method} ${req.url ?? '/'}`, error);
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

const server = createServer((req, res) => {
  void handleRequest(req, res).catch(async (error) => {
    await log(`błąd granicy żądania ${req.method} ${req.url ?? '/'}`, error);
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
});

// Port bywa zajęty przez stary proces, który dopiero się zamyka — zamiast umierać
// ze stosem, próbujemy jeszcze kilka razy.
const listen = (attempt = 0) => {
  server.listen(PORT, () => {
    console.log(`Edytor: http://localhost:${PORT}`);
    console.log(`Dane: ${DATA}; log: ${LOG}`);
    void log(`start pid=${process.pid} port=${PORT} data=${DATA}`);
  });
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 10) {
      void log(`port ${PORT} zajęty, próba ${attempt + 1}/10`, error);
      setTimeout(() => listen(attempt + 1), 1000);
      return;
    }
    void log(`serwer nie wystartował na porcie ${PORT}`, error);
    process.exit(2);
  });
};

// Jeden nieudany request nie może gasić edytora w trakcie pracy.
process.on('uncaughtException', (error) => {
  void log('uncaughtException — proces pozostaje aktywny', error);
});
process.on('unhandledRejection', (reason) => {
  void log('unhandledRejection — proces pozostaje aktywny', reason);
});

listen();
