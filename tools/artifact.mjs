// Builds a single self-contained page (CSS + JS inlined) for publishing as a shareable link.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
const dir = 'dist/assets';
const js = readFileSync(`${dir}/game.js`, 'utf8').replace(/<\/script/gi, '<\\/script');
const cssFile = readdirSync(dir).find((f) => f.endsWith('.css'));
const css = readFileSync(`${dir}/${cssFile}`, 'utf8');
const page = `<title>Skyline Runner</title>
<style>${css}
html, body { height: 100%; background: #000; }
</style>
<canvas id="game"></canvas>
<div id="ui"></div>
<script type="module">${js}</script>
`;
mkdirSync('dist-artifact', { recursive: true });
writeFileSync('dist-artifact/skyline-runner.html', page);
console.log('wrote dist-artifact/skyline-runner.html', (page.length / 1024).toFixed(0), 'KB');
