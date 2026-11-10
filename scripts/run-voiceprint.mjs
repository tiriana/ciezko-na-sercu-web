#!/usr/bin/env node
/**
 * Liczy profile głosu dla pozycji z `ids.txt` (id<TAB>url), równolegle.
 * Pojedynczy błąd nie przerywa całości — odcinek trafia do raportu na końcu.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

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

const idsFile = args.get('ids') ?? 'ids.txt';
const outDir = args.get('out') ?? 'voiceprint-out';
const parallel = Math.max(1, Number.parseInt(args.get('parallel') ?? '4', 10) || 4);

if (!existsSync(idsFile)) {
  console.error(`Brak ${idsFile}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const jobs = readFileSync(idsFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [id, url] = line.split('\t');
    return { id, url };
  });

const failures = [];
let cursor = 0;
let done = 0;

const runOne = (job) =>
  new Promise((resolve) => {
    const child = spawn(
      'python',
      [
        'scripts/voiceprint.py',
        '--id', job.id,
        '--url', job.url,
        '--episode', `data/episodes/${job.id}.json`,
        '--transcript', `data/transcripts/${job.id}.json`,
        '--out', `${outDir}/${job.id}.voiceprint.json`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.on('close', (code) => {
      done += 1;
      const summary = output.split('\n').filter(Boolean).at(-1) ?? '';
      console.log(`[${done}/${jobs.length}] ${job.id} → ${code === 0 ? 'ok' : `błąd ${code}`} ${summary.slice(0, 160)}`);
      if (code !== 0) failures.push(job.id);
      resolve();
    });
  });

const worker = async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor];
    cursor += 1;
    await runOne(job);
  }
};

await Promise.all(Array.from({ length: Math.min(parallel, jobs.length || 1) }, worker));

if (failures.length > 0) {
  console.log(`Nie udało się: ${failures.join(', ')}`);
  if (failures.length === jobs.length) process.exit(1);
}
console.log(`Gotowe: ${jobs.length - failures.length}/${jobs.length} odcinków.`);
