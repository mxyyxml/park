import { PlayerController, PState } from '../player/PlayerController';
import { Bot } from './Bot';
import type { CollisionWorld } from '../physics/collision';
import { COLS, type CityInfo, type Edge } from '../world/city';
import type { Zipline } from '../player/PlayerController';

export interface Checkpoint { x: number; y: number; z: number; r: number }
export interface TrialDef {
  id: string; name: string; desc: string;
  start: { x: number; y: number; z: number; yaw: number };
  checkpoints: Checkpoint[];
  medals: [number, number, number]; // gold, silver, bronze (seconds)
  length: number;
  buildings: number[];
  /** route polyline used by the autopilot: approach, lip and landing points for every edge */
  wps: { x: number; y: number; z: number; kind?: string; arrive?: number }[];
}

/** Dijkstra over the traversal graph (edge weight = horizontal distance + kind penalty). */
export function route(city: CityInfo, from: number, to: number, avoid: Set<number> = new Set()): Edge[] | null {
  const dist = new Map<number, number>(), prev = new Map<number, Edge>();
  const out = new Map<number, Edge[]>();
  for (const e of city.edges) { if (!out.has(e.a)) out.set(e.a, []); out.get(e.a)!.push(e); }
  dist.set(from, 0);
  const open = new Set([from]);
  const center = (i: number) => { const b = city.buildings[i]; return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]; };
  while (open.size) {
    let cur = -1, best = Infinity;
    for (const n of open) { const d = dist.get(n)!; if (d < best) { best = d; cur = n; } }
    open.delete(cur);
    if (cur === to) break;
    for (const e of out.get(cur) ?? []) {
      if (avoid.has(e.b) && e.b !== to) continue;
      const [ax, az] = center(e.a), [bx, bz] = center(e.b);
      const w = Math.hypot(bx - ax, bz - az) + (e.kind === 'climb' ? 6 : e.kind === 'drop' ? 2 : 0);
      const nd = best + w;
      if (nd < (dist.get(e.b) ?? Infinity)) { dist.set(e.b, nd); prev.set(e.b, e); open.add(e.b); }
    }
  }
  if (!prev.has(to)) return null;
  const path: Edge[] = [];
  let n = to;
  while (n !== from) { const e = prev.get(n)!; path.unshift(e); n = e.a; }
  return path;
}

function surfaceY(world: CollisionWorld, x: number, z: number, fromY: number) {
  const h = world.raycast(x, fromY, z, 0, -1, 0, 12);
  return h ? h.y : fromY - 3;
}

function trialFromPath(city: CityInfo, world: CollisionWorld, id: string, name: string, desc: string, path: Edge[], startFrom?: { x: number; z: number }): TrialDef {
  const B = city.buildings;
  const a0 = B[path[0].a];
  let sx = startFrom ? startFrom.x : (a0.minX + a0.maxX) / 2, sz = startFrom ? startFrom.z : (a0.minZ + a0.maxZ) / 2;
  // start a few metres back from the first edge
  const e0 = path[0];
  const dx = e0.ax - sx, dz = e0.az - sz;
  const L0 = Math.hypot(dx, dz) || 1;
  if (!startFrom && L0 > 10) { sx = e0.ax - dx / L0 * 10; sz = e0.az - dz / L0 * 10; }
  const yaw = Math.atan2(-(e0.ax - sx), -(e0.az - sz));
  const cps: Checkpoint[] = [];
  const wps: TrialDef['wps'] = [];
  let px = sx, pz = sz, length = 0;
  const atrId = city.special.atrium;
  for (let i = 0; i < path.length; i++) {
    const e = path[i];
    const b = B[e.b];
    const a = B[e.a];
    // moving between the atrium's interior floor and its roof: take the stairs
    if (i > 0 && e.a === atrId) {
      const inside = path[i - 1].kind === 'interior', outside = e.kind !== 'interior';
      const st = city.atrium;
      if (inside && outside) wps.push({ x: st.stairBottom.x, y: st.stairBottom.y, z: st.stairBottom.z, arrive: 1.0, kind: 'strict' }, { x: st.stairTop.x, y: st.stairTop.y, z: st.stairTop.z, arrive: 1.2, kind: 'strict' });
      else if (!inside && !outside) wps.push({ x: st.stairTop.x, y: st.stairTop.y, z: st.stairTop.z, arrive: 1.2, kind: 'strict' }, { x: st.stairBottom.x, y: st.stairBottom.y, z: st.stairBottom.z, arrive: 1.2, kind: 'strict' });
    }
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    {
      // approach perpendicular to the edge: direction from lip (a) to landing (b)
      let ux = e.bx - e.ax, uz = e.bz - e.az; const ul = Math.hypot(ux, uz);
      if (ul > 0.3) { ux /= ul; uz /= ul; } else { const acx = (a.minX + a.maxX) / 2, acz = (a.minZ + a.maxZ) / 2; ux = e.ax - acx; uz = e.az - acz; const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l; }
      if (e.kind === 'route') {
        for (const r of city.spireRoute) wps.push({ x: r.x, y: r.y, z: r.z, arrive: 1.1, kind: 'strict' });
      } else if (e.kind === 'zip') {
        wps.push({ x: e.ax - ux * 5, y: a.h, z: e.az - uz * 5 });
        wps.push({ x: e.ax, y: a.h, z: e.az, kind: 'zip', arrive: 0.8 });
        wps.push({ x: e.bx + ux * 3, y: b.h, z: e.bz + uz * 3 });
      } else if (e.kind === 'crane') {
        const jib = city.buildings[e.a].h; void jib;
        wps.push({ x: e.ax, y: a.h, z: e.az - 1.5, arrive: 0.7 });
        wps.push({ x: e.ax, y: a.h, z: e.az + 0.2, arrive: 0.5, kind: 'ladder' });
        wps.push({ x: e.ax + 3, y: b.h + 3, z: e.bz, arrive: 1.2 });
        wps.push({ x: e.bx, y: b.h, z: e.bz });
      } else if (e.kind === 'interior') {
        // through the wall opening at interior floor height
        const fy = city.atrium.floor;
        let nx = 0, nz = 0;
        const bb = e.a === atrId ? a : b;
        if (Math.abs(e.ax - bb.minX) < 0.5) nx = -1; else if (Math.abs(e.ax - bb.maxX) < 0.5) nx = 1; else if (Math.abs(e.az - bb.minZ) < 0.5) nz = -1; else nz = 1;
        const sgn = e.a === atrId ? 1 : -1; // leaving the atrium: move outward
        wps.push({ x: e.ax - nx * sgn * 3, y: fy, z: e.az - nz * sgn * 3, arrive: 1.5 });
        wps.push({ x: e.ax + nx * sgn * 3.5, y: fy, z: e.az + nz * sgn * 3.5, arrive: 1.8 });
      } else {
        const ain = Math.min(6, Math.max(a.maxX - a.minX, a.maxZ - a.minZ) * 0.3);
        wps.push({ x: e.ax - ux * ain, y: a.h, z: e.az - uz * ain, arrive: 1.8 });
        wps.push({ x: e.bx + ux * 2.5, y: b.h, z: e.bz + uz * 2.5, arrive: 2.0 });
      }
    }
    // checkpoint just inside the arrival roof
    // checkpoint on the route: the landing point of this edge
    const lw = wps[wps.length - 1];
    let x = lw.x, z = lw.z;
    void cx; void cz;
    if (e.kind === 'route' && city.spireRoute.length) {
      // spire: checkpoints along the climb
      for (let k = 6; k < city.spireRoute.length - 1; k += 8) {
        const r = city.spireRoute[k];
        cps.push({ x: r.x, y: r.y, z: r.z, r: 2.2 });
      }
      const top = city.spireRoute[city.spireRoute.length - 1];
      x = top.x; z = top.z;
    }
    const y = e.kind === 'interior' && e.b === atrId ? city.atrium.floor : surfaceY(world, x, z, Math.max(b.h, lw.y) + 4);
    length += Math.hypot(x - px, z - pz) + Math.abs(y - (cps.length ? cps[cps.length - 1].y : b.h)) * 1.5;
    px = x; pz = z;
    const last = cps[cps.length - 1];
    if (last && Math.hypot(last.x - x, last.z - z) < 9 && i < path.length - 1) continue;
    cps.push({ x, y, z, r: 3.0 });
  }
  const gold = Math.round(length / 6.4 + 2);
  return {
    id, name, desc, start: { x: sx, y: surfaceY(world, sx, sz, a0.h + 3), z: sz, yaw }, checkpoints: cps,
    medals: [gold, Math.round(gold * 1.25), Math.round(gold * 1.6)], length, buildings: [path[0].a, ...path.map((p) => p.b)], wps,
  };
}

export function buildTrials(city: CityInfo, world: CollisionWorld, ziplines: Zipline[] = []): TrialDef[] {
  const B = city.buildings;
  const trials: TrialDef[] = [];
  const inBlock = (i: number, j: number) => B.filter((b) => b.block === j * COLS + i && b.kind !== 'spire');
  /** buildings in the blocks around building `bi` (its own block and the 4 neighbours) */
  const around = (bi: number) => { const k = B[bi].block, i = k % COLS, j = Math.floor(k / COLS); return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([di, dj]) => inBlock(i + di, j + dj)).map((b) => b.id); };
  // keep a route only if the autopilot can actually run it with the real physics (else try the next one)
  const accept = (t: TrialDef) => { const ok = calibrate(t, world, ziplines) != null; if (ok) trials.push(t); return ok; };
  const farthest = (from: number, cands: number[]) => {
    const f = B[from];
    return cands.map((c) => ({ c, d: Math.hypot((B[c].minX + B[c].maxX) / 2 - (f.minX + f.maxX) / 2, (B[c].minZ + B[c].maxZ) / 2 - (f.minZ + f.maxZ) / 2) }))
      .sort((a, b) => b.d - a.d).map((x) => x.c);
  };
  const tryMake = (id: string, name: string, desc: string, from: number, targets: number[], minLen = 2, startAt?: { x: number; z: number }) => {
    for (const t of targets) {
      if (t === from) continue;
      const p = route(city, from, t);
      if (p && p.length >= minLen && accept(trialFromPath(city, world, id, name, desc, p, startAt))) return true;
    }
    return false;
  };
  const spawnB = city.special.spawn;
  // 1. warm-up inside the starting block
  tryMake('first-light', 'First Light', 'A warm-up across the rooftops of the starting block. Learn to carry speed through gaps.',
    spawnB, farthest(spawnB, inBlock(0, 1).concat(inBlock(1, 1)).map((b) => b.id)), 3, { x: city.spawn.x, z: city.spawn.z });
  // 2. crosstown: west to east across the district
  const E = COLS - 1;
  tryMake('crosstown', 'Crosstown', 'From the west residential blocks to the eastern edge, crossing the streets by bridge and zipline.',
    spawnB, farthest(spawnB, inBlock(E, 1).concat(inBlock(E, 0), inBlock(E, 2), inBlock(E - 1, 1)).map((b) => b.id)), 4, { x: city.spawn.x, z: city.spawn.z });
  // 3. spire ascent
  const spire = city.special.spire;
  for (const spireStart of city.edges.filter((e) => e.kind === 'route' && e.b === spire)) {
    const p = route(city, spawnB, spireStart.a);
    if (p && accept(trialFromPath(city, world, 'spire', 'Spire Ascent', 'Reach the spire and climb its spiral of platforms to the antenna at 78 m.', [...p, spireStart], { x: city.spawn.x, z: city.spawn.z }))) break;
  }
  // 4. crane line
  const crane = city.edges.find((e) => e.kind === 'crane');
  if (crane) {
    const fromB = B[crane.a];
    const start = { x: (fromB.minX + fromB.maxX) / 2, z: (fromB.minZ + fromB.maxZ) / 2 };
    const after = farthest(crane.b, around(crane.b));
    for (const t of [crane.b, ...after].reverse()) {
      const rest = t === crane.b ? [] : route(city, crane.b, t);
      if (rest && accept(trialFromPath(city, world, 'crane', 'Crane Line', 'Climb the construction site, walk the tower-crane jib across the street and drop onto the roofs beyond.', [crane, ...rest], start))) break;
    }
  }
  // 5. industrial
  const ind = inBlock(1, 0).map((b) => b.id);
  if (ind.length > 1) {
    const s = ind[0];
    tryMake('industrial', 'Pipeworks', 'Vault, slide and balance through the industrial block: ducts, pipe racks, cooling towers.', s, farthest(s, ind), 2);
  }
  // 6. the long way: a loop through the atrium interior
  const atr = city.special.atrium;
  const toAtr = route(city, spawnB, atr);
  if (toAtr) {
    const exits = farthest(atr, around(atr)).filter((x) => x !== atr);
    for (const ex of exits) {
      const out = route(city, atr, ex, new Set(toAtr.map((e) => e.a)));
      if (out && out.length >= 1 && accept(trialFromPath(city, world, 'atrium', 'Glass Office', 'Break through the gutted office floor — vault desks, slide under ducts, wall-run the glass partition — and out the far side.', [...toAtr, ...out], { x: city.spawn.x, z: city.spawn.z }))) break;
    }
  }
  return trials;
}

/**
 * Run the autopilot through a trial with the real physics to measure a reference time.
 * Medal targets derive from it (the bot is cautious, so gold asks a human to beat it).
 */
export function calibrate(t: TrialDef, world: CollisionWorld, ziplines: import('../player/PlayerController').Zipline[]): number | null {
  // lazy imports keep this module light for the UI
  const dt = 1 / 120;
  const p = new PlayerController(world);
  p.ziplines = ziplines;
  p.spawn(t.start.x, t.start.y, t.start.z, t.start.yaw);
  const bot = new Bot(world, t.wps);
  let cp = 0, time = 0;
  while (time < 300 && cp < t.checkpoints.length) {
    p.update(dt, bot.step(p, dt));
    time += dt;
    const c = t.checkpoints[cp];
    if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < c.r + 0.5 && Math.abs(p.pos.y - c.y) < 3) cp++;
    if (p.state === PState.Dead || bot.stuckT > 10) return null;
  }
  if (cp < t.checkpoints.length) return null;
  t.medals = [Math.round(time * 0.9), Math.round(time * 1.12), Math.round(time * 1.45)];
  return time;
}
