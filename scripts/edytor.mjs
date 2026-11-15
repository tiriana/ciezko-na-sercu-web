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

import {
  aliasCandidates,
  aliasProblems,
  collectLabels,
  normalizeAliasFile,
  tagRows,
} from '../lib/aliases.mjs';
import {
  applyOverrides,
  isEmptyOverrides,
  mergeOverrides,
  normalize,
  same,
  validateSavePayload,
} from '../lib/overrides.mjs';
import { peaksFromAudio, resample } from './lib/peaks.mjs';
import { mediaDurationOf } from './lib/timeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(process.env.EDITOR_DATA_DIR ?? join(ROOT, 'data'));
const PORT = Number(process.env.PORT ?? 4330);
const CACHE = resolve(process.env.EDITOR_CACHE_DIR ?? join(ROOT, '.cache'));
const LOG = join(CACHE, 'edytor.log');
const PEAKS = join(CACHE, 'peaks');
// Szkice i dziennik zapisów trzymamy poza `data/`, bo to nie jest treść strony:
// mają ratować pracę, a nie trafiać do repozytorium.
const DRAFTS = join(CACHE, 'drafts');
const JOURNAL = join(CACHE, 'journal');
const PEAKS_PER_SEC = 100; // 1 słupek = 10 ms

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
const loadAliasFile = async () => {
  const file = await readJson(ALIASES_PATH, { version: 1, aliases: {}, types: {}, dismissed: [] });
  return { aliases: file.aliases ?? {}, types: file.types ?? {}, dismissed: file.dismissed ?? [] };
};
// Etykiety z odcinków plus nazwy z creditsów — wspólne z edytorem online.
const labelsOfData = async () => collectLabels([...(await loadEpisodes()).values()]);

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

const peaksInFlight = new Map();

const computePeaks = (audioUrl) => peaksFromAudio(audioUrl, { perSec: PEAKS_PER_SEC });

// Waveform musi być w skali odtwarzacza (nagłówek mp3 bywa krótszy niż realne audio),
// inaczej kreska i znaczniki rozjeżdżają się ku końcowi audycji. `v2` unieważnia cache
// policzony w starej skali.
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
      const [labels, file] = await Promise.all([labelsOfData(), loadAliasFile()]);
      json(res, 200, {
        aliases: file.aliases,
        types: file.types,
        dismissed: file.dismissed,
        candidates: aliasCandidates(labels, file.aliases, file.dismissed),
        tags: tagRows(labels, file),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/aliases') {
      const file = normalizeAliasFile(JSON.parse(await readBody(req)));
      const problems = aliasProblems(file.aliases);
      if (problems.length > 0) return json(res, 400, { error: problems.join('; ') });
      await writeJson(ALIASES_PATH, file);
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
        durationSec: episodes.get(id)?.durationSec ?? entry.durationSec ?? null,
        audioDurationSec: episodes.get(id)?.audioDurationSec ?? null,
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

    if (url.pathname === '/api/draft') {
      const id = url.searchParams.get('id');
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, { error: 'nieprawidłowy id' });
      const draftPath = join(DRAFTS, `${id}.json`);
      if (req.method === 'GET') {
        try {
          return json(res, 200, JSON.parse(await readFile(draftPath, 'utf8')));
        } catch {
          return json(res, 404, { error: 'brak szkicu' });
        }
      }
      if (req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (error) {
          return json(res, 400, { error: `nieprawidłowy JSON: ${error.message}` });
        }
        await mkdir(DRAFTS, { recursive: true });
        await writeJson(draftPath, { at: new Date().toISOString(), payload });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await rm(draftPath, { force: true });
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'metoda nieobsługiwana' });
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
      const next = mergeOverrides(previous, payload);
      const empty = isEmptyOverrides(next);
      // Dziennik: każdy zapis zostawia pełną kopię, więc wersję sprzed złej zmiany
      // można przywrócić bez sięgania do gita. Trzymamy ostatnie 20.
      await mkdir(JOURNAL, { recursive: true });
      const journalPath = join(JOURNAL, `${id}.jsonl`);
      const journalEntry = JSON.stringify({ at: new Date().toISOString(), payload });
      await appendFile(journalPath, `${journalEntry}\n`).catch(() => {});
      try {
        const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean);
        if (lines.length > 20) await writeFile(journalPath, `${lines.slice(-20).join('\n')}\n`);
      } catch {}

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
