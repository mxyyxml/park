// Builds dist-offline/skyline-runner-offline.html: one self-contained file (code, styles, every
// texture and model embedded) that plays without a network connection. Run after `vite build`.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const assets = {};
for (const f of walk('public/assets')) {
  const key = relative('public', f).split('\\').join('/');
  const buf = readFileSync(f);
  if (f.endsWith('.jpg')) assets[key] = 'data:image/jpeg;base64,' + buf.toString('base64');
  else if (f.endsWith('.json')) assets[key] = 'data:application/json;charset=utf-8,' + encodeURIComponent(buf.toString('utf8'));
}
const js = readFileSync('dist/assets/game.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join('dist/assets', readdirSync('dist/assets').find((f) => f.endsWith('.css'))), 'utf8');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Skyline Runner</title>
<style>${css}</style></head>
<body><canvas id="game"></canvas><div id="ui"></div>
<script>window.__ASSETS=${JSON.stringify(assets)};</script>
<script type="module">${js}</script>
</body></html>
`;
mkdirSync('dist-offline', { recursive: true });
writeFileSync('dist-offline/skyline-runner-offline.html', html);
console.log('wrote dist-offline/skyline-runner-offline.html', (html.length / 1048576).toFixed(1), 'MB,', Object.keys(assets).length, 'assets');
