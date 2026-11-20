import { Box, CollisionWorld, F, Surface } from '../physics/collision';
import type { Zipline } from '../player/PlayerController';
import { box, BoxOpts, GeoBatch, MatKey } from './geo';

export const CHUNK = 48;

export interface Building {
  id: number;
  minX: number; minZ: number; maxX: number; maxZ: number;
  h: number;
  block: number;
  kind: string;
  /** props occupy cells on the roof; used to place things without overlaps */
  occ: { minX: number; minZ: number; maxX: number; maxZ: number }[];
  edgeOpen: [boolean, boolean, boolean, boolean]; // -x,+x,-z,+z : no parapet (jump edges)
  collider: Box | null;
}

export interface LightDef { x: number; y: number; z: number; color: number; intensity: number; distance: number }
export interface Anchor { type: string; x: number; y: number; z: number; a?: number; b?: number; c?: number; d?: number }

export class Rng {
  s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next() { // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number) { return this.next() < p; }
}

export class WorldBuilder {
  world = new CollisionWorld();
  visual: boolean;
  chunks = new Map<string, Map<MatKey, GeoBatch>>();
  /** far geometry: no shadows, merged per material globally per sector */
  farChunks = new Map<string, Map<MatKey, GeoBatch>>();
  buildings: Building[] = [];
  ziplines: Zipline[] = [];
  lights: LightDef[] = [];
  anchors: Anchor[] = [];
  far = false;

  constructor(visual: boolean) { this.visual = visual; }

  batch(mat: MatKey, x: number, z: number): GeoBatch {
    const map = this.far ? this.farChunks : this.chunks;
    const size = this.far ? CHUNK * 4 : CHUNK;
    const key = `${Math.floor(x / size)},${Math.floor(z / size)}`;
    let m = map.get(key);
    if (!m) { m = new Map(); map.set(key, m); }
    let g = m.get(mat);
    if (!g) {
      g = new GeoBatch();
      if (mat === 'facade') g.facade = [];
      if (mat === 'foliage' || mat === 'foliageDark' || mat === 'metalPainted' || mat === 'concrete') g.col = [];
      m.set(mat, g);
    }
    return g;
  }

  /** Visual-only box */
  vbox(mat: MatKey, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, o?: BoxOpts) {
    if (!this.visual) return;
    box(this.batch(mat, (minX + maxX) / 2, (minZ + maxZ) / 2), minX, minY, minZ, maxX, maxY, maxZ, o);
  }

  /** Collider-only box */
  cbox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, surface = Surface.Concrete, flags = 0) {
    return this.world.add(minX, minY, minZ, maxX, maxY, maxZ, surface, flags);
  }

  /** Visual + collider */
  solid(mat: MatKey, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
        surface = Surface.Concrete, flags = 0, o?: BoxOpts) {
    this.vbox(mat, minX, minY, minZ, maxX, maxY, maxZ, o);
    return this.cbox(minX, minY, minZ, maxX, maxY, maxZ, surface, flags);
  }

  g(mat: MatKey, x: number, z: number) { return this.batch(mat, x, z); }

  /** Is a roof rect free of props? */
  free(b: Building, minX: number, minZ: number, maxX: number, maxZ: number, margin = 0.6) {
    if (minX < b.minX + 0.4 || maxX > b.maxX - 0.4 || minZ < b.minZ + 0.4 || maxZ > b.maxZ - 0.4) return false;
    for (const o of b.occ) {
      if (maxX + margin > o.minX && minX - margin < o.maxX && maxZ + margin > o.minZ && minZ - margin < o.maxZ) return false;
    }
    return true;
  }

  occupy(b: Building, minX: number, minZ: number, maxX: number, maxZ: number) {
    b.occ.push({ minX, minZ, maxX, maxZ });
  }
}

/** Rotate helper for props: local frame (origin, rotation in quarter turns). */
export class Frame {
  constructor(public x: number, public y: number, public z: number, public r: number) { this.r = ((r % 4) + 4) % 4; }
  p(lx: number, lz: number): [number, number] {
    switch (this.r) {
      case 0: return [this.x + lx, this.z + lz];
      case 1: return [this.x + lz, this.z - lx];
      case 2: return [this.x - lx, this.z - lz];
      default: return [this.x - lz, this.z + lx];
    }
  }
  rect(lminX: number, lminZ: number, lmaxX: number, lmaxZ: number): [number, number, number, number] {
    const [ax, az] = this.p(lminX, lminZ), [bx, bz] = this.p(lmaxX, lmaxZ);
    return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
  }
  /** direction vector of local +x / +z */
  dir(lx: number, lz: number): [number, number] {
    const [a, b] = this.p(lx, lz);
    return [a - this.x, b - this.z];
  }
}

export { F, Surface };
