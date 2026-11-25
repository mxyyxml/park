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
import type { CollisionWorld } from '../physics/collision';
import type { Building } from '../world/builder';

export type InfState = 'idle' | 'chase' | 'windup' | 'recover' | 'stagger' | 'down' | 'dead';
export interface Infected {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  yaw: number; hp: number; state: InfState; t: number; gait: number; speed: number;
  falling: boolean; seed: number; groanT: number; wanderYaw: number;
  detour: number; detourT: number;  // steering offset while going round an obstacle
  hx: number; hy: number; hz: number; // where it was placed, to rise again later
}
export interface Target { x: number; y: number; z: number; alive: boolean }
export type InfEvent = { type: 'hit'; dmg: number; fromX: number; fromZ: number } | { type: 'groan'; x: number; y: number; z: number } | { type: 'fallDeath' };

const R = 0.32, H = 1.7, G = 24;
const SIGHT = 24, REACH = 1.25, HIT_RANGE = 1.75, LEVEL = 1.6;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export class Horde {
  list: Infected[] = [];
  events: InfEvent[] = [];
  constructor(private world: CollisionWorld) {}

  /** Street walkers between the blocks plus small groups on some roofs (never the spawn roof). */
  populate(buildings: Building[], avoid: { x: number; z: number }, street = 36, roof = 22, seed = 7) {
    const r = rng(seed);
    this.list = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of buildings) { minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX); minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ); }
    const place = (x: number, y: number, z: number) => {
      const g = this.world.groundHeight(x, z, y + 1.2, 2.5);
      if (!g || Math.abs(g.y - y) > 0.6 || this.world.overlapCylinder(x, g.y + 0.15, z, R, H - 0.2)) return false;
      if (Math.hypot(x - avoid.x, z - avoid.z) < 18) return false;
      this.list.push({ hx: x, hy: g.y, hz: z, x, y: g.y, z, vx: 0, vy: 0, vz: 0, yaw: r() * Math.PI * 2, hp: 3, state: 'idle', t: r() * 3, gait: r() * 6, speed: 2.3 + r() * 1.4, falling: false, seed: r(), groanT: 2 + r() * 8, wanderYaw: r() * Math.PI * 2, detour: 0, detourT: 0 });
      return true;
    };
    for (let tries = 0; this.list.length < street && tries < street * 40; tries++) place(minX - 8 + r() * (maxX - minX + 16), 0, minZ - 8 + r() * (maxZ - minZ + 16));
    const roofs = buildings.filter((b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) > 160 && b.kind !== 'spire' && !(avoid.x >= b.minX && avoid.x <= b.maxX && avoid.z >= b.minZ && avoid.z <= b.maxZ));
    for (let tries = 0; this.list.length < street + roof && tries < roof * 60 && roofs.length; tries++) {
      const b = roofs[Math.floor(r() * roofs.length)];
      place(b.minX + 2 + r() * (b.maxX - b.minX - 4), b.h, b.minZ + 2 + r() * (b.maxZ - b.minZ - 4));
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

  update(dt: number, p: Target) {
    this.events.length = 0;
    for (const z of this.list) {
      const dx = p.x - z.x, dz = p.z - z.z, dist = Math.hypot(dx, dz), dy = p.y - z.y;
      // the dead rise again at their post, out of the runner's sight
      if (z.state === 'dead' && z.t > 25 && Math.hypot(p.x - z.hx, p.z - z.hz) > 60) {
        Object.assign(z, { x: z.hx, y: z.hy, z: z.hz, vx: 0, vy: 0, vz: 0, hp: 3, state: 'idle', t: 0, falling: false });
        continue;
      }
      if (dist > 140 && !z.falling && (z.state === 'idle' || z.state === 'chase')) continue; // far from the runner: frozen
      z.t += dt;
      // gravity: knocked off a ledge, or the floor ended
      if (!z.falling && !this.supported(z)) { z.falling = true; z.vy = 0; }
      if (z.falling) {
        z.vy -= G * dt; z.y += z.vy * dt;
        this.move(z, z.vx * dt, z.vz * dt, false);
        const g = this.world.groundHeight(z.x, z.z, z.y + 0.6 - z.vy * dt, 0.7 - z.vy * dt);
        if (g && z.y <= g.y + 0.02 && z.vy <= 0) {
          z.y = g.y; z.falling = false;
          if (z.vy < -11 && z.state !== 'dead') { z.state = 'dead'; z.t = 0; z.hp = 0; this.events.push({ type: 'fallDeath' }); }
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
          if (sameLevel && dist < SIGHT) { z.state = 'chase'; z.t = 0; this.events.push({ type: 'groan', x: z.x, y: z.y + 1.6, z: z.z }); }
          break;
        }
        case 'chase': {
          if (!sameLevel || dist > SIGHT * 1.6) { z.state = 'idle'; z.t = 0; break; }
          const sp = z.speed;
          z.yaw = turn(z.yaw, this.steer(z, Math.atan2(-dx, -dz), sp, dt), dt * 6);
          z.gait += dt * sp * 2.6;
          if (dist < REACH) { z.state = 'windup'; z.t = 0; }
          break;
        }
        case 'windup':
          z.yaw = turn(z.yaw, Math.atan2(-dx, -dz), dt * 6);
          if (z.t > 0.45) {
            if (dist < HIT_RANGE && Math.abs(dy) < LEVEL && p.alive) this.events.push({ type: 'hit', dmg: 22, fromX: z.x, fromZ: z.z });
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
        if (z.groanT < 0 && dist < 40) { z.groanT = 4 + z.seed * 7; this.events.push({ type: 'groan', x: z.x, y: z.y + 1.6, z: z.z }); }
      }
    }
  }

  /** Runner's kick: everything in a short cone in front is knocked back. Returns how many were hit. */
  kick(px: number, py: number, pz: number, yaw: number, power: number): number {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let n = 0;
    for (const z of this.list) {
      if (z.state === 'dead' || z.falling) continue;
      const dx = z.x - px, dz = z.z - pz, d = Math.hypot(dx, dz);
      if (d > 2.4 || Math.abs(z.y - py) > LEVEL || (d > 0.4 && (dx * fx + dz * fz) / d < 0.45)) continue;
      n++;
      z.hp -= power >= 12 ? 2 : 1;
      z.vx = fx * power; z.vz = fz * power;
      z.state = z.hp <= 0 ? 'dead' : power >= 12 ? 'down' : 'stagger';
      z.t = 0;
    }
    return n;
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
type Part = { mesh: THREE.InstancedMesh; pivot: THREE.Vector3; axis: 'armL' | 'armR' | 'legL' | 'legR' | 'none' };

export class InfectedView {
  group = new THREE.Group();
  private parts: Part[] = [];
  private m = new THREE.Matrix4(); private root = new THREE.Matrix4(); private local = new THREE.Matrix4();
  private tmp = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler();

  constructor(private max: number) {
    this.group.name = 'infected';
    const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x7d8a7a, roughness: 0.7 });
    const eyes = new THREE.MeshStandardMaterial({ color: 0x222211, emissive: 0xd8e27a, emissiveIntensity: 2.2 });
    const cap = (r: number, len: number) => { const g = new THREE.CapsuleGeometry(r, len, 4, 8); g.translate(0, -(len / 2 + r), 0); return g; };
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pivot: [number, number, number], axis: Part['axis'], color?: (i: number) => THREE.Color) => {
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.count = 0;
      if (color) for (let i = 0; i < max; i++) mesh.setColorAt(i, color(i));
      this.parts.push({ mesh, pivot: new THREE.Vector3(...pivot), axis });
      this.group.add(mesh);
    };
    const shirts = [0x3b3f45, 0x5a4636, 0x2f3b4a, 0x6b6b5e, 0x4a2f2f, 0x30402f].map((c) => new THREE.Color(c));
    const pants = [0x23262b, 0x3a3a40, 0x2b3340, 0x40372c].map((c) => new THREE.Color(c));
    const torso = new THREE.CapsuleGeometry(0.19, 0.42, 4, 10); torso.scale(1.15, 1, 0.75); torso.translate(0, 0.2, 0);
    add(torso, cloth, [0, 1.06, 0], 'none', (i) => shirts[i % shirts.length]);
    const head = new THREE.SphereGeometry(0.125, 12, 10); head.scale(0.9, 1.1, 1);
    add(head, skin, [0, 1.62, 0.02], 'none');
    const eyeG = new THREE.SphereGeometry(0.018, 6, 4); const eyeL = eyeG.clone().translate(-0.042, 0.02, -0.11); const eyeR = eyeG.clone().translate(0.042, 0.02, -0.11);
    add(mergeTwo(eyeL, eyeR), eyes, [0, 1.62, 0.02], 'none');
    add(cap(0.06, 0.48), skin, [-0.25, 1.46, 0], 'armL');
    add(cap(0.06, 0.48), skin, [0.25, 1.46, 0], 'armR');
    add(cap(0.085, 0.66), cloth, [-0.1, 0.92, 0], 'legL', (i) => pants[i % pants.length]);
    add(cap(0.085, 0.66), cloth, [0.1, 0.92, 0], 'legR', (i) => pants[(i + 1) % pants.length]);
  }

  update(list: Infected[], time: number) {
    const n = Math.min(list.length, this.max);
    for (let i = 0; i < n; i++) {
      const z = list[i];
      // whole-body pose: lean while chasing, topple backwards when floored or dead
      let fall = 0, lean = 0.08;
      if (z.state === 'chase') lean = 0.22;
      if (z.state === 'windup') lean = -0.1 + Math.min(1, z.t / 0.45) * 0.45;
      if (z.state === 'stagger') lean = -0.3;
      if (z.state === 'down' || z.state === 'dead') fall = Math.min(1, Math.max(0, z.t) / 0.45);
      if (z.state === 'down' && z.t > 2.1) fall = Math.max(0, 1 - (z.t - 2.1) / 0.5);
      this.root.makeTranslation(z.x, z.y + fall * 0.2, z.z);
      this.e.set(-lean * (1 - fall) + fall * Math.PI / 2, z.yaw, 0, 'YXZ');
      this.root.multiply(this.tmp.makeRotationFromEuler(this.e));
      const sw = Math.sin(z.gait), moving = z.state === 'chase' || z.state === 'idle' ? 1 : 0.2;
      const twitch = Math.sin(time * 9 + z.seed * 40) * 0.08;
      for (const p of this.parts) {
        let ax = 0, az = 0;
        if (p.axis === 'armL' || p.axis === 'armR') {
          const side = p.axis === 'armL' ? 1 : -1;
          // arms reach forward toward prey, flailing on the strike
          ax = z.state === 'windup' ? 2.3 - Math.min(1, z.t / 0.45) * 1.7 : z.state === 'chase' ? 1.35 + sw * side * 0.25 + twitch : 0.5 + sw * side * 0.3;
          az = side * (0.12 + (z.state === 'stagger' ? 0.6 : 0));
          if (fall) { ax *= 1 - fall; az = side * 1.1 * fall; }
        } else if (p.axis === 'legL' || p.axis === 'legR') {
          const side = p.axis === 'legL' ? 1 : -1;
          ax = sw * side * 0.55 * moving * (1 - fall);
        }
        this.e.set(ax, 0, az, 'XYZ');
        this.local.makeRotationFromEuler(this.e).setPosition(p.pivot);
        this.m.multiplyMatrices(this.root, this.local);
        p.mesh.setMatrixAt(i, this.m);
      }
    }
    for (const p of this.parts) { p.mesh.count = n; p.mesh.instanceMatrix.needsUpdate = true; }
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.getAttribute(name) as THREE.BufferAttribute, B = b.getAttribute(name) as THREE.BufferAttribute;
    const arr = new Float32Array(A.array.length + B.array.length); arr.set(A.array as Float32Array); arr.set(B.array as Float32Array, A.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize));
  }
  const ia = a.index!.array, ib = b.index!.array, off = a.getAttribute('position').count;
  const idx = new Uint32Array(ia.length + ib.length); idx.set(ia); for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + off;
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
