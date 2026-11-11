#!/usr/bin/env node
// Test 1:1 migracji: stary episode.json → artefakty → kompilacja → ten sam odcinek.
// Sprawdza też, że po nałożeniu ręcznych poprawek i wariantów nazw wynik jest identyczny
// z tym, co dziś renderuje strona. Nic nie zapisuje — to harness, nie migracja.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mergeEpisode } from '../src/lib/merge.ts';
import { overrideSchema } from '../src/lib/schema.ts';
import { compileEpisode, decomposeEpisode } from './lib/episode-artifacts.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DATA = join(ROOT, 'data');

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const clone = (value) => structuredClone(value);

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

const [catalog, aliasesFile, overrideNames, episodeNames] = await Promise.all([
  readJson(join(DATA, 'catalog.json'), { episodes: [] }),
  readJson(join(DATA, 'aliases.json'), {}),
  readdir(join(DATA, 'overrides')).catch(() => []),
  readdir(join(DATA, 'episodes')),
]);

const byId = new Map(catalog.episodes.map((entry) => [entry.id, entry]));
const overrides = new Map(
  await Promise.all(
    overrideNames
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const raw = await readJson(join(DATA, 'overrides', name), null);
        return [name.replace(/\.json$/, ''), raw ? overrideSchema.parse(raw) : null];
      })
  )
);
const aliases = aliasesFile.aliases ?? {};
const types = aliasesFile.types ?? {};

let checked = 0;
let withIntro = 0;
let failures = 0;
const report = [];

for (const name of episodeNames.filter((entry) => entry.endsWith('.json')).sort()) {
  const legacy = await readJson(join(DATA, 'episodes', name), null);
  if (!legacy) {
    report.push(`${name}: nie da się wczytać`);
    failures++;
    continue;
  }
  const artifacts = decomposeEpisode(legacy, byId.get(legacy.id));
  if (artifacts.intro) withIntro++;
  const rebuilt = compileEpisode(artifacts);

  const structural = differences(legacy, rebuilt);
  if (structural.length > 0) {
    failures++;
    report.push(`${name}: kompilacja różni się w ${structural.length} miejscach`, ...structural.slice(0, 5).map((line) => `    ${line}`));
    continue;
  }

  const context = { override: overrides.get(legacy.id), aliases, types };
  const mergedLegacy = mergeEpisode(clone(legacy), context);
  const mergedRebuilt = mergeEpisode(clone(rebuilt), context);
  const mergedDiff = differences(mergedLegacy, mergedRebuilt);
  if (mergedDiff.length > 0) {
    failures++;
    report.push(`${name}: scalenie różni się w ${mergedDiff.length} miejscach`, ...mergedDiff.slice(0, 5).map((line) => `    ${line}`));
    continue;
  }
  checked++;
}

for (const line of report) console.log(line);
console.log(
  `Odcinków zgodnych: ${checked}/${episodeNames.length} (z intro: ${withIntro}), różnic: ${failures}`
);
process.exitCode = failures > 0 ? 1 : 0;
