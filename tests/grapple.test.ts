import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { emptyInput, PlayerController, PState } from '../src/player/PlayerController';

describe('grappling hook', () => {
  const b = new WorldBuilder(false);
  const city = buildCity(b);
  const tall = city.buildings.filter((q) => q.h >= 28 && q.kind !== 'skeleton');
  it('there are tall roofs to grapple to', () => expect(tall.length).toBeGreaterThan(5));
  it('from the street, a grapple to a roof-edge anchor lands you on that roof', () => {
    let tried = 0, made = 0;
    for (const bl of tall) {
      const cx = (bl.minX + bl.maxX) / 2, a = { x: cx, y: bl.h + 1.6, z: bl.minZ - 0.15 };
      const p = new PlayerController(b.world);
      p.anchors = [a];
      const sx = cx, sz = bl.minZ - 8; // on the street in front of that side
      const g = b.world.groundHeight(sx, sz, 3, 6);
      if (!g || g.y > 0.5 || b.world.overlapCylinder(sx, g.y + 0.05, sz, 0.4, 1.7)) continue;
      p.spawn(sx, g.y, sz, Math.PI);
      for (let i = 0; i < 30; i++) p.update(1 / 120, emptyInput());
      const ey = p.pos.y + 1.6, d = Math.hypot(a.x - sx, a.y - ey, a.z - sz);
      const t = p.grappleTarget(sx, ey, sz, (a.x - sx) / d, (a.y - ey) / d, (a.z - sz) / d);
      if (!t) continue; // line of sight blocked from this spot
      tried++;
      p.startGrapple(t);
      for (let i = 0; i < 120 * 6 && !(p.state === PState.Ground && p.pos.y > bl.h - 0.5); i++) {
        const f = emptyInput(); f.moveY = p.state === PState.Grapple ? 0 : 1;
        p.update(1 / 120, f);
      }
      if (p.state === PState.Ground && Math.abs(p.pos.y - bl.h) < 1.2 && p.pos.z > bl.minZ) made++;
    }
    console.log(`grapple: ${made}/${tried} landed on the roof`);
    expect(tried).toBeGreaterThan(3);
    expect(made / tried).toBeGreaterThanOrEqual(0.8);
  });
});
