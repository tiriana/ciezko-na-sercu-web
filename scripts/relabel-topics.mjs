#!/usr/bin/env node
/**
 * Skraca etykiety wejść do jednego głównego tematu.
 *
 * `enrich-episode.mjs` uzupełnia tylko brakujące i `#TODO` — ten skrypt bierze
 * wszystkie wejścia odcinka (po scaleniu z poprawkami edytora) i przepisuje każdą
 * etykietę na krótką. Wynik trafia do `data/episodes/<id>.json` jako pełna lista
 * wejść, a `override.topics`/`addTopics` zostają wyczyszczone — inaczej łańcuch
 * starych `newLabel` nadpisywałby nowe nazwy przy każdym odczycie.
 *
 * Etykietę skracamy z jej własnej treści, a nie z transkryptu: w starych odcinkach
 * czasy wejść bywają przesunięte i kontekst wokół znacznika mówi o poprzedniej płycie.
 *
 *   node scripts/relabel-topics.mjs --episodes <id|slug,...> [--retime] [--limit N] [--model ...] [--pause ms] [--write]
 */
import { readFile, writeFile } from 'node:fs/promises';

import { mergeEpisode } from '../src/lib/merge.ts';
import { askJson } from './lib/llm.mjs';

const LABEL_MAX = 60;
const LABEL_WORDS = 8;

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
const limit = Number.parseInt(args.get('limit') ?? '0', 10) || 0;
// Darmowe tiery liczą tokeny na minutę; przy kilkudziesięciu wejściach warto zwolnić.
const pause = Number.parseInt(args.get('pause') ?? '0', 10) || 0;
// `--retime` liczy wejścia od nowa z bloków mowy transkryptu — dla odcinków,
// w których stare czasy rozjechały się z nagraniem, a etykiety mówią o czym innym.
const retime = args.has('retime');
const model = args.get('model') ?? process.env.ENRICH_MODELS ?? '';
const wanted = String(args.get('episodes') ?? '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// Klucz znacznika „ok” jest ten sam co w edytorze: NFC, bez spacji, małe litery.
const reviewKey = (label) => `p:${String(label ?? '').normalize('NFC').trim().toLowerCase()}`;

// Nazwa ma się mieścić w jednym wierszu spisu treści: jeden temat, bez wyliczanek.
const usable = (label) => {
  const text = String(label ?? '').trim();
  if (!text || text.length > LABEL_MAX) return false;
  if (/\s\/\s|#/.test(text) || /#TODO/i.test(text)) return false;
  if (/brak tytułu|\(brak/i.test(text)) return false;
  const words = text.split(/\s+/).length;
  return words >= 1 && words <= LABEL_WORDS;
};

const labelPrompt = (label, context = '') =>
  [
    label ? `Obecna etykieta wejścia audycji: „${label}”.` : 'Fragment audycji bez etykiety.',
    '',
    ...(context ? ['TRANSKRYPT FRAGMENTU:', context, ''] : []),
    'Zadanie: napisz krótką etykietę o jednym głównym temacie: 2–6 słów, maks. 60 znaków.',
    'Zostaw nazwę wykonawcy lub zespołu i dopisz, czego dotyczy (nowa płyta, singiel, debiut, koncert) — nie kończ na samym gatunku.',
    'Usuń tytuły albumów i utworów, daty, liczby i wyliczenia; jeśli etykieta wymienia kilka tematów rozdzielonych „ / ”, zostaw tylko pierwszy.',
    'Nie zmieniaj znaczenia nazw gatunków: „grind/death metal” zostaje bez zmian.',
    'Bez cudzysłowów, bez numeru czasu, bez wstępów.',
    '',
    'Odpowiedz wyłącznie JSON-em: {"label": "..."}',
  ].join('\n');

// Blok mowy to ciąg segmentów bez pauzy dłuższej niż kilka sekund — w audycji
// jeden blok to zwykle zapowiedź jednej płyty (czasem z dokończeniem po utworze).
const speechBlocks = (transcript) => {
  const blocks = [];
  let current = null;
  for (const segment of transcript?.segments ?? []) {
    if (!current || segment.start - current.end > 6) {
      if (current) blocks.push(current);
      current = { start: segment.start, end: segment.end, text: String(segment.text ?? '').trim() };
    } else {
      current.end = segment.end;
      current.text = `${current.text} ${String(segment.text ?? '').trim()}`;
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) => ({
    start: Math.round(block.start * 100) / 100,
    end: Math.round(block.end * 100) / 100,
    text: block.text,
  }));
};

const episodeId = async (key, catalog) => {
  const byId = new Map(catalog.episodes.map((entry) => [entry.id, entry]));
  if (byId.has(key)) return key;
  const matches = catalog.episodes.filter((entry) => entry.id.startsWith(key));
  if (matches.length === 1) return matches[0].id;
  throw new Error(
    matches.length > 1
      ? `Niejednoznaczny prefiks ${key}: ${matches.map((entry) => entry.id.slice(0, 8)).join(', ')}`
      : `Nieznany odcinek: ${key}`
  );
};

// Wejście nie może nachodzić na utwór: mówienie kończy się tam, gdzie startuje muzyka.
const clampEnds = (topics, tracks) => {
  const starts = (tracks ?? []).map((track) => Number(track.start)).filter(Number.isFinite).sort((left, right) => left - right);
  return topics.map((topic) => {
    const next = starts.find((start) => start > topic.start + 0.01);
    const end = next !== undefined && topic.end !== undefined && next < topic.end ? next : topic.end;
    return { ...topic, ...(end !== undefined ? { end } : {}) };
  });
};

const catalog = await readJson('data/catalog.json');
const names = await readJson('data/aliases.json').catch(() => ({}));
const aliases = names.aliases ?? {};
const types = names.types ?? {};

let processed = 0;
let updated = 0;

for (const key of wanted) {
  if (limit > 0 && processed >= limit) break;
  const id = await episodeId(key, catalog);
  const episodePath = `data/episodes/${id}.json`;
  const overridePath = `data/overrides/${id}.json`;

  if (await readFile(`data/artifacts/${id}/manual.json`).then(() => true).catch(() => false)) {
    console.error(`— ${id.slice(0, 8)}: odcinek zmigrowany do artefaktów, etykiety należą do edytora — pomijam`);
    continue;
  }

  const episode = await readJson(episodePath);
  const override = await readJson(overridePath).catch(() => null);
  const merged = mergeEpisode(structuredClone(episode), { override, aliases, types });
  const transcript = retime ? await readJson(`data/transcripts/${id}.json`).catch(() => null) : null;
  if (retime && !transcript) {
    console.error(`— ${id.slice(0, 8)}: brak transkryptu`);
    continue;
  }
  const topics = retime ? speechBlocks(transcript) : (merged.topics ?? []);
  if (topics.length === 0) {
    console.log(`— ${id.slice(0, 8)}: brak wejść`);
    continue;
  }

  processed += 1;
  console.log(`${write ? '+' : '·'} ${id.slice(0, 8)} — ${topics.length} wejść`);
  const labelled = [];
  let failed = 0;
  for (const topic of topics) {
    try {
      const context = retime ? topic.text.slice(0, 900) : '';
      const answer = await askJson(labelPrompt(topic.label ?? '', context), {
        models: model,
        maxTokens: 60,
        temperature: 0.1,
      });
      const label = String(answer.data?.label ?? '').trim();
      if (!usable(label)) {
        console.log(`   ${topic.start}: odrzucone „${label.slice(0, 70)}”`);
        failed += 1;
        continue;
      }
      if (label === topic.label) continue;
      if (retime) {
        console.log(`   ${topic.start}: «${topic.text.slice(0, 60)}…»\n      → ${label}`);
      } else {
        console.log(`   ${topic.start}: ${topic.label}\n      → ${label}`);
      }
      labelled.push({ topic, label });
    } catch (error) {
      console.error(`   ${topic.start}: ${error.message}`);
      failed += 1;
    }
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }

  // Nowa siatka wejść musi być kompletna: brak etykiety zostawiłby puste wejście.
  if (retime && failed > 0) {
    console.error(`— ${id.slice(0, 8)}: ${failed} wejść bez etykiety, nic nie zapisuję`);
    continue;
  }
  if (!write || labelled.length === 0) continue;
  const byTopic = new Map(labelled.map(({ topic, label }) => [topic, label]));
  episode.topics = clampEnds(
    topics
      .map((topic) => ({
        start: topic.start,
        ...(topic.end !== undefined ? { end: topic.end } : {}),
        label: byTopic.get(topic) ?? topic.label,
      }))
      .sort((left, right) => left.start - right.start),
    merged.tracks
  );
  // Wszystko, co robiły poprawki etykiet i dodane wejścia, jest już w odcinku.
  if (override) {
    override.topics = [];
    override.addTopics = [];
    await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`);
  }
  await writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);

  const reviewed = await readJson('data/reviewed.json').catch(() => ({ version: 1, episodes: {} }));
  const marks = reviewed.episodes?.[id];
  let moved = 0;
  for (const { topic, label } of labelled) {
    if (!marks) break;
    const from = reviewKey(topic.label);
    const to = reviewKey(label);
    if (from === to || !(from in marks)) continue;
    marks[to] = true;
    delete marks[from];
    moved += 1;
  }
  // Przy nowej siatce etykiety nie mają odpowiedników 1:1 — znacznik „ok” przenosimy
  // po nazwie zespołu (część przed „ – ”), żeby nie zgubić przejrzanych wejść.
  if (retime && marks) {
    for (const mark of Object.keys(marks)) {
      if (!mark.startsWith('p:')) continue;
      const prefix = mark.slice(2).split(' – ')[0].trim();
      const target = episode.topics.find((topic) => topic.label.split(' – ')[0].trim().toLowerCase() === prefix);
      if (!target) continue;
      const to = reviewKey(target.label);
      if (mark === to || !marks[mark]) continue;
      marks[to] = true;
      delete marks[mark];
      moved += 1;
    }
  }
  if (moved > 0) await writeFile('data/reviewed.json', `${JSON.stringify(reviewed, null, 2)}\n`);
  updated += 1;
}

console.log(`\nOdcinków: ${processed}, zapisanych: ${updated}${write ? '' : ' (bez --write nic nie zapisano)'}`);
