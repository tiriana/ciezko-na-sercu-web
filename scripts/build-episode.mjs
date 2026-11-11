#!/usr/bin/env node
// Kompilator odcinka: `data/episodes/<iso>_<uuid>/` (artefakty) → `episode.json`.
// Nic nie wie o tym, który producent kiedy się uruchomił — czyta pliki, które leżą.
//
// Tryby:
//   <uuid>            kompiluje wskazany odcinek i zapisuje episode.json
//   --all             kompiluje wszystkie katalogi artefaktów
//   --preview         pokazuje różnice zamiast zapisywać
//   --check           kod 2, gdy wynik różni się od zapisanego episode.json
//   --from-legacy     czyta stare data/episodes/<id>.json + overrides (harness migracji)

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileEpisode, decomposeEpisode } from './lib/episode-artifacts.mjs';
import { mergeEpisode } from '../src/lib/merge.ts';
import { overrideSchema } from '../src/lib/schema.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DATA = join(ROOT, 'data');
const EPISODES = join(DATA, 'episodes');

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const only = args.filter((arg) => !arg.startsWith('--'));

const readJson = async (path, fallback = null) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const directories = async () => {
  const names = await readdir(EPISODES);
  const found = [];
  for (const name of names) {
    const meta = await readJson(join(EPISODES, name, 'metadata.json'));
    if (meta) found.push({ name, metadata: meta });
  }
  return found.map((item) => ({ ...item, uuid: item.metadata.uuid, dir: join(EPISODES, item.name) }));
};

const loadArtifacts = async (dir) => {
  const names = ['metadata', 'audioId', 'topics', 'text', 'voice', 'intro', 'manual'];
  const files = { metadata: 'metadata.json', audioId: 'audio-id.json', topics: 'topics.json', text: 'text.json', voice: 'voice.json', intro: 'intro.json', manual: 'manual.json' };
  const loaded = Object.fromEntries(await Promise.all(names.map(async (key) => [key, await readJson(join(dir, files[key]))])));
  if (!loaded.metadata?.uuid) throw new Error(`${dir}: brak metadata.json z uuid`);
  return loaded;
};

const loadLegacy = async (uuid, entry) => {
  const episode = await readJson(join(EPISODES, `${uuid}.json`));
  if (!episode) throw new Error(`${uuid}: brak starego episode.json`);
  const rawOverride = await readJson(join(DATA, 'overrides', `${uuid}.json`));
  const artifacts = decomposeEpisode(episode, entry);
  artifacts.manual.patches = rawOverride ? overrideSchema.parse(rawOverride) : null;
  return { artifacts, episode };
};

const differences = (left, right, path = '', out = []) => {
  if (Object.is(left, right)) return out;
  const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  if (kind(left) !== kind(right)) {
    out.push(`${path || '(root)'}: ${kind(left)} → ${kind(right)}`);
    return out;
  }
  if (kind(left) === 'array') {
    if (left.length !== right.length) out.push(`${path}: długość ${left.length} → ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length); index++) differences(left[index], right[index], `${path}[${index}]`, out);
    return out;
  }
  if (kind(left) === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (left[key] === undefined && right[key] === undefined) continue;
      if (!(key in left) || left[key] === undefined) out.push(`${path}.${key}: brak → ${JSON.stringify(right[key])}`);
      else if (!(key in right) || right[key] === undefined) out.push(`${path}.${key}: ${JSON.stringify(left[key])} → brak`);
      else differences(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
  return out;
};

const [catalog, aliasesFile] = await Promise.all([
  readJson(join(DATA, 'catalog.json'), { episodes: [] }),
  readJson(join(DATA, 'aliases.json'), {}),
]);
const byId = new Map(catalog.episodes.map((entry) => [entry.id, entry]));
const aliases = aliasesFile.aliases ?? {};
const types = aliasesFile.types ?? {};

const fromLegacy = flags.has('--from-legacy');
const preview = flags.has('--preview');
const check = flags.has('--check');

let targets;
if (fromLegacy) {
  const names = (await readdir(EPISODES)).filter((name) => name.endsWith('.json'));
  targets = names.map((name) => ({ uuid: name.replace(/\.json$/, '') })).filter((item) => only.length === 0 || only.includes(item.uuid));
} else {
  const found = await directories();
  targets = found.filter((item) => only.length === 0 || only.includes(item.uuid));
}

if (targets.length === 0) {
  console.error(fromLegacy ? 'Brak starych odcinków do sprawdzenia.' : 'Brak katalogów z metadata.json — uruchom najpierw `npm run metadata --write`.');
  process.exit(1);
}

let changed = 0;
let same = 0;
const problems = [];

for (const target of targets) {
  const { uuid } = target;
  let artifacts;
  let expected;
  let reference;
  try {
    if (fromLegacy) {
      const legacy = await loadLegacy(uuid, byId.get(uuid));
      artifacts = legacy.artifacts;
      // Referencją jest dzisiejszy render: stare dane + poprawki + warianty nazw.
      expected = structuredClone(legacy.episode);
      reference = mergeEpisode(expected, { override: artifacts.manual.patches, aliases, types });
    } else {
      artifacts = await loadArtifacts(target.dir);
      expected = await readJson(join(target.dir, 'episode.json'));
      reference = expected;
    }
  } catch (error) {
    problems.push(error.message);
    continue;
  }

  const episode = compileEpisode(artifacts, { aliases, types });
  const diff = reference ? differences(reference, episode) : ['(brak zapisanego episode.json)'];

  if (diff.length === 0) {
    same++;
    continue;
  }
  changed++;
  if (check || fromLegacy) {
    problems.push(`${uuid}: ${diff.length} różnic`, ...diff.slice(0, 5).map((line) => `    ${line}`));
    continue;
  }
  if (preview) {
    console.log(`${uuid}: ${diff.length} różnic`);
    for (const line of diff.slice(0, 20)) console.log(`    ${line}`);
    continue;
  }
  await mkdir(target.dir, { recursive: true });
  await writeFile(join(target.dir, 'episode.json'), `${JSON.stringify(episode, null, 2)}\n`);
  console.log(`✓ ${uuid}`);
}

for (const line of problems) console.error(line);
console.log(`Bez zmian: ${same}, do zmiany: ${changed}, błędów: ${problems.length}`);
if (problems.length > 0) process.exitCode = 2;
