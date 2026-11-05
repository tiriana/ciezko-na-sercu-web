import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { chromium, firefox, webkit } from 'playwright';

/**
 * Jeden zrzut na konfigurację: sam player (pasek audio), motyw jasny, widok desktop.
 * Interesuje nas wyłącznie wygląd playera w danych przeglądarkach, bez reszty strony.
 *
 * Serwer statyczny startuje w tym samym procesie. Wcześniej workflow uruchamiał go
 * w tle powłoki, co na Windowsie kończyło się "Could not connect to server".
 */
const OUT = process.env.OUT_DIR ?? 'screenshots';
const BROWSER = process.env.BROWSER ?? 'chromium';
const OS_LABEL = (process.env.OS_LABEL ?? 'local').replace(/[^a-z0-9-]/gi, '-');
const PAGE = process.env.PAGE ?? '/odcinki/2026-11-04-sluchamy-umarlych/';
const DIST = resolve(process.env.DIST_DIR ?? 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

const engines = { chromium, firefox, webkit };
const engine = engines[BROWSER];
if (!engine) throw new Error(`unknown BROWSER=${BROWSER}`);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  let target = join(DIST, normalize(pathname));
  if (!target.startsWith(DIST)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

await mkdir(OUT, { recursive: true });

const browser = await engine.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'pl-PL',
});
const page = await context.newPage();

// WebKit na Windowsie nie kończy oczekiwania na fonty (document.fonts nigdy nie
// przechodzi w "loaded"), a Playwright czeka na to przed każdym zrzutem. Blokujemy
// pliki fontów tylko w tej konfiguracji — zrzut powstaje na fontach systemowych.
if (BROWSER === 'webkit' && process.platform === 'win32') {
  await page.route('**/*.woff2', (route) => route.abort());
  console.warn('⚠️  webkit na Windowsie: fonty zablokowane, zrzut na fontach systemowych');
}

await page.goto(`${BASE}${PAGE}`, { waitUntil: 'load', timeout: 60_000 });

// Fonty są lokalne, ale WebKit potrafi czekać na nie dłużej niż na samo malowanie;
// ograniczamy oczekiwanie, żeby zrzut nie kończył się timeoutem w CI.
await page.evaluate(() =>
  Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, 5_000))])
);

const player = page.locator('.audio-bar');
if ((await player.count()) === 0) {
  throw new Error('Brak playera (.audio-bar) na wskazanej stronie — sprawdź PAGE.');
}

await player.first().scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const file = `${OUT}/${OS_LABEL}-${BROWSER}.png`;
try {
  await player.first().screenshot({ path: file, animations: 'disabled', timeout: 60_000 });
} catch (error) {
  // WebKit na Windowsie potrafi czekać na fonty w nieskończoność (document.fonts nigdy
  // nie przechodzi w "loaded"), mimo że strona jest wyrenderowana. Wtedy robimy zrzut
  // na fontach systemowych, żeby artefakt powstał i było widać różnicę.
  console.warn(`⚠️  ${BROWSER}: zrzut z fontami zablokowanymi (${error.name})`);
  await page.addStyleTag({ content: '* { font-family: Arial, sans-serif !important; }' });
  await player.first().screenshot({ path: file, animations: 'disabled', timeout: 30_000 });
}
console.log(file);

await browser.close();
server.close();
