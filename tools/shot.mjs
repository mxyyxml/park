// usage: node tools/shot.mjs <url-query> <out.png> [waitFrames]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const [, , query = '', out = 'shot.png', wait = '20'] = process.argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:5173/?${query}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction((n) => (window.__frames || 0) >= n, Number(wait), { timeout: 240000 }).catch((e) => logs.push('timeout ' + e.message));
await page.screenshot({ path: out });
const stats = await page.evaluate(() => window.__stats);
console.log('time', Date.now() - t0, 'ms', JSON.stringify(stats));
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
