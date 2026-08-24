/**
 * landing-shots.cjs — real-browser QA of the built landing page.
 * Drives the system Edge via playwright-core (channel: 'msedge').
 * Captures desktop/tablet/mobile screenshots + console errors + overflow check.
 * Usage: node scripts/landing-shots.cjs  (expects vite preview on :4173)
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1280', width: 1280, height: 800 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-430', width: 430, height: 932 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-360', width: 360, height: 780 },
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let anyFail = false;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto('http://localhost:4173/', { waitUntil: 'load' });
    await page.waitForTimeout(700);

    // horizontal overflow check
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // full-page screenshot
    await page.screenshot({ path: path.join(OUT, vp.name + '.png'), fullPage: true });

    // hero-only screenshot for quick eyeballing
    await page.screenshot({ path: path.join(OUT, vp.name + '-hero.png') });

    // FAQ open state (first question) — verify interaction works in a real engine
    if (vp.name === 'desktop-1440') {
      await page.click('.faq-q');
      await page.waitForTimeout(450);
      const open = await page.evaluate(() => document.querySelector('.faq').classList.contains('open'));
      console.log('faq opens in real browser:', open);
      // demo entry smoke test: enterDemo should reveal the app shell
      await page.click('.lnav-links .nav-cta').catch(() => {});
      await page.waitForTimeout(1200);
      const appVisible = await page.evaluate(() => {
        const app = document.getElementById('view-app');
        return app && !app.classList.contains('hidden');
      });
      console.log('enterDemo reveals app shell:', appVisible);
    }

    const bad = errors.filter(e => !/net::|favicon|fonts\.gstatic|googleapis/i.test(e));
    console.log(`${vp.name}: overflowX=${overflow}px consoleErrors=${bad.length}${bad.length ? ' :: ' + bad.join(' | ') : ''}`);
    if (overflow > 1 || bad.length) anyFail = true;
    await ctx.close();
  }
  await browser.close();
  console.log(anyFail ? 'RESULT: ISSUES FOUND' : 'RESULT: CLEAN');
  process.exit(anyFail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
