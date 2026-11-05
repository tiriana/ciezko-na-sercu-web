#!/usr/bin/env node
/**
 * Lokalny edytor osi czasu: przeglądarka + zapis do data/overrides i data/titles.json.
 * Uruchomienie: npm run edytor (http://localhost:4330).
 *
 * Edytuje wyłącznie warstwę poprawek, więc kolejny import z taggera niczego nie kasuje.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 4330);

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(ROOT, 'scripts', 'edytor.html'), 'utf8'));
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
        credits: previous.credits ?? { rename: {} },
      };
      const empty = next.tracks.length === 0 && next.topics.length === 0;
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
