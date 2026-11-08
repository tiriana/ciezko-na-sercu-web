import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const posts = [];
page.on('request', (r) => { if (r.url().includes('/api/save')) posts.push(1); });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await page.goto('http://localhost:4330/');
await page.waitForSelector('#list button');
await page.evaluate(() => [...document.querySelectorAll('#list button')].find((b) => b.querySelector('time')?.textContent.startsWith('2026-11-04'))?.click());
await page.waitForTimeout(2500);

// okno przybliżone do 30 s wokół 0:20 i odtwarzanie przez krawędź
const stage = await page.locator('.wave canvas').boundingBox();
await page.mouse.move(stage.x + stage.width * 0.3, stage.y + 30);
for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
const label = () => page.evaluate(() => [...document.querySelectorAll('.wave span, .wave div')].map((n) => n.textContent.trim()).filter((t) => /–/.test(t) && t.length < 24)[0]);
console.log('okno', await label());
await page.evaluate(() => { const a = document.querySelector('#audio'); a.currentTime = 28; a.play().catch(() => {}); });
await page.waitForTimeout(9000);
const info = await page.evaluate(() => {
  const node = document.querySelector('#wave-playhead');
  const stage = document.querySelector('#wave-stage');
  return { left: node.style.left, cls: node.className, width: stage.clientWidth, hidden: node.hidden };
});
console.log('playhead', info, 'okno po 9 s', await label());
await page.evaluate(() => document.querySelector('#audio').pause());
await page.screenshot({ path: '/tmp/opencode/ciezko-issues/pin-right.png', clip: { x: stage.x - 2, y: stage.y - 2, width: stage.width + 4, height: stage.height + 4 } });

// Ctrl+S z fokusem na znaczniku
const marker = page.locator('.wave [aria-label^="Wejście: Pamięć"]').first();
await marker.focus();
await page.keyboard.press('Control+s');
await page.waitForTimeout(800);
console.log('Ctrl+S na znaczniku:', posts.length, await page.textContent('#status'));

// Ctrl+S bez odcinka: świeży reload
await page.reload();
await page.waitForTimeout(500);
await page.keyboard.press('Control+s');
await page.waitForTimeout(400);
console.log('Ctrl+S bez odcinka:', posts.length, await page.textContent('#status'));
await browser.close();
