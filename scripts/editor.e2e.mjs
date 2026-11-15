#!/usr/bin/env node
/**
 * Test edytora online bez sieci i bez prawdziwego GitHuba: serwujemy zbudowany
 * `.cache/editor-dist`, podmieniamy API GitHuba na atrapę i sprawdzamy, że publikacja
 * faktycznie wysyła jeden commit z poprawnymi plikami.
 *
 * Użycie: npm run test:editor (najpierw `npm run editor:build`)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { chromium } from 'playwright';

const ROOT = '.cache/editor-dist';
const PORT = Number(process.env.EDITOR_TEST_PORT ?? 4391);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('404');
  }
});

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

const ok = (message) => console.log(`✓ ${message}`);

await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch();
const page = await browser.newPage();
const steps = [];
let published = null;

await page.route('https://api.github.com/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (path === '/user') return json({ login: 'radomir' });
  if (path === '/repos/tiriana/ciezko-na-sercu-web' && method === 'GET') {
    return json({ permissions: { push: true, admin: false } });
  }
  if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'parent1' } });
  if (path.endsWith('/git/commits/parent1')) return json({ tree: { sha: 'tree0' } });
  if (path.endsWith('/git/blobs')) {
    const body = JSON.parse(request.postData() ?? '{}');
    steps.push({ kind: 'blob', content: body.content });
    return json({ sha: `blob${steps.length}` });
  }
  if (path.endsWith('/git/trees')) {
    const body = JSON.parse(request.postData() ?? '{}');
    published = { tree: body.tree, base: body.base_tree };
    return json({ sha: 'tree1' });
  }
  if (path.endsWith('/git/commits')) {
    const body = JSON.parse(request.postData() ?? '{}');
    published.message = body.message;
    published.parents = body.parents;
    return json({ sha: 'commit1' });
  }
  if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
    published.refSha = JSON.parse(request.postData() ?? '{}').sha;
    return json({ object: { sha: 'commit1' } });
  }
  return json({ message: 'nieznany endpoint w atrapie' }, 404);
});

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#episodes li button', { timeout: 20000 });
  const episodes = await page.locator('#episodes li button').count();
  if (episodes > 0) ok(`lista odcinków: ${episodes}`);
  else fail('lista odcinków jest pusta');

  await page.locator('#episodes li button').first().click();
  await page.waitForSelector('#tracks tr');
  const rows = await page.locator('#tracks tr').count();
  if (rows > 0) ok(`wiersze utworów: ${rows}`);
  else fail('odcinek nie ma wierszy');

  const episodeSlug = await page.evaluate(() => document.querySelector('#episode-meta').textContent.split(' · ')[0]);
  if (episodeSlug) ok(`wczytany odcinek: ${episodeSlug}`);

  if (await page.locator('#publish').isDisabled()) ok('publikacja zablokowana bez logowania');
  else fail('publikacja dostępna bez logowania');

  await page.locator('#sign-in').click();
  await page.locator('#token').fill('testowy-token');
  await page.locator('#login-token').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('radomir'), null, { timeout: 10000 });
  ok('logowanie przyjęte');

  const artistInput = page.locator('#tracks tr:first-child td:nth-child(3) input');
  await artistInput.fill('Poprawiony Wykonawca');
  await artistInput.press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  ok('szkic odblokował publikację');

  await page.locator('#publish').click();
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.startsWith('zapisane'), null, { timeout: 10000 });

  if (!published) throw new Error('nie doszło do commita');
  const paths = published.tree.map((entry) => entry.path).sort();
  const overridePath = paths.find((path) => /^data\/overrides\/[0-9a-f-]{36}\.json$/.test(path));
  if (overridePath) ok(`commit zawiera plik poprawek odcinka (${overridePath})`);
  else fail(`commit bez pliku poprawek (jest: ${paths.join(', ')})`);
  if (paths.includes('data/titles.json')) ok('commit zawiera data/titles.json');
  else fail('commit bez data/titles.json');

  if (/^fix\(dane\): /.test(published.message ?? '')) ok(`komunikat commita: ${published.message}`);
  else fail(`komunikat bez prefiksu wydania: ${published.message}`);

  const overrideBlob = steps.find((step) => step.kind === 'blob' && step.content.includes('Poprawiony Wykonawca'));
  if (overrideBlob) ok('poprawka trafiła do treści pliku');
  else fail('w plikach commita brak zmienionego wykonawcy');

  if (published.refSha === 'commit1') ok('gałąź main przesunięta na nowy commit');
  else fail('gałąź nie została przesunięta');
} catch (error) {
  fail(error.message);
} finally {
  await browser.close();
  server.close();
}

if (process.exitCode) console.error('test edytora NIE przeszedł');
else console.log('test edytora przeszedł');
