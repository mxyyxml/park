import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { Horde, type Infected } from '../src/game/Infected';

describe('infected', () => {
  const b = new WorldBuilder(false);
  const city = buildCity(b);
  const spawn = city.spawn;
  const fresh = () => { const h = new Horde(b.world); h.populate(city.buildings, spawn); return h; };
  const run = (h: Horde, secs: number, t: { x: number; y: number; z: number; alive: boolean }) => {
    const ev: string[] = [];
    for (let i = 0; i < secs * 60; i++) { h.update(1 / 60, t); for (const e of h.events) ev.push(e.type); }
    return ev;
  };
  const roofOne = (h: Horde) => h.list.find((z) => z.y > 10)!;
  /** a clear spot on the same roof 4-6 m from the infected */
  const nearSpot = (z: Infected) => {
    for (let a = 0; a < 24; a++) for (const d of [5, 4, 6]) {
      const x = z.x + Math.cos(a / 24 * Math.PI * 2) * d, zz = z.z + Math.sin(a / 24 * Math.PI * 2) * d;
      const g = b.world.groundHeight(x, zz, z.y + 0.45, 0.9);
      if (g && Math.abs(g.y - z.y) < 0.3 && !b.world.overlapCylinder(x, z.y + 0.4, zz, 0.4, 1.25)) return { x, y: z.y, z: zz, alive: true };
    }
    throw new Error('no clear spot');
  };

  it('populates streets and rooftops, away from the spawn', () => {
    const h = fresh();
    expect(h.list.filter((z) => z.y < 1).length).toBeGreaterThan(25);
    expect(h.list.filter((z) => z.y > 10).length).toBeGreaterThan(12);
    for (const z of h.list) expect(Math.hypot(z.x - spawn.x, z.z - spawn.z)).toBeGreaterThan(17);
  });

  it('a rooftop infected chases a runner on its roof and strikes', () => {
    const h = fresh(); const z = roofOne(h);
    h.list = [z];
    const ev = run(h, 8, nearSpot(z));
    expect(ev).toContain('hit');
  });

  it('cannot follow across a gap: a runner on another level is safe', () => {
    const h = fresh(); const z = roofOne(h);
    h.list = [z];
    const ev = run(h, 8, { x: z.x + 4, y: z.y + 6, z: z.z, alive: true });
    expect(ev).not.toContain('hit');
  });

  it('never walks off its roof while chasing', () => {
    const h = fresh();
    const roofers = h.list.filter((q) => q.y > 10);
    const ys = roofers.map((q) => q.y);
    // runner hovering beyond each roof edge at roof height: they come to the edge and stop
    for (const q of roofers) { h.list = [q]; run(h, 10, { x: q.x + 60, y: q.y, z: q.z, alive: true }); }
    roofers.forEach((q, i) => { expect(q.falling).toBe(false); expect(q.y).toBeCloseTo(ys[i], 0); });
  });

  it('a kick staggers, a dropkick floors, and a knock off the roof kills', () => {
    const h = fresh(); const z: Infected = roofOne(h);
    h.list = [z];
    expect(h.kick(z.x, z.y, z.z + 1.2, 0, 8)).toBe(1); // facing -z, infected 1.2 m ahead
    expect(z.state).toBe('stagger');
    z.state = 'chase'; z.hp = 3;
    h.kick(z.x, z.y, z.z + 1.2, 0, 14);
    expect(z.state).toBe('down');
    // shove hard toward the nearest roof edge and let it slide off
    z.state = 'chase'; z.hp = 3;
    const bl = city.buildings.find((q) => z.x >= q.minX && z.x <= q.maxX && z.z >= q.minZ && z.z <= q.maxZ && Math.abs(q.h - z.y) < 1)!;
    const edges = [[z.x - bl.minX, Math.PI / 2], [bl.maxX - z.x, -Math.PI / 2], [z.z - bl.minZ, 0], [bl.maxZ - z.z, Math.PI]] as [number, number][];
    const [, yaw] = edges.sort((a, c) => a[0] - c[0])[0];
    for (let k = 0; k < 20 && !z.falling && (z.state as string) !== 'dead'; k++) {
      z.state = 'chase'; z.hp = 3;
      h.kick(z.x + Math.sin(yaw) * 1.2, z.y, z.z + Math.cos(yaw) * 1.2, yaw, 16);
      run(h, 0.5, { x: 9999, y: 0, z: 9999, alive: false });
    }
    run(h, 4, { x: 9999, y: 0, z: 9999, alive: false });
    expect(z.state).toBe('dead');
  });
});
