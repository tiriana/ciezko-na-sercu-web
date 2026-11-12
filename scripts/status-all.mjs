#!/usr/bin/env node
/**
 * Stan etapów dla całego katalogu: transkrypcja (Whisper), rozpoznane utwory
 * (Shazam) i profil głosu. Redakcja potrzebuje jednego miejsca, w którym widać,
 * które odcinki przeszły którą maszynę — dotąd każdy etap miał osobne narzędzie.
 *
 * `--pending` pokazuje tylko odcinki z brakującym etapem, `--limit N` skraca listę.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { frozenEpisodes } from './frozen.mjs';
import { readLedger } from './voiceprint-ledger.mjs';

const args = new Set(process.argv.slice(2));
const pendingOnly = args.has('--pending');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex > 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? '0', 10) || 0 : 0;

const DATA = 'data';
const catalog = JSON.parse(readFileSync(join(DATA, 'catalog.json'), 'utf8'));
const ledger = readLedger();
const frozen = frozenEpisodes();

const reviewed = (() => {
  try {
    return JSON.parse(readFileSync(join(DATA, 'reviewed.json'), 'utf8')).episodes ?? {};
  } catch {
    return {};
  }
})();

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const rows = catalog.episodes
  .map((episode) => {
  const transcript = readJson(join(DATA, 'transcripts', `${episode.id}.json`));
  const enriched = readJson(join(DATA, 'episodes', `${episode.id}.json`));
  const entry = ledger.episodes[episode.id];
  return {
    id: episode.id,
    date: episode.date,
    slug: episode.slug,
    whisper: Boolean(transcript?.segments?.length),
    spans: Boolean(readJson(join(DATA, 'artifacts', episode.id, 'speech-spans.json'))?.chunks?.length),
    tracks: enriched?.tracks?.length ?? 0,
    voiceprint: entry ? 'ok' : frozen.has(episode.id) ? 'pominięty' : '—',
    reviewedOk: Object.values(reviewed[episode.id] ?? {}).filter(Boolean).length,
  };
  })
  .sort((left, right) => right.date.localeCompare(left.date));

const summarize = (label, done, total) => `${label}: ${done}/${total}`;
const counts = {
  spans: rows.filter((row) => row.spans).length,
  whisper: rows.filter((row) => row.whisper).length,
  tracks: rows.filter((row) => row.tracks > 0).length,
  voiceprint: rows.filter((row) => row.voiceprint === 'ok').length,
  reviewed: rows.filter((row) => row.reviewedOk > 0).length,
};
const missing = (row) => !row.whisper || row.tracks === 0 || row.voiceprint === '—';

const lines = [
  `Odcinków: ${rows.length}`,
  `  ${summarize('VAD', counts.spans, rows.length)}, ${summarize('Whisper', counts.whisper, rows.length)}, ${summarize('Shazam', counts.tracks, rows.length)}, ` +
    `${summarize('profil głosu', counts.voiceprint, rows.length)}, ${summarize('przejrzane', counts.reviewed, rows.length)}`,
];

const shown = rows.filter((row) => (pendingOnly ? missing(row) : true)).slice(0, limit > 0 ? limit : undefined);
if (shown.length > 0) {
  const mark = (value) => (value ? '✔' : '✘');
  const cell = (value, width, align = 'left') =>
    align === 'right' ? String(value).padStart(width) : String(value).padEnd(width);
  lines.push(
    '',
    [cell('odcinek', 44), cell('mowa', 5), cell('whisper', 7), cell('utwory', 6, 'right'), cell('profil', 9), cell('ok', 3, 'right')].join('  ')
  );
  for (const row of shown) {
    lines.push(
      [
        cell(`${row.date}  ${row.slug.slice(0, 30)}`, 44),
        cell(mark(row.spans), 5),
        cell(mark(row.whisper), 7),
        cell(row.tracks, 6, 'right'),
        cell(row.voiceprint, 9),
        cell(row.reviewedOk, 3, 'right'),
      ].join('  ')
    );
  }
} else {
  lines.push('', pendingOnly ? 'Wszystkie etapy domknięte.' : 'Brak odcinków.');
}

console.log(lines.join('\n'));

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const pending = rows.filter(missing).length;
  const body = [
    '### Stan etapów',
    '',
    `- Bloki mowy (VAD): **${counts.spans}/${rows.length}**`,
    `- Whisper: **${counts.whisper}/${rows.length}**`,
    `- Shazam (utwory): **${counts.tracks}/${rows.length}**`,
    `- Profil głosu: **${counts.voiceprint}/${rows.length}**`,
    `- Przejrzane w edytorze: **${counts.reviewed}/${rows.length}**`,
    `- Odcinki z brakującym etapem: ${pending}`,
    '',
  ].join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summary, body);
}
