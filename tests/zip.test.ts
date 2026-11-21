import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { emptyInput, PlayerController, PState } from '../src/player/PlayerController';

describe('ziplines', () => {
  const b = new WorldBuilder(false);
  buildCity(b);
  it('the city has plenty of ziplines', () => expect(b.ziplines.length).toBeGreaterThanOrEqual(6));
  b.ziplines.forEach((z, i) => {
    it(`zipline ${i} can be caught from its roof and ridden to the far roof`, () => {
      const L = Math.hypot(z.bx - z.ax, z.bz - z.az), ux = (z.bx - z.ax) / L, uz = (z.bz - z.az) / L;
      const p = new PlayerController(b.world);
      p.ziplines = b.ziplines;
      p.spawn(z.ax - ux * 3 - uz * 0.6, z.ay - 3.1, z.az - uz * 3 + ux * 0.6, Math.atan2(-ux, -uz)); // beside the post, still under the cable
      let rode = false;
      for (let k = 0; k < 120 * 30; k++) {
        const f = emptyInput();
        f.moveY = p.state === PState.Zip ? 0 : 1;
        const along = (p.pos.x - z.ax) * ux + (p.pos.z - z.az) * uz;
        f.jump = f.jumpPressed = p.state === PState.Ground && along > 0.4 && !rode;
        p.update(1 / 120, f);
        if (p.state === PState.Zip) rode = true;
        if (rode && p.state === PState.Ground) break;
        if (p.state === PState.Dead) break;
      }
      expect(rode).toBe(true);
      expect(p.state).toBe(PState.Ground);
      expect(Math.hypot(p.pos.x - z.bx, p.pos.z - z.bz)).toBeLessThan(8);
      expect(Math.abs(p.pos.y - (z.by - 2.6))).toBeLessThan(1.5);
    });
  });
});
