import { mkdir } from 'node:fs/promises';

import { chromium, firefox, webkit } from 'playwright';

/**
 * Jeden zrzut na konfigurację: sam player (pasek audio), motyw jasny, widok desktop.
 * Interesuje nas wyłącznie wygląd playera w danych przeglądarkach, bez reszty strony.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321';
const OUT = process.env.OUT_DIR ?? 'screenshots';
const BROWSER = process.env.BROWSER ?? 'chromium';
const OS_LABEL = (process.env.OS_LABEL ?? 'local').replace(/[^a-z0-9-]/gi, '-');
const PAGE = process.env.PAGE ?? '/odcinki/2026-11-04-sluchamy-umarlych/';

const engines = { chromium, firefox, webkit };

const engine = engines[BROWSER];
if (!engine) throw new Error(`unknown BROWSER=${BROWSER}`);

await mkdir(OUT, { recursive: true });

const browser = await engine.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'pl-PL',
});
const page = await context.newPage();

await page.goto(`${BASE}${PAGE}`, { waitUntil: 'networkidle', timeout: 60_000 });

// Fonty są lokalne, ale WebKit potrafi czekać na nie dłużej niż na samo malowanie;
// ograniczamy oczekiwanie, żeby zrzut nie kończył się timeoutem w CI.
await page.evaluate(() =>
  Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 5_000))])
);

const player = page.locator('.audio-bar');
if ((await player.count()) === 0) {
  throw new Error('Brak playera (.audio-bar) na wskazanej stronie — sprawdź PAGE.');
}

await player.first().scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const file = `${OUT}/${OS_LABEL}-${BROWSER}.png`;
await player.first().screenshot({ path: file, animations: 'disabled', timeout: 60_000 });
console.log(file);

await browser.close();
