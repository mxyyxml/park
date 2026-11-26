/**
 * The infected: shambling humanoids for Night Run. They roam the streets and some rooftops,
 * notice the runner on their own level, chase and strike. They cannot jump gaps or climb, so
 * parkour is the escape; a kick staggers them, a running or airborne dropkick floors them, and
 * one knocked off a roof does not get up.
 *
 * Simulation is plain data (testable without a renderer); `InfectedView` draws every body with
 * a handful of instanced meshes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterAssets } from '../player/assets';
import type { CollisionWorld } from '../physics/collision';
import type { Building } from '../world/builder';

export type InfState = 'idle' | 'chase' | 'windup' | 'recover' | 'stagger' | 'down' | 'dead' | 'charge' | 'climb';
export type InfKind = 'walker' | 'runner' | 'mutant';
/** per-type tuning: walkers shamble, runners sprint and leap short gaps, mutants are slow tanks that charge */
export const KINDS: Record<InfKind, { hp: number; speed: [number, number]; dmg: number; windup: number; knock: number; sight: number; scale: number }> = {
  walker: { hp: 3, speed: [2.3, 3.7], dmg: 22, windup: 0.45, knock: 4, sight: 24, scale: 1 },
  runner: { hp: 2, speed: [5.0, 5.8], dmg: 14, windup: 0.28, knock: 3, sight: 32, scale: 0.96 },
  mutant: { hp: 8, speed: [1.6, 1.9], dmg: 38, windup: 0.8, knock: 11, sight: 20, scale: 1.4 },
};
export interface Infected {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  kind: InfKind; chargeCD: number; cdx: number; cdz: number;
  yaw: number; hp: number; state: InfState; t: number; gait: number; speed: number;
  falling: boolean; seed: number; groanT: number; wanderYaw: number;
  detour: number; detourT: number;  // steering offset while going round an obstacle
  hx: number; hy: number; hz: number; // where it was placed, to rise again later
  climb?: { sx: number; sy: number; sz: number; tx: number; ty: number; tz: number; dur: number }; // runner parkour
}
export interface Target { x: number; y: number; z: number; alive: boolean }
export type InfEvent = { type: 'hit'; dmg: number; knock: number; fromX: number; fromZ: number } | { type: 'groan'; x: number; y: number; z: number; kind: InfKind } | { type: 'fallDeath' };

const R = 0.32, H = 1.7, G = 24;
const REACH = 1.25, HIT_RANGE = 1.75, LEVEL = 1.6;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export class Horde {
  list: Infected[] = [];
  events: InfEvent[] = [];
  /** kinds that went down since the game last drained this (kicks and falls) */
  deaths: InfKind[] = [];
  constructor(private world: CollisionWorld) {}

  /** Street walkers between the blocks plus small groups on some roofs (never the spawn roof). */
  populate(buildings: Building[], avoid: { x: number; z: number }, street = 36, roof = 22, seed = 7) {
    const r = rng(seed);
    this.list = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of buildings) { minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX); minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ); }
    const place = (x: number, y: number, z: number, kind: InfKind) => {
      const g = this.world.groundHeight(x, z, y + 1.2, 2.5);
      if (!g || Math.abs(g.y - y) > 0.6 || this.world.overlapCylinder(x, g.y + 0.15, z, R, H - 0.2)) return false;
      if (Math.hypot(x - avoid.x, z - avoid.z) < 18) return false;
      const k = KINDS[kind];
      this.list.push({ kind, chargeCD: 0, cdx: 0, cdz: 0, hx: x, hy: g.y, hz: z, x, y: g.y, z, vx: 0, vy: 0, vz: 0, yaw: r() * Math.PI * 2, hp: k.hp, state: 'idle', t: r() * 3, gait: r() * 6, speed: k.speed[0] + r() * (k.speed[1] - k.speed[0]), falling: false, seed: r(), groanT: 2 + r() * 8, wanderYaw: r() * Math.PI * 2, detour: 0, detourT: 0 });
      return true;
    };
    // streets: mostly walkers, a pack of runners, a few mutants; roofs: walkers and runners
    const streetKind = (): InfKind => { const u = r(); return u < 0.55 ? 'walker' : u < 0.87 ? 'runner' : 'mutant'; };
    for (let tries = 0; this.list.length < street && tries < street * 40; tries++) place(minX - 8 + r() * (maxX - minX + 16), 0, minZ - 8 + r() * (maxZ - minZ + 16), streetKind());
    const roofs = buildings.filter((b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) > 160 && b.kind !== 'spire' && !(avoid.x >= b.minX && avoid.x <= b.maxX && avoid.z >= b.minZ && avoid.z <= b.maxZ));
    for (let tries = 0; this.list.length < street + roof && tries < roof * 60 && roofs.length; tries++) {
      const b = roofs[Math.floor(r() * roofs.length)];
      place(b.minX + 2 + r() * (b.maxX - b.minX - 4), b.h, b.minZ + 2 + r() * (b.maxZ - b.minZ - 4), r() < 0.7 ? 'walker' : 'runner');
    }
  }

  private supported(z: Infected, x = z.x, zz = z.z) {
    const g = this.world.groundHeight(x, zz, z.y + 0.45, 0.9);
    return g && g.y > z.y - 0.6 ? g : null;
  }

  /** move with collision; `edgeSafe` refuses steps that would walk off a roof */
  private move(z: Infected, dx: number, dz: number, edgeSafe: boolean): number {
    const x0 = z.x, z0 = z.z;
    for (const [mx, mz] of [[dx, 0], [0, dz]]) {
      if (mx === 0 && mz === 0) continue;
      const nx = z.x + mx, nz = z.z + mz;
      if (this.world.overlapCylinder(nx, z.y + 0.4, nz, R, H - 0.45)) {
        // a body sent flying tumbles over a parapet or railing (up to ~1.3 m) instead of stopping dead
        const flying = !edgeSafe && Math.hypot(z.vx, z.vz) > 5;
        if (flying && !this.world.overlapCylinder(nx, z.y + 1.35, nz, R, H - 0.45)) { z.y += 1.35; z.x = nx; z.z = nz; continue; }
        if (mx) z.vx *= -0.3; else z.vz *= -0.3;
        continue;
      }
      const g = this.supported(z, nx, nz);
      if (edgeSafe && !g) continue;
      z.x = nx; z.z = nz;
      if (g && g.y > z.y) z.y = g.y; // small step up
    }
    return Math.hypot(z.x - x0, z.z - z0);
  }

  /** walk toward a heading; when blocked, try angled detours and keep the one that works for a while */
  private steer(z: Infected, yaw: number, sp: number, dt: number) {
    z.detourT -= dt;
    if (z.detourT <= 0) z.detour = 0;
    const want = sp * dt;
    for (const off of z.detour ? [z.detour] : [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4]) {
      const a = yaw + off;
      const ox = z.x, oz = z.z;
      if (this.move(z, -Math.sin(a) * want, -Math.cos(a) * want, true) > want * 0.5) {
        if (off !== 0 && !z.detour) { z.detour = off; z.detourT = 0.5 + z.seed * 0.4; }
        return a;
      }
      z.x = ox; z.z = oz;
    }
    z.detour = 0;
    return yaw;
  }

  update(dt: number, player: Target) {
    this.events.length = 0;
    const L = this.lure;
    if (L && (L.t -= dt) <= 0) this.lure = null;
    for (const z of this.list) {
      const pd = Math.hypot(player.x - z.x, player.z - z.z);
      const lured = !!L && L.t > 0 && pd > 5 && Math.hypot(L.x - z.x, L.z - z.z) < 30 && Math.abs(L.y - z.y) < LEVEL;
      const p = lured ? { x: L!.x, y: L!.y, z: L!.z, alive: true } : player;
      const dx = p.x - z.x, dz = p.z - z.z, dist = Math.hypot(dx, dz), dy = p.y - z.y;
      // the dead rise again at their post, out of the runner's sight
      if (z.state === 'dead' && z.t > 25 && Math.hypot(p.x - z.hx, p.z - z.hz) > 60) {
        Object.assign(z, { x: z.hx, y: z.hy, z: z.hz, vx: 0, vy: 0, vz: 0, hp: KINDS[z.kind].hp, state: 'idle', t: 0, falling: false });
        continue;
      }
      if (dist > 140 && !z.falling && (z.state === 'idle' || z.state === 'chase')) continue; // far from the runner: frozen
      z.t += dt;
      z.chargeCD -= dt;
      const K = KINDS[z.kind];
      // gravity: knocked off a ledge, or the floor ended
      if (!z.falling && !this.supported(z)) { z.falling = true; z.vy = 0; }
      if (z.falling) {
        z.vy -= G * dt; z.y += z.vy * dt;
        this.move(z, z.vx * dt, z.vz * dt, false);
        const g = this.world.groundHeight(z.x, z.z, z.y + 0.6 - z.vy * dt, 0.7 - z.vy * dt);
        if (g && z.y <= g.y + 0.02 && z.vy <= 0) {
          z.y = g.y; z.falling = false;
          if (z.vy < (z.kind === 'runner' ? -16 : -11) && z.state !== 'dead') { z.state = 'dead'; z.t = 0; z.hp = 0; this.deaths.push(z.kind); this.events.push({ type: 'fallDeath' }); }
          else if (z.state === 'chase' || z.state === 'idle') { z.state = 'chase'; z.t = 0; } // a runner's leap landed
          z.vy = 0;
        }
        if (z.y < -40) { z.state = 'dead'; z.y = -40; z.falling = false; }
        continue;
      }
      const sameLevel = Math.abs(dy) < LEVEL && p.alive;
      switch (z.state) {
        case 'idle': {
          if (z.t > 3) { z.t = 0; z.wanderYaw += (z.seed - 0.5) * 2.4 + Math.sin(z.gait) * 1.2; }
          z.yaw = turn(z.yaw, this.steer(z, z.wanderYaw, 0.6, dt), dt * 1.5);
          z.gait += dt * 3;
          if (sameLevel && dist < K.sight) { z.state = 'chase'; z.t = 0; this.events.push({ type: 'groan', x: z.x, y: z.y + 1.6, z: z.z, kind: z.kind }); }
          break;
        }
        case 'chase': {
          // runners do parkour: they keep after you up to ~4.6 m above or 6 m below, within 14 m
          const parkour = z.kind === 'runner' && p.alive && dist < 14 && dy > -6 && dy < 4.6 && z.t > 0.3;
          if (!sameLevel && !parkour || dist > K.sight * 1.6) { z.state = 'idle'; z.t = 0; break; }
          const sp = z.speed, ox = z.x, oz = z.z;
          z.yaw = turn(z.yaw, this.steer(z, Math.atan2(-dx, -dz), sp, dt), dt * 6);
          z.gait += dt * sp * 2.6;
          if (parkour && Math.hypot(z.x - ox, z.z - oz) < sp * dt * 0.3 && dist > 1.5) {
            if (this.tryClimb(z, dx / dist, dz / dist)) break;           // wall or obstacle ahead: climb / vault it
            if (!this.supported(z, z.x + dx / dist * 0.8, z.z + dz / dist * 0.8)) {
              if (dy < -LEVEL) { z.vx = dx / dist * 3.5; z.vz = dz / dist * 3.5; z.vy = 2; }      // you're below: drop after you
              else if (dist < 8) { z.vx = dx / dist * 7.5; z.vz = dz / dist * 7.5; z.vy = 6.5 + Math.max(0, dy) * 1.6; } // across a gap: leap
              else break;
              z.falling = true; z.y += 0.05; z.yaw = Math.atan2(-dx, -dz);
              break;
            }
          }
          // mutants charge from a distance: a telegraphed wind-up, then a straight rush
          if (z.kind === 'mutant' && sameLevel && dist > 4 && dist < 12 && z.chargeCD <= 0) {
            z.state = 'charge'; z.t = 0; z.cdx = dx / dist; z.cdz = dz / dist; z.chargeCD = 5;
            this.events.push({ type: 'groan', x: z.x, y: z.y + 1.6, z: z.z, kind: z.kind });
            break;
          }
          if (lured && dist < 2.2) { z.gait -= dt * sp * 2.6; z.yaw += Math.sin(z.t * 2 + z.seed * 9) * dt; break; } // milling round the flare
          if (dist < REACH * K.scale) { z.state = 'windup'; z.t = 0; }
          break;
        }
        case 'climb': {
          // hand over hand up the face, then pull over the top onto it
          const c = z.climb!, u = Math.min(1, z.t / c.dur);
          const up = Math.min(1, u / 0.7), over = Math.max(0, (u - 0.55) / 0.45);
          z.y = c.sy + (c.ty - c.sy) * up * up * (3 - 2 * up);
          z.x = c.sx + (c.tx - c.sx) * over; z.z = c.sz + (c.tz - c.sz) * over;
          z.gait += dt * 14;
          if (u >= 1) { z.y = c.ty; z.climb = undefined; z.state = 'chase'; z.t = 0.31; }
          break;
        }
        case 'charge': {
          if (z.t < 0.7) { z.yaw = turn(z.yaw, Math.atan2(-dx, -dz), dt * 4); z.cdx = -Math.sin(z.yaw); z.cdz = -Math.cos(z.yaw); break; }
          const moved = this.move(z, z.cdx * 9 * dt, z.cdz * 9 * dt, true);
          z.gait += dt * 20;
          if (!lured && dist < HIT_RANGE * 1.1 && Math.abs(dy) < LEVEL && p.alive) {
            this.events.push({ type: 'hit', dmg: K.dmg, knock: 14, fromX: z.x, fromZ: z.z });
            z.state = 'recover'; z.t = -0.5;
          } else if (moved < 9 * dt * 0.3 || z.t > 1.8) { z.state = 'stagger'; z.t = 0; } // hit a wall or ran out
          break;
        }
        case 'windup':
          z.yaw = turn(z.yaw, Math.atan2(-dx, -dz), dt * 6);
          if (z.t > K.windup) {
            if (!lured && dist < HIT_RANGE * K.scale && Math.abs(dy) < LEVEL && p.alive) this.events.push({ type: 'hit', dmg: K.dmg, knock: K.knock, fromX: z.x, fromZ: z.z });
            z.state = 'recover'; z.t = 0;
          }
          break;
        case 'recover': if (z.t > 0.7) { z.state = 'chase'; z.t = 0; } break;
        case 'stagger': case 'down': case 'dead': {
          // knockback slides with friction and can carry them off a roof edge
          const f = Math.max(0, 1 - dt * (z.state === 'stagger' ? 5 : 3));
          z.vx *= f; z.vz *= f;
          this.move(z, z.vx * dt, z.vz * dt, false);
          if (z.state === 'stagger' && z.t > 0.8) { z.state = 'chase'; z.t = 0; }
          if (z.state === 'down' && z.t > 2.6) { z.state = 'chase'; z.t = 0; }
          break;
        }
      }
      if (z.state !== 'dead' && z.state !== 'down') {
        z.groanT -= dt;
        if (z.groanT < 0 && dist < 40) { z.groanT = 4 + z.seed * 7; this.events.push({ type: 'groan', x: z.x, y: z.y + 1.6, z: z.z, kind: z.kind }); }
      }
    }
  }

  /** Runner parkour: something solid ahead with a standable top up to 4.6 m higher? climb (or vault) it. */
  private tryClimb(z: Infected, fx: number, fz: number) {
    const hit = this.world.raycast(z.x, z.y + 0.4, z.z, fx, 0, fz, R + 0.9);
    if (!hit) return false;
    const tx = hit.x + fx * 0.55, tz = hit.z + fz * 0.55;
    const top = this.world.groundHeight(tx, tz, z.y + 5.2, 5.0);
    if (!top) return false;
    const h = top.y - z.y;
    if (h < 0.3 || h > 4.6 || this.world.overlapCylinder(tx, top.y + 0.05, tz, R, H - 0.1)) return false;
    z.climb = { sx: z.x, sy: z.y, sz: z.z, tx, ty: top.y, tz, dur: 0.25 + h * 0.16 };
    z.state = 'climb'; z.t = 0; z.yaw = Math.atan2(-fx, -fz);
    return true;
  }

  /** Runner's kick: everything in a short cone in front is knocked back. Returns how many were hit. */
  kick(px: number, py: number, pz: number, yaw: number, power: number): number {
    return this.hit(px, py, pz, yaw, { range: 2.4, arc: 0.45, dmg: power >= 12 ? 2 : 1, push: power, floor: power >= 12, tankStagger: power >= 12 });
  }

  /**
   * A melee strike in a cone in front of the runner. `arc` is the cosine of the half-angle,
   * `floor` knocks walkers/runners down (else they stagger); mutants only stagger if `tankStagger`.
   */
  hit(px: number, py: number, pz: number, yaw: number, w: { range: number; arc: number; dmg: number; push: number; floor: boolean; tankStagger: boolean }): number {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let n = 0;
    for (const z of this.list) {
      if (z.state === 'dead' || z.falling) continue;
      const dx = z.x - px, dz = z.z - pz, d = Math.hypot(dx, dz);
      if (d > w.range || Math.abs(z.y - py) > LEVEL || (d > 0.4 && (dx * fx + dz * fz) / d < w.arc)) continue;
      n++;
      z.hp -= w.dmg;
      const tank = z.kind === 'mutant';
      const push = tank ? w.push * 0.3 : w.push;
      z.vx = fx * push; z.vz = fz * push;
      if (z.hp <= 0) { z.state = 'dead'; this.deaths.push(z.kind); }
      else if (tank) { if (w.tankStagger) z.state = 'stagger'; else continue; }
      else z.state = w.floor ? 'down' : 'stagger';
      z.t = 0;
    }
    return n;
  }

  /** a burning flare: infected nearby on its level go to it instead of you (unless you're right there) */
  lure: { x: number; y: number; z: number; t: number } | null = null;

  /** a runner coming up over an edge at (ex, ey, ez): starts below it on the outside, ends on top facing in */
  addClimber(ex: number, ey: number, ez: number, inX: number, inZ: number) {
    const sx = ex - inX * 0.6, sz = ez - inZ * 0.6;
    const k = KINDS.runner;
    this.list.push({ kind: 'runner', chargeCD: 0, cdx: 0, cdz: 0, hx: sx, hy: ey, hz: sz, x: sx, y: ey - 4, z: sz, vx: 0, vy: 0, vz: 0,
      yaw: Math.atan2(-inX, -inZ), hp: k.hp, state: 'climb', t: 0, gait: 0, speed: k.speed[1], falling: false, seed: Math.random(), groanT: 1,
      wanderYaw: 0, detour: 0, detourT: 0, climb: { sx, sy: ey - 4, sz, tx: ex + inX * 0.9, ty: ey, tz: ez + inZ * 0.9, dur: 0.9 } });
  }

  /** after a respawn, nothing is waiting right on top of the runner */
  clearAround(x: number, z: number, r: number) {
    for (const q of this.list) if (q.state !== 'dead' && Math.hypot(q.x - x, q.z - z) < r) { q.state = 'down'; q.t = -2; q.vx = q.vz = 0; }
  }
  get alive() { return this.list.filter((z) => z.state !== 'dead').length; }
}

function turn(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}

// ---- rendering --------------------------------------------------------------------------------

const UPPER = 0.29, FORE = 0.27, THIGH = 0.44, SHIN = 0.43; // same proportions as the runner

/** bake an asset's meshes into one geometry (position + normal), one group per source mesh */
function bake(o: THREE.Object3D): { geo: THREE.BufferGeometry; names: string[] } {
  o.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [], names: string[] = [];
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    const g = new THREE.BufferGeometry();
    const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    g.setAttribute('position', src.getAttribute('position').clone());
    g.setAttribute('normal', src.getAttribute('normal').clone());
    g.applyMatrix4(m.matrixWorld);
    geos.push(g); names.push((Array.isArray(m.material) ? m.material[0] : m.material).name || '');
  });
  return { geo: mergeGeometries(geos, true)!, names };
}
function plain(g: THREE.BufferGeometry) { const n = g.index ? g.toNonIndexed() : g.clone(); const o = new THREE.BufferGeometry(); o.setAttribute('position', n.getAttribute('position')); o.setAttribute('normal', n.getAttribute('normal')); return o; }
const segCap = (r: number, len: number) => { const g = new THREE.CapsuleGeometry(r, len - 2 * r, 4, 8); g.translate(0, len / 2, 0); return g; };

type PartKey = 'hips' | 'torso' | 'head' | 'eyes' | 'upperL' | 'upperR' | 'foreL' | 'foreR' | 'wristL' | 'wristR' | 'handL' | 'handR' | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'shoeL' | 'shoeR';

/**
 * Infected bodies built on a small skeleton (hips, knees, ankles, shoulders, elbows, wrists, neck)
 * posed in code every frame. With the sculpted runner assets the pieces are the same sculpted
 * torso, hips, limbs, head and shoes in drab, varied clothing; without them, simple shapes.
 */
export class InfectedView {
  group = new THREE.Group();
  private parts = {} as Record<PartKey, THREE.InstancedMesh>;
  private root = new THREE.Matrix4(); private m = new THREE.Matrix4(); private tmp = new THREE.Matrix4();
  private e = new THREE.Euler(); private q = new THREE.Quaternion(); private one = new THREE.Vector3(1, 1, 1);

  constructor(private max: number, assets: CharacterAssets | null = null) {
    this.group.name = 'infected';
    const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x8e9a86, roughness: 0.75 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b2d, roughness: 0.8 });
    const eyes = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); // per-kind glow via instance colour
    const shirts = [0x4a4f55, 0x6a5440, 0x3b4a5c, 0x77776a, 0x5a3434, 0x3c4d3a, 0x8a8478].map((c) => new THREE.Color(c));
    const pants = [0x26292e, 0x3d3d44, 0x2e3746, 0x4a3f31, 0x55534d].map((c) => new THREE.Color(c));
    const add = (k: PartKey, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], color?: (i: number) => THREE.Color) => {
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.count = 0;
      if (color) for (let i = 0; i < max; i++) mesh.setColorAt(i, color(i));
      this.parts[k] = mesh; this.group.add(mesh);
    };
    const shirt = (i: number) => shirts[(i * 7) % shirts.length], pant = (i: number) => pants[(i * 3) % pants.length];
    this.shirt = shirt; this.pant = pant;
    if (assets) {
      const hips = bake(assets.pelvis), torso = bake(assets.torso), head = bake(assets.head), shoe = bake(assets.shoe);
      add('hips', hips.geo, cloth, pant);
      add('torso', torso.geo, cloth, shirt);
      add('head', head.geo, head.names.map((n) => (/hair/.test(n) ? hair : /skin|face/.test(n) || !n ? skin : dark)));
      add('upperL', plain(assets.sleeveUpper), cloth, shirt); add('upperR', plain(assets.sleeveUpper), cloth, shirt);
      add('foreL', plain(assets.sleeveFore), cloth, shirt); add('foreR', plain(assets.sleeveFore), cloth, shirt);
      add('thighL', plain(assets.thigh), cloth, pant); add('thighR', plain(assets.thigh), cloth, pant);
      add('shinL', plain(assets.shin), cloth, pant); add('shinR', plain(assets.shin), cloth, pant);
      add('shoeL', shoe.geo, dark); add('shoeR', shoe.geo, dark);
    } else {
      const torso = new THREE.CapsuleGeometry(0.17, 0.3, 4, 10); torso.scale(1.15, 1, 0.7); torso.translate(0, 0.32, 0);
      const hips = new THREE.CapsuleGeometry(0.14, 0.04, 4, 10); hips.scale(1.2, 1, 0.8);
      const head = new THREE.SphereGeometry(0.11, 14, 10); head.scale(0.9, 1.15, 1);
      add('hips', hips, cloth, pant); add('torso', torso, cloth, shirt); add('head', head, skin);
      for (const s of ['L', 'R'] as const) {
        add(`upper${s}`, segCap(0.055, UPPER), cloth, shirt); add(`fore${s}`, segCap(0.045, FORE * 0.72), cloth, shirt);
        add(`thigh${s}`, segCap(0.08, THIGH), cloth, pant); add(`shin${s}`, segCap(0.06, SHIN), cloth, pant);
        const sh = new THREE.BoxGeometry(0.1, 0.08, 0.26); sh.translate(0, -0.03, 0.05); add(`shoe${s}`, sh, dark);
      }
    }
    for (const s of ['L', 'R'] as const) {
      add(`wrist${s}`, segCap(0.032, FORE * 0.3), skin);
      const hand = new THREE.SphereGeometry(0.05, 10, 8); hand.scale(0.8, 1.2, 0.55); hand.translate(0, 0.05, 0);
      add(`hand${s}`, hand, skin);
    }
    const eye = new THREE.SphereGeometry(0.016, 6, 4);
    add('eyes', mergeGeometries([eye.clone().translate(-0.034, 0.01, -0.092), eye.clone().translate(0.034, 0.01, -0.092)])!, eyes, () => InfectedView.EYE.walker);
  }

  /** world matrix for a limb segment from a to b (segment geometry runs along +Y from its origin) */
  private seg(k: PartKey, i: number, a: THREE.Vector3, b: THREE.Vector3, right: THREE.Vector3) {
    const y = b.clone().sub(a); const len = y.length(); y.divideScalar(len || 1);
    let x = new THREE.Vector3().crossVectors(y, right); if (x.lengthSq() < 1e-6) x.set(1, 0, 0); x.normalize();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    this.m.makeBasis(x, y, z).setPosition(a);
    this.parts[k].setMatrixAt(i, this.m);
  }
  private place(k: PartKey, i: number, local: THREE.Matrix4) { this.m.multiplyMatrices(this.root, local); this.parts[k].setMatrixAt(i, this.m); }

  private kindOf: (InfKind | null)[] = [];
  private shirt!: (i: number) => THREE.Color; private pant!: (i: number) => THREE.Color;
  private static EYE: Record<InfKind, THREE.Color> = { walker: new THREE.Color(2.2, 2.3, 0.9), runner: new THREE.Color(1.6, 2.4, 2.8), mutant: new THREE.Color(3.2, 0.4, 0.2) };
  private static FLESH = new THREE.Color(0x6e4640);
  /** clothes keep their per-instance colours; a mutant's bloated body is raw flesh */
  private recolour(i: number, kind: InfKind) {
    if (this.kindOf[i] === kind) return;
    this.kindOf[i] = kind;
    this.parts.eyes.setColorAt(i, InfectedView.EYE[kind]);
    const top: PartKey[] = ['torso', 'upperL', 'upperR', 'foreL', 'foreR'], bottom: PartKey[] = ['hips', 'thighL', 'thighR', 'shinL', 'shinR'];
    for (const k of top) this.parts[k].setColorAt(i, kind === 'mutant' ? InfectedView.FLESH : this.shirt(i));
    for (const k of bottom) this.parts[k].setColorAt(i, kind === 'mutant' ? InfectedView.FLESH : this.pant(i));
    for (const m of Object.values(this.parts)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  update(list: Infected[], time: number) {
    const n = Math.min(list.length, this.max);
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(this.root);
    for (let i = 0; i < n; i++) {
      const z = list[i];
      // whole-body pose: hunched, leaning into the chase, toppling backwards when floored or dead
      this.recolour(i, z.kind);
      let fall = 0, lean = 0.06;
      if (z.state === 'chase') lean = z.kind === 'runner' ? 0.42 : 0.2;
      if (z.state === 'charge') lean = z.t < 0.7 ? -0.15 : 0.5;
      if (z.state === 'windup') lean = -0.05 + Math.min(1, z.t / 0.45) * 0.4;
      if (z.state === 'stagger') lean = -0.3;
      if (z.state === 'down' || z.state === 'dead') fall = Math.min(1, Math.max(0, z.t) / 0.45);
      if (z.state === 'down' && z.t > 2.1) fall = Math.max(0, 1 - (z.t - 2.1) / 0.5);
      this.root.makeTranslation(z.x, z.y + fall * 0.15, z.z);
      this.e.set(-lean * (1 - fall) + fall * Math.PI / 2, z.yaw, 0, 'YXZ');
      this.root.multiply(this.tmp.makeRotationFromEuler(this.e));
      const sc = KINDS[z.kind].scale;
      this.root.multiply(this.tmp.makeScale(sc * (z.kind === 'mutant' ? 1.15 : z.kind === 'runner' ? 0.88 : 1), sc, sc)); // mutants bulk out, runners are wiry
      const right = new THREE.Vector3(1, 0, 0).transformDirection(this.root);
      const hunch = 0.35 + z.seed * 0.2, droop = (z.seed - 0.5) * 0.5;
      const ch = Math.cos(hunch), sh = Math.sin(hunch);
      const up = (x: number, y: number, zz: number) => P(x, 0.95 + y * ch, -y * sh + zz); // upper body, hunched about the pelvis
      const sw = Math.sin(z.gait), moving = z.state === 'chase' || z.state === 'idle' ? 1 : 0.15;
      const twitch = Math.sin(time * 9 + z.seed * 40) * 0.06;
      // hips, torso, head
      this.place('hips', i, this.tmp.makeTranslation(0, 0.95, 0));
      this.e.set(-hunch, 0, 0); this.place('torso', i, this.tmp.makeRotationFromEuler(this.e).setPosition(0, 0.98, 0));
      const hp = up(0, 0.72, 0.02);
      this.e.set(-hunch * 0.4 + 0.25, 0, droop, 'YXZ');
      const headM = new THREE.Matrix4().compose(hp.clone().applyMatrix4(this.root.clone().invert()), this.q.setFromEuler(this.e), this.one);
      this.place('head', i, headM); this.place('eyes', i, headM);
      for (const side of [-1, 1] as const) {
        const s = side < 0 ? 'L' : 'R';
        // arms: reaching for prey, flailing on the strike, limp when down
        let ax = z.state === 'climb' ? 2.75 + sw * side * 0.35 : z.state === 'windup' ? 2.2 - Math.min(1, z.t / 0.45) * 1.6 : z.state === 'chase' ? 1.3 + sw * side * 0.22 + twitch : 0.45 + sw * side * 0.25;
        let spread = 0.12 + (z.state === 'stagger' ? 0.6 : 0);
        if (fall) { ax *= 1 - fall; spread = 1.1 * fall; }
        const sho = up(side * 0.19, 0.46, 0);
        const dir = (a: number, sp: number) => new THREE.Vector3(side * Math.sin(sp), -Math.cos(a) * Math.cos(sp), -Math.sin(a) * Math.cos(sp)).transformDirection(this.root);
        const elb = sho.clone().addScaledVector(dir(ax, spread), UPPER);
        const fd = dir(ax + 0.35, spread * 0.6);
        const wri = elb.clone().addScaledVector(fd, FORE * 0.72), end = wri.clone().addScaledVector(fd, FORE * 0.3);
        this.seg(`upper${s}`, i, sho, elb, right); this.seg(`fore${s}`, i, elb, wri, right);
        this.seg(`wrist${s}`, i, wri, end, right); this.seg(`hand${s}`, i, end, end.clone().addScaledVector(fd, 0.1), right);
        // legs: shambling gait with bent knees
        const climbing = z.state === 'climb' ? 1 : 0;
        const a = (sw * side * 0.45 * moving + climbing * (0.5 + sw * side * 0.4)) * (1 - fall), k = (0.2 + Math.max(0, -sw * side) * 0.55 * moving + climbing * 0.9) * (1 - fall);
        const hip = P(side * 0.1, 0.91, 0);
        const kn = P(side * 0.1, 0.91 - Math.cos(a) * THIGH, -Math.sin(a) * THIGH);
        const ank = kn.clone().add(new THREE.Vector3(0, -Math.cos(a - k), -Math.sin(a - k)).transformDirection(this.root).multiplyScalar(SHIN));
        this.seg(`thigh${s}`, i, hip, kn, right); this.seg(`shin${s}`, i, kn, ank, right);
        this.m.copy(this.root).setPosition(ank).multiply(this.tmp.makeRotationY(Math.PI)); // shoes face +Z
        this.parts[`shoe${s}`].setMatrixAt(i, this.m);
      }
    }
    for (const p of Object.values(this.parts)) { p.count = n; p.instanceMatrix.needsUpdate = true; }
  }
}
