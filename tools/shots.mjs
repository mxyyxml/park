// usage: node tools/shots.mjs "<query>" <outPrefix> <frame,frame,...> [w] [h]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const [, , query = '', prefix = 'shot', frames = '10', w = '1280', h = '720'] = process.argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const t0 = Date.now();
await page.goto(`http://localhost:5173/?${query}`, { waitUntil: 'load', timeout: 120000 });
for (const f of frames.split(',').map(Number)) {
  await page.waitForFunction((n) => (window.__frames || 0) >= n, f, { timeout: 400000 }).catch((e) => logs.push('timeout ' + e.message));
  await page.screenshot({ path: `${prefix}-${f}.png`, timeout: 180000 });
  const info = await page.evaluate(() => { const g = window.__game; if (!g) return null; const p = g.player; return { mode: g.mode, state: p.state, pos: [p.pos.x, p.pos.y, p.pos.z].map((v) => +v.toFixed(1)), speed: +p.hSpeed.toFixed(2), calls: g.r.renderer.info.render.calls, tris: g.r.renderer.info.render.triangles }; });
  console.log('frame', f, JSON.stringify(info), ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
console.log(JSON.stringify(await page.evaluate(() => window.__stats)));
console.log(logs.filter((l) => !l.includes('GPU stall')).slice(0, 25).join('\n'));
await browser.close();
