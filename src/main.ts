import { Game } from './game/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.init().catch((e) => {
  console.error(e);
  const el = document.querySelector('#loading .msg');
  if (el) el.textContent = `Failed to start: ${e?.message ?? e}`;
});
