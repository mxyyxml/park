/**
 * Collision world: static axis-aligned boxes in a uniform spatial hash, queried by a
 * vertical-cylinder character. All parkour detection (walls, ledges, vault obstacles,
 * ceilings) is built on the ray and overlap queries in this file.
 *
 * Kept free of any rendering dependency so it runs headless in tests.
 */

export enum Surface {
  Concrete = 0,
  Metal = 1,
  Glass = 2,
  Gravel = 3,
  Wood = 4,
  Grass = 5,
  Rubber = 6,
}

/** Behaviour flags on colliders. */
export const F = {
  NONE: 0,
  PIPE: 1 << 0, // vertical climbable pipe
  LADDER: 1 << 1,
  NO_WALLRUN: 1 << 2,
  NO_GRAB: 1 << 3,
  DEADLY: 1 << 4, // street level: landing here from height kills
  BALANCE: 1 << 5, // narrow beam: triggers balance mode
  SPRINGBOARD: 1 << 6, // red traversal helper (visual hint only)
  INTERIOR: 1 << 7,
} as const;

export const SURFACE_FRICTION: Record<Surface, number> = {
  [Surface.Concrete]: 1.0,
  [Surface.Metal]: 0.88,
  [Surface.Glass]: 0.72,
  [Surface.Gravel]: 1.12,
  [Surface.Wood]: 0.95,
  [Surface.Grass]: 1.08,
  [Surface.Rubber]: 1.15,
};

export interface Box {
  id: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  surface: Surface;
  flags: number;
  stamp: number; // for query de-duplication
}

export interface RayHit {
  t: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  box: Box;
}

export interface MoveResult {
  grounded: boolean;
  ground: Box | null;
  hitCeiling: boolean;
  /** Horizontal wall contact normal of the strongest wall hit this move (0 if none). */
  wallNX: number; wallNZ: number; wall: Box | null;
  stepped: number; // total height stepped up
}

const CELL = 8;
const EPS = 1e-4;

export class CollisionWorld {
  boxes: Box[] = [];
  private grid = new Map<number, Box[]>();
  private stamp = 1;
  private scratch: Box[] = [];

  static key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  add(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
      surface: Surface = Surface.Concrete, flags = 0): Box {
    if (minX > maxX) [minX, maxX] = [maxX, minX];
    if (minY > maxY) [minY, maxY] = [maxY, minY];
    if (minZ > maxZ) [minZ, maxZ] = [maxZ, minZ];
    const b: Box = { id: this.boxes.length, minX, minY, minZ, maxX, maxY, maxZ, surface, flags, stamp: 0 };
    this.boxes.push(b);
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = CollisionWorld.key(cx, cz);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      list.push(b);
    }
    return b;
  }

  /** Add a box from center + half extents. */
  addC(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, surface = Surface.Concrete, flags = 0): Box {
    return this.add(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz, surface, flags);
  }

  /** Boxes whose XZ footprint touches the given rectangle. Returned array is reused. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, minY = -Infinity, maxY = Infinity): Box[] {
    const out = this.scratch; out.length = 0;
    const s = ++this.stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const list = this.grid.get(CollisionWorld.key(cx, cz));
      if (!list) continue;
      for (const b of list) {
        if (b.stamp === s) continue;
        b.stamp = s;
        if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
        if (b.maxY < minY || b.minY > maxY) continue;
        out.push(b);
      }
    }
    return out;
  }

  /** Ray cast (slab method). dir need not be normalised; t is in units of dir length. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number,
          filter?: (b: Box) => boolean): RayHit | null {
    const ex = ox + dx * maxT, ez = oz + dz * maxT;
    const ey = oy + dy * maxT;
    const list = this.query(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez),
      Math.min(oy, ey), Math.max(oy, ey));
    let best: RayHit | null = null;
    let bestT = maxT;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    for (const b of list) {
      if (filter && !filter(b)) continue;
      let t0 = 0, t1 = bestT;
      let nAxis = -1, nSign = 0;
      // X slab
      if (Math.abs(dx) < 1e-12) { if (ox < b.minX || ox > b.maxX) continue; }
      else {
        let ta = (b.minX - ox) * ix, tb = (b.maxX - ox) * ix, s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > t0) { t0 = ta; nAxis = 0; nSign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (Math.abs(dy) < 1e-12) { if (oy < b.minY || oy > b.maxY) continue; }
      else {
        let ta = (b.minY - oy) * iy, tb = (b.maxY - oy) * iy, s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > t0) { t0 = ta; nAxis = 1; nSign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-12) { if (oz < b.minZ || oz > b.maxZ) continue; }
      else {
        let ta = (b.minZ - oz) * iz, tb = (b.maxZ - oz) * iz, s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > t0) { t0 = ta; nAxis = 2; nSign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (nAxis < 0) continue; // origin inside box: ignore
      if (t0 < bestT) {
        bestT = t0;
        best = {
          t: t0, x: ox + dx * t0, y: oy + dy * t0, z: oz + dz * t0,
          nx: nAxis === 0 ? nSign : 0, ny: nAxis === 1 ? nSign : 0, nz: nAxis === 2 ? nSign : 0,
          box: b,
        };
      }
    }
    return best;
  }

  /** Highest surface top under (x,z) within a vertical range, using a thin vertical ray. */
  groundHeight(x: number, z: number, fromY: number, maxDrop: number): RayHit | null {
    return this.raycast(x, fromY, z, 0, -1, 0, maxDrop);
  }

  /** True if a vertical cylinder (feet at y) overlaps any box. */
  overlapCylinder(x: number, y: number, z: number, r: number, h: number, ignoreFlags = 0): boolean {
    const list = this.query(x - r, z - r, x + r, z + r, y, y + h);
    for (const b of list) {
      if (ignoreFlags && (b.flags & ignoreFlags)) continue;
      if (y + h <= b.minY + EPS || y >= b.maxY - EPS) continue;
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const ddx = x - cx, ddz = z - cz;
      if (ddx * ddx + ddz * ddz < r * r - EPS) return true;
    }
    return false;
  }

  /**
   * Move a vertical cylinder by (dx,dy,dz), resolving collisions with sub-stepping.
   * pos is mutated. vel is mutated to remove velocity into contact normals.
   */
  moveCylinder(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
               dx: number, dy: number, dz: number, r: number, h: number,
               stepHeight: number, out: MoveResult): MoveResult {
    out.grounded = false; out.ground = null; out.hitCeiling = false;
    out.wallNX = 0; out.wallNZ = 0; out.wall = null; out.stepped = 0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(len / (r * 0.45)));
    const sx = dx / steps, sy = dy / steps, sz = dz / steps;
    let bestWall = 0;
    for (let s = 0; s < steps; s++) {
      pos.x += sx; pos.y += sy; pos.z += sz;
      for (let iter = 0; iter < 6; iter++) {
        const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, pos.y - 0.01, pos.y + h + 0.01);
        let resolved = false;
        // find deepest overlap to resolve first
        let bestPen = Infinity, bx = 0, by = 0, bz = 0, bBox: Box | null = null, kind = 0;
        for (const b of list) {
          const feet = pos.y, head = pos.y + h;
          if (head <= b.minY + EPS || feet >= b.maxY - EPS) continue;
          const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
          const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
          let ddx = pos.x - cx, ddz = pos.z - cz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= r * r - EPS) continue;
          // horizontal push
          let hx = 0, hz = 0, hPen: number;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            hPen = r - d; hx = ddx / d; hz = ddz / d;
          } else {
            // centre inside footprint: push out the nearest side
            const pxn = pos.x - b.minX + r, pxp = b.maxX - pos.x + r;
            const pzn = pos.z - b.minZ + r, pzp = b.maxZ - pos.z + r;
            hPen = pxn; hx = -1; hz = 0;
            if (pxp < hPen) { hPen = pxp; hx = 1; hz = 0; }
            if (pzn < hPen) { hPen = pzn; hx = 0; hz = -1; }
            if (pzp < hPen) { hPen = pzp; hx = 0; hz = 1; }
          }
          const upPen = b.maxY - feet;
          const downPen = head - b.minY;
          // choose resolution
          let pen = hPen, k = 0;
          const stepOk = upPen <= stepHeight && (vel.y <= 2.0 || upPen < 0.3);
          if (stepOk || upPen < hPen) { pen = upPen; k = 1; }
          if (downPen < pen && vel.y > -1 && !stepOk) { pen = downPen; k = 2; }
          // prioritise resolving by the smallest needed correction among boxes, but steps last
          const score = k === 1 && upPen > hPen ? pen + 10 : pen;
          if (score < bestPen) { bestPen = score; bBox = b; kind = k; bx = hx; bz = hz; by = pen; }
        }
        if (!bBox) break;
        resolved = true;
        if (kind === 1) {
          const up = bBox.maxY - pos.y;
          pos.y = bBox.maxY;
          if (vel.y < 0) vel.y = 0;
          out.grounded = true; out.ground = bBox;
          if (up > 0.02) out.stepped += up;
        } else if (kind === 2) {
          pos.y = bBox.minY - h;
          if (vel.y > 0) vel.y = 0;
          out.hitCeiling = true;
        } else {
          const pen = by;
          pos.x += bx * pen; pos.z += bz * pen;
          const vn = vel.x * bx + vel.z * bz;
          if (vn < 0) {
            vel.x -= bx * vn; vel.z -= bz * vn;
            if (-vn > bestWall) { bestWall = -vn; out.wallNX = bx; out.wallNZ = bz; out.wall = bBox; }
          }
          if (!out.wall) { out.wallNX = bx; out.wallNZ = bz; out.wall = bBox; }
        }
        if (!resolved) break;
      }
    }
    return out;
  }

  /** Box under the feet (support), searching a thin slab below feet. */
  support(x: number, y: number, z: number, r: number, depth: number): Box | null {
    const list = this.query(x - r, z - r, x + r, z + r, y - depth, y + 0.02);
    let best: Box | null = null;
    for (const b of list) {
      if (b.maxY > y + 0.02 || b.maxY < y - depth) continue;
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const ddx = x - cx, ddz = z - cz;
      if (ddx * ddx + ddz * ddz >= r * r) continue;
      if (!best || b.maxY > best.maxY) best = b;
    }
    return best;
  }
}

export function newMoveResult(): MoveResult {
  return { grounded: false, ground: null, hitCeiling: false, wallNX: 0, wallNZ: 0, wall: null, stepped: 0 };
}
