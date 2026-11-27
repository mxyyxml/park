import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { buildTrials } from '../src/game/Trials';
import { Bot } from '../src/game/Bot';
import { PlayerController, PState } from '../src/player/PlayerController';

const DT = 1 / 120;

describe('time trials are completable by the autopilot using the real physics', () => {
  const b = new WorldBuilder(false);
  const city = buildCity(b);
  const trials = buildTrials(city, b.world, b.ziplines);
  it('generates trials', () => {
    console.log(trials.map((t) => `${t.id}: ${t.checkpoints.length} cps, ${t.wps.length} wps, ${t.length.toFixed(0)} m, gold ${t.medals[0]}s`).join('\n'));
    expect(trials.length).toBeGreaterThanOrEqual(5);
  });
  for (const t of trials) {
    it(`completes ${t.id}`, () => {
      const p = new PlayerController(b.world);
      p.ziplines = b.ziplines;
      p.spawn(t.start.x, t.start.y, t.start.z, t.start.yaw);
      const bot = new Bot(b.world, t.wps);
      let cp = 0, time = 0, deaths = 0, closest = Infinity;
      const log: string[] = [];
      let last = '';
      while (time < 240 && cp < t.checkpoints.length) {
        const inp = bot.step(p, DT);
        p.update(DT, inp);
        time += DT;
        const st = `${p.state}`;
        if (st !== last) { log.push(`${time.toFixed(2)} ${st} wp${bot.i} (${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)})`); last = st; }
        const c = t.checkpoints[cp];
        closest = Math.min(closest, Math.hypot(p.pos.x - c.x, p.pos.z - c.z) + Math.abs(p.pos.y - c.y) * 10);
        if (bot.done && time > 1 && closest > 50) break;
        if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < c.r + 0.5 && Math.abs(p.pos.y - c.y) < 3) { cp++; closest = Infinity; }
        if (p.state === PState.Dead) {
          deaths++;
          log.push(`DIED at wp${bot.i} cp${cp}`);
          break;
        }
        if (bot.stuckT > 8) { log.push(`STUCK at wp${bot.i}/${t.wps.length} (${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)}) target ${JSON.stringify(t.wps[bot.i])}`); break; }
      }
      if (cp < t.checkpoints.length) console.log(t.id, 'FAILED', 'missing cp', cp, JSON.stringify(t.checkpoints[cp]), 'closest', closest.toFixed(1), '\n' + log.slice(-14).join('\n'));
      else console.log(t.id, 'done in', time.toFixed(1), 's (gold', t.medals[0], ')');
      expect(cp).toBe(t.checkpoints.length);
      expect(deaths).toBe(0);
    });
  }
  it('a second load reuses the cached, already-validated routes without re-running the autopilot', () => {
    const cache: Record<string, number> = {};
    const t0 = performance.now();
    const first = buildTrials(city, b.world, b.ziplines, cache, 'test');
    const cold = performance.now() - t0;
    const t1 = performance.now();
    const second = buildTrials(city, b.world, b.ziplines, cache, 'test');
    const warm = performance.now() - t1;
    expect(second.map((t) => `${t.id}:${t.checkpoints.length}:${t.medals.join(',')}`)).toEqual(first.map((t) => `${t.id}:${t.checkpoints.length}:${t.medals.join(',')}`));
    expect(warm).toBeLessThan(cold / 3);
  });
});
