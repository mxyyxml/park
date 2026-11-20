/**
 * Lightweight geometry accumulation (no three.js dependency) so the level can be generated
 * headless for tests. The renderer turns batches into merged BufferGeometries.
 */

export type MatKey =
  | 'concrete' | 'concreteDark' | 'concreteWarm' | 'roof' | 'gravel' | 'metal' | 'metalDark' | 'metalPainted'
  | 'red' | 'glass' | 'glassDark' | 'wood' | 'grass' | 'foliage' | 'foliageDark' | 'trunk' | 'facade' | 'lamp'
  | 'lampRed' | 'lampWarm' | 'asphalt' | 'sidewalk' | 'interiorFloor' | 'interiorWall' | 'rubber' | 'screen'
  | 'water' | 'tile' | 'solar' | 'cable' | 'stripe';

export class GeoBatch {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** optional per-vertex vec4 (facade parameters) */
  facade: number[] | null = null;
  /** optional per-vertex color tint */
  col: number[] | null = null;
  vcount = 0;
  facadeCur: [number, number, number, number] = [0, 0, 3.6, 1.5];
  colCur: [number, number, number] = [1, 1, 1];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v);
    if (this.facade) this.facade.push(...this.facadeCur);
    if (this.col) this.col.push(...this.colCur);
    return this.vcount++;
  }

  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
}

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** world-projected UV for a point given a face normal */
function wuv(x: number, y: number, z: number, nx: number, ny: number, nz: number, s: number): [number, number] {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return [x * s, z * s];
  if (ax >= az) return [(nx > 0 ? -z : z) * s, y * s];
  return [(nz > 0 ? x : -x) * s, y * s];
}

function pushTri(g: GeoBatch, p: number[][], n: number[], s: number) {
  // ensure outward winding relative to desired normal n
  const [a, b, c] = p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  const ids = p.map((q) => { const [u, v] = wuv(q[0], q[1], q[2], n[0], n[1], n[2], s); return g.vert(q[0], q[1], q[2], n[0], n[1], n[2], u, v); });
  if (flip) g.tri(ids[0], ids[2], ids[1]); else g.tri(ids[0], ids[1], ids[2]);
}

function pushQuad(g: GeoBatch, p: number[][], n: number[], s: number) {
  const [a, b, c, d] = p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  const ids = p.map((q) => { const [u, v] = wuv(q[0], q[1], q[2], n[0], n[1], n[2], s); return g.vert(q[0], q[1], q[2], n[0], n[1], n[2], u, v); });
  if (flip) { g.tri(ids[0], ids[2], ids[1]); g.tri(ids[0], ids[3], ids[2]); }
  else { g.tri(ids[0], ids[1], ids[2]); g.tri(ids[0], ids[2], ids[3]); }
}

export interface BoxOpts {
  bevel?: number;
  uvScale?: number;
  /** skip faces: bitmask -x,+x,-y,+y,-z,+z = 1,2,4,8,16,32 */
  skip?: number;
}

/**
 * Axis-aligned box with optional chamfered edges (one bevel segment) — chamfers catch light
 * along edges, which is most of what makes architectural blocks read as "real".
 */
export function box(g: GeoBatch, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, o: BoxOpts = {}) {
  const s = o.uvScale ?? 0.25;
  const skip = o.skip ?? 0;
  const mn = [minX, minY, minZ], mx = [maxX, maxY, maxZ];
  const size = [maxX - minX, maxY - minY, maxZ - minZ];
  const b = Math.min(o.bevel ?? 0, size[0] * 0.45, size[1] * 0.45, size[2] * 0.45);
  // faces
  for (let a = 0; a < 3; a++) for (let sg = 0; sg < 2; sg++) {
    const bit = 1 << (a * 2 + sg);
    if (skip & bit) continue;
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const c = sg ? mx[a] : mn[a];
    const pts: number[][] = [];
    const uLo = mn[u] + b, uHi = mx[u] - b, vLo = mn[v] + b, vHi = mx[v] - b;
    for (const [uu, vv] of [[uLo, vLo], [uHi, vLo], [uHi, vHi], [uLo, vHi]]) {
      const p = [0, 0, 0]; p[a] = c; p[u] = uu; p[v] = vv; pts.push(p);
    }
    const n = AX[a].map((q) => q * (sg ? 1 : -1));
    pushQuad(g, pts, n, s);
  }
  if (b <= 0) return;
  // edges
  for (let a1 = 0; a1 < 3; a1++) for (let a2 = a1 + 1; a2 < 3; a2++) {
    const a3 = 3 - a1 - a2;
    for (let s1 = 0; s1 < 2; s1++) for (let s2 = 0; s2 < 2; s2++) {
      if ((skip & (1 << (a1 * 2 + s1))) && (skip & (1 << (a2 * 2 + s2)))) continue;
      const c1 = s1 ? mx[a1] : mn[a1], c2 = s2 ? mx[a2] : mn[a2];
      const i1 = s1 ? mx[a1] - b : mn[a1] + b, i2 = s2 ? mx[a2] - b : mn[a2] + b;
      const lo = mn[a3] + b, hi = mx[a3] - b;
      const mk = (p1: number, p2: number, p3: number) => { const p = [0, 0, 0]; p[a1] = p1; p[a2] = p2; p[a3] = p3; return p; };
      const pts = [mk(c1, i2, lo), mk(i1, c2, lo), mk(i1, c2, hi), mk(c1, i2, hi)];
      const n = [0, 0, 0]; n[a1] = s1 ? 0.7071 : -0.7071; n[a2] = s2 ? 0.7071 : -0.7071;
      pushQuad(g, pts, n, s);
    }
  }
  // corners
  for (let sx = 0; sx < 2; sx++) for (let sy = 0; sy < 2; sy++) for (let sz = 0; sz < 2; sz++) {
    const c = [sx ? mx[0] : mn[0], sy ? mx[1] : mn[1], sz ? mx[2] : mn[2]];
    const i = [sx ? mx[0] - b : mn[0] + b, sy ? mx[1] - b : mn[1] + b, sz ? mx[2] - b : mn[2] + b];
    const pts = [[c[0], i[1], i[2]], [i[0], c[1], i[2]], [i[0], i[1], c[2]]];
    const n = [sx ? 0.577 : -0.577, sy ? 0.577 : -0.577, sz ? 0.577 : -0.577];
    pushTri(g, pts, n, s);
  }
}

/** Vertical or horizontal cylinder (smooth normals). axis: 'x'|'y'|'z'. */
export function cylinder(g: GeoBatch, cx: number, cy: number, cz: number, r: number, len: number, axis: 'x' | 'y' | 'z',
                         seg = 12, caps = true, r2 = r) {
  const base = g.vcount;
  const map = (a: number, b: number, c: number): [number, number, number] => {
    // a along axis, (b,c) radial
    if (axis === 'y') return [cx + b, cy + a, cz + c];
    if (axis === 'x') return [cx + a, cy + b, cz + c];
    return [cx + b, cy + c, cz + a];
  };
  const h = len / 2;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const cs = Math.cos(t), sn = Math.sin(t);
    for (let e = 0; e < 2; e++) {
      const rr = e ? r2 : r;
      const [x, y, z] = map(e ? h : -h, cs * rr, sn * rr);
      const [nx, ny, nz] = map(0, cs, sn).map((q, k) => q - [cx, cy, cz][k]);
      g.vert(x, y, z, nx, ny, nz, i / seg * Math.PI * 2 * r, (e ? len : 0));
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    const P = (k: number) => [g.pos[k * 3], g.pos[k * 3 + 1], g.pos[k * 3 + 2]];
    const pa = P(a), pc = P(c), pd = P(d);
    const e1 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]], e2 = [pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const n = [g.nor[a * 3] + g.nor[c * 3], g.nor[a * 3 + 1] + g.nor[c * 3 + 1], g.nor[a * 3 + 2] + g.nor[c * 3 + 2]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) { g.tri(a, c, d); g.tri(a, d, b); }
    else { g.tri(a, d, c); g.tri(a, b, d); }
  }
  if (!caps) return;
  for (let e = 0; e < 2; e++) {
    const rr = e ? r2 : r;
    const sgn = e ? 1 : -1;
    const [nx, ny, nz] = map(sgn, 0, 0).map((q, k) => q - [cx, cy, cz][k]);
    const [ccx, ccy, ccz] = map(sgn * h, 0, 0);
    const ci = g.vert(ccx, ccy, ccz, nx, ny, nz, 0, 0);
    const ring: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const [x, y, z] = map(sgn * h, Math.cos(t) * rr, Math.sin(t) * rr);
      ring.push(g.vert(x, y, z, nx, ny, nz, Math.cos(t) * rr, Math.sin(t) * rr));
    }
    for (let i = 0; i < seg; i++) {
      // pick winding so the face points along the cap normal
      const p0 = [ccx, ccy, ccz];
      const pa = [g.pos[ring[i] * 3], g.pos[ring[i] * 3 + 1], g.pos[ring[i] * 3 + 2]];
      const pb = [g.pos[ring[i + 1] * 3], g.pos[ring[i + 1] * 3 + 1], g.pos[ring[i + 1] * 3 + 2]];
      const e1 = [pa[0] - p0[0], pa[1] - p0[1], pa[2] - p0[2]], e2 = [pb[0] - p0[0], pb[1] - p0[1], pb[2] - p0[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[0] * nx + cr[1] * ny + cr[2] * nz >= 0) g.tri(ci, ring[i], ring[i + 1]); else g.tri(ci, ring[i + 1], ring[i]);
    }
  }
}

/** Arbitrary oriented quad strip / beam between two points (square cross-section). */
export function beam(g: GeoBatch, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, h: number) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  const fx = dx / L, fy = dy / L, fz = dz / L;
  // side vector
  let sx = -fz, sy = 0, sz = fx;
  const sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-4) { sx = 1; sy = 0; sz = 0; } else { sx /= sl; sz /= sl; }
  // up = side x fwd
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  const hw = w / 2, hh = h / 2;
  const corner = (px: number, py: number, pz: number, a: number, b: number) =>
    [px + sx * a * hw + ux * b * hh, py + sy * a * hw + uy * b * hh, pz + sz * a * hw + uz * b * hh];
  const faces: [number, number, number[]][] = [[1, 0, [sx, sy, sz]], [-1, 0, [-sx, -sy, -sz]], [0, 1, [ux, uy, uz]], [0, -1, [-ux, -uy, -uz]]];
  for (const [a, b, n] of faces) {
    const pa = a !== 0 ? [[a, -1], [a, 1]] : [[-1, b], [1, b]];
    const q = [corner(ax, ay, az, pa[0][0], pa[0][1]), corner(ax, ay, az, pa[1][0], pa[1][1]),
      corner(bx, by, bz, pa[1][0], pa[1][1]), corner(bx, by, bz, pa[0][0], pa[0][1])];
    pushQuadLocal(g, q, n, L);
  }
}

function pushQuadLocal(g: GeoBatch, p: number[][], n: number[], L: number) {
  const [a, b, c] = p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  const uvs = [[0, 0], [1, 0], [1, L], [0, L]];
  const ids = p.map((q, i) => g.vert(q[0], q[1], q[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1]));
  if (flip) { g.tri(ids[0], ids[2], ids[1]); g.tri(ids[0], ids[3], ids[2]); }
  else { g.tri(ids[0], ids[1], ids[2]); g.tri(ids[0], ids[2], ids[3]); }
}

/** Low-poly sphere-ish blob (icosphere-like via lat/long) for foliage and lamps. */
export function sphere(g: GeoBatch, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg = 8) {
  const base = g.vcount;
  const rings = Math.max(4, Math.floor(seg * 0.6));
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const ph = (j / seg) * Math.PI * 2;
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
      g.vert(cx + nx * rx, cy + ny * ry, cz + nz * rz, nx, ny, nz, j / seg, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = base + i * (seg + 1) + j, b = a + seg + 1;
    g.tri(a, a + 1, b); g.tri(a + 1, b + 1, b);
  }
}

/** Flat quad with explicit normal (e.g. decals, signs). Points in order. */
export function quad(g: GeoBatch, p: number[][], n: number[], uvs?: number[][]) {
  const [a, b, c] = p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  const uv = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ids = p.map((q, i) => g.vert(q[0], q[1], q[2], n[0], n[1], n[2], uv[i][0], uv[i][1]));
  if (flip) { g.tri(ids[0], ids[2], ids[1]); g.tri(ids[0], ids[3], ids[2]); }
  else { g.tri(ids[0], ids[1], ids[2]); g.tri(ids[0], ids[2], ids[3]); }
}
