// Nadzorca edytora: uruchamia serwer i podnosi go po każdym zakończeniu procesu.
// Celowo bez `node --watch`, bo ten po crashu wypisuje „waiting for file changes”
// i czeka w nieskończoność — wtedy serwer leży, a proces nadzorczy żyje, więc nikt
// go nie podnosi. Zmianę scripts/edytor.mjs obserwujemy tutaj i restartujemy sami.
// Log z obu procesów ląduje w `.cache/edytor.log`.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(resolve(process.env.EDITOR_CACHE_DIR ?? join(ROOT, '.cache')), 'edytor.log');
const ENTRY = join(ROOT, 'scripts', 'edytor.mjs');

const stamp = () => new Date().toISOString();
const log = async (line, error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error ?? '');
  const text = `[${stamp()}] ${line}${detail ? `\n${detail}` : ''}\n`;
  process.stdout.write(text);
  await appendFile(LOG, text).catch(() => {});
};

await mkdir(dirname(LOG), { recursive: true });

let child;
let stopping = false;
let restarting = false;
let failures = 0;
let startedAt = 0;

const start = () => {
  startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  void log(`start pid=${child.pid ?? '—'} port=${process.env.PORT ?? 4330}`);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    appendFile(LOG, chunk).catch(() => {});
  });
  child.on('exit', async (code, signal) => {
    if (stopping || restarting) return;
    const lived = Date.now() - startedAt;
    if (lived > 30_000) failures = 0;
    failures += 1;
    // Kod 2 to zajęty port — wtedy warto poczekać, aż stary edytor zwolni.
    const delay = code === 2 ? 5000 : Math.min(400 * 2 ** (failures - 1), 5000);
    await log(`edytor zakończony (kod ${code ?? '—'}, sygnał ${signal ?? '—'}), start za ${delay} ms`);
    setTimeout(() => {
      if (!stopping) start();
    }, delay);
  });
  child.on('error', (error) => log('nie udało się uruchomić serwera', error));
};

const restart = async (reason) => {
  if (restarting || stopping) return;
  restarting = true;
  await log(`restart (${reason})`);
  const current = child;
  current?.kill('SIGTERM');
  await new Promise((resolve) => {
    if (!current || current.exitCode !== null) return resolve();
    current.once('exit', resolve);
    setTimeout(resolve, 1500);
  });
  restarting = false;
  if (!stopping) start();
};

start();

let timer = 0;
let mtime = 0;
const changed = async () => {
  try {
    const next = (await stat(ENTRY)).mtimeMs;
    if (next === mtime) return;
    mtime = next;
    clearTimeout(timer);
    timer = setTimeout(() => restart('zmiana scripts/edytor.mjs'), 200);
  } catch {}
};
await changed();
const watcher = watch(dirname(ENTRY), (_event, filename) => {
  if (filename === 'edytor.mjs') changed();
});
watcher.on('error', (error) => log(`podgląd plików: ${error.message}`));

const stop = () => {
  stopping = true;
  void log('nadzorca zatrzymany przez sygnał');
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
