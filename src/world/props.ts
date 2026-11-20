import { F, Surface } from '../physics/collision';
import { Building, Frame, WorldBuilder } from './builder';
import { beam, box, cylinder, quad, sphere } from './geo';

/** Rooftop air-conditioning unit (≈1.1 m tall: vaultable). Local: x width, z depth. */
export function acUnit(b: WorldBuilder, f: Frame, w = 1.8, d = 1.3, h = 1.1) {
  const [x0, z0, x1, z1] = f.rect(-w / 2, -d / 2, w / 2, d / 2);
  const y = f.y;
  b.cbox(x0, y, z0, x1, y + h, z1, Surface.Metal);
  if (!b.visual) return;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const gm = b.g('metalPainted', cx, cz);
  gm.colCur = [0.92, 0.93, 0.94];
  // plinth rails
  box(b.g('metalDark', cx, cz), x0 + 0.05, y, z0 + 0.05, x1 - 0.05, y + 0.12, z1 - 0.05, { bevel: 0.02 });
  // body
  box(gm, x0, y + 0.12, z0, x1, y + h - 0.06, z1, { bevel: 0.035 });
  // top lid
  box(gm, x0 - 0.02, y + h - 0.06, z0 - 0.02, x1 + 0.02, y + h, z1 + 0.02, { bevel: 0.02 });
  // fan grilles on top
  const fans = (x1 - x0) > (z1 - z0) ? [[cx - (x1 - x0) * 0.24, cz], [cx + (x1 - x0) * 0.24, cz]] : [[cx, cz - (z1 - z0) * 0.24], [cx, cz + (z1 - z0) * 0.24]];
  const fr = Math.min(x1 - x0, z1 - z0) * 0.36;
  for (const [fx, fz] of fans) {
    cylinder(b.g('metalDark', fx, fz), fx, y + h + 0.03, fz, fr, 0.06, 'y', 18);
    cylinder(b.g('metal', fx, fz), fx, y + h + 0.07, fz, fr * 0.18, 0.04, 'y', 10);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI;
      beam(b.g('metal', fx, fz), fx - Math.cos(a) * fr, y + h + 0.075, fz - Math.sin(a) * fr, fx + Math.cos(a) * fr, y + h + 0.075, fz + Math.sin(a) * fr, 0.015, 0.012);
    }
  }
  // side louvres (on the long faces)
  const gl = b.g('metalDark', cx, cz);
  const nL = 7;
  for (let i = 0; i < nL; i++) {
    const yy = y + 0.25 + i * (h - 0.45) / nL;
    if (x1 - x0 > z1 - z0) {
      box(gl, x0 + 0.12, yy, z0 - 0.025, x1 - 0.12, yy + 0.045, z0 + 0.01);
      box(gl, x0 + 0.12, yy, z1 - 0.01, x1 - 0.12, yy + 0.045, z1 + 0.025);
    } else {
      box(gl, x0 - 0.025, yy, z0 + 0.12, x0 + 0.01, yy + 0.045, z1 - 0.12);
      box(gl, x1 - 0.01, yy, z0 + 0.12, x1 + 0.025, yy + 0.045, z1 - 0.12);
    }
  }
  // refrigerant pipes
  const [px, pz] = f.p(w / 2 - 0.2, d / 2 + 0.08);
  cylinder(b.g('metal', px, pz), px, y + 0.35, pz, 0.035, 0.7, 'y', 8);
}

export function ventStack(b: WorldBuilder, x: number, y: number, z: number, r = 0.22, h = 1.2) {
  b.cbox(x - r, y, z - r, x + r, y + h, z + r, Surface.Metal);
  if (!b.visual) return;
  const g = b.g('metal', x, z);
  cylinder(g, x, y + h / 2, z, r, h, 'y', 14);
  cylinder(g, x, y + h + 0.1, z, r * 1.9, 0.06, 'y', 16);
  cylinder(b.g('metalDark', x, z), x, y + h + 0.03, z, r * 1.1, 0.08, 'y', 14);
  cylinder(g, x, y + h + 0.2, z, r * 0.6, 0.18, 'y', 12, true, 0.05);
}

export function mushroomVent(b: WorldBuilder, x: number, y: number, z: number) {
  b.cbox(x - 0.35, y, z - 0.35, x + 0.35, y + 0.7, z + 0.35, Surface.Metal);
  if (!b.visual) return;
  const g = b.g('metal', x, z);
  cylinder(g, x, y + 0.25, z, 0.25, 0.5, 'y', 14);
  sphere(g, x, y + 0.5, z, 0.42, 0.2, 0.42, 14);
}

/** Stair access housing with a door. Local +z is the door side. */
export function stairHouse(b: WorldBuilder, f: Frame, w = 3.2, d = 4.2, h = 2.9) {
  const [x0, z0, x1, z1] = f.rect(-w / 2, -d / 2, w / 2, d / 2);
  const y = f.y;
  b.solid('concrete', x0, y, z0, x1, y + h, z1, Surface.Concrete, 0, { bevel: 0.04 });
  if (!b.visual) return;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  // roof cap
  b.vbox('concreteDark', x0 - 0.12, y + h, z0 - 0.12, x1 + 0.12, y + h + 0.18, z1 + 0.12, { bevel: 0.03 });
  // door: recessed dark panel on the +z local face
  const [dx0, dz0, dx1, dz1] = f.rect(-0.55, d / 2 - 0.04, 0.55, d / 2 + 0.03);
  b.vbox('metalDark', dx0, y, dz0, dx1, y + 2.15, dz1, { bevel: 0.01 });
  const [fx0, fz0, fx1, fz1] = f.rect(-0.68, d / 2 - 0.02, 0.68, d / 2 + 0.06);
  b.vbox('metal', fx0, y + 2.15, fz0, fx1, y + 2.27, fz1);
  const [hx, hz] = f.p(0.38, d / 2 + 0.07);
  b.vbox('metal', hx - 0.06, y + 1.0, hz - 0.03, hx + 0.06, y + 1.05, hz + 0.03);
  // lamp above door
  const [lx, lz] = f.p(0, d / 2 + 0.12);
  b.vbox('lampWarm', lx - 0.12, y + 2.45, lz - 0.06, lx + 0.12, y + 2.55, lz + 0.06);
  // wall vent grille
  const [vx0, vz0, vx1, vz1] = f.rect(-w / 2 - 0.02, -0.4, -w / 2 + 0.03, 0.4);
  for (let i = 0; i < 5; i++) b.vbox('metalDark', vx0, y + 1.6 + i * 0.08, vz0, vx1, y + 1.64 + i * 0.08, vz1);
  // ladder up the back
  const [bx, bz] = f.p(0, -d / 2 - 0.12);
  void cx; void cz;
  ladderVisual(b, bx, y, bz, y + h + 0.9, f.r % 2 === 0 ? 'x' : 'z');
  const [lcx0, lcz0, lcx1, lcz1] = f.rect(-0.3, -d / 2 - 0.22, 0.3, -d / 2);
  b.cbox(lcx0, y, lcz0, lcx1, y + h, lcz1, Surface.Metal, F.LADDER);
}

/** ladder rails & rungs; axis = direction the rungs span */
export function ladderVisual(b: WorldBuilder, x: number, y0: number, z: number, y1: number, axis: 'x' | 'z', w = 0.5) {
  if (!b.visual) return;
  const g = b.g('metalPainted', x, z);
  g.colCur = [0.75, 0.12, 0.1];
  const hw = w / 2;
  const h = y1 - y0;
  if (axis === 'x') {
    box(g, x - hw - 0.03, y0, z - 0.03, x - hw + 0.03, y1, z + 0.03);
    box(g, x + hw - 0.03, y0, z - 0.03, x + hw + 0.03, y1, z + 0.03);
  } else {
    box(g, x - 0.03, y0, z - hw - 0.03, x + 0.03, y1, z - hw + 0.03);
    box(g, x - 0.03, y0, z + hw - 0.03, x + 0.03, y1, z + hw + 0.03);
  }
  for (let yy = y0 + 0.3; yy < y1 - 0.1; yy += 0.3) {
    if (axis === 'x') cylinder(g, x, yy, z, 0.018, w, 'x', 6, false);
    else cylinder(g, x, yy, z, 0.018, w, 'z', 6, false);
  }
  void h;
}

/** Wall ladder: against a wall whose outward normal is (nx,nz). */
export function wallLadder(b: WorldBuilder, x: number, z: number, nx: number, nz: number, y0: number, y1: number) {
  const ox = x + nx * 0.18, oz = z + nz * 0.18;
  const axis = nx !== 0 ? 'z' : 'x';
  ladderVisual(b, ox, y0, oz, y1 + 0.9, axis);
  // standoff brackets
  if (b.visual) for (let yy = y0 + 1; yy < y1; yy += 2.5) b.vbox('metalDark', Math.min(x, ox) - 0.02, yy, Math.min(z, oz) - 0.02, Math.max(x, ox) + 0.02, yy + 0.05, Math.max(z, oz) + 0.02);
  const hw = 0.3;
  if (axis === 'z') b.cbox(Math.min(x, ox + nx * 0.06), y0, z - hw, Math.max(x, ox + nx * 0.06), y1, z + hw, Surface.Metal, F.LADDER);
  else b.cbox(x - hw, y0, Math.min(z, oz + nz * 0.06), x + hw, y1, Math.max(z, oz + nz * 0.06), Surface.Metal, F.LADDER);
}

/** Climbable drain pipe on a wall face. */
export function wallPipe(b: WorldBuilder, x: number, z: number, nx: number, nz: number, y0: number, y1: number, red = true) {
  const r = 0.085;
  const cx = x + nx * (r + 0.06), cz = z + nz * (r + 0.06);
  b.cbox(cx - r, y0, cz - r, cx + r, y1, cz + r, Surface.Metal, F.PIPE);
  if (!b.visual) return;
  const g = b.g(red ? 'red' : 'metal', cx, cz);
  cylinder(g, cx, (y0 + y1) / 2, cz, r, y1 - y0, 'y', 12, false);
  for (let yy = y0 + 0.8; yy < y1; yy += 2.2) {
    cylinder(g, cx, yy, cz, r + 0.02, 0.08, 'y', 12);
    b.vbox('metalDark', Math.min(x, cx) - 0.02, yy - 0.03, Math.min(z, cz) - 0.02, Math.max(x, cx) + 0.02, yy + 0.03, Math.max(z, cz) + 0.02);
  }
  // elbow at top
  cylinder(g, cx - nx * 0.1, y1 + 0.02, cz - nz * 0.1, r * 1.1, 0.12, 'y', 12);
}

export function waterTank(b: WorldBuilder, x: number, y: number, z: number, r = 1.3, h = 2.8) {
  const leg = 1.6;
  b.cbox(x - r, y + leg, z - r, x + r, y + leg + h, z + r, Surface.Metal);
  for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = x + lx * r * 0.7, pz = z + lz * r * 0.7;
    b.cbox(px - 0.08, y, pz - 0.08, px + 0.08, y + leg, pz + 0.08, Surface.Metal);
  }
  if (!b.visual) return;
  const g = b.g('metalPainted', x, z);
  g.colCur = [0.86, 0.87, 0.88];
  cylinder(g, x, y + leg + h / 2, z, r, h, 'y', 24);
  cylinder(g, x, y + leg + h + 0.25, z, r * 0.15, 0.5, 'y', 8, true, r * 1.02);
  for (let i = 1; i < 4; i++) cylinder(b.g('metalDark', x, z), x, y + leg + i * h / 4, z, r + 0.02, 0.05, 'y', 24, false);
  const gd = b.g('metalDark', x, z);
  for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = x + lx * r * 0.7, pz = z + lz * r * 0.7;
    box(gd, px - 0.08, y, pz - 0.08, px + 0.08, y + leg, pz + 0.08);
  }
  beam(gd, x - r * 0.7, y + 0.2, z - r * 0.7, x + r * 0.7, y + leg - 0.1, z - r * 0.7, 0.05, 0.05);
  beam(gd, x + r * 0.7, y + 0.2, z + r * 0.7, x - r * 0.7, y + leg - 0.1, z + r * 0.7, 0.05, 0.05);
  box(gd, x - r, y + leg - 0.12, z - r, x + r, y + leg, z + r);
  ladderVisual(b, x, y, z + r + 0.1, y + leg + h + 0.6, 'x', 0.42);
  b.cbox(x - 0.25, y, z + r, x + 0.25, y + leg + h, z + r + 0.2, Surface.Metal, F.LADDER);
}

export function skylight(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number) {
  b.cbox(x0, y, z0, x1, y + 0.75, z1, Surface.Glass);
  if (!b.visual) return;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.vbox('metalDark', x0, y, z0, x1, y + 0.45, z1, { bevel: 0.02 });
  b.vbox('glassDark', x0 + 0.06, y + 0.45, z0 + 0.06, x1 - 0.06, y + 0.72, z1 - 0.06);
  const g = b.g('metal', cx, cz);
  for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2))) box(g, x - 0.03, y + 0.45, z0, x + 0.03, y + 0.76, z1);
  box(g, x0, y + 0.72, z0, x1, y + 0.76, z0 + 0.06); box(g, x0, y + 0.72, z1 - 0.06, x1, y + 0.76, z1);
}

export function solarArray(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number) {
  // rows along x, tilted toward -z (south-ish)
  for (let z = z0; z + 1.6 <= z1; z += 2.4) {
    b.cbox(x0, y, z, x1, y + 0.95, z + 1.6, Surface.Metal);
    if (!b.visual) continue;
    const g = b.g('solar', (x0 + x1) / 2, z);
    quad(g, [[x0, y + 0.45, z], [x1, y + 0.45, z], [x1, y + 1.0, z + 1.6], [x0, y + 1.0, z + 1.6]], [0, 0.95, -0.33],
      [[0, 0], [(x1 - x0) / 1.0, 0], [(x1 - x0) / 1.0, 1.7], [0, 1.7]]);
    const gm = b.g('metal', x0, z);
    for (let x = x0 + 0.2; x < x1; x += 2.0) {
      box(gm, x - 0.03, y, z + 0.05, x + 0.03, y + 0.45, z + 0.11);
      box(gm, x - 0.03, y, z + 1.45, x + 0.03, y + 0.98, z + 1.51);
    }
    box(gm, x0, y + 0.42, z - 0.02, x1, y + 0.47, z + 0.02);
  }
}

/** Long duct on supports. axis along which it runs. */
export function duct(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number, h = 0.95) {
  const ax = x1 - x0 > z1 - z0 ? 'x' : 'z';
  const s = 0.75;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.cbox(x0, y, z0, x1, y + h, z1, Surface.Metal);
  if (!b.visual) return;
  const g = b.g('metal', cx, cz);
  box(g, x0, y + h - s, z0, x1, y + h, z1, { bevel: 0.04 });
  const len = ax === 'x' ? x1 - x0 : z1 - z0;
  for (let t = 0.6; t < len; t += 1.4) {
    if (ax === 'x') { box(g, x0 + t - 0.04, y + h - s - 0.02, z0 - 0.02, x0 + t + 0.04, y + h + 0.02, z1 + 0.02); box(b.g('metalDark', cx, cz), x0 + t - 0.05, y, z0 + 0.05, x0 + t + 0.05, y + h - s, z1 - 0.05); }
    else { box(g, x0 - 0.02, y + h - s - 0.02, z0 + t - 0.04, x1 + 0.02, y + h + 0.02, z0 + t + 0.04); box(b.g('metalDark', cx, cz), x0 + 0.05, y, z0 + t - 0.05, x1 - 0.05, y + h - s, z0 + t + 0.05); }
  }
}

/** Pipe rack: 2–3 pipes at low height (step/vault). */
export function pipeRun(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number) {
  const ax = x1 - x0 > z1 - z0 ? 'x' : 'z';
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.cbox(x0, y, z0, x1, y + 0.6, z1, Surface.Metal);
  if (!b.visual) return;
  const len = ax === 'x' ? x1 - x0 : z1 - z0;
  const wid = ax === 'x' ? z1 - z0 : x1 - x0;
  const n = Math.max(2, Math.floor(wid / 0.32));
  for (let i = 0; i < n; i++) {
    const o = -wid / 2 + (i + 0.5) * wid / n;
    const r = 0.09 + (i % 2) * 0.04;
    const mat = i === 0 ? 'red' : 'metal';
    if (ax === 'x') cylinder(b.g(mat, cx, cz), cx, y + 0.42, cz + o, r, len, 'x', 12);
    else cylinder(b.g(mat, cx, cz), cx + o, y + 0.42, cz, r, len, 'z', 12);
  }
  const gd = b.g('metalDark', cx, cz);
  for (let t = 0.3; t < len; t += 2.5) {
    if (ax === 'x') box(gd, x0 + t - 0.05, y, z0, x0 + t + 0.05, y + 0.3, z1);
    else box(gd, x0, y, z0 + t - 0.05, x1, y + 0.3, z0 + t + 0.05);
  }
}

export function antenna(b: WorldBuilder, x: number, y: number, z: number, h = 6) {
  b.cbox(x - 0.12, y, z - 0.12, x + 0.12, y + h, z + 0.12, Surface.Metal, F.NO_GRAB);
  if (!b.visual) return;
  const g = b.g('metalPainted', x, z);
  g.colCur = [0.9, 0.9, 0.9];
  cylinder(g, x, y + h / 2, z, 0.06, h, 'y', 8, true, 0.03);
  for (let i = 1; i < 4; i++) {
    const yy = y + h * i / 4;
    beam(g, x - 0.5 + i * 0.1, yy, z, x + 0.5 - i * 0.1, yy, z, 0.03, 0.03);
  }
  sphere(b.g('lampRed', x, z), x, y + h + 0.06, z, 0.09, 0.09, 0.09, 8);
  b.anchors.push({ type: 'beacon', x, y: y + h + 0.06, z });
  // guy wires
  for (const [dx, dz] of [[1.6, 0], [-0.8, 1.4], [-0.8, -1.4]]) beam(b.g('cable', x, z), x, y + h * 0.7, z, x + dx, y, z + dz, 0.012, 0.012);
}

export function dish(b: WorldBuilder, x: number, y: number, z: number, r = 0.8) {
  b.cbox(x - 0.25, y, z - 0.25, x + 0.25, y + 1.2, z + 0.25, Surface.Metal);
  if (!b.visual) return;
  cylinder(b.g('metalDark', x, z), x, y + 0.6, z, 0.07, 1.2, 'y', 8);
  const g = b.g('metalPainted', x, z);
  g.colCur = [0.95, 0.95, 0.95];
  // shallow dish (cone frustum) facing up-south, feed arm and LNB
  cylinder(g, x, y + 1.35, z + 0.08, 0.12, 0.28, 'z', 20, true, r);
  beam(b.g('metalDark', x, z), x, y + 1.35, z + 0.22, x, y + 1.35, z + 0.9, 0.025, 0.025);
  box(b.g('metalDark', x, z), x - 0.05, y + 1.3, z + 0.88, x + 0.05, y + 1.4, z + 0.98);
}

/** Railing between two points (axis-aligned). glass = glass panels else metal bars. */
export function railing(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number, glass = true, h = 1.1) {
  const ax = Math.abs(x1 - x0) > Math.abs(z1 - z0) ? 'x' : 'z';
  const t = 0.05;
  if (ax === 'x') b.cbox(Math.min(x0, x1), y, z0 - t, Math.max(x0, x1), y + h, z0 + t, Surface.Metal, F.NO_GRAB | F.NO_WALLRUN);
  else b.cbox(x0 - t, y, Math.min(z0, z1), x0 + t, y + h, Math.max(z0, z1), Surface.Metal, F.NO_GRAB | F.NO_WALLRUN);
  if (!b.visual) return;
  const len = ax === 'x' ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const n = Math.max(1, Math.round(len / 1.5));
  const gx = (x0 + x1) / 2, gz = (z0 + z1) / 2;
  const gm = b.g('metal', gx, gz);
  const lo = ax === 'x' ? Math.min(x0, x1) : Math.min(z0, z1);
  for (let i = 0; i <= n; i++) {
    const p = lo + len * i / n;
    if (ax === 'x') box(gm, p - 0.025, y, z0 - 0.025, p + 0.025, y + h, z0 + 0.025);
    else box(gm, x0 - 0.025, y, p - 0.025, x0 + 0.025, y + h, p + 0.025);
  }
  // handrail
  if (ax === 'x') cylinder(gm, gx, y + h, z0, 0.03, len, 'x', 8);
  else cylinder(gm, x0, y + h, gz, 0.03, len, 'z', 8);
  if (glass) {
    if (ax === 'x') b.vbox('glass', Math.min(x0, x1) + 0.03, y + 0.08, z0 - 0.01, Math.max(x0, x1) - 0.03, y + h - 0.06, z0 + 0.01);
    else b.vbox('glass', x0 - 0.01, y + 0.08, Math.min(z0, z1) + 0.03, x0 + 0.01, y + h - 0.06, Math.max(z0, z1) - 0.03);
  } else {
    for (const hh of [0.35, 0.7]) {
      if (ax === 'x') cylinder(gm, gx, y + hh, z0, 0.018, len, 'x', 6, false);
      else cylinder(gm, x0, y + hh, gz, 0.018, len, 'z', 6, false);
    }
  }
}

/** Billboard / ad panel: a tall flat wall (wall-run surface). Spans along axis. */
export function billboard(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number, h0: number, h1: number, adIndex: number) {
  const ax = Math.abs(x1 - x0) > Math.abs(z1 - z0) ? 'x' : 'z';
  const th = 0.35;
  const lo = ax === 'x' ? Math.min(x0, x1) : Math.min(z0, z1), hi = ax === 'x' ? Math.max(x0, x1) : Math.max(z0, z1);
  if (ax === 'x') b.solid('metalDark', lo, y + h0, z0 - th / 2, hi, y + h1, z0 + th / 2, Surface.Metal, 0, { bevel: 0.03 });
  else b.solid('metalDark', x0 - th / 2, y + h0, lo, x0 + th / 2, y + h1, hi, Surface.Metal, 0, { bevel: 0.03 });
  if (!b.visual) return;
  const cols = 4, rows = 4;
  const ci = adIndex % (cols * rows);
  const u0 = (ci % cols) / cols, v0 = 1 - (Math.floor(ci / cols) + 1) / rows;
  const u1 = u0 + 1 / cols, v1 = v0 + 1 / rows;
  const gx = (x0 + x1) / 2, gz = (z0 + z1) / 2;
  const g = b.g('screen', gx, gz);
  const m = 0.12;
  if (ax === 'x') {
    for (const s of [-1, 1]) {
      const zz = z0 + s * (th / 2 + 0.005);
      const pts = s > 0 ? [[lo + m, y + h0 + m, zz], [hi - m, y + h0 + m, zz], [hi - m, y + h1 - m, zz], [lo + m, y + h1 - m, zz]]
        : [[hi - m, y + h0 + m, zz], [lo + m, y + h0 + m, zz], [lo + m, y + h1 - m, zz], [hi - m, y + h1 - m, zz]];
      quad(g, pts, [0, 0, s], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    }
  } else {
    for (const s of [-1, 1]) {
      const xx = x0 + s * (th / 2 + 0.005);
      const pts = s < 0 ? [[xx, y + h0 + m, lo + m], [xx, y + h0 + m, hi - m], [xx, y + h1 - m, hi - m], [xx, y + h1 - m, lo + m]]
        : [[xx, y + h0 + m, hi - m], [xx, y + h0 + m, lo + m], [xx, y + h1 - m, lo + m], [xx, y + h1 - m, hi - m]];
      quad(g, pts, [s, 0, 0], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    }
  }
  // support legs
  const gd = b.g('metalDark', gx, gz);
  for (let p = lo + 0.6; p < hi; p += Math.max(2.5, (hi - lo - 1.2) / 3)) {
    if (h0 > 0.05) {
      if (ax === 'x') box(gd, p - 0.08, y, z0 - 0.08, p + 0.08, y + h0, z0 + 0.08);
      else box(gd, x0 - 0.08, y, p - 0.08, x0 + 0.08, y + h0, p + 0.08);
    }
  }
  // top light bar
  if (ax === 'x') b.vbox('lamp', lo, y + h1, z0 - 0.06, hi, y + h1 + 0.08, z0 + 0.06);
  else b.vbox('lamp', x0 - 0.06, y + h1, lo, x0 + 0.06, y + h1 + 0.08, hi);
  b.anchors.push({ type: 'screen', x: gx, y: y + (h0 + h1) / 2, z: gz });
}

export function tree(b: WorldBuilder, x: number, y: number, z: number, s: number, rng: () => number) {
  b.cbox(x - 0.15 * s, y, z - 0.15 * s, x + 0.15 * s, y + 2.2 * s, z + 0.15 * s, Surface.Wood);
  if (!b.visual) return;
  const gt = b.g('trunk', x, z);
  cylinder(gt, x, y + 1.3 * s, z, 0.11 * s, 2.6 * s, 'y', 8, false, 0.06 * s);
  const n = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 0.9 * s;
    const fx = x + Math.cos(a) * r, fz = z + Math.sin(a) * r, fy = y + (2.3 + rng() * 1.6) * s;
    const g = b.g(rng() < 0.5 ? 'foliage' : 'foliageDark', fx, fz);
    const tint = 0.85 + rng() * 0.3;
    g.colCur = [tint, tint * (0.95 + rng() * 0.1), tint * 0.9];
    const rr = (0.7 + rng() * 0.6) * s;
    sphere(g, fx, fy, fz, rr, rr * 0.8, rr, 9);
    if (i < 3) beam(gt, x, y + 1.8 * s, z, fx, fy - 0.3, fz, 0.06 * s, 0.06 * s);
  }
}

export function shrub(b: WorldBuilder, x: number, y: number, z: number, s: number, rng: () => number) {
  if (!b.visual) return;
  for (let i = 0; i < 3; i++) {
    const g = b.g(rng() < 0.5 ? 'foliage' : 'foliageDark', x, z);
    const t = 0.8 + rng() * 0.3; g.colCur = [t, t, t];
    sphere(g, x + (rng() - 0.5) * s, y + 0.3 * s, z + (rng() - 0.5) * s, 0.5 * s, 0.42 * s, 0.5 * s, 8);
  }
}

/** Raised planter box with greenery (0.6 m: step-up / vault). */
export function planter(b: WorldBuilder, x0: number, y: number, z0: number, x1: number, z1: number, rng: () => number, withTree = false) {
  b.solid('concreteWarm', x0, y, z0, x1, y + 0.6, z1, Surface.Concrete, 0, { bevel: 0.03 });
  if (!b.visual) return;
  b.vbox('grass', x0 + 0.12, y + 0.6, z0 + 0.12, x1 - 0.12, y + 0.62, z1 - 0.12);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (withTree) tree(b, cx, y + 0.6, cz, 1.0 + rng() * 0.4, rng);
  else {
    const n = Math.max(1, Math.floor(((x1 - x0) * (z1 - z0)) / 1.5));
    for (let i = 0; i < n; i++) shrub(b, x0 + 0.4 + rng() * (x1 - x0 - 0.8), y + 0.6, z0 + 0.4 + rng() * (z1 - z0 - 0.8), 0.7 + rng() * 0.5, rng);
  }
}

export function bench(b: WorldBuilder, f: Frame) {
  const [x0, z0, x1, z1] = f.rect(-0.9, -0.25, 0.9, 0.25);
  b.cbox(x0, f.y, z0, x1, f.y + 0.48, z1, Surface.Wood);
  if (!b.visual) return;
  b.vbox('concrete', x0 + 0.1, f.y, z0 + 0.05, x0 + 0.3, f.y + 0.42, z1 - 0.05, { bevel: 0.02 });
  b.vbox('concrete', x1 - 0.3, f.y, z0 + 0.05, x1 - 0.1, f.y + 0.42, z1 - 0.05, { bevel: 0.02 });
  b.vbox('wood', x0, f.y + 0.42, z0, x1, f.y + 0.48, z1, { bevel: 0.015 });
}

export function coolingFan(b: WorldBuilder, x: number, y: number, z: number, r = 1.4) {
  b.cbox(x - r, y, z - r, x + r, y + 1.5, z + r, Surface.Metal);
  if (!b.visual) return;
  const g = b.g('metalPainted', x, z);
  g.colCur = [0.82, 0.84, 0.86];
  cylinder(g, x, y + 0.75, z, r, 1.5, 'y', 24, false);
  cylinder(b.g('metalDark', x, z), x, y + 1.45, z, r * 0.97, 0.06, 'y', 24);
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI;
    beam(b.g('metal', x, z), x - Math.cos(a) * r, y + 1.52, z - Math.sin(a) * r, x + Math.cos(a) * r, y + 1.52, z + Math.sin(a) * r, 0.03, 0.03);
  }
  b.anchors.push({ type: 'fan', x, y: y + 1.48, z, a: r });
}

export function chimney(b: WorldBuilder, x: number, y: number, z: number, h = 5, r = 0.5) {
  b.cbox(x - r, y, z - r, x + r, y + h, z + r, Surface.Metal, F.NO_GRAB);
  if (!b.visual) return;
  const g = b.g('metal', x, z);
  cylinder(g, x, y + h / 2, z, r, h, 'y', 16, false);
  cylinder(b.g('red', x, z), x, y + h - 0.4, z, r + 0.02, 0.35, 'y', 16, false);
  cylinder(b.g('metalDark', x, z), x, y + h, z, r * 1.05, 0.12, 'y', 16);
  b.anchors.push({ type: 'steam', x, y: y + h + 0.1, z });
}

/** Low concrete-and-gravel helipad markings (visual), on a roof. */
export function helipad(b: WorldBuilder, cx: number, y: number, cz: number, r: number) {
  if (!b.visual) return;
  const g = b.g('stripe', cx, cz);
  const seg = 40;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const ri = r - 0.35;
    quad(g, [[cx + Math.cos(a0) * ri, y, cz + Math.sin(a0) * ri], [cx + Math.cos(a1) * ri, y, cz + Math.sin(a1) * ri],
      [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r]], [0, 1, 0]);
  }
  // H
  const s = r * 0.4;
  quad(g, [[cx - s, y, cz - s], [cx - s + 0.45, y, cz - s], [cx - s + 0.45, y, cz + s], [cx - s, y, cz + s]], [0, 1, 0]);
  quad(g, [[cx + s - 0.45, y, cz - s], [cx + s, y, cz - s], [cx + s, y, cz + s], [cx + s - 0.45, y, cz + s]], [0, 1, 0]);
  quad(g, [[cx - s, y, cz - 0.22], [cx + s, y, cz - 0.22], [cx + s, y, cz + 0.22], [cx - s, y, cz + 0.22]], [0, 1, 0]);
}

/** A climbable 'red' traversal hint block (springboard crate). */
export function crate(b: WorldBuilder, x: number, y: number, z: number, w = 1.0, h = 0.9) {
  b.solid('red', x - w / 2, y, z - w / 2, x + w / 2, y + h, z + w / 2, Surface.Metal, F.SPRINGBOARD, { bevel: 0.04 });
}

export function lampPost(b: WorldBuilder, x: number, y: number, z: number, h = 7, dx = 1, dz = 0) {
  if (!b.visual) return;
  const g = b.g('metalDark', x, z);
  cylinder(g, x, y + h / 2, z, 0.08, h, 'y', 8, true, 0.06);
  beam(g, x, y + h, z, x + dx * 1.4, y + h + 0.1, z + dz * 1.4, 0.08, 0.06);
  b.vbox('lampWarm', x + dx * 1.4 - 0.25, y + h - 0.02, z + dz * 1.4 - 0.12, x + dx * 1.4 + 0.25, y + h + 0.06, z + dz * 1.4 + 0.12);
}

export type { Building };
