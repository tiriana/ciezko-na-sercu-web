// E2E na zbudowanej stronie i prawdziwych danych: filtrowanie tagów i układ karty.
// Uruchomienie: npm run test:e2e (build musi być aktualny — skrypt go nie robi).
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)).replace(/^(\.\.[/\\])+/, '');
  for (const candidate of [join(ROOT, path), join(ROOT, path, 'index.html'), join(ROOT, `${path}.html`)]) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      response.writeHead(200, { 'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream' });
      createReadStream(candidate).pipe(response);
      return;
    } catch {}
  }
  response.writeHead(404).end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/tagi/`, { waitUntil: 'networkidle' });

  const total = await page.locator('.tags-section .tag-list a').count();
  check('lista tagów ma wpisy', total > 1000, `${total} etykiet`);

  await page.fill('#tag-filter', 'vader');
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.tags-section .tag-list a')];
    const visible = links.filter((link) => !link.classList.contains('is-filtered-out'));
    return {
      visibleLabels: visible.map((link) => link.dataset.tagLabel),
      visibleSections: [...document.querySelectorAll('.tags-section')].filter((section) => !section.hidden).length,
      hiddenSections: [...document.querySelectorAll('.tags-section')].filter((section) => section.hidden).length,
      status: document.querySelector('#tag-filter-status')?.textContent ?? '',
      hiddenDisplay: visible.length ? getComputedStyle(links.find((link) => link.classList.contains('is-filtered-out'))).display : 'n/a',
    };
  });

  check('tylko pasujące tagi zostają widoczne', state.visibleLabels.every((label) => label.toLowerCase().includes('vader')), state.visibleLabels.join(', '));
  check('coś pasuje do „vader”', state.visibleLabels.length > 0, `${state.visibleLabels.length} trafień`);
  check('niepasujące tagi są ukryte w CSS', state.hiddenDisplay === 'none', state.hiddenDisplay);
  check('sekcje bez trafień znikają', state.hiddenSections > 0, `${state.hiddenSections} ukrytych sekcji`);
  check('licznik zgadza się z liczbą widocznych etykiet', state.status.startsWith(String(state.visibleLabels.length)), `„${state.status}” vs ${state.visibleLabels.length}`);

  await page.fill('#tag-filter', '');
  await page.waitForTimeout(100);
  const restored = await page.evaluate(() => ({
    filtered: document.querySelectorAll('.tags-section .is-filtered-out').length,
    hiddenSections: [...document.querySelectorAll('.tags-section')].filter((section) => section.hidden).length,
  }));
  check('wyczyszczenie filtra przywraca wszystkie tagi', restored.filtered === 0 && restored.hiddenSections === 0, JSON.stringify(restored));

  const layout = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('main *')].find((element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    });
    const overflowing = [...document.querySelectorAll('.tag-list a')].filter((link) => {
      const card = link.closest('.card').getBoundingClientRect();
      return link.getBoundingClientRect().right > card.right - 20;
    });
    return { innerScroller: scroller?.className ?? null, overflowing: overflowing.length, docScrolls: document.documentElement.scrollHeight > window.innerHeight };
  });
  check('strona nie ma wewnętrznego okna przewijania', layout.innerScroller === null, layout.innerScroller ?? 'brak');
  check('strona przewija się jako całość', layout.docScrolls);
  check('tagi nie wychodzą za kartę', layout.overflowing === 0, `${layout.overflowing} poza kartą`);

  // Wejście z menu to nawigacja kliencka: skrypt strony musi związać się z nowym DOM.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.click('nav.site-nav a[href="/tagi/"]');
  await page.waitForURL('**/tagi/');
  await page.waitForTimeout(300);
  await page.fill('#tag-filter', 'vader');
  await page.waitForTimeout(100);
  const afterNav = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.tags-section .tag-list a')];
    return {
      visible: links.filter((link) => !link.classList.contains('is-filtered-out')).map((link) => link.dataset.tagLabel),
      status: document.querySelector('#tag-filter-status')?.textContent ?? '',
    };
  });
  check('filtr działa po wejściu z menu', afterNav.visible.length > 0 && afterNav.visible.every((label) => label.toLowerCase().includes('vader')), JSON.stringify(afterNav));

  // Lista odcinków: filtr tytułu. Wiersze mają data-month tak samo jak nagłówki miesięcy,
  // więc pętla nagłówków potrafiła nadpisywać im hidden.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.fill('[data-filter-title]', 'estonia');
  await page.waitForTimeout(100);
  const list = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-episode]')];
    const visible = rows.filter((row) => !row.hidden);
    return {
      total: rows.length,
      visible: visible.map((row) => row.dataset.episode),
      months: [...document.querySelectorAll('.list__month[data-month]')].filter((month) => !month.hidden).length,
      counter: document.querySelector('[data-result-count]')?.textContent ?? '',
    };
  });
  check('filtr listy zostawia tylko pasujące tytuły', list.visible.every((title) => title.toLowerCase().includes('estonia')), list.visible.join(', '));
  check('filtr listy nie ukrywa pasującego wiersza', list.visible.length > 0, `${list.visible.length} widocznych z ${list.total}`);
  check('licznik zgadza się z liczbą wierszy', list.counter === String(list.visible.length), `„${list.counter}” vs ${list.visible.length}`);
  check('zostaje tylko nagłówek miesiąca z trafieniem', list.months === 1, `${list.months} nagłówków`);

  await page.fill('[data-filter-title]', '');
  await page.waitForTimeout(100);
  const restoredList = await page.evaluate(() => [...document.querySelectorAll('[data-episode]')].filter((row) => !row.hidden).length);
  check('wyczyszczenie filtra przywraca całą listę', restoredList === list.total, `${restoredList} z ${list.total}`);

  const player = await page.evaluate(() => {
    const bar = document.querySelector('.audio-bar');
    if (!bar || bar.hidden) return 'brak paska';
    return getComputedStyle(bar).position;
  });
  check('pasek odtwarzacza jest przyklejony', player === 'sticky' || player === 'brak paska', player);
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} niepowodzeń:\n${failures.map((item) => ` - ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('\nWszystkie sprawdzenia przeszły.');
