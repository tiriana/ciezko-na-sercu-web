import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('./matrix-ids.mjs', import.meta.url).pathname;

const ids = async (matrix) => {
  const { stdout } = await run('node', [script], { env: { ...process.env, MATRIX: matrix } });
  return stdout.trim();
};

test('płaska tablica (tryb spans i time) daje unikalne id w kolejności', async () => {
  const matrix = JSON.stringify([
    { id: 'a', part: 0 },
    { id: 'a', part: 1 },
    { id: 'b', part: 0 },
  ]);
  assert.equal(await ids(matrix), 'a,b');
});

test('obiekt {include} nadal działa', async () => {
  assert.equal(await ids(JSON.stringify({ include: [{ id: 'x' }, { id: 'x' }] })), 'x');
});

test('pusta macierz nie wywala skryptu', async () => {
  assert.equal(await ids(''), '');
  assert.equal(await ids('[]'), '');
});
