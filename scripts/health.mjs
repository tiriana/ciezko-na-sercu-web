#!/usr/bin/env node
/**
 * Co zostało po dobie pracy automatów: brakujące etapy per odcinek i deploy
 * starszy od ostatniej zmiany w danych. Etapy zamawiają się nawzajem, więc
 * każda usterka po drodze zostawia odcinek bez reszty — ten skrypt domyka to
 * następnego dnia, niezależnie od tego, który dispatch nie doszedł.
 *
 *   node scripts/health.mjs           # sam raport
 *   node scripts/health.mjs --dispatch  # zamawia brakujące etapy i deploy
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { frozenEpisodes } from './frozen.mjs';
import { readLedger } from './voiceprint-ledger.mjs';

const dispatch = process.argv.includes('--dispatch');

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const catalog = JSON.parse(readFileSync(join('data', 'catalog.json'), 'utf8'));
const ledger = readLedger();
const frozen = frozenEpisodes();

const rows = catalog.episodes
  .map((entry) => {
    const transcript = readJson(join('data', 'transcripts', `${entry.id}.json`));
    const spans = readJson(join('data', 'artifacts', entry.id, 'speech-spans.json'));
    const episode = readJson(join('data', 'episodes', `${entry.id}.json`));
    return {
      id: entry.id,
      date: entry.date,
      slug: entry.slug,
      frozen: frozen.has(entry.id),
      spans: Boolean(spans?.chunks?.length),
      whisper: Boolean(transcript?.segments?.length),
      tracks: episode?.tracks?.length ?? 0,
      summary: Boolean(episode?.summary),
      topics: episode?.topics?.length ?? 0,
      tags: episode?.tags?.length ?? 0,
      voiceprint: Boolean(ledger.episodes?.[entry.id]),
    };
  })
  .sort((left, right) => right.date.localeCompare(left.date));

const open = rows.filter((row) => !row.frozen);
const gaps = {
  spans: open.filter((row) => !row.spans),
  transcribe: open.filter((row) => row.spans && !row.whisper),
  identify: open.filter((row) => row.whisper && row.tracks === 0),
  enrich: open.filter((row) => row.whisper && row.tracks > 0 && (!row.summary || row.topics === 0 || row.tags === 0)),
  voiceprint: open.filter((row) => !row.voiceprint),
};

const ids = (list) => list.map((row) => row.id).join(',');

// Brak utworów blokuje streszczenie, bo opis bierze ich nazwy — reszta etapów
// jest niezależna i może iść równolegle.
const jobs = [
  ['spans.yml', (list) => ['-f', `episodes=${ids(list)}`], gaps.spans],
  ['transcribe.yml', (list) => ['-f', `episodes=${ids(list)}`, '-f', 'label=uzupełnienie'], gaps.transcribe],
  ['identify.yml', (list) => ['-f', `episodes=${ids(list)}`, '-f', 'limit=0'], gaps.identify],
  ['nightly.yml', (list) => ['-f', 'stage=enrich', '-f', `episodes=${ids(list)}`], gaps.enrich],
  ['nightly.yml', (list) => ['-f', 'stage=voiceprint', '-f', `episodes=${ids(list)}`, '-f', 'apply=true'], gaps.voiceprint],
];

const lines = [
  `Odcinków: ${rows.length}, przejrzanych ręcznie (pomijane): ${rows.length - open.length}`,
  ...Object.entries(gaps).map(([stage, list]) => `  ${stage}: ${list.length} do zrobienia`),
];

for (const [stage, list] of Object.entries(gaps)) {
  for (const row of list) lines.push(`  ${stage.padEnd(10)} ${row.date}  ${row.slug.slice(0, 40)}`);
}

const lastData = (() => {
  try {
    return execFileSync(
      'gh',
      ['api', 'repos/{owner}/{repo}/commits?path=data&per_page=1', '--jq', '.[0].commit.committer.date'],
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
})();

const lastDeploy = (() => {
  try {
    const runs = JSON.parse(
      execFileSync('gh', ['run', 'list', '--workflow', 'deploy.yml', '--branch', 'main', '--status', 'success', '--limit', '1', '--json', 'createdAt'], {
        encoding: 'utf8',
      })
    );
    return runs[0]?.createdAt ?? null;
  } catch {
    return null;
  }
})();

const deployStale = !lastDeploy || (lastData && lastData > lastDeploy);
lines.push('', `Ostatnia zmiana danych: ${lastData ?? '?'}`, `Ostatni udany deploy: ${lastDeploy ?? '?'}`);
if (deployStale) lines.push('  deploy: zaległy');

console.log(lines.join('\n'));

if (dispatch) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  for (const [workflow, build, list] of jobs) {
    if (list.length === 0) continue;
    const args = build(list);
    console.log(`→ ${workflow} ${args.join(' ')}`);
    execFileSync('gh', ['workflow', 'run', workflow, '--ref', 'main', ...args], { stdio: 'inherit' });
  }
  if (deployStale) {
    console.log(`→ deploy.yml v${version}`);
    execFileSync('gh', ['workflow', 'run', 'deploy.yml', '--ref', 'main', '-f', `version=${version}`], { stdio: 'inherit' });
  }
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const body = [
    '### Zdrowie katalogu',
    '',
    `- Bloki mowy: ${rows.length - gaps.spans.length}/${rows.length}`,
    `- Whisper: ${rows.filter((row) => row.whisper).length}/${rows.length}`,
    `- Utwory: ${rows.length - gaps.identify.length}/${rows.length}`,
    `- Streszczenia: ${rows.length - gaps.enrich.length}/${rows.length}`,
    `- Profil głosu: ${rows.length - gaps.voiceprint.length}/${rows.length}`,
    `- Deploy: ${deployStale ? 'zaległy' : 'aktualny'}`,
    '',
  ].join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summary, body);
}
