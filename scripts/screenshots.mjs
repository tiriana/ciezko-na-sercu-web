import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, firefox, webkit } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321';
const OUT = process.env.OUT_DIR ?? 'screenshots';
const BROWSER = process.env.BROWSER ?? 'chromium';
// HOME zamiast "/" w danych wejściowych: Git Bash na Windows zamienia wartość
// zaczynającą się od ukośnika na ścieżkę systemową, co psuło adres URL.
const PAGES = (process.env.PAGES ?? 'HOME,/odcinki/2026-11-04-sluchamy-umarlych/')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean)
  .map((path) => (path === 'HOME' ? '/' : path));
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const SCHEMES = ['light', 'dark'];

const engines = { chromium, firefox, webkit };

const engine = engines[BROWSER];
if (!engine) throw new Error(`unknown BROWSER=${BROWSER}`);

await mkdir(OUT, { recursive: true });

const browser = await engine.launch();
let count = 0;

for (const path of PAGES) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: scheme,
        locale: 'pl-PL',
      });
      const page = await context.newPage();
      const url = `${BASE}${path}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      const slug = path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/\//g, '-');
      const file = join(OUT, `${BROWSER}-${slug}-${viewport.name}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(file);
      count += 1;
      await context.close();
    }
  }
}

await browser.close();
console.log(`${count} zrzutów (${BROWSER})`);
