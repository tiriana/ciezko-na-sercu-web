import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('./collect-spans.mjs', import.meta.url).pathname;

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'spans-'));
  return {
    root,
    source: join(root, 'in'),
    destination: join(root, 'out'),
  };
};

const artifact = (dir, episodeId, name = 'speech-spans.json') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ episodeId, chunks: [] }));
};

test('jeden artefakt rozpakowany płasko trafia pod swoje id', async () => {
  const { source, destination } = workspace();
  mkdirSync(source, { recursive: true });
  artifact(source, 'abc-123');

  const { stdout } = await run('node', [script, source, destination]);
  assert.match(stdout, /włożonych artefaktów: 1/);
  assert.equal(JSON.parse(readFileSync(join(destination, 'abc-123', 'speech-spans.json'), 'utf8')).episodeId, 'abc-123');
});

test('kilka artefaktów w podkatalogach per artefakt też działa', async () => {
  const { source, destination } = workspace();
  mkdirSync(source, { recursive: true });
  artifact(join(source, 'spans-aaa'), 'aaa');
  artifact(join(source, 'spans-bbb'), 'bbb');

  const { stdout } = await run('node', [script, source, destination]);
  assert.match(stdout, /włożonych artefaktów: 2/);
  assert.ok(readFileSync(join(destination, 'aaa', 'speech-spans.json')));
  assert.ok(readFileSync(join(destination, 'bbb', 'speech-spans.json')));
});

test('brak oczekiwanych artefaktów kończy się błędem', async () => {
  const { source, destination } = workspace();
  mkdirSync(source, { recursive: true });
  artifact(source, 'abc-123');

  await assert.rejects(
    run('node', [script, source, destination], { env: { ...process.env, EXPECTED: '2' } }),
    (error) => error.code === 1 && /oczekiwano 2/.test(error.stderr)
  );
});

test('pusty katalog przy oczekiwaniu zera to sukces', async () => {
  const { source, destination } = workspace();
  mkdirSync(source, { recursive: true });
  const { stdout } = await run('node', [script, source, destination]);
  assert.match(stdout, /włożonych artefaktów: 0/);
});
