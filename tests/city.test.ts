import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';

describe('city generation', () => {
  it('builds deterministically with a connected graph', () => {
    const b = new WorldBuilder(false);
    const t0 = performance.now();
    const c = buildCity(b);
    const ms = performance.now() - t0;
    console.log('buildings', c.buildings.length, 'colliders', b.world.boxes.length, 'edges', c.edges.length,
      'collectibles', c.collectibles.length, 'zips', b.ziplines.length, 'ms', ms.toFixed(0));
    expect(c.buildings.length).toBeGreaterThan(30);
    // spawn is standing room
    expect(b.world.overlapCylinder(c.spawn.x, c.spawn.y + 0.05, c.spawn.z, 0.3, 1.75)).toBe(false);
    // reachability from spawn over the graph
    const adj = new Map<number, number[]>();
    for (const e of c.edges) { if (!adj.has(e.a)) adj.set(e.a, []); adj.get(e.a)!.push(e.b); }
    const seen = new Set([c.special.spawn]); const q = [c.special.spawn];
    while (q.length) { const x = q.shift()!; for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    const district = c.buildings.filter((x) => x.kind !== 'outer');
    // and back to spawn (strong connectivity)
    const radj = new Map<number, number[]>();
    for (const e of c.edges) { if (!radj.has(e.b)) radj.set(e.b, []); radj.get(e.b)!.push(e.a); }
    const back = new Set([c.special.spawn]); const q2 = [c.special.spawn];
    while (q2.length) { const x = q2.shift()!; for (const y of radj.get(x) ?? []) if (!back.has(y)) { back.add(y); q2.push(y); } }
    const kinds: Record<string, number> = {};
    for (const e of c.edges) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log('reachable', seen.size, 'return', back.size, 'of', district.length, kinds);
    expect(seen.size).toBeGreaterThan(district.length * 0.7);
  });
  it('visual build produces geometry', () => {
    const b = new WorldBuilder(true);
    const t0 = performance.now();
    buildCity(b);
    let verts = 0, batches = 0;
    for (const m of [...b.chunks.values(), ...b.farChunks.values()]) for (const g of m.values()) { verts += g.vcount; batches++; }
    console.log('verts', verts, 'batches', batches, 'ms', (performance.now() - t0).toFixed(0));
    expect(verts).toBeGreaterThan(10000);
  });
});
