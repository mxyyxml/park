/**
 * District generator. Deterministic (seeded). Produces colliders + visual batches through
 * WorldBuilder, plus a traversal graph used for time-trial routing and level validation.
 */
import { F, Surface } from '../physics/collision';
import { Building, Frame, Rng, WorldBuilder } from './builder';
import { box, cylinder, beam, GeoBatch, MatKey } from './geo';
import * as P from './props';

export const BLOCK = 46;
export const STREET = 16;
export const COLS = 4;
export const ROWS = 3;
export const X0 = -(COLS * BLOCK + (COLS - 1) * STREET) / 2;
export const Z0 = -(ROWS * BLOCK + (ROWS - 1) * STREET) / 2;

export type BlockKind = 'res' | 'industrial' | 'garden' | 'atrium' | 'spire' | 'construction' | 'campus';
const LAYOUT: BlockKind[][] = [
  ['res', 'industrial', 'res', 'garden'],
  ['res', 'atrium', 'spire', 'res'],
  ['construction', 'res', 'campus', 'industrial'],
];

export interface Edge { a: number; b: number; kind: 'jump' | 'climb' | 'drop' | 'bridge' | 'zip' | 'beam' | 'billboard' | 'crane' | 'interior' | 'route'; ax: number; az: number; bx: number; bz: number }

export interface Collectible { x: number; y: number; z: number; id: number }

export interface CityInfo {
  spawn: { x: number; y: number; z: number; yaw: number };
  buildings: Building[];
  edges: Edge[];
  collectibles: Collectible[];
  blockOf: (bi: number) => [number, number];
  special: Record<string, number>; // named buildings
  spireRoute: { x: number; y: number; z: number }[];
  trainPath: { z: number; y: number; x0: number; x1: number };
  lanes: { x0: number; z0: number; x1: number; z1: number; dir: 'x' | 'z' }[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

interface Lot { minX: number; minZ: number; maxX: number; maxZ: number }

function blockRect(i: number, j: number): Lot {
  const x = X0 + i * (BLOCK + STREET), z = Z0 + j * (BLOCK + STREET);
  return { minX: x, minZ: z, maxX: x + BLOCK, maxZ: z + BLOCK };
}

const STYLE_PARAMS: [number, number][] = [[3.8, 1.5], [3.6, 2.4], [3.4, 2.0], [4.0, 1.25]];

export function buildCity(b: WorldBuilder, seed = 1337): CityInfo {
  const rng = new Rng(seed);
  const R = () => rng.next();
  const edges: Edge[] = [];
  const collectibles: Collectible[] = [];
  const special: Record<string, number> = {};
  const lanes: { b: number; x0: number; z0: number; x1: number; z1: number }[] = [];
  const blockIndex: number[] = [];
  let spireRoute: { x: number; y: number; z: number }[] = [];
  const addCollectible = (x: number, y: number, z: number) => collectibles.push({ x, y, z, id: collectibles.length });

  // ---------------------------------------------------------------- lots per block
  const blockLots: Building[][] = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const kind = LAYOUT[j][i];
    const r = blockRect(i, j);
    const lots: Lot[] = [];
    const split = (l: Lot, depth: number) => {
      const w = l.maxX - l.minX, d = l.maxZ - l.minZ;
      const area = w * d;
      const maxDepth = kind === 'campus' ? 2 : 3;
      if (depth >= maxDepth || area < 260 || Math.max(w, d) < 17) { lots.push(l); return; }
      const alongX = w > d ? true : w < d ? false : R() < 0.5;
      const len = alongX ? w : d;
      const t = 0.4 + R() * 0.2;
      const gapOpts = kind === 'industrial' ? [0, 2.5, 3, 3.5, 4, 6.5] : [0, 2.5, 3, 3.5, 4, 4.5, 5, 7.0];
      let gap = rng.pick(gapOpts);
      if (depth === 0 && gap === 0) gap = 3.5;
      const c = (alongX ? l.minX : l.minZ) + len * t;
      if (alongX) { split({ ...l, maxX: c - gap / 2 }, depth + 1); split({ ...l, minX: c + gap / 2 }, depth + 1); }
      else { split({ ...l, maxZ: c - gap / 2 }, depth + 1); split({ ...l, minZ: c + gap / 2 }, depth + 1); }
    };
    split(r, 0);
    const baseH = kind === 'campus' ? 18 + rng.int(0, 4) : kind === 'garden' ? 22 + rng.int(0, 4) : 24 + rng.int(0, 10);
    const list: Building[] = [];
    for (const l of lots) {
      const dh = rng.pick([-3, -1.5, 0, 0, 1.5, 3]);
      const bl: Building = {
        id: b.buildings.length, ...l, h: Math.max(14, baseH + dh), block: j * COLS + i, kind,
        occ: [], edgeOpen: [false, false, false, false], collider: null,
      };
      b.buildings.push(bl); list.push(bl);
      blockIndex.push(j * COLS + i);
    }
    blockLots.push(list);
  }

  // ---------------------------------------------------------------- neighbour analysis within blocks
  interface Nb { a: Building; b: Building; axis: 'x' | 'z'; gap: number; lo: number; hi: number; aSide: number }
  const neighbours: Nb[] = [];
  for (const list of blockLots) {
    for (const A of list) for (const B of list) {
      if (A.id >= B.id) continue;
      // facing across x
      const ovZ0 = Math.max(A.minZ, B.minZ), ovZ1 = Math.min(A.maxZ, B.maxZ);
      const ovX0 = Math.max(A.minX, B.minX), ovX1 = Math.min(A.maxX, B.maxX);
      if (ovZ1 - ovZ0 >= 3) {
        const g1 = B.minX - A.maxX, g2 = A.minX - B.maxX;
        if (g1 >= -0.01 && g1 <= 8) neighbours.push({ a: A, b: B, axis: 'x', gap: g1, lo: ovZ0, hi: ovZ1, aSide: 1 });
        else if (g2 >= -0.01 && g2 <= 8) neighbours.push({ a: A, b: B, axis: 'x', gap: g2, lo: ovZ0, hi: ovZ1, aSide: -1 });
      }
      if (ovX1 - ovX0 >= 3) {
        const g1 = B.minZ - A.maxZ, g2 = A.minZ - B.maxZ;
        if (g1 >= -0.01 && g1 <= 8) neighbours.push({ a: A, b: B, axis: 'z', gap: g1, lo: ovX0, hi: ovX1, aSide: 1 });
        else if (g2 >= -0.01 && g2 <= 8) neighbours.push({ a: A, b: B, axis: 'z', gap: g2, lo: ovX0, hi: ovX1, aSide: -1 });
      }
    }
  }
  // attached buildings: ensure a readable but climbable height step
  for (const n of neighbours) {
    if (n.gap < 0.5) {
      const d = n.b.h - n.a.h;
      if (Math.abs(d) < 1.5) n.b.h = n.a.h + (d >= 0 ? 2.5 : -2.5);
      if (Math.abs(n.b.h - n.a.h) > 3.5) n.b.h = n.a.h + Math.sign(n.b.h - n.a.h) * 3.5;
    }
  }

  // ---------------------------------------------------------------- special blocks: adjust lots
  const lotsOf = (kind: BlockKind) => blockLots.find((l) => l[0].kind === kind)!;
  const biggest = (l: Building[]) => l.reduce((m, x) => ((x.maxX - x.minX) * (x.maxZ - x.minZ) > (m.maxX - m.minX) * (m.maxZ - m.minZ) ? x : m));
  const spireB = biggest(lotsOf('spire'));
  spireB.kind = 'spire'; spireB.h = 78; special.spire = spireB.id;
  const atriumB = biggest(lotsOf('atrium'));
  atriumB.kind = 'atrium-interior'; special.atrium = atriumB.id;
  const atriumFloor = Math.round(atriumB.h - 5.2);
  const consB = biggest(lotsOf('construction'));
  consB.kind = 'skeleton'; special.skeleton = consB.id;
  consB.h = Math.round(consB.h / 4) * 4;

  // atrium: neighbours across alleys sit at interior floor height so the openings line up
  for (const n of neighbours) {
    if (n.a === atriumB || n.b === atriumB) {
      const other = n.a === atriumB ? n.b : n.a;
      if (n.gap > 0.5 && n.gap <= 4.5) other.h = atriumFloor;
      else if (n.gap <= 0.5) other.h = atriumFloor + 0; // attached: opening straight in
    }
  }

  // ---------------------------------------------------------------- graph edges between neighbours
  const lane = (bl: Building, x: number, z: number) => {
    const cx = (bl.minX + bl.maxX) / 2, cz = (bl.minZ + bl.maxZ) / 2;
    lanes.push({ b: bl.id, x0: cx, z0: cz, x1: x, z1: z });
  };
  const wideGaps: Nb[] = [];
  const aids: { from: Building; to: Building; n: Nb; d: number; fx: number; fz: number; tx: number; tz: number }[] = [];
  for (const n of neighbours) {
    const mid = (n.lo + n.hi) / 2;
    // edge points on each roof
    let ax: number, az: number, bx: number, bz: number;
    if (n.axis === 'x') {
      ax = n.aSide > 0 ? n.a.maxX : n.a.minX; bx = n.aSide > 0 ? n.b.minX : n.b.maxX; az = bz = mid;
      n.a.edgeOpen[n.aSide > 0 ? 1 : 0] = true; n.b.edgeOpen[n.aSide > 0 ? 0 : 1] = true;
    } else {
      az = n.aSide > 0 ? n.a.maxZ : n.a.minZ; bz = n.aSide > 0 ? n.b.minZ : n.b.maxZ; ax = bx = mid;
      n.a.edgeOpen[n.aSide > 0 ? 3 : 2] = true; n.b.edgeOpen[n.aSide > 0 ? 2 : 3] = true;
    }
    lane(n.a, ax, az); lane(n.b, bx, bz);
    const dh = n.b.h - n.a.h;
    if (n.a.kind === 'spire' || n.b.kind === 'spire') continue;
    if (n.gap > 5.2) { wideGaps.push(n); continue; }
    const push = (from: Building, to: Building, d: number, fx: number, fz: number, tx: number, tz: number) => {
      const kind = n.gap < 0.5 ? (d > 0 ? 'climb' : 'drop') : (d > 0.2 ? 'climb' : d < -0.2 ? 'drop' : 'jump');
      // feasibility heuristics (validated by bot tests); add traversal aids where a step is too high
      if (n.gap < 0.5) { if (d > 3.6 || d < -9) return; }
      else if (d > 0) {
        if (d > 1.6 || n.gap > 4.2) { aids.push({ from, to, n, d, fx, fz, tx, tz }); return; }
      }
      else if (d < -9) return;
      edges.push({ a: from.id, b: to.id, kind, ax: fx, az: fz, bx: tx, bz: tz });
    };
    push(n.a, n.b, dh, ax, az, bx, bz);
    push(n.b, n.a, -dh, bx, bz, ax, az);
  }

  // ---------------------------------------------------------------- build buildings
  for (const bl of b.buildings) buildBuilding(b, bl, rng, atriumFloor);

  // traversal aids for high steps across alleys
  for (const a of aids) {
    const dx = Math.sign(a.tx - a.fx), dz = Math.sign(a.tz - a.fz);
    if (a.d <= 2.6 && a.n.gap <= 4.0) {
      // springboard crate on the lower roof, a run-up away from the edge
      const cx = a.fx - dx * 2.6, cz = a.fz - dz * 2.6;
      P.crate(b, cx, a.from.h, cz, 1.1, 0.9);
      b.occupy(a.from, cx - 1, cz - 1, cx + 1, cz + 1);
      a.from.edgeOpen = a.from.edgeOpen; // keep
      edges.push({ a: a.from.id, b: a.to.id, kind: 'climb', ax: a.fx, az: a.fz, bx: a.tx, bz: a.tz });
    } else if (a.n.gap <= 4.2) {
      // climbable pipe on the taller building's face across the alley
      const perp = (a.n.hi - a.n.lo) * 0.25;
      const px = a.tx + (dz !== 0 ? perp : 0), pz = a.tz + (dx !== 0 ? perp : 0);
      P.wallPipe(b, px, pz, -dx, -dz, a.from.h - 3, a.to.h - 0.05);
      edges.push({ a: a.from.id, b: a.to.id, kind: 'climb', ax: a.fx + (dz !== 0 ? perp : 0), az: a.fz + (dx !== 0 ? perp : 0), bx: px, bz: pz });
    }
  }

  // wide alleys: billboards (wall-run) or beams
  let adI = 0;
  for (const n of wideGaps) {
    const mid = (n.lo + n.hi) / 2;
    const hLow = Math.min(n.a.h, n.b.h), hHigh = Math.max(n.a.h, n.b.h);
    const useBoard = Math.abs(n.a.h - n.b.h) < 2.5 && R() < 0.75;
    if (useBoard) {
      // panel along the jump direction, offset from the lane so the runner passes alongside
      const off = 1.3;
      if (n.axis === 'x') {
        const x0 = Math.min(n.a.maxX, n.b.maxX) - (n.aSide > 0 ? 0 : 0);
        const ga = n.aSide > 0 ? n.a.maxX : n.b.maxX, gb = n.aSide > 0 ? n.b.minX : n.a.minX;
        void x0;
        P.billboard(b, ga - 2.2, hLow, mid + off, gb + 2.2, mid + off, -1.2, hHigh - hLow + 4.2, adI++);
      } else {
        const ga = n.aSide > 0 ? n.a.maxZ : n.b.maxZ, gb = n.aSide > 0 ? n.b.minZ : n.a.minZ;
        P.billboard(b, mid + off, hLow, ga - 2.2, mid + off, gb + 2.2, -1.2, hHigh - hLow + 4.2, adI++);
      }
      const e = edges.length;
      void e;
      let ax: number, az: number, bx: number, bz: number;
      if (n.axis === 'x') { ax = n.aSide > 0 ? n.a.maxX : n.a.minX; bx = n.aSide > 0 ? n.b.minX : n.b.maxX; az = bz = mid; }
      else { az = n.aSide > 0 ? n.a.maxZ : n.a.minZ; bz = n.aSide > 0 ? n.b.minZ : n.b.maxZ; ax = bx = mid; }
      if (n.b.h - n.a.h < 1.2) edges.push({ a: n.a.id, b: n.b.id, kind: 'billboard', ax, az, bx, bz });
      if (n.a.h - n.b.h < 1.2) edges.push({ a: n.b.id, b: n.a.id, kind: 'billboard', ax: bx, az: bz, bx: ax, bz: az });
    } else {
      // steel I-beam plank at the lower roof height (balance)
      const y = hLow;
      let x0: number, z0: number, x1: number, z1: number;
      if (n.axis === 'x') {
        const ga = n.aSide > 0 ? n.a.maxX : n.b.maxX, gb = n.aSide > 0 ? n.b.minX : n.a.minX;
        x0 = ga - 0.6; x1 = gb + 0.6; z0 = mid - 0.2; z1 = mid + 0.2;
      } else {
        const ga = n.aSide > 0 ? n.a.maxZ : n.b.maxZ, gb = n.aSide > 0 ? n.b.minZ : n.a.minZ;
        z0 = ga - 0.6; z1 = gb + 0.6; x0 = mid - 0.2; x1 = mid + 0.2;
      }
      b.cbox(x0, y - 0.3, z0, x1, y + 0.02, z1, Surface.Metal, F.BALANCE);
      if (b.visual) {
        const g = b.g('red', (x0 + x1) / 2, (z0 + z1) / 2);
        box(g, x0, y - 0.03, z0, x1, y + 0.02, z1);
        box(g, x0, y - 0.3, z0, x1, y - 0.25, z1);
        if (n.axis === 'x') box(g, x0, y - 0.28, mid - 0.03, x1, y - 0.02, mid + 0.03);
        else box(g, mid - 0.03, y - 0.28, z0, mid + 0.03, y - 0.02, z1);
      }
      let ax: number, az: number, bx: number, bz: number;
      if (n.axis === 'x') { ax = n.aSide > 0 ? n.a.maxX : n.a.minX; bx = n.aSide > 0 ? n.b.minX : n.b.maxX; az = bz = mid; }
      else { az = n.aSide > 0 ? n.a.maxZ : n.a.minZ; bz = n.aSide > 0 ? n.b.minZ : n.b.maxZ; ax = bx = mid; }
      if (n.b.h - n.a.h < 2.0) edges.push({ a: n.a.id, b: n.b.id, kind: 'beam', ax, az, bx, bz });
      if (n.a.h - n.b.h < 2.0) edges.push({ a: n.b.id, b: n.a.id, kind: 'beam', ax: bx, az: bz, bx: ax, bz: az });
    }
  }

  // ---------------------------------------------------------------- street connectors between blocks
  const blockAt = (i: number, j: number) => blockLots[j * COLS + i];
  let zipCount = 0;
  const connect = (A: Building[], B: Building[], axis: 'x' | 'z', allowZip: boolean) => {
    // A is west/north of B. Candidates facing each other across the street
    let best: { a: Building; b: Building; lo: number; hi: number; score: number } | null = null;
    for (const a of A) for (const c of B) {
      if (a.kind === 'spire' || c.kind === 'spire' || a.kind === 'skeleton' || c.kind === 'skeleton') continue;
      const facing = axis === 'x' ? Math.abs(c.minX - a.maxX - STREET) < 0.5 : Math.abs(c.minZ - a.maxZ - STREET) < 0.5;
      if (!facing) continue;
      const lo = axis === 'x' ? Math.max(a.minZ, c.minZ) : Math.max(a.minX, c.minX);
      const hi = axis === 'x' ? Math.min(a.maxZ, c.maxZ) : Math.min(a.maxX, c.maxX);
      if (hi - lo < 5) continue;
      const score = Math.abs(a.h - c.h) * 2 - (hi - lo) * 0.2 + R() * 2;
      if (!best || score < best.score) best = { a, b: c, lo, hi, score };
    }
    if (!best) return;
    const { a, b: c, lo, hi } = best;
    const mid = (lo + hi) / 2;
    const dh = c.h - a.h;
    const useZip = allowZip && Math.abs(dh) >= 4 && zipCount < 4;
    if (useZip) {
      zipCount++;
      const hiB = dh > 0 ? c : a, loB = dh > 0 ? a : c;
      // anchor posts
      let sx: number, sz: number, ex: number, ez: number;
      const sgn = hiB === c ? -1 : 1; // direction from high to low along the axis
      if (axis === 'x') { sx = (hiB === c ? c.minX : a.maxX) - sgn * -2.2; ex = (loB === c ? c.minX : a.maxX) + sgn * 4.5; sz = ez = mid; }
      else { sz = (hiB === c ? c.minZ : a.maxZ) - sgn * -2.2; ez = (loB === c ? c.minZ : a.maxZ) + sgn * 4.5; sx = ex = mid; }
      // correct anchor positions to lie on roofs
      if (axis === 'x') { sx = hiB === c ? c.minX + 2.2 : a.maxX - 2.2; ex = loB === c ? c.minX + 5 : a.maxX - 5; }
      else { sz = hiB === c ? c.minZ + 2.2 : a.maxZ - 2.2; ez = loB === c ? c.minZ + 5 : a.maxZ - 5; }
      const sy = hiB.h + 3.1, ey = loB.h + 2.6;
      b.ziplines.push({ ax: sx, ay: sy, az: sz, bx: ex, by: ey, bz: ez });
      // posts
      for (const [px, py, pz, top] of [[sx, hiB.h, sz, sy], [ex, loB.h, ez, ey]]) {
        b.cbox(px - 0.12, py, pz - 0.12, px + 0.12, top + 0.3, pz + 0.12, Surface.Metal, F.NO_GRAB);
        if (b.visual) {
          const g = b.g('red', px, pz);
          cylinder(g, px, (py + top + 0.3) / 2, pz, 0.1, top + 0.3 - py, 'y', 10);
          box(b.g('metalDark', px, pz), px - 0.5, py, pz - 0.5, px + 0.5, py + 0.15, pz + 0.5, { bevel: 0.03 });
        }
      }
      if (b.visual) beam(b.g('cable', sx, sz), sx, sy, sz, ex, ey, ez, 0.025, 0.025);
      edges.push({ a: hiB.id, b: loB.id, kind: 'zip', ax: sx, az: sz, bx: ex, bz: ez });
      lane(hiB, sx, sz); lane(loB, ex, ez);
      // keep space around posts
      b.occupy(hiB, sx - 1.5, sz - 1.5, sx + 1.5, sz + 1.5);
      b.occupy(loB, ex - 1.5, ez - 1.5, ex + 1.5, ez + 1.5);
      return;
    }
    // sky bridge at the lower roof height
    const y = Math.min(a.h, c.h);
    const hw = 1.6;
    let x0: number, z0: number, x1: number, z1: number;
    if (axis === 'x') { x0 = a.maxX - 0.05; x1 = c.minX + 0.05; z0 = mid - hw; z1 = mid + hw; }
    else { z0 = a.maxZ - 0.05; z1 = c.minZ + 0.05; x0 = mid - hw; x1 = mid + hw; }
    b.cbox(x0, y - 0.5, z0, x1, y, z1, Surface.Metal);
    if (b.visual) {
      b.vbox('concrete', x0, y - 0.5, z0, x1, y - 0.05, z1, { bevel: 0.03 });
      b.vbox('tile', x0, y - 0.05, z0, x1, y, z1);
      // underside truss
      const len = axis === 'x' ? x1 - x0 : z1 - z0;
      const gm = b.g('metalDark', (x0 + x1) / 2, (z0 + z1) / 2);
      for (let t = 0; t <= len; t += 2) {
        if (axis === 'x') { box(gm, x0 + t - 0.06, y - 1.4, z0, x0 + t + 0.06, y - 0.5, z0 + 0.12); box(gm, x0 + t - 0.06, y - 1.4, z1 - 0.12, x0 + t + 0.06, y - 0.5, z1); }
        else { box(gm, x0, y - 1.4, z0 + t - 0.06, x0 + 0.12, y - 0.5, z0 + t + 0.06); box(gm, x1 - 0.12, y - 1.4, z0 + t - 0.06, x1, y - 0.5, z0 + t + 0.06); }
      }
      if (axis === 'x') { box(gm, x0, y - 1.5, z0, x1, y - 1.35, z0 + 0.15); box(gm, x0, y - 1.5, z1 - 0.15, x1, y - 1.35, z1); }
      else { box(gm, x0, y - 1.5, z0, x0 + 0.15, y - 1.35, z1); box(gm, x1 - 0.15, y - 1.5, z0, x1, y - 1.35, z1); }
      // light strips
      if (axis === 'x') { b.vbox('lamp', x0, y - 0.52, z0 + 0.3, x1, y - 0.48, z0 + 0.36); b.vbox('lamp', x0, y - 0.52, z1 - 0.36, x1, y - 0.48, z1 - 0.3); }
      else { b.vbox('lamp', x0 + 0.3, y - 0.52, z0, x0 + 0.36, y - 0.48, z1); b.vbox('lamp', x1 - 0.36, y - 0.52, z0, x1 - 0.3, y - 0.48, z1); }
    }
    if (axis === 'x') { P.railing(b, x0 + 0.2, y, z0 + 0.06, x1 - 0.2, z0 + 0.06, true); P.railing(b, x0 + 0.2, y, z1 - 0.06, x1 - 0.2, z1 - 0.06, true); }
    else { P.railing(b, x0 + 0.06, y, z0 + 0.2, x0 + 0.06, z1 - 0.2, true); P.railing(b, x1 - 0.06, y, z0 + 0.2, x1 - 0.06, z1 - 0.2, true); }
    // remove parapet conflict: the bridge enters through the parapet line; parapets are built with gaps for 'doors'
    const hiB = a.h > c.h ? a : c;
    const lowB = hiB === a ? c : a;
    const d = Math.abs(dh);
    // gap in parapets on both ends
    doors.push({ bl: a, axis, side: 1, lo: mid - hw, hi: mid + hw });
    doors.push({ bl: c, axis, side: -1, lo: mid - hw, hi: mid + hw });
    if (d > 0.3) {
      // taller end: ladder / climbable face up from the bridge deck
      const wallX = axis === 'x' ? (hiB === c ? c.minX : a.maxX) : mid + 0.9;
      const wallZ = axis === 'x' ? mid + 0.9 : (hiB === c ? c.minZ : a.maxZ);
      const nx = axis === 'x' ? (hiB === c ? -1 : 1) : 0, nz = axis === 'z' ? (hiB === c ? -1 : 1) : 0;
      if (d > 1.4) P.wallLadder(b, wallX, wallZ, nx, nz, y, hiB.h);
    }
    const ex = axis === 'x' ? a.maxX : mid, ez = axis === 'x' ? mid : a.maxZ;
    const fx = axis === 'x' ? c.minX : mid, fz = axis === 'x' ? mid : c.minZ;
    edges.push({ a: a.id, b: c.id, kind: 'bridge', ax: ex, az: ez, bx: fx, bz: fz });
    edges.push({ a: c.id, b: a.id, kind: 'bridge', ax: fx, az: fz, bx: ex, bz: ez });
    lane(a, ex, ez); lane(c, fx, fz);
    void lowB;
  };
  const doors: { bl: Building; axis: 'x' | 'z'; side: number; lo: number; hi: number }[] = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    if (i + 1 < COLS) connect(blockAt(i, j), blockAt(i + 1, j), 'x', (i + j) % 2 === 1);
    if (j + 1 < ROWS) connect(blockAt(i, j), blockAt(i, j + 1), 'z', (i + j) % 2 === 0);
  }

  // ---------------------------------------------------------------- set pieces
  spireRoute = buildSpire(b, spireB, rng, edges, neighbours, addCollectible);
  buildAtrium(b, atriumB, atriumFloor, rng, neighbours, edges);
  buildSkeletonAndCrane(b, consB, rng, edges, blockLots, addCollectible);

  // ---------------------------------------------------------------- parapets & roof props
  for (const bl of b.buildings) {
    buildParapets(b, bl, rng, doors.filter((d) => d.bl === bl));
    if (bl.kind === 'spire' || bl.kind === 'skeleton') continue;
    const myLanes = lanes.filter((l) => l.b === bl.id);
    roofProps(b, bl, rng, myLanes, addCollectible);
  }

  // wall pipes & ladders on attached height steps (alternative climb routes)
  for (const n of neighbours) {
    if (n.gap > 0.5 || n.a.kind === 'spire' || n.b.kind === 'spire') continue;
    const hi = n.a.h > n.b.h ? n.a : n.b, lo = hi === n.a ? n.b : n.a;
    if (hi.kind === 'atrium-interior' || lo.kind === 'atrium-interior') continue;
    const mid = (n.lo + n.hi) / 2 + (R() - 0.5) * (n.hi - n.lo) * 0.5;
    if (R() < 0.6) {
      if (n.axis === 'x') {
        const wx = hi === n.a ? (n.aSide > 0 ? hi.maxX : hi.minX) : (n.aSide > 0 ? hi.minX : hi.maxX);
        const nx = Math.sign(((lo.minX + lo.maxX) / 2) - wx);
        P.wallPipe(b, wx, mid, nx, 0, lo.h + 0.2, hi.h - 0.05);
      } else {
        const wz = hi === n.a ? (n.aSide > 0 ? hi.maxZ : hi.minZ) : (n.aSide > 0 ? hi.minZ : hi.maxZ);
        const nz = Math.sign(((lo.minZ + lo.maxZ) / 2) - wz);
        P.wallPipe(b, mid, wz, 0, nz, lo.h + 0.2, hi.h - 0.05);
      }
    }
  }

  // ---------------------------------------------------------------- streets & outer city
  buildStreets(b, rng);
  const trainPath = buildTrain(b);
  buildOuterCity(b, rng);

  // spawn: on the largest roof of the first residential block
  const spawnB = biggest(blockLots[COLS]);
  special.spawn = spawnB.id;
  const sx = (spawnB.minX + spawnB.maxX) / 2, sz = (spawnB.minZ + spawnB.maxZ) / 2;
  const spawn = findFreeSpot(b, spawnB, sx, sz);

  const outLanes = [] as CityInfo['lanes'];
  for (let i = 0; i < COLS - 1; i++) {
    const x = X0 + (i + 1) * BLOCK + i * STREET;
    outLanes.push({ x0: x + 4, z0: -700, x1: x + 4, z1: 700, dir: 'z' }, { x0: x + 12, z0: 700, x1: x + 12, z1: -700, dir: 'z' });
  }
  for (let j = 0; j < ROWS - 1; j++) {
    const z = Z0 + (j + 1) * BLOCK + j * STREET;
    outLanes.push({ x0: -700, z0: z + 4, x1: 700, z1: z + 4, dir: 'x' }, { x0: 700, z0: z + 12, x1: -700, z1: z + 12, dir: 'x' });
  }
  // perimeter streets
  outLanes.push({ x0: X0 - 12, z0: -700, x1: X0 - 12, z1: 700, dir: 'z' }, { x0: -X0 + 12, z0: 700, x1: -X0 + 12, z1: -700, dir: 'z' });
  outLanes.push({ x0: -700, z0: Z0 - 12, x1: 700, z1: Z0 - 12, dir: 'x' }, { x0: 700, z0: -Z0 + 12, x1: -700, z1: -Z0 + 12, dir: 'x' });

  return {
    spawn: { x: spawn[0], y: spawnB.h, z: spawn[1], yaw: Math.PI / 2 },
    buildings: b.buildings,
    edges,
    collectibles,
    blockOf: (bi: number) => { const k = b.buildings[bi].block; return [k % COLS, Math.floor(k / COLS)]; },
    special,
    spireRoute,
    trainPath,
    lanes: outLanes,
    bounds: { minX: X0, maxX: -X0, minZ: Z0, maxZ: -Z0 },
  };
}

export function findFreeSpot(b: WorldBuilder, bl: Building, x: number, z: number): [number, number] {
  for (let r = 0; r < 20; r += 0.5) {
    for (let a = 0; a < 8; a++) {
      const px = x + Math.cos(a * Math.PI / 4) * r, pz = z + Math.sin(a * Math.PI / 4) * r;
      if (px < bl.minX + 1 || px > bl.maxX - 1 || pz < bl.minZ + 1 || pz > bl.maxZ - 1) continue;
      if (!b.world.overlapCylinder(px, bl.h + 0.05, pz, 0.6, 1.8)) return [px, pz];
    }
  }
  return [x, z];
}

// =====================================================================================================
function facadeFor(kind: string, rng: Rng): number {
  if (kind === 'campus') return 0;
  if (kind === 'industrial') return rng.pick([2, 2, 1]);
  if (kind === 'garden') return rng.pick([1, 3, 2]);
  return rng.pick([0, 1, 2, 3, 1, 0]);
}

function buildBuilding(b: WorldBuilder, bl: Building, rng: Rng, atriumFloor: number) {
  const { minX, minZ, maxX, maxZ } = bl;
  const h = bl.h;
  const surface = bl.kind === 'garden' ? Surface.Grass : bl.kind === 'industrial' ? Surface.Metal : rng.pick([Surface.Gravel, Surface.Concrete, Surface.Rubber]);
  if (bl.kind === 'spire' || bl.kind === 'skeleton') {
    // spire collider built in its own function; skeleton too
    if (bl.kind === 'spire') bl.collider = b.cbox(minX, 0, minZ, maxX, h, maxZ, Surface.Concrete);
  } else if (bl.kind === 'atrium-interior') {
    bl.collider = b.cbox(minX, 0, minZ, maxX, atriumFloor, maxZ, Surface.Concrete);
  } else bl.collider = b.cbox(minX, 0, minZ, maxX, h, maxZ, surface);
  if (!b.visual) return;
  const style = facadeFor(bl.kind, rng);
  const [fh, cw] = STYLE_PARAMS[style];
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const g = b.g('facade', cx, cz);
  g.facadeCur = [style, rng.int(0, 400), fh + rng.range(-0.1, 0.2), cw];
  const topY = bl.kind === 'atrium-interior' ? atriumFloor - 0.4 : bl.kind === 'skeleton' ? 8 : h - 0.7;
  box(g, minX, 0, minZ, maxX, topY, maxZ, { skip: 4 | 8 });
  // podium / lobby band
  b.vbox('concreteDark', minX - 0.25, 0, minZ - 0.25, maxX + 0.25, 4.6, maxZ + 0.25, { bevel: 0.05, skip: 4 });
  b.vbox('concrete', minX - 0.35, 4.6, minZ - 0.35, maxX + 0.35, 5.0, maxZ + 0.35, { bevel: 0.05 });
  // corner pilasters for non-glass styles
  if (style !== 0 && bl.kind !== 'skeleton') {
    const t = 0.45;
    for (const [px, pz] of [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]) {
      b.vbox('concrete', px - t / 2 - 0.05, 5, pz - t / 2 - 0.05, px + t / 2 + 0.05, topY, pz + t / 2 + 0.05, { bevel: 0.04, skip: 4 | 8 });
    }
  }
  if (bl.kind === 'skeleton') return;
  if (bl.kind === 'atrium-interior') return;
  // cornice + roof slab
  const gc = b.g('concrete', cx, cz);
  gc.colCur = [1, 1, 1];
  box(gc, minX - 0.08, h - 0.7, minZ - 0.08, maxX + 0.08, h, maxZ + 0.08, { bevel: 0.05, skip: 4 });
  const roofMat: MatKey = surface === Surface.Gravel ? 'gravel' : surface === Surface.Grass ? 'grass' : surface === Surface.Metal ? 'roof' : surface === Surface.Rubber ? 'roof' : 'concreteWarm';
  b.vbox(roofMat, minX + 0.35, h, minZ + 0.35, maxX - 0.35, h + 0.015, maxZ - 0.35);
}

function buildParapets(b: WorldBuilder, bl: Building, rng: Rng, doors: { axis: 'x' | 'z'; side: number; lo: number; hi: number }[]) {
  if (bl.kind === 'skeleton' || bl.kind === 'spire') return;
  const h = bl.h;
  const type = bl.kind === 'campus' ? 'glass' : rng.pick(['wall', 'wall', 'glass', 'metal']);
  const ph = type === 'wall' ? 1.0 : 1.1;
  const t = 0.3;
  const edges: [number, number, number, number, 'x' | 'z', number][] = [
    // x0,z0,x1,z1, axis(normal), side
    [bl.minX, bl.minZ, bl.minX, bl.maxZ, 'x', -1],
    [bl.maxX, bl.minZ, bl.maxX, bl.maxZ, 'x', 1],
    [bl.minX, bl.minZ, bl.maxX, bl.minZ, 'z', -1],
    [bl.minX, bl.maxZ, bl.maxX, bl.maxZ, 'z', 1],
  ];
  edges.forEach(([x0, z0, x1, z1, ax, side], k) => {
    const open = bl.edgeOpen[k];
    // segments with door gaps
    const lo0 = ax === 'x' ? z0 : x0, hi0 = ax === 'x' ? z1 : x1;
    const gaps = doors.filter((d) => d.axis === ax && d.side === side).map((d) => [d.lo, d.hi]).sort((a, c) => a[0] - c[0]);
    const segs: [number, number][] = [];
    let cur = lo0;
    for (const [glo, ghi] of gaps) { if (glo > cur) segs.push([cur, glo]); cur = Math.max(cur, ghi); }
    if (cur < hi0) segs.push([cur, hi0]);
    for (const [lo, hi] of segs) {
      if (hi - lo < 0.2) continue;
      if (open) {
        // low lip only (auto step height)
        if (ax === 'x') { const xa = side < 0 ? x0 : x0 - 0.25; b.solid('concrete', xa, h, lo, xa + 0.25, h + 0.18, hi, Surface.Concrete, 0, { bevel: 0.03 }); }
        else { const za = side < 0 ? z0 : z0 - 0.25; b.solid('concrete', lo, h, za, hi, h + 0.18, za + 0.25, Surface.Concrete, 0, { bevel: 0.03 }); }
        continue;
      }
      if (type === 'wall') {
        if (ax === 'x') { const xa = side < 0 ? x0 : x0 - t; b.solid('concrete', xa, h, lo, xa + t, h + ph, hi, Surface.Concrete, 0, { bevel: 0.04 }); b.vbox('metal', xa - 0.02, h + ph, lo, xa + t + 0.02, h + ph + 0.04, hi); }
        else { const za = side < 0 ? z0 : z0 - t; b.solid('concrete', lo, h, za, hi, h + ph, za + t, Surface.Concrete, 0, { bevel: 0.04 }); b.vbox('metal', lo, h + ph, za - 0.02, hi, h + ph + 0.04, za + t + 0.02); }
      } else {
        if (ax === 'x') { const xa = side < 0 ? x0 + 0.15 : x0 - 0.15; P.railing(b, xa, h, lo, xa, hi, type === 'glass'); }
        else { const za = side < 0 ? z0 + 0.15 : z0 - 0.15; P.railing(b, lo, h, za, hi, za, type === 'glass'); }
      }
    }
  });
}

function nearLane(lanes: { x0: number; z0: number; x1: number; z1: number }[], minX: number, minZ: number, maxX: number, maxZ: number, w = 1.6) {
  for (const l of lanes) {
    const L = Math.hypot(l.x1 - l.x0, l.z1 - l.z0);
    const n = Math.max(1, Math.ceil(L / 0.8));
    for (let i = 0; i <= n; i++) {
      const px = l.x0 + (l.x1 - l.x0) * i / n, pz = l.z0 + (l.z1 - l.z0) * i / n;
      const cx = Math.max(minX, Math.min(px, maxX)), cz = Math.max(minZ, Math.min(pz, maxZ));
      if ((px - cx) ** 2 + (pz - cz) ** 2 < w * w) return true;
    }
  }
  return false;
}

function roofProps(b: WorldBuilder, bl: Building, rng: Rng, lanes: { x0: number; z0: number; x1: number; z1: number }[], addCollectible: (x: number, y: number, z: number) => void) {
  const y = bl.h;
  const R = () => rng.next();
  const w = bl.maxX - bl.minX, d = bl.maxZ - bl.minZ;
  const area = w * d;
  const tryPlace = (pw: number, pd: number, tall: boolean, place: (x: number, z: number) => void, attempts = 14) => {
    for (let k = 0; k < attempts; k++) {
      const x = bl.minX + 1.4 + pw / 2 + R() * Math.max(0, w - 2.8 - pw);
      const z = bl.minZ + 1.4 + pd / 2 + R() * Math.max(0, d - 2.8 - pd);
      const r = [x - pw / 2, z - pd / 2, x + pw / 2, z + pd / 2] as const;
      if (!b.free(bl, r[0], r[1], r[2], r[3], 0.9)) continue;
      if (tall && nearLane(lanes, r[0], r[1], r[2], r[3])) continue;
      b.occupy(bl, r[0], r[1], r[2], r[3]);
      place(x, z);
      return true;
    }
    return false;
  };
  const fr = (x: number, z: number) => new Frame(x, y, z, rng.int(0, 3));
  if (bl.kind === 'garden') {
    const n = Math.floor(area / 60);
    for (let i = 0; i < n; i++) tryPlace(2.2, 2.2, true, (x, z) => P.planter(b, x - 1.1, y, z - 1.1, x + 1.1, z + 1.1, R, true));
    for (let i = 0; i < n; i++) tryPlace(3.5, 1.2, false, (x, z) => P.planter(b, x - 1.75, y, z - 0.6, x + 1.75, z + 0.6, R, false));
    for (let i = 0; i < n / 2; i++) tryPlace(1.8, 0.6, false, (x, z) => P.bench(b, new Frame(x, y, z, rng.pick([0, 2]))));
    // wooden deck area
    tryPlace(6, 5, false, (x, z) => { b.vbox('wood', x - 3, y, z - 2.5, x + 3, y + 0.06, z + 2.5); });
    return;
  }
  if (bl.kind === 'industrial') {
    tryPlace(3.2, 3.2, true, (x, z) => P.coolingFan(b, x, y, z, 1.4));
    tryPlace(3, 3, true, (x, z) => P.waterTank(b, x, y, z, 1.25, 2.6));
    tryPlace(1.2, 1.2, true, (x, z) => P.chimney(b, x, y, z, 4 + R() * 4, 0.45));
    for (let i = 0; i < 2; i++) {
      const alongX = R() < 0.5;
      const L = 5 + R() * 6;
      tryPlace(alongX ? L : 1.0, alongX ? 1.0 : L, false, (x, z) => alongX ? P.pipeRun(b, x - L / 2, y, z - 0.5, x + L / 2, z + 0.5) : P.pipeRun(b, x - 0.5, y, z - L / 2, x + 0.5, z + L / 2));
    }
    const alongX = R() < 0.5, L = 6 + R() * 5;
    tryPlace(alongX ? L : 1.1, alongX ? 1.1 : L, false, (x, z) => alongX ? P.duct(b, x - L / 2, y, z - 0.55, x + L / 2, z + 0.55) : P.duct(b, x - 0.55, y, z - L / 2, x + 0.55, z + L / 2));
    for (let i = 0; i < 3; i++) tryPlace(2.0, 1.5, false, (x, z) => P.acUnit(b, fr(x, z)));
    return;
  }
  // residential / campus
  if (area > 220) tryPlace(4.5, 4.5, true, (x, z) => { P.stairHouse(b, fr(x, z)); addCollectibleMaybe(x, y + 2.9 + 1.0, z); });
  const nAC = Math.floor(area / 110) + rng.int(0, 2);
  for (let i = 0; i < nAC; i++) {
    if (R() < 0.5) tryPlace(2.0, 1.5, false, (x, z) => P.acUnit(b, fr(x, z)));
    else tryPlace(4.2, 1.5, false, (x, z) => { const f = new Frame(x, y, z, rng.pick([0, 1])); P.acUnit(b, new Frame(...((): [number, number, number, number] => { const [a, c] = f.p(-1.0, 0); return [a, y, c, f.r]; })())); P.acUnit(b, new Frame(...((): [number, number, number, number] => { const [a, c] = f.p(1.0, 0); return [a, y, c, f.r]; })())); });
  }
  for (let i = 0; i < 3; i++) tryPlace(0.8, 0.8, false, (x, z) => (R() < 0.5 ? P.ventStack(b, x, y, z, 0.18 + R() * 0.1, 0.9 + R() * 0.8) : P.mushroomVent(b, x, y, z)));
  if (bl.kind === 'campus' || R() < 0.35) {
    const sw = 3 + R() * 3, sd = 2 + R() * 2;
    tryPlace(sw, sd, false, (x, z) => P.skylight(b, x - sw / 2, y, z - sd / 2, x + sw / 2, z + sd / 2));
  }
  if (R() < 0.3 && area > 300) {
    const sw = 6 + R() * 4, sd = 4.0;
    tryPlace(sw, sd, false, (x, z) => P.solarArray(b, x - sw / 2, y, z - sd / 2, x + sw / 2, z + sd / 2));
  }
  if (R() < 0.3) tryPlace(3, 3, true, (x, z) => P.waterTank(b, x, y, z, 1.2, 2.4));
  if (R() < 0.35) tryPlace(1.5, 1.5, true, (x, z) => P.antenna(b, x, y, z, 4 + R() * 6));
  if (R() < 0.25) tryPlace(1.4, 1.4, true, (x, z) => P.dish(b, x, y, z, 0.7));
  if (R() < 0.2 && area > 350) tryPlace(10, 10, false, (x, z) => P.helipad(b, x, y + 0.02, z, 4.6));
  if (R() < 0.25) {
    const alongX = R() < 0.5, L = 5 + R() * 5;
    tryPlace(alongX ? L : 1.0, alongX ? 1.0 : L, false, (x, z) => alongX ? P.pipeRun(b, x - L / 2, y, z - 0.45, x + L / 2, z + 0.45) : P.pipeRun(b, x - 0.45, y, z - L / 2, x + 0.45, z + L / 2));
  }
  function addCollectibleMaybe(x: number, yy: number, z: number) { if (R() < 0.45) addCollectible(x, yy, z); }
}

// =====================================================================================================
function buildSpire(b: WorldBuilder, bl: Building, rng: Rng, edges: { a: number; b: number; kind: Edge['kind']; ax: number; az: number; bx: number; bz: number }[],
                    neighbours: { a: Building; b: Building; gap: number }[], addCollectible: (x: number, y: number, z: number) => void) {
  // tower occupies the lot; a spiral of cantilevered platforms climbs around it.
  const { minX, minZ, maxX, maxZ } = bl;
  const route: { x: number; y: number; z: number }[] = [];
  // start height: the lowest neighbour roof
  const nbs = neighbours.filter((n) => n.a === bl || n.b === bl).map((n) => (n.a === bl ? n.b : n.a));
  const startB = nbs.length ? nbs.reduce((m, x) => (x.h < m.h ? x : m)) : null;
  let y = (startB ? startB.h : 26) + 1.3;
  // perimeter param
  const W = maxX - minX, D = maxZ - minZ;
  const per = 2 * (W + D);
  // start on the side facing the start neighbour
  let s = 0;
  if (startB) {
    const scx = (startB.minX + startB.maxX) / 2, scz = (startB.minZ + startB.maxZ) / 2;
    if (startB.maxZ <= minZ + 0.1) s = W / 2;           // north side (−z): along top edge
    else if (startB.minX >= maxX - 0.1) s = W + D / 2;  // east
    else if (startB.minZ >= maxZ - 0.1) s = W + D + W / 2; // south
    else s = W + D + W + D / 2;                          // west
    void scx; void scz;
  }
  const point = (t: number): [number, number, number, number] => {
    t = ((t % per) + per) % per;
    if (t < W) return [minX + t, minZ, 0, -1];
    t -= W; if (t < D) return [maxX, minZ + t, 1, 0];
    t -= D; if (t < W) return [maxX - t, maxZ, 0, 1];
    t -= W; return [minX, maxZ - t, -1, 0];
  };
  const pw = 2.6, depth = 2.5;
  let i = 0;
  while (y < bl.h - 1.0) {
    let [px, pz, nx, nz] = point(s);
    // keep platforms off corners
    const corner = (t: number) => { const tt = ((t % per) + per) % per; const cs = [0, W, W + D, 2 * W + D, per]; return cs.some((c) => Math.abs(tt - c) < pw * 0.75); };
    if (corner(s)) { s += pw * 0.8; [px, pz, nx, nz] = point(s); }
    // platform box
    const tx = -nz, tz = nx; // tangent
    const x0 = Math.min(px + nx * depth - tx * pw / 2, px - tx * pw / 2), x1 = Math.max(px + nx * depth + tx * pw / 2, px + tx * pw / 2);
    const z0 = Math.min(pz + nz * depth - tz * pw / 2, pz - tz * pw / 2), z1 = Math.max(pz + nz * depth + tz * pw / 2, pz + tz * pw / 2);
    // skip spots that would intersect neighbouring buildings
    const blocked = b.world.query(x0, z0, x1, z1, y - 0.35, y + 2.2).some((o) => o !== bl.collider &&
      o.minX < x1 && o.maxX > x0 && o.minZ < z1 && o.maxZ > z0 && o.minY < y + 2.2 && o.maxY > y - 0.35);
    if (blocked) { s += pw * 0.6; continue; }
    b.solid(i % 5 === 4 ? 'red' : 'concrete', x0, y - 0.35, z0, x1, y, z1, Surface.Concrete, 0, { bevel: 0.04 });
    if (b.visual) {
      // brackets underneath
      const g = b.g('metalDark', px, pz);
      beam(g, px + nx * depth * 0.9, y - 0.35, pz + nz * depth * 0.9, px, y - 1.6, pz, 0.12, 0.12);
      b.vbox('lamp', Math.min(px, px + nx * 0.15) - Math.abs(tx) * 0.8, y - 0.4, Math.min(pz, pz + nz * 0.15) - Math.abs(tz) * 0.8,
        Math.max(px, px + nx * 0.15) + Math.abs(tx) * 0.8, y - 0.36, Math.max(pz, pz + nz * 0.15) + Math.abs(tz) * 0.8);
    }
    route.push({ x: px + nx * depth / 2, y, z: pz + nz * depth / 2 });
    if (i % 7 === 6) addCollectible(px + nx * depth / 2, y + 1.2, pz + nz * depth / 2);
    i++;
    y += 1.45;
    s += pw + 0.9;
  }
  // tower top
  const h = bl.h;
  b.solid('concrete', minX - 0.1, h - 0.8, minZ - 0.1, maxX + 0.1, h, maxZ + 0.1, Surface.Concrete, 0, { bevel: 0.06 });
  // tower top parapet (glass) except where the route arrives
  P.antenna(b, (minX + maxX) / 2, h, (minZ + maxZ) / 2, 18);
  b.vbox('roof', minX + 0.4, h, minZ + 0.4, maxX - 0.4, h + 0.015, maxZ - 0.4);
  addCollectible((minX + maxX) / 2 + 3, h + 1.2, (minZ + maxZ) / 2 + 3);
  route.push({ x: (minX + maxX) / 2 + 2, y: h, z: (minZ + maxZ) / 2 - 2 });
  if (startB) edges.push({ a: startB.id, b: bl.id, kind: 'route', ax: route[0].x, az: route[0].z, bx: route[route.length - 1].x, bz: route[route.length - 1].z });
  void rng;
  return route;
}

function buildAtrium(b: WorldBuilder, bl: Building, floorY: number, rng: Rng, neighbours: { a: Building; b: Building; gap: number; axis: 'x' | 'z'; lo: number; hi: number; aSide: number }[],
                     edges: Edge[]) {
  const { minX, minZ, maxX, maxZ } = bl;
  const h = bl.h, ceil = h - 0.5;
  const R = () => rng.next();
  // floor surface
  b.vbox('interiorFloor', minX, floorY - 0.4, minZ, maxX, floorY, maxZ);
  // roof slab with a stair hole
  const holeX0 = minX + 2, holeX1 = minX + 4.5, holeZ0 = minZ + 3, holeZ1 = minZ + 3 + 7.5;
  const slab = (x0: number, z0: number, x1: number, z1: number) => {
    if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
    b.solid('concrete', x0, ceil, z0, x1, h, z1, Surface.Gravel, 0, { bevel: 0.03 });
    b.vbox('gravel', x0 + 0.02, h, z0 + 0.02, x1 - 0.02, h + 0.015, z1 - 0.02);
  };
  slab(minX - 0.1, minZ - 0.1, maxX + 0.1, holeZ0);
  slab(minX - 0.1, holeZ1, maxX + 0.1, maxZ + 0.1);
  slab(minX - 0.1, holeZ0, holeX0, holeZ1);
  slab(holeX1, holeZ0, maxX + 0.1, holeZ1);
  b.vbox('interiorWall', minX + 0.02, ceil - 0.02, minZ + 0.02, maxX - 0.02, ceil, maxZ - 0.02); // ceiling finish
  // stairs up to the roof through the hole (rise 0.38 each)
  const steps = Math.ceil((h - floorY) / 0.38);
  for (let k = 0; k < steps; k++) {
    const sy = floorY + (k + 1) * (h - floorY) / steps;
    const z0 = holeZ1 - (k + 1) * (7.0 / steps) - 0.25;
    b.solid('concreteDark', holeX0 + 0.05, floorY, z0, holeX1 - 0.05, sy, z0 + 7.0 / steps + 0.01, Surface.Concrete, 0, { bevel: 0.01 });
  }
  P.railing(b, holeX1 + 0.05, floorY, holeZ0, holeX1 + 0.05, holeZ1, false);
  // perimeter walls with openings facing neighbours
  const openings: { side: number; lo: number; hi: number }[] = [];
  for (const n of neighbours) {
    if (n.a !== bl && n.b !== bl) continue;
    const other = n.a === bl ? n.b : n.a;
    if (Math.abs(other.h - floorY) > 0.6) continue;
    const mid = (n.lo + n.hi) / 2;
    const sideIdx = n.axis === 'x' ? ((n.a === bl) === (n.aSide > 0) ? 1 : 0) : ((n.a === bl) === (n.aSide > 0) ? 3 : 2);
    openings.push({ side: sideIdx, lo: mid - 1.8, hi: mid + 1.8 });
    // graph: neighbour <-> atrium through the opening
    const px = n.axis === 'x' ? (sideIdx === 1 ? maxX : minX) : mid, pz = n.axis === 'z' ? (sideIdx === 3 ? maxZ : minZ) : mid;
    edges.push({ a: other.id, b: bl.id, kind: 'interior', ax: px, az: pz, bx: px, bz: pz });
    edges.push({ a: bl.id, b: other.id, kind: 'interior', ax: px, az: pz, bx: px, bz: pz });
  }
  const sides: [number, number, number, number, 'x' | 'z'][] = [
    [minX, minZ, minX, maxZ, 'z'], [maxX, minZ, maxX, maxZ, 'z'], [minX, minZ, maxX, minZ, 'x'], [minX, maxZ, maxX, maxZ, 'x'],
  ];
  const doorTop = floorY + 3.3;
  sides.forEach(([x0, z0, x1, z1, ax], k) => {
    const lo0 = ax === 'x' ? x0 : z0, hi0 = ax === 'x' ? x1 : z1;
    const ops = openings.filter((o) => o.side === k).sort((a, c) => a.lo - c.lo);
    const segs: [number, number, boolean][] = [];
    let cur = lo0;
    for (const o of ops) { if (o.lo > cur) segs.push([cur, o.lo, true]); segs.push([o.lo, o.hi, false]); cur = o.hi; }
    if (cur < hi0) segs.push([cur, hi0, true]);
    for (const [lo, hi, solid] of segs) {
      const t = 0.2;
      const yTop = solid ? ceil : ceil;
      const yBot = solid ? floorY : doorTop;
      const bx0 = ax === 'x' ? lo : (k === 0 ? x0 : x0 - t), bx1 = ax === 'x' ? hi : (k === 0 ? x0 + t : x0);
      const bz0 = ax === 'z' ? lo : (k === 2 ? z0 : z0 - t), bz1 = ax === 'z' ? hi : (k === 2 ? z0 + t : z0);
      b.cbox(bx0, yBot, bz0, bx1, yTop, bz1, Surface.Glass, F.NO_WALLRUN);
      if (b.visual) {
        if (solid) {
          b.vbox('glass', bx0, floorY, bz0, bx1, ceil, bz1);
          // mullions
          const g = b.g('metalDark', (bx0 + bx1) / 2, (bz0 + bz1) / 2);
          for (let p = lo; p <= hi; p += 1.6) {
            if (ax === 'x') box(g, p - 0.04, floorY, bz0 - 0.03, p + 0.04, ceil, bz1 + 0.03);
            else box(g, bx0 - 0.03, floorY, p - 0.04, bx1 + 0.03, ceil, p + 0.04);
          }
          b.vbox('metalDark', bx0 - 0.03, floorY, bz0 - 0.03, bx1 + 0.03, floorY + 0.12, bz1 + 0.03);
        } else {
          b.vbox('concrete', bx0, doorTop, bz0, bx1, ceil, bz1, { bevel: 0.02 });
          b.vbox('red', bx0 - 0.02, doorTop - 0.06, bz0 - 0.02, bx1 + 0.02, doorTop, bz1 + 0.02);
        }
      }
    }
  });
  // exterior band and roof cornice
  b.vbox('concrete', minX - 0.1, floorY - 0.6, minZ - 0.1, maxX + 0.1, floorY, maxZ + 0.1, { bevel: 0.04 });
  // interior content: columns, desks, partitions, a low duct to slide under
  const W = maxX - minX, D = maxZ - minZ;
  for (let x = minX + 6; x < maxX - 3; x += 7) for (let z = minZ + 6; z < maxZ - 3; z += 7) {
    if (x < holeX1 + 1.5 && z < holeZ1 + 1 && z > holeZ0 - 2) continue;
    b.solid('concrete', x - 0.3, floorY, z - 0.3, x + 0.3, ceil, z + 0.3, Surface.Concrete, F.NO_GRAB, { bevel: 0.03 });
  }
  // desk rows (0.75 m: vaultable)
  for (let z = minZ + 4; z < maxZ - 4; z += 4.5) {
    for (let x = minX + 7; x < maxX - 5; x += 6.5) {
      if (R() < 0.25) continue;
      if (x < holeX1 + 2 && z < holeZ1 + 1.5) continue;
      const x0 = x, x1 = x + 3.2, z0 = z, z1 = z + 1.4;
      if (b.world.overlapCylinder((x0 + x1) / 2, floorY + 0.1, (z0 + z1) / 2, 2, 2)) continue;
      b.cbox(x0, floorY, z0, x1, floorY + 0.76, z1, Surface.Wood);
      if (b.visual) {
        b.vbox('interiorWall', x0, floorY + 0.72, z0, x1, floorY + 0.76, z1, { bevel: 0.01 });
        b.vbox('metalDark', x0 + 0.05, floorY, z0 + 0.05, x0 + 0.1, floorY + 0.72, z1 - 0.05);
        b.vbox('metalDark', x1 - 0.1, floorY, z0 + 0.05, x1 - 0.05, floorY + 0.72, z1 - 0.05);
        b.vbox('glassDark', x0 + 0.4, floorY + 0.76, z0 + 0.5, x0 + 0.9, floorY + 1.1, z0 + 0.53);
        b.vbox('glassDark', x1 - 0.9, floorY + 0.76, z1 - 0.53, x1 - 0.4, floorY + 1.1, z1 - 0.5);
        b.vbox('red', x0 + 1.4, floorY + 0.76, z0 + 0.2, x0 + 1.7, floorY + 0.9, z0 + 0.5);
      }
    }
  }
  // glass partition (wall-runnable) running across the room
  const pz = minZ + D * 0.55;
  b.solid('glass', minX + W * 0.35, floorY, pz - 0.04, minX + W * 0.75, floorY + 2.6, pz + 0.04, Surface.Glass);
  b.vbox('metalDark', minX + W * 0.35, floorY + 2.6, pz - 0.05, minX + W * 0.75, floorY + 2.66, pz + 0.05);
  // slide-under duct
  const dz = minZ + D * 0.3;
  b.solid('metal', minX + W * 0.45, floorY + 1.15, dz - 0.5, maxX - 1, ceil, dz + 0.5, Surface.Metal, F.NO_GRAB);
  // ceiling lights + point lights
  for (let x = minX + 4; x < maxX - 2; x += 6) for (let z = minZ + 4; z < maxZ - 2; z += 6) {
    b.vbox('lamp', x - 1.2, ceil - 0.06, z - 0.2, x + 1.2, ceil - 0.02, z + 0.2);
  }
  b.lights.push({ x: minX + W * 0.3, y: ceil - 0.6, z: minZ + D * 0.5, color: 0xfff1e0, intensity: 30, distance: 22 });
  b.lights.push({ x: minX + W * 0.75, y: ceil - 0.6, z: minZ + D * 0.5, color: 0xfff1e0, intensity: 30, distance: 22 });
  // lower facade to podium is built by buildBuilding (atrium variant)
}

function buildSkeletonAndCrane(b: WorldBuilder, bl: Building, rng: Rng, edges: Edge[], blockLots: Building[][], addCollectible: (x: number, y: number, z: number) => void) {
  const { minX, minZ, maxX, maxZ } = bl;
  const floorH = 4.0;
  const top = Math.round(bl.h / floorH) * floorH;
  bl.h = top;
  // columns grid
  const cols: [number, number][] = [];
  for (let x = minX + 0.5; x <= maxX - 0.4; x += (maxX - minX - 1) / Math.max(1, Math.round((maxX - minX) / 6))) for (let z = minZ + 0.5; z <= maxZ - 0.4; z += (maxZ - minZ - 1) / Math.max(1, Math.round((maxZ - minZ) / 6))) cols.push([x, z]);
  for (const [x, z] of cols) b.solid('concreteDark', x - 0.3, 0, z - 0.3, x + 0.3, top, z + 0.3, Surface.Concrete, F.NO_GRAB);
  // floor slabs: full at certain levels, partial near top
  for (let y = floorH * 2; y <= top + 0.01; y += floorH) {
    const full = y >= top - 0.01 || y % (floorH * 3) === 0;
    if (full) {
      b.solid('concrete', minX, y - 0.35, minZ, maxX, y, maxZ, Surface.Concrete, 0, { bevel: 0.03 });
    } else {
      const half = rng.next() < 0.5;
      if (half) b.solid('concrete', minX, y - 0.35, minZ, (minX + maxX) / 2, y, maxZ, Surface.Concrete, 0, { bevel: 0.03 });
      else b.solid('concrete', minX, y - 0.35, minZ, maxX, y, (minZ + maxZ) / 2, Surface.Concrete, 0, { bevel: 0.03 });
    }
    // steel edge beams
    if (b.visual) {
      const g = b.g('red', (minX + maxX) / 2, (minZ + maxZ) / 2);
      box(g, minX, y - 0.6, minZ - 0.05, maxX, y - 0.35, minZ + 0.15);
      box(g, minX, y - 0.6, maxZ - 0.15, maxX, y - 0.35, maxZ + 0.05);
    }
  }
  // scaffold ladder at a corner for climbing up through the floors
  P.wallLadder(b, maxX, minZ + 2, 1, 0, 0.5, top);
  // ramp of stacked material pallets on the roof edge
  P.crate(b, minX + 3, top, minZ + 3, 1.2, 1.0);
  P.crate(b, minX + 3, top + 1.0, minZ + 3, 1.0, 0.9);
  // tower crane: mast at the lot corner, jib extends over the street to the neighbouring block
  const mastX = maxX - 2.5;
  // find target building east (+x) for the jib: in the next block along x
  const myBlock = bl.block;
  const target = blockLots[myBlock + 1]?.filter((o) => o.minX > maxX && o.maxZ - o.minZ > 6)
    .reduce<Building | null>((m, o) => (!m || o.minX < m.minX - 0.5 || (Math.abs(o.minX - m.minX) < 0.5 && o.maxZ - o.minZ > m.maxZ - m.minZ) ? o : m), null);
  const mastZ = target ? Math.min(maxZ - 2.5, Math.max(minZ + 2.5, (target.minZ + target.maxZ) / 2)) : maxZ - 2.5;
  const jibY = Math.max(top + 2.6, target ? target.h + 3.2 : top + 6);
  const mastTop = jibY + 6;
  b.cbox(mastX - 1, 0, mastZ - 1, mastX + 1, jibY - 0.6, mastZ + 1, Surface.Metal, F.LADDER);
  const jibLen = target ? target.minX - mastX + 6 : 40;
  // jib walkway (balance beam with a mesh deck)
  const jx0 = mastX - 1, jx1 = mastX + jibLen;
  b.cbox(jx0, jibY - 0.25, mastZ - 0.45, jx1, jibY, mastZ + 0.45, Surface.Metal, F.BALANCE);
  // counter jib
  b.cbox(mastX - 14, jibY - 0.25, mastZ - 0.8, mastX - 1, jibY, mastZ + 0.8, Surface.Metal);
  b.cbox(mastX - 13, jibY, mastZ - 1.2, mastX - 9, jibY + 2.2, mastZ + 1.2, Surface.Concrete); // counterweight
  // cab
  b.cbox(mastX - 1.2, jibY - 2.6, mastZ + 1.0, mastX + 1.2, jibY - 0.3, mastZ + 2.8, Surface.Metal);
  if (b.visual) {
    const g = b.g('red', mastX, mastZ);
    // lattice mast
    for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(g, mastX + ox * 0.95 - 0.08, 0, mastZ + oz * 0.95 - 0.08, mastX + ox * 0.95 + 0.08, mastTop, mastZ + oz * 0.95 + 0.08);
    for (let y = 1; y < mastTop; y += 1.9) {
      beam(g, mastX - 0.95, y, mastZ - 0.95, mastX + 0.95, y + 1.9, mastZ - 0.95, 0.05, 0.05);
      beam(g, mastX + 0.95, y, mastZ + 0.95, mastX - 0.95, y + 1.9, mastZ + 0.95, 0.05, 0.05);
      beam(g, mastX - 0.95, y, mastZ + 0.95, mastX - 0.95, y + 1.9, mastZ - 0.95, 0.05, 0.05);
      beam(g, mastX + 0.95, y, mastZ - 0.95, mastX + 0.95, y + 1.9, mastZ + 0.95, 0.05, 0.05);
    }
    // jib lattice (triangular)
    const gj = g;
    box(gj, jx0, jibY - 0.25, mastZ - 0.55, jx1, jibY - 0.1, mastZ - 0.4);
    box(gj, jx0, jibY - 0.25, mastZ + 0.4, jx1, jibY - 0.1, mastZ + 0.55);
    box(gj, jx0, jibY + 1.5, mastZ - 0.08, jx1, jibY + 1.65, mastZ + 0.08);
    for (let x = jx0; x < jx1; x += 1.6) {
      beam(gj, x, jibY - 0.1, mastZ - 0.5, x + 0.8, jibY + 1.55, mastZ, 0.04, 0.04);
      beam(gj, x + 0.8, jibY + 1.55, mastZ, x + 1.6, jibY - 0.1, mastZ - 0.5, 0.04, 0.04);
      beam(gj, x, jibY - 0.1, mastZ + 0.5, x + 0.8, jibY + 1.55, mastZ, 0.04, 0.04);
      beam(gj, x + 0.8, jibY + 1.55, mastZ, x + 1.6, jibY - 0.1, mastZ + 0.5, 0.04, 0.04);
    }
    const gd = b.g('metal', mastX, mastZ);
    box(gd, jx0, jibY - 0.12, mastZ - 0.42, jx1, jibY - 0.02, mastZ + 0.42); // grated deck
    box(gj, mastX - 14, jibY - 0.25, mastZ - 0.8, mastX - 1, jibY, mastZ + 0.8);
    b.vbox('concreteDark', mastX - 13, jibY, mastZ - 1.2, mastX - 9, jibY + 2.2, mastZ + 1.2, { bevel: 0.05 });
    // apex & ties
    beam(gj, mastX, mastTop, mastZ, jx1 - 6, jibY + 1.6, mastZ, 0.04, 0.04);
    beam(gj, mastX, mastTop, mastZ, mastX - 13, jibY + 0.5, mastZ, 0.04, 0.04);
    // cab
    b.vbox('metalPainted', mastX - 1.2, jibY - 2.6, mastZ + 1.0, mastX + 1.2, jibY - 0.3, mastZ + 2.8, { bevel: 0.06 });
    b.vbox('glassDark', mastX - 1.22, jibY - 1.8, mastZ + 1.6, mastX + 1.22, jibY - 0.6, mastZ + 2.82);
    // trolley + hook cable
    const tx = mastX + jibLen * 0.55;
    b.vbox('metalDark', tx - 0.6, jibY - 0.6, mastZ - 0.6, tx + 0.6, jibY - 0.25, mastZ + 0.6);
    beam(b.g('cable', tx, mastZ), tx, jibY - 0.6, mastZ, tx, jibY - 14, mastZ, 0.03, 0.03);
    b.vbox('metalPainted', tx - 0.3, jibY - 14.6, mastZ - 0.3, tx + 0.3, jibY - 14, mastZ + 0.3);
    sphere2(b, mastX, mastTop + 0.2, mastZ);
  }
  P.railing(b, jx0 + 1, jibY, mastZ - 0.48, jx1 - 0.2, mastZ - 0.48, false, 1.0);
  b.anchors.push({ type: 'crane', x: mastX, y: jibY, z: mastZ, a: jibLen });
  addCollectible(jx1 - 1, jibY + 1.2, mastZ);
  // ladder up the mast to the jib
  P.wallLadder(b, mastX - 1, mastZ, -1, 0, top, jibY - 0.6);
  if (target) {
    edges.push({ a: bl.id, b: target.id, kind: 'crane', ax: mastX - 1.3, az: mastZ, bx: target.minX + 4, bz: mastZ });
  }
}

function sphere2(b: WorldBuilder, x: number, y: number, z: number) {
  if (!b.visual) return;
  box(b.g('lampRed', x, z), x - 0.12, y - 0.12, z - 0.12, x + 0.12, y + 0.12, z + 0.12);
  b.anchors.push({ type: 'beacon', x, y, z });
}

// =====================================================================================================
function buildStreets(b: WorldBuilder, rng: Rng) {
  // ground (deadly from height)
  b.cbox(-1500, -2, -1500, 1500, 0, 1500, Surface.Concrete, F.DEADLY);
  if (!b.visual) return;
  // near streets in detail
  b.far = true;
  b.vbox('asphalt', -1500, -0.2, -1500, 1500, 0, 1500, { uvScale: 0.05 });
  b.far = false;
  const ext = 2;
  for (let j = -ext; j < ROWS + ext; j++) for (let i = -ext; i < COLS + ext; i++) {
    const r = blockRect(i, j);
    // sidewalk ring
    b.vbox('sidewalk', r.minX - 3.2, 0, r.minZ - 3.2, r.maxX + 3.2, 0.15, r.maxZ + 3.2, { bevel: 0.05, uvScale: 0.5 });
    // street lights along sidewalks
    for (let x = r.minX; x <= r.maxX; x += 15) {
      P.lampPost(b, x, 0.15, r.minZ - 2.6, 7, 0, -1);
      P.lampPost(b, x, 0.15, r.maxZ + 2.6, 7, 0, 1);
    }
    for (let z = r.minZ + 7; z <= r.maxZ; z += 15) {
      P.lampPost(b, r.minX - 2.6, 0.15, z, 7, -1, 0);
      P.lampPost(b, r.maxX + 2.6, 0.15, z, 7, 1, 0);
    }
    // street trees
    for (let x = r.minX + 5; x < r.maxX - 3; x += 9) if (rng.next() < 0.7) P.tree(b, x, 0.15, r.maxZ + 1.8, 1.2, () => rng.next());
  }
  // lane markings
  const g = b.g('stripe', 0, 0);
  void g;
  for (let i = -ext; i < COLS + ext - 1; i++) {
    const x = X0 + (i + 1) * BLOCK + i * STREET + STREET / 2;
    for (let z = Z0 - 140; z < -Z0 + 140; z += 6) b.vbox('stripe', x - 0.08, 0.005, z, x + 0.08, 0.02, z + 3);
  }
  for (let j = -ext; j < ROWS + ext - 1; j++) {
    const z = Z0 + (j + 1) * BLOCK + j * STREET + STREET / 2;
    for (let x = X0 - 140; x < -X0 + 140; x += 6) b.vbox('stripe', x, 0.005, z - 0.08, x + 3, 0.02, z + 0.08);
  }
}

function buildTrain(b: WorldBuilder) {
  // elevated maglev viaduct running along the street between rows 1 and 2, out to the horizon
  const z = Z0 + 2 * BLOCK + STREET + STREET / 2;
  const y = 13;
  if (b.visual) {
    b.far = true;
    b.vbox('concrete', -1400, y - 1.2, z - 2.2, 1400, y, z + 2.2, { bevel: 0.1, uvScale: 0.1 });
    b.vbox('metal', -1400, y, z - 0.4, 1400, y + 0.35, z + 0.4);
    b.far = false;
    for (let x = -1400; x <= 1400; x += 30) {
      const near = Math.abs(x) < 300;
      b.far = !near;
      b.vbox('concrete', x - 0.9, 0, z - 0.9, x + 0.9, y - 1.2, z + 0.9, { bevel: 0.08 });
      b.vbox('concrete', x - 1.2, y - 2.2, z - 2.4, x + 1.2, y - 1.2, z + 2.4, { bevel: 0.08 });
      b.far = false;
    }
  }
  return { z, y: y + 0.35, x0: -1400, x1: 1400 };
}

function buildOuterCity(b: WorldBuilder, rng: Rng) {
  // Ring 1 (adjacent): detailed but unreachable. Ring 2+: far skyline.
  const R = () => rng.next();
  for (let j = -9; j < ROWS + 9; j++) for (let i = -10; i < COLS + 10; i++) {
    if (i >= 0 && i < COLS && j >= 0 && j < ROWS) continue;
    const ring = Math.max(i < 0 ? -i : i >= COLS ? i - COLS + 1 : 0, j < 0 ? -j : j >= ROWS ? j - ROWS + 1 : 0);
    const r = blockRect(i, j);
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    // downtown cluster to the north-east
    const dtx = 380, dtz = -520;
    const dDT = Math.hypot(cx - dtx, cz - dtz);
    const downtown = Math.max(0, 1 - dDT / 520);
    // sub-lots
    const lots: Lot[] = [];
    const n = ring <= 1 ? 2 : 1 + (R() < 0.6 ? 1 : 0);
    if (n === 1) lots.push({ minX: r.minX + 2, minZ: r.minZ + 2, maxX: r.maxX - 2, maxZ: r.maxZ - 2 });
    else if (R() < 0.5) {
      const c = r.minX + BLOCK * (0.4 + R() * 0.2);
      lots.push({ ...r, maxX: c - 2 }, { ...r, minX: c + 2 });
    } else {
      const c = r.minZ + BLOCK * (0.4 + R() * 0.2);
      lots.push({ ...r, maxZ: c - 2 }, { ...r, minZ: c + 2 });
    }
    for (const l of lots) {
      let h = 26 + R() * 30 + ring * 4;
      if (R() < 0.12 + downtown * 0.6) h = 80 + R() * 120 + downtown * 180;
      // tall towers get setbacks
      b.far = ring >= 2;
      const style = rng.pick([0, 0, 1, 2, 3]);
      const [fh, cw] = STYLE_PARAMS[style];
      const tcx = (l.minX + l.maxX) / 2, tcz = (l.minZ + l.maxZ) / 2;
      const g: GeoBatch = b.g('facade', tcx, tcz);
      g.facadeCur = [style, Math.floor(R() * 400), fh, cw];
      if (h > 90) {
        const h1 = h * (0.45 + R() * 0.2);
        box(g, l.minX, 0, l.minZ, l.maxX, h1, l.maxZ, { skip: 4 });
        const ins = Math.min(l.maxX - l.minX, l.maxZ - l.minZ) * 0.18;
        b.vbox('concrete', l.minX - 0.2, h1, l.minZ - 0.2, l.maxX + 0.2, h1 + 1.2, l.maxZ + 0.2);
        const g2 = b.g('facade', tcx, tcz);
        g2.facadeCur = [style === 0 ? 3 : 0, Math.floor(R() * 400), fh, cw];
        box(g2, l.minX + ins, h1 + 1.2, l.minZ + ins, l.maxX - ins, h, l.maxZ - ins, { skip: 4 });
        b.vbox('concrete', l.minX + ins - 0.3, h, l.minZ + ins - 0.3, l.maxX - ins + 0.3, h + 2.5, l.maxZ - ins + 0.3);
        // crown / mast
        if (R() < 0.6) {
          b.vbox('metalDark', tcx - 0.4, h + 2.5, tcz - 0.4, tcx + 0.4, h + 18 + R() * 20, tcz + 0.4);
          b.anchors.push({ type: 'beacon', x: tcx, y: h + 20, z: tcz });
        }
      } else {
        box(g, l.minX, 0, l.minZ, l.maxX, h, l.maxZ, { skip: 4 });
        b.vbox('concrete', l.minX - 0.15, h - 0.6, l.minZ - 0.15, l.maxX + 0.15, h + 0.6, l.maxZ + 0.15, { bevel: ring <= 1 ? 0.05 : 0 });
        if (ring <= 2) {
          // a few roof masses for silhouette
          for (let k = 0; k < 3; k++) {
            const w = 2 + R() * 5, d = 2 + R() * 5;
            const px = l.minX + 2 + R() * Math.max(0, l.maxX - l.minX - 4 - w), pz = l.minZ + 2 + R() * Math.max(0, l.maxZ - l.minZ - 4 - d);
            b.vbox(R() < 0.5 ? 'metalPainted' : 'concrete', px, h + 0.6, pz, px + w, h + 0.6 + 1 + R() * 3, pz + d, { bevel: 0.04 });
          }
        }
      }
      if (ring <= 1) b.cbox(l.minX, 0, l.minZ, l.maxX, h, l.maxZ, Surface.Concrete);
      b.far = false;
    }
  }
}
