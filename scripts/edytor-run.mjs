// Nadzorca edytora: uruchamia serwer i podnosi go po każdym zakończeniu procesu.
// Celowo bez `node --watch`, bo ten po crashu wypisuje „waiting for file changes”
// i czeka w nieskończoność — wtedy serwer leży, a proces nadzorczy żyje, więc nikt
// go nie podnosi. Zmianę scripts/edytor.mjs obserwujemy tutaj i restartujemy sami.
// Log z obu procesów ląduje w `.cache/edytor.log`.
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(resolve(process.env.EDITOR_CACHE_DIR ?? join(ROOT, '.cache')), 'edytor.log');
const ENTRY = join(ROOT, 'scripts', 'edytor.mjs');
const PID_FILE = join(resolve(process.env.EDITOR_CACHE_DIR ?? join(ROOT, '.cache')), 'edytor-run.pid');
const PORT = process.env.PORT ?? '4330';

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

// Port trzymany przez osierocony proces to najczęstsza przyczyna „edytor umarł":
// nowy start nie może się podpiąć, kończy się kodem 2 i wygląda, jakby serwer nie wstawał.
const killPortHolders = () => {
  let output = '';
  try {
    output = execFileSync('ss', ['-ltnpH', `sport = :${PORT}`], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const match of output.matchAll(/pid=(\d+)/g)) {
    const pid = Number.parseInt(match[1], 10);
    let cmdline = '';
    try {
      cmdline = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (!cmdline.includes('edytor.mjs')) continue;
    try {
      process.kill(pid, 'SIGKILL');
      void log(`zwolniony port ${PORT}: zabity osierocony pid ${pid}`);
    } catch {}
  }
};

// Drugi nadzorca walczy o ten sam port, więc poprzedni dostaje stopień.
const claimSupervisor = async () => {
  try {
    const previous = Number.parseInt((await readFile(PID_FILE, 'utf8')).trim(), 10);
    if (Number.isInteger(previous) && previous !== process.pid) {
      const cmdline = execFileSync('ps', ['-o', 'args=', '-p', String(previous)], { encoding: 'utf8' });
      if (cmdline.includes('edytor-run.mjs')) {
        process.kill(previous, 'SIGTERM');
        void log(`zatrzymany poprzedni nadzorca pid ${previous}`);
      }
    }
  } catch {}
  await writeFile(PID_FILE, `${process.pid}\n`).catch(() => {});
};

const start = () => {
  killPortHolders();
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
  // SIGTERM bywa za wolny, gdy serwer kończy otwarty strumień — wtedy port zostaje zajęty.
  killPortHolders();
  restarting = false;
  if (!stopping) start();
};

await claimSupervisor();
start();

process.on('exit', () => {
  try {
    execFileSync('sh', ['-c', `rm -f "${PID_FILE}"`]);
  } catch {}
});

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
