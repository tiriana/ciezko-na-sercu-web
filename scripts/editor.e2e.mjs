#!/usr/bin/env node
/**
 * Test edytora online bez sieci i bez prawdziwego GitHuba: serwujemy zbudowany
 * `.cache/editor-dist`, podmieniamy GitHub API i `raw.githubusercontent.com` na atrapę,
 * a dane czytamy z lokalnego repozytorium. Żadne żądanie nie wychodzi poza localhost.
 *
 * Użycie: npm run test:editor (najpierw `npm run editor:build`)
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { chromium } from 'playwright';

const ROOT = '.cache/editor-dist';
const REPO = resolve('.');
const PORT = Number(process.env.EDITOR_TEST_PORT ?? 4391);
const RAW_PREFIX = '/tiriana/ciezko-na-sercu-web/main/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
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

await new Promise((resolveListen) => server.listen(PORT, resolveListen));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('[pageerror]', String(error).slice(0, 400)));


const blobs = [];
const publishes = [];
const external = [];
const validTokens = new Set();
// Atrapa czyta pliki z repo, ale publikacje nakładają się na to jak na prawdziwą gałąź:
// bez tego drugi odczyt po własnym commicie widziałby stary plik.
const overlay = new Map();
const blobContent = new Map();
let current = null;
let conflicts = 0;
let conflictPending = false;
let offline = false;
let headSha = 'parent1';
let headTree = 'tree0';
let commitCount = 0;

const fulfillFile = (route, path, body) =>
  route.fulfill({
    status: 200,
    contentType: TYPES[extname(path)] ?? 'application/octet-stream',
    body,
  });

const serveRepoFile = async (route, request) => {
  if (offline) return route.fulfill({ status: 503, body: 'offline' });
  const url = new URL(request.url());
  if (!url.pathname.startsWith(RAW_PREFIX)) return route.fulfill({ status: 404, body: '404' });
  const path = decodeURIComponent(url.pathname.slice(RAW_PREFIX.length));
  if (path.includes('..') || !/^(data\/|package\.json$)/.test(path)) return route.fulfill({ status: 404, body: '404' });
  if (overlay.has(path)) return fulfillFile(route, path, overlay.get(path));
  try {
    return fulfillFile(route, path, await readFile(join(REPO, path)));
  } catch {
    return route.fulfill({ status: 404, body: '404' });
  }
};

const handleApi = async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const token = (request.headers()['authorization'] ?? '').replace(/^Bearer /, '');

  if (path === '/user') {
    if (!token) return json({ message: 'wymagany token' }, 401);
    validTokens.add(token);
    return json({ login: 'radomir' });
  }
  // Wygaszony token: każde kolejne żądanie dostaje 401, tak jak od GitHuba.
  if (!validTokens.has(token)) return json({ message: 'Bad credentials' }, 401);
  if (path === '/repos/tiriana/ciezko-na-sercu-web' && method === 'GET') {
    return json({ permissions: { push: true, admin: false } });
  }
  if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: headSha } });
  if (path.includes('/git/commits/')) return json({ tree: { sha: headTree } });
  if (path.endsWith('/git/blobs')) {
    const body = JSON.parse(request.postData() ?? '{}');
    const sha = `blob${blobs.length + 1}`;
    blobs.push({ kind: 'blob', content: body.content });
    blobContent.set(sha, body.content);
    return json({ sha });
  }
  if (path.endsWith('/git/trees')) {
    const body = JSON.parse(request.postData() ?? '{}');
    current = { tree: body.tree, base: body.base_tree, blobs: [...blobs] };
    publishes.push(current);
    return json({ sha: `tree${publishes.length}` });
  }
  if (path.endsWith('/git/commits')) {
    const body = JSON.parse(request.postData() ?? '{}');
    commitCount += 1;
    if (current) {
      current.message = body.message;
      current.parents = body.parents;
      current.commitSha = `commit${commitCount}`;
    }
    return json({ sha: `commit${commitCount}` });
  }
  if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
    if (conflictPending) {
      // Ktoś inny wypchnął commit w trakcie publikacji: gałąź przesuwa się na nowy
      // koniec, więc ponowna próba musi rebazować na niego, a nie na stary `parent1`.
      conflictPending = false;
      conflicts += 1;
      headSha = 'parent-external';
      headTree = 'tree-external';
      return json({ message: 'branch changed' }, 409);
    }
    const body = JSON.parse(request.postData() ?? '{}');
    if (current) {
      current.refSha = body.sha;
      for (const entry of current.tree) {
        if (entry.sha === null) overlay.delete(entry.path);
        else if (blobContent.has(entry.sha)) overlay.set(entry.path, blobContent.get(entry.sha));
      }
      headSha = current.commitSha;
      headTree = `tree${publishes.length}`;
    }
    return json({ object: { sha: headSha } });
  }
  return json({ message: 'nieznany endpoint w atrapie' }, 404);
};

await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === 'localhost') return route.continue();
  if (url.hostname === 'raw.githubusercontent.com') return serveRepoFile(route, route.request());
  if (url.hostname === 'api.github.com') return handleApi(route);
  external.push(url.href);
  return route.abort();
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

  const windowBefore = await page.locator('#wave-window').textContent();
  await page.locator('#wave-in').click();
  const windowAfter = await page.locator('#wave-window').textContent();
  if (/\d+:\d+/.test(windowBefore ?? '') && windowBefore !== windowAfter) ok('waveform ma okno czasu i zoom');
  else fail(`waveform bez okna albo zoom nie działa (${windowBefore} → ${windowAfter})`);
  await page.locator('#wave-all').click();

  if (await page.locator('#publish').isDisabled()) ok('publikacja zablokowana bez logowania');
  else fail('publikacja dostępna bez logowania');

  await page.locator('#sign-in').click();
  await page.locator('#token').fill('testowy-token');
  await page.locator('#login-token').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('radomir'), null, { timeout: 10000 });
  ok('logowanie przyjęte');

  const artistCell = () => page.locator('#tracks tr:first-child td:nth-child(4) input');
  await artistCell().fill('Poprawiony Wykonawca');
  await artistCell().press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  ok('szkic odblokował publikację');

  const publishAndWait = async () => {
    const before = publishes.length;
    await page.locator('#publish').click();
    await page.waitForFunction(() => document.querySelector('#hint')?.textContent.startsWith('zapisane'), null, { timeout: 10000 });
    if (publishes.length === before) throw new Error('nie doszło do commita');
    return publishes.at(-1);
  };

  const published = await publishAndWait();
  const paths = published.tree.map((entry) => entry.path).sort();
  const overridePath = paths.find((path) => /^data\/overrides\/[0-9a-f-]{36}\.json$/.test(path));
  if (overridePath) ok(`commit zawiera plik poprawek odcinka (${overridePath})`);
  else fail(`commit bez pliku poprawek (jest: ${paths.join(', ')})`);
  if (paths.includes('data/titles.json')) ok('commit zawiera data/titles.json');
  else fail('commit bez data/titles.json');

  if (/^fix\(dane\): /.test(published.message ?? '')) ok(`komunikat commita: ${published.message}`);
  else fail(`komunikat bez prefiksu wydania: ${published.message}`);

  const overrideBlob = published.blobs.find((step) => step.kind === 'blob' && step.content.includes('Poprawiony Wykonawca'));
  if (overrideBlob) ok('poprawka trafiła do treści pliku');
  else fail('w plikach commita brak zmienionego wykonawcy');

  if (published.refSha === 'commit1') ok('gałąź main przesunięta na nowy commit');
  else fail('gałąź nie została przesunięta');

  // Ukrycie utworu: osobna poprawka, ten sam jeden commit.
  await page.locator('#tracks tr:first-child td.actions button:last-child').click();
  const hidden = await publishAndWait();
  const hiddenBlob = hidden.blobs.find((step) => step.kind === 'blob' && step.content.includes('"hide": true'));
  if (hiddenBlob) ok('ukrycie utworu trafia do poprawek');
  else fail('ukrycie nie trafiło do poprawek');

  // Tytuł redakcyjny: zmiana tytułu musi wylądować w data/titles.json.
  await page.locator('#episode-title').fill('Tytuł z edytora online');
  await page.locator('#episode-title').press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  const retitled = await publishAndWait();
  const titlesBlob = retitled.blobs.find(
    (step) => step.kind === 'blob' && step.content.includes('Tytuł z edytora online') && step.content.includes('"titles"')
  );
  if (titlesBlob) ok('tytuł odcinka trafia do data/titles.json');
  else fail('zmiana tytułu nie trafiła do data/titles.json');

  // Znaczniki „przejrzane” jadą do repo tym samym commitem, więc wracają po przeładowaniu
  // karty i widzi je także lokalny edytor.
  const beforeReview = await page.locator('#progress').textContent();
  const reviewBox = page.locator('#tracks tr:nth-child(2) td.done-cell input');
  await reviewBox.click();
  const reviewAfterClick = await reviewBox.isChecked();
  await page.waitForFunction(
    (before) => document.querySelector('#progress')?.textContent !== before,
    beforeReview,
    { timeout: 5000 }
  );
  ok('znacznik „przejrzane” zmienia licznik');
  const reviewedPublish = await publishAndWait();
  const reviewedPaths = reviewedPublish.tree.map((entry) => entry.path);
  if (reviewedPaths.includes('data/reviewed.json')) ok('commit zawiera data/reviewed.json');
  else fail(`commit bez data/reviewed.json (jest: ${reviewedPaths.join(', ')})`);
  const reviewedBlob = reviewedPublish.blobs.find((step) => step.kind === 'blob' && step.content.includes('"episodes"'));
  if (reviewedBlob) ok('znaczniki „przejrzane” trafiają do treści pliku');
  else fail('w plikach commita brak znaczników „przejrzane”');

  // Dodanie wejścia i utworu: nowe pozycje jadą w addTopics/addTracks.
  await page.locator('#wave-add-topic').click();
  const topicInputs = page.locator('#add-topics tr:last-child input[type="text"]');
  await topicInputs.nth(0).fill('1:00');
  await topicInputs.nth(1).fill('Wejście z edytora online');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  const addedTopic = await publishAndWait();
  const topicBlob = addedTopic.blobs.find(
    (step) => step.kind === 'blob' && step.content.includes('"addTopics"') && step.content.includes('Wejście z edytora online')
  );
  if (topicBlob) ok('dodane wejście trafia do addTopics');
  else fail('dodane wejście nie trafiło do pliku poprawek');

  await page.locator('#wave-add-track').click();
  const trackInputs = page.locator('#add-tracks tr:last-child input[type="text"]');
  await trackInputs.nth(0).fill('2:00');
  await trackInputs.nth(2).fill('Dodany Wykonawca');
  await trackInputs.nth(3).fill('Dodany Tytuł');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  const addedTrack = await publishAndWait();
  const trackBlob = addedTrack.blobs.find(
    (step) => step.kind === 'blob' && step.content.includes('"addTracks"') && step.content.includes('Dodany Wykonawca')
  );
  if (trackBlob) ok('dodany utwór trafia do addTracks');
  else fail('dodany utwór nie trafił do pliku poprawek');

  // Strażnik przed zepsutym plikiem: koniec przed początkiem nie może dojść do GitHuba.
  const beforeGuard = publishes.length;
  const endInput = page.locator('#tracks tr:nth-child(2) td:nth-child(3) input');
  const originalEnd = await endInput.inputValue();
  await endInput.fill('0:01');
  await endInput.press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  await page.locator('#publish').click();
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.startsWith('nie publikuję'), null, {
    timeout: 5000,
  });
  if (publishes.length === beforeGuard) ok('niepoprawny czas zablokował publikację');
  else fail('niepoprawny czas trafił do commita');
  await endInput.fill(originalEnd);
  await endInput.press('Tab');

  // Szkic: zmiana ma przetrwać przeładowanie karty (IndexedDB). Zapis jest odroczony
  // o 0,5 s, więc dajemy mu dojść do skutku przed przeładowaniem.
  await artistCell().fill('Szkic po przeładowaniu');
  await artistCell().press('Tab');
  await page.waitForTimeout(900);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#episodes li button');
  await page.locator('#filter').fill(episodeSlug);
  await page.waitForTimeout(300);
  await page.locator('#episodes li button').first().click();
  await page.waitForSelector('#tracks tr');
  await page.waitForFunction(
    () => document.querySelector('#tracks tr:first-child td:nth-child(4) input')?.value === 'Szkic po przeładowaniu',
    null,
    { timeout: 10000 }
  );
  ok('szkic przeżył przeładowanie karty');
  const reviewAfterReload = await page.locator('#tracks tr:nth-child(2) td.done-cell input').isChecked();
  if (reviewAfterReload === reviewAfterClick) ok('znacznik „przejrzane” wraca z repozytorium po przeładowaniu');
  else fail(`znacznik „przejrzane” nie wrócił z repozytorium (${reviewAfterClick} → ${reviewAfterReload})`);

  // Offline po wcześniejszym odczycie: dane z pamięci, nie biała strona.
  offline = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#episodes li button', { timeout: 15000 });
  const cachedEpisodes = await page.locator('#episodes li button').count();
  if (cachedEpisodes > 0) ok(`bez sieci lista odcinków wraca z pamięci (${cachedEpisodes})`);
  else fail('bez sieci edytor nie pokazał listy');
  offline = false;

  await page.locator('#filter').fill(episodeSlug);
  await page.waitForTimeout(300);
  await page.locator('#episodes li button').first().click();
  await page.waitForSelector('#tracks tr');

  // Sesja przeżywa odświeżenie karty (sessionStorage), więc nie trzeba się logować ponownie.
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('radomir'), null, {
    timeout: 10000,
  });
  ok('sesja przeżyła przeładowanie karty');

  // Konflikt: gałąź zmieniła się w trakcie publikacji — edytor pobiera ref ponownie.
  conflictPending = true;
  const beforeConflict = publishes.length;
  await artistCell().fill('Po konflikcie');
  await artistCell().press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  await publishAndWait();
  if (conflicts === 1) ok('konflikt 409 kończy się ponowną próbą');
  else fail(`oczekiwano jednego konfliktu, było ${conflicts}`);
  if (publishes.length === beforeConflict + 2) ok('druga próba po konflikcie tworzy commit');
  else fail(`po konflikcie oczekiwano dwóch prób, było ${publishes.length - beforeConflict}`);
  const retried = publishes.at(-1);
  if (retried.parents?.[0] === 'parent-external' && retried.base === 'tree-external') {
    ok('ponowna próba rebazuje na nowy koniec gałęzi');
  } else {
    fail(`ponowna próba użyła starego końca gałęzi (${retried.parents?.[0]}, ${retried.base})`);
  }

  // 401: wygaszony token nie może zapisać nic po cichu — UI wraca do logowania.
  await artistCell().fill('Po wygaśnięciu');
  await artistCell().press('Tab');
  await page.waitForFunction(() => !document.querySelector('#publish').disabled, null, { timeout: 5000 });
  validTokens.clear();
  const beforeExpiry = publishes.length;
  await page.locator('#publish').click();
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.includes('sesja wygasła'), null, {
    timeout: 10000,
  });
  if (publishes.length === beforeExpiry) ok('wygaszony token nie tworzy commita');
  else fail('wygaszony token zapisał commit');
  if (await page.locator('#sign-in').isVisible()) ok('po 401 edytor prosi o logowanie');
  else fail('po 401 brak przycisku logowania');
  if (await page.locator('#publish').isDisabled()) ok('po 401 publikacja zablokowana');
  else fail('po 401 publikacja dalej aktywna');

  await page.locator('#sign-in').click();
  await page.locator('#token').fill('nowy-token');
  await page.locator('#login-token').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('radomir'), null, { timeout: 10000 });
  const afterRelogin = await publishAndWait();
  if (/^commit\d+$/.test(afterRelogin.refSha ?? '')) ok('po ponownym logowaniu szkic da się opublikować');
  else fail(`po ponownym logowaniu publikacja nie przeszła (${afterRelogin.refSha})`);

  // Tagi i aliasy: lista etykiet liczona z odcinków pobranych przez klienta odczytu.
  await page.locator('#tab-tags').click();
  await page.waitForFunction(() => document.querySelectorAll('#tag-rows tr').length > 0, null, { timeout: 60000 });
  const tagRows = await page.locator('#tag-rows tr').count();
  if (tagRows > 0) ok(`etykiety policzone w przeglądarce: ${tagRows} wierszy`);
  else fail('brak etykiet w widoku tagów');
  const candidates = await page.locator('#alias-candidates li').count();
  if (candidates > 0) ok(`kandydaci na alias: ${candidates}`);
  else fail('brak kandydatów na alias');

  await page.locator('#tag-search').fill('Szubrycht');
  const filtered = await page.locator('#tag-rows tr').count();
  if (filtered > 0 && filtered < tagRows) ok(`filtr etykiet zawęża listę (${filtered})`);
  else fail('filtr etykiet nie działa');
  await page.locator('#tag-search').fill('');

  const beforeAliases = publishes.length;
  await page.locator('#alias-from').fill('Testowy Wariant');
  await page.locator('#alias-to').fill('Jarek Szubrycht');
  await page.locator('#alias-add').click();
  await page.waitForFunction(() => !document.querySelector('#aliases-save').disabled, null, { timeout: 5000 });
  await page.locator('#aliases-save').click();
  await page.waitForFunction(() => document.querySelector('#aliases-hint')?.textContent.startsWith('zapisane'), null, {
    timeout: 10000,
  });
  const aliasPublish = publishes.at(-1);
  const aliasPaths = aliasPublish.tree.map((entry) => entry.path);
  if (aliasPaths.includes('data/aliases.json')) ok('alias zapisany jednym commitem do data/aliases.json');
  else fail(`commit bez data/aliases.json (jest: ${aliasPaths.join(', ')})`);
  const aliasBlob = aliasPublish.blobs.find(
    (step) => step.kind === 'blob' && step.content.includes('Testowy Wariant') && step.content.includes('Jarek Szubrycht')
  );
  if (aliasBlob) ok('alias trafił do treści pliku');
  else fail('w pliku aliasów brak nowej pary');
  if (publishes.length === beforeAliases + 1) ok('zapis aliasów to jeden commit');
  else fail(`zapis aliasów zrobił ${publishes.length - beforeAliases} commitów`);

  // Druga publikacja po przeładowaniu: atrapa oddaje już zapisany plik, więc edytor
  // nie może zablokować zapisu komunikatem o cudzej zmianie.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#episodes li button');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('radomir'), null, {
    timeout: 10000,
  });
  await page.locator('#tab-tags').click();
  await page.waitForFunction(() => document.querySelectorAll('#tag-rows tr').length > 0, null, { timeout: 60000 });
  await page.locator('#alias-from').fill('Drugi Wariant');
  await page.locator('#alias-to').fill('Jarek Szubrycht');
  await page.locator('#alias-add').click();

  // Brak sieci przy sprawdzaniu pliku nie może znaczyć „wolno nadpisać”.
  offline = true;
  const beforeOffline = publishes.length;
  await page.locator('#aliases-save').click();
  await page.waitForFunction(() => document.querySelector('#aliases-hint')?.textContent.includes('nie mogę sprawdzić'), null, {
    timeout: 10000,
  });
  if (publishes.length === beforeOffline) ok('brak sieci wstrzymuje zapis aliasów');
  else fail('brak sieci nie zatrzymał zapisu aliasów');
  offline = false;

  await page.locator('#aliases-save').click();
  await page.waitForFunction(() => document.querySelector('#aliases-hint')?.textContent.startsWith('zapisane'), null, {
    timeout: 10000,
  });
  const mergedAliases = overlay.get('data/aliases.json') ?? '';
  if (mergedAliases.includes('Testowy Wariant') && mergedAliases.includes('Drugi Wariant')) {
    ok('druga publikacja aliasów nie gubi pierwszej');
  } else {
    fail('druga publikacja aliasów nadpisała pierwszą');
  }

  if (external.length === 0) ok('żadne żądanie nie wyszło poza mock');
  else fail(`ruch poza mockiem: ${external.join(', ')}`);
} catch (error) {
  fail(error.message);
} finally {
  await browser.close();
  server.close();
}

if (process.exitCode) console.error('test edytora NIE przeszedł');
else console.log('test edytora przeszedł');
