import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1710, height: 900 } });
await page.goto('http://localhost:4336/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
console.log(await page.evaluate(() => {
  const stage = document.querySelector('.wave-stage, #wave-stage');
  const band = document.querySelector('.episodes');
  return {
    health: document.querySelector('.health')?.textContent?.trim().slice(0, 40),
    bandH: Math.round(band?.getBoundingClientRect().height ?? -1),
    stageW: Math.round(stage?.getBoundingClientRect().width ?? -1),
    openTitle: document.querySelector('#originalTitle')?.textContent?.slice(0, 40),
    draft: Object.keys(localStorage).filter((k) => k.startsWith('edytor.draft')).length,
  };
}));
await browser.close();
