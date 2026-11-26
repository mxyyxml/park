import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { Horde, KINDS, type InfKind, type Infected } from '../src/game/Infected';
import { CollisionWorld } from '../src/physics/collision';

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

  it('the city has walkers, runners and mutants', () => {
    const h = fresh();
    for (const k of ['walker', 'runner', 'mutant'] as InfKind[]) expect(h.list.some((z) => z.kind === k)).toBe(true);
  });

  // two roofs 10 m up with a 3 m gap between them, over a street
  const gapWorld = () => { const w = new CollisionWorld(); w.add(-10, 0, -10, 0, 10, 10); w.add(3, 0, -10, 13, 10, 10); w.add(-100, -1, -100, 100, 0, 100); return w; };
  const mk = (kind: InfKind, x: number, y: number, z: number, yaw = 0): Infected => ({ kind, chargeCD: 0, cdx: 0, cdz: 0, hx: x, hy: y, hz: z, x, y, z, vx: 0, vy: 0, vz: 0, yaw, hp: KINDS[kind].hp, state: 'chase', t: 1, gait: 0, speed: KINDS[kind].speed[0], falling: false, seed: 0.5, groanT: 99, wanderYaw: 0, detour: 0, detourT: 0 });

  it('a runner leaps a short gap between roofs to reach you; a walker cannot', () => {
    for (const kind of ['runner', 'walker'] as InfKind[]) {
      const h = new Horde(gapWorld());
      const z = mk(kind, -3, 10, 0, -Math.PI / 2);
      h.list = [z];
      const ev = run(h, 6, { x: 5, y: 10, z: 0, alive: true });
      if (kind === 'runner') { expect(z.x).toBeGreaterThan(3); expect(z.y).toBeCloseTo(10, 0); expect(ev).toContain('hit'); }
      else { expect(z.x).toBeLessThan(0); expect(ev).not.toContain('hit'); }
    }
  });

  it('a mutant charges from a distance and hits hard', () => {
    const w = new CollisionWorld(); w.add(-100, -1, -100, 100, 0, 100);
    const h = new Horde(w);
    const z = mk('mutant', 0, 0, 0, Math.PI); // facing +z
    h.list = [z];
    const hits: number[] = [];
    for (let i = 0; i < 60 * 3; i++) { h.update(1 / 60, { x: 0, y: 0, z: 8, alive: true }); for (const e of h.events) if (e.type === 'hit') hits.push(e.dmg); }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBeGreaterThanOrEqual(30);
  });

  it('a mutant shrugs off a normal kick; only a dropkick staggers it', () => {
    const w = new CollisionWorld(); w.add(-100, -1, -100, 100, 0, 100);
    const h = new Horde(w);
    const z = mk('mutant', 0, 0, -1.2);
    h.list = [z];
    h.kick(0, 0, 0, 0, 8);
    expect(z.state).toBe('chase');
    h.kick(0, 0, 0, 0, 14);
    expect(z.state).toBe('stagger');
    expect(z.hp).toBe(KINDS.mutant.hp - 3);
  });

  describe('runner parkour', () => {
    // street level with a 3 m wall/roof ahead (+x), a 1 m barrier, and a 4 m ledge to drop from
    const parkourWorld = () => {
      const w = new CollisionWorld();
      w.add(-100, -1, -100, 100, 0, 100);   // ground
      w.add(6, 0, -10, 20, 3, 10);          // 3 m block to climb onto
      w.add(-6, 0, 20, -5, 1, 30);          // 1 m barrier across the path at x≈-5.5
      w.add(-30, 0, -40, -10, 4, -25);      // 4 m roof to drop from
      return w;
    };
    const follow = (h: Horde, z: Infected, t: { x: number; y: number; z: number }, secs: number) => {
      const ev: string[] = [];
      for (let i = 0; i < secs * 60; i++) { h.update(1 / 60, { ...t, alive: true }); for (const e of h.events) ev.push(e.type); }
      return ev;
    };
    it('climbs a 3 m wall to reach you on top; a walker cannot', () => {
      for (const kind of ['runner', 'walker'] as InfKind[]) {
        const h = new Horde(parkourWorld()); const z = mk(kind, 2, 0, 0, -Math.PI / 2); h.list = [z];
        follow(h, z, { x: 9, y: 3, z: 0 }, 6);
        if (kind === 'runner') expect(z.y).toBeCloseTo(3, 1);
        else expect(z.y).toBeCloseTo(0, 1);
      }
    });
    it('vaults a 1 m barrier in its way', () => {
      const h = new Horde(parkourWorld()); const z = mk('runner', -2, 0, 25, Math.PI / 2); h.list = [z];
      const ev = follow(h, z, { x: -12, y: 0, z: 25 }, 6);
      expect(z.x).toBeLessThan(-6);
      expect(ev).toContain('hit');
    });
    it('drops off a 4 m roof after you and survives', () => {
      const h = new Horde(parkourWorld()); const z = mk('runner', -15, 4, -30, -Math.PI / 2); h.list = [z];
      const ev = follow(h, z, { x: -4, y: 0, z: -30 }, 6);
      expect(z.state).not.toBe('dead');
      expect(z.y).toBeCloseTo(0, 1);
      expect(ev).toContain('hit');
    });
  });
});
