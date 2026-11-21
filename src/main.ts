import * as THREE from 'three';
import { Game } from './game/Game';

// Offline build: textures and models are embedded in the page (window.__ASSETS, keyed by
// 'assets/...' path) and served from there instead of the network.
const embedded = (window as any).__ASSETS as Record<string, string> | undefined;
if (embedded) THREE.DefaultLoadingManager.setURLModifier((url) => {
  const i = url.indexOf('assets/');
  return (i >= 0 && embedded[url.slice(i)]) || url;
});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.init().catch((e) => {
  console.error(e);
  const el = document.querySelector('#loading .msg');
  if (el) el.textContent = `Failed to start: ${e?.message ?? e}`;
});
