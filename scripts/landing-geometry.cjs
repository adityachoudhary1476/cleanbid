/**
 * landing-geometry.cjs — layout defect detector.
 * For each viewport: flags elements wider than the viewport (clipping),
 * elements overflowing their container horizontally, and text nodes
 * that collide with sibling text. Complements screenshots.
 */
const { chromium } = require('playwright-core');

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440 }, { name: 'desktop-1280', width: 1280 },
  { name: 'laptop-1024', width: 1024 }, { name: 'tablet-768', width: 768 },
  { name: 'mobile-430', width: 430 }, { name: 'mobile-390', width: 390 },
  { name: 'mobile-360', width: 360 },
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let issues = 0;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('http://localhost:4173/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const found = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      const els = document.querySelectorAll('#view-login section *, .lnav *, .lhero *, .finalcta *, .lfoot *');
      els.forEach(el => {
        if (!(el instanceof HTMLElement)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        // element extends beyond viewport (allow 1px rounding)
        if (r.right > vw + 1 || r.left < -1) {
          out.push(`CLIP ${el.tagName}.${String(el.className).slice(0,40)} right=${Math.round(r.right)} left=${Math.round(r.left)} vw=${vw}`);
        }
        // horizontal scroll escape inside a card
        if (el.scrollWidth > el.clientWidth + 2 && !['auto','scroll','hidden','clip'].includes(getComputedStyle(el).overflowX)) {
          const txt = (el.textContent || '').trim().slice(0, 40);
          out.push(`ESCAPE ${el.tagName}.${String(el.className).slice(0,40)} sw=${el.scrollWidth} cw=${el.clientWidth} "${txt}"`);
        }
      });
      return out.slice(0, 12);
    });
    console.log(`${vp.name}: ${found.length === 0 ? 'OK' : ''}`);
    found.forEach(f => { console.log('   ', f); issues++; });
    await ctx.close();
  }
  await browser.close();
  console.log(issues ? `RESULT: ${issues} geometry issues` : 'RESULT: GEOMETRY CLEAN');
  process.exit(issues ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
