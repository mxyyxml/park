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
      let rode = false, entry = 0, top = 0;
      for (let k = 0; k < 120 * 30; k++) {
        const f = emptyInput();
        f.moveY = p.state === PState.Zip ? 0 : 1;
        const along = (p.pos.x - z.ax) * ux + (p.pos.z - z.az) * uz;
        f.jump = f.jumpPressed = p.state === PState.Ground && along > 0.4 && !rode;
        p.update(1 / 120, f);
        if (p.state === PState.Zip) { if (!rode) entry = p.zipSpeed; rode = true; top = Math.max(top, p.zipSpeed); }
        if (rode && p.state === PState.Ground) break;
        if (p.state === PState.Dead) break;
      }
      expect(rode).toBe(true);
      expect(top).toBeGreaterThan(entry + 2.5); // the ride builds speed
      expect(p.state).toBe(PState.Ground);
      expect(Math.hypot(p.pos.x - z.bx, p.pos.z - z.bz)).toBeLessThan(8);
      expect(Math.abs(p.pos.y - (z.by - 2.6))).toBeLessThan(1.5);
    });
  });
  b.ziplines.forEach((z, i) => {
    it(`zipline ${i} also rides backwards, from its low end up to the start roof`, () => {
      const L = Math.hypot(z.bx - z.ax, z.bz - z.az), ux = (z.ax - z.bx) / L, uz = (z.az - z.bz) / L; // pointing back to a
      const p = new PlayerController(b.world);
      p.ziplines = b.ziplines;
      // stand under the cable a few metres from the low post, on clear roof (props can sit near the post)
      const spot = [1.5, 2, 3, 4, 5, 6, 8].map((d) => [z.bx + ux * d, z.bz + uz * d]).find(([x, zz]) => {
        const g = b.world.groundHeight(x, zz, z.by, 3);
        return g && Math.abs(g.y - (z.by - 2.6)) < 0.3 && !b.world.overlapCylinder(x, g.y + 0.05, zz, 0.35, 1.7);
      })!;
      expect(spot).toBeDefined();
      p.spawn(spot[0], z.by - 2.6, spot[1], Math.atan2(-ux, -uz));
      let rode = false, dir = 0;
      for (let k = 0; k < 120 * 40; k++) {
        const f = emptyInput();
        f.moveY = p.state === PState.Zip ? 0 : 1;
        f.moveY = rode && p.state !== PState.Zip ? 1 : 0; // jump straight up for the cable, walk on after landing
        f.jump = f.jumpPressed = p.state === PState.Ground && k > 30 && !rode;
        p.update(1 / 120, f);
        if (p.state === PState.Zip && !rode) { rode = true; dir = p.zipDir; }
        if (rode && p.state === PState.Ground) break;
        if (p.state === PState.Dead) break;
      }
      expect(rode).toBe(true);
      expect(dir).toBe(-1);
      expect(p.state).toBe(PState.Ground);
      expect(Math.hypot(p.pos.x - z.ax, p.pos.z - z.az)).toBeLessThan(8);
    });
  });
});
