/**
 * Inventory (two slots), held-weapon animation and thrown flares.
 *
 * The animation works in view space: each pose is a grip position (where the right hand holds the
 * handle) and a blade direction. Poses blend for idle (breathing), running (gait sway, then a
 * low "runner's carry" at sprint), the draw when you switch, and swings built from wind-up ->
 * strike -> follow-through -> recover keyframes. The body's arm IK reaches for the grip and the
 * weapon is attached to where the hand actually lands, so they never separate. Damage happens at
 * the strike frame, not on the button press.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '../physics/collision';
import type { Horde } from './Infected';

export type ItemKind = 'katana' | 'pipe' | 'flares';
export interface Item { kind: ItemKind; count: number }
type MeleeKind = 'katana' | 'pipe';
type Spec = { range: number; arc: number; dmg: number; push: number; floor: boolean; tankStagger: boolean };
export const SPECS: Record<MeleeKind, Spec & { dur: number; impact: number; name: string }> = {
  katana: { name: 'Katana', range: 2.7, arc: 0.2, dmg: 2, push: 3, floor: false, tankStagger: true, dur: 0.46, impact: 0.42 },
  pipe: { name: 'Steel pipe', range: 2.4, arc: 0.45, dmg: 1, push: 11, floor: true, tankStagger: true, dur: 0.66, impact: 0.5 },
};
export const ITEM_NAME: Record<ItemKind, string> = { katana: 'Katana', pipe: 'Steel pipe', flares: 'Flares' };

// ---- poses (view space: x right, y up, -z forward) --------------------------------------------
type Pose = { g: THREE.Vector3; b: THREE.Vector3 };
const P = (gx: number, gy: number, gz: number, bx: number, by: number, bz: number): Pose => ({ g: new THREE.Vector3(gx, gy, gz), b: new THREE.Vector3(bx, by, bz).normalize() });
// all grips sit within arm's reach of the shoulders (view space ~(±0.19, -0.25, 0.13), arm ~0.56 m)
const POSES = {
  katana: {
    idle: P(0.12, -0.3, -0.34, -0.15, 0.85, -0.5),        // two-handed guard, blade up and forward
    run: P(0.2, -0.38, -0.26, 0.35, 0.45, 0.82),          // sprint: blade trailing low behind
    draw: P(0.28, -0.7, -0.1, 0.6, 0.2, 0.75),
    // swings: [wind-up, mid (blade forward), end]; the three cuts cycle
    swings: [
      // hands stay 0.28-0.42 m in front; the blade crosses the view diagonally so the cut reads
      [P(0.2, -0.12, -0.3, 0.55, 0.75, 0.35), P(0.06, -0.22, -0.4, -0.55, 0.45, -0.7), P(-0.06, -0.3, -0.36, -0.9, -0.25, -0.35)],   // high right -> low left
      [P(0.0, -0.12, -0.3, -0.55, 0.75, 0.35), P(0.08, -0.22, -0.4, 0.55, 0.45, -0.7), P(0.22, -0.32, -0.34, 0.9, -0.25, -0.35)],    // high left -> low right
      [P(0.24, -0.24, -0.28, 0.9, 0.2, 0.35), P(0.08, -0.25, -0.42, -0.45, 0.15, -0.88), P(-0.08, -0.27, -0.36, -0.95, 0.1, -0.3)],  // flat cut
    ],
  },
  pipe: {
    idle: P(0.22, -0.32, -0.32, 0.05, 0.9, -0.4),
    run: P(0.22, -0.17, -0.2, 0.15, 0.22, 0.96),          // resting on the shoulder
    draw: P(0.28, -0.7, -0.1, 0.4, 0.3, 0.85),
    swings: [
      [P(0.2, -0.06, -0.22, 0.15, 0.55, 0.8), P(0.14, -0.16, -0.4, 0.05, 0.75, -0.65), P(0.08, -0.38, -0.36, 0, -0.5, -0.85)],   // overhead smash
      [P(0.36, -0.22, -0.22, 0.8, 0.45, 0.35), P(0.12, -0.26, -0.42, -0.4, 0.35, -0.85), P(-0.04, -0.3, -0.34, -0.9, 0.15, -0.4)], // side swing
    ],
  },
  flares: {
    idle: P(0.22, -0.32, -0.32, 0.2, 0.9, -0.3),
    run: P(0.22, -0.36, -0.26, 0.3, 0.8, 0.2),
    draw: P(0.28, -0.7, -0.12, 0.3, 0.8, 0.3),
    swings: [[P(0.3, -0.08, -0.16, 0.3, 0.9, 0.4), P(0.2, -0.12, -0.36, 0.1, 0.7, -0.6), P(0.08, -0.2, -0.44, 0, 0.4, -0.9)]],  // throw
  },
};
const SHOULDER_R = new THREE.Vector3(0.19, -0.25, 0.13), SHOULDER_L = new THREE.Vector3(-0.19, -0.25, 0.13), REACH = 0.52;
/** keep a hand target where the arm can actually get to, so the weapon never parts from the hand */
function reach(p: THREE.Vector3, shoulder: THREE.Vector3) {
  const d = p.clone().sub(shoulder), l = d.length();
  return l > REACH ? shoulder.clone().addScaledVector(d, REACH / l) : p;
}
const ease = (t: number) => t * t * (3 - 2 * t);
const easeOutBack = (t: number) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const qUp = new THREE.Vector3(0, 1, 0);
function blend(a: Pose, b: Pose, t: number, out: Pose) {
  out.g.copy(a.g).lerp(b.g, t);
  const qa = new THREE.Quaternion().setFromUnitVectors(qUp, a.b), qb = new THREE.Quaternion().setFromUnitVectors(qUp, b.b);
  out.b.copy(qUp).applyQuaternion(qa.slerp(qb, t));
  return out;
}

export class Weapons {
  slots: (Item | null)[] = [null, null];
  active = 0;
  private swingT = -1; private swingI = 0; private swingKind: ItemKind = 'katana'; private struck = false;
  private drawT = 1;
  private pose: Pose = P(0.2, -0.3, -0.42, 0, 1, 0);
  private runBlend = 0; private t = 0;
  private view = new THREE.Group();
  private models: Record<ItemKind, THREE.Object3D>;
  private flare: { mesh: THREE.Mesh; light: THREE.PointLight; vel: THREE.Vector3; landed: boolean; t: number } | null = null;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, private world: CollisionWorld) {
    const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const black = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: 0x9a1418, roughness: 0.6 });
    // models are built with the grip at the origin and the blade along +Y
    const kat = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.74, 0.032), steel); blade.position.y = 0.5;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.08, 4), steel); tip.position.y = 0.91; tip.scale.set(0.6, 1, 1);
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), black); guard.position.y = 0.125;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.24, 8), red);
    kat.add(blade, tip, guard, grip);
    const pipe = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 12), new THREE.MeshStandardMaterial({ color: 0x6b6e72, metalness: 0.9, roughness: 0.45 }));
    tube.position.y = 0.3;
    pipe.add(tube, new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 12), black));
    const flare = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0xc01a14, roughness: 0.5 }));
    stick.position.y = 0.06;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.03, 8), black); cap.position.y = 0.18;
    flare.add(stick, cap);
    this.models = { katana: kat, pipe, flares: flare };
    for (const m of Object.values(this.models)) { m.visible = false; this.view.add(m); }
    camera.add(this.view);
  }

  // ---- inventory --------------------------------------------------------------------------------
  get held(): Item | null { return this.slots[this.active]; }
  reset() { this.slots = [null, null]; this.active = 0; this.swingT = -1; this.removeFlare(); }
  /** pick something up: flares stack; else an empty slot (preferring the hand); else swap with the hand. Returns what was dropped. */
  give(kind: ItemKind, count = kind === 'flares' ? 3 : 1): Item | null {
    const stack = this.slots.find((s) => s?.kind === 'flares');
    if (kind === 'flares' && stack) { stack.count += count; return null; }
    const free = this.slots[this.active] ? this.slots.findIndex((s) => !s) : this.active;
    const item = { kind, count };
    if (free >= 0) { this.slots[free] = item; if (free === this.active) this.drawT = 0; return null; }
    const dropped = this.slots[this.active];
    this.slots[this.active] = item; this.drawT = 0; this.swingT = -1;
    return dropped;
  }
  select(i: number) { if (i !== this.active) { this.active = i; this.drawT = 0; this.swingT = -1; } }
  get label() { return this.slots.map((s, i) => `${i === this.active ? '▸' : ' '}${i + 1} ${s ? ITEM_NAME[s.kind] + (s.kind === 'flares' ? ` ×${s.count}` : '') : '—'}`).join('   '); }
  get busy() { return this.swingT >= 0 || this.drawT < 1; }

  /** F: start a swing or a throw with what's in hand. false = empty hand (caller kicks) */
  use(): boolean {
    const h = this.held;
    if (!h) return false;
    if (this.busy) return true;
    const sw = POSES[h.kind].swings;
    this.swingKind = h.kind; this.swingT = 0; this.struck = false; this.swingI = (this.swingI + 1) % sw.length;
    return true;
  }

  /**
   * Advance the animation. Returns the melee spec at the exact strike frame of a swing (the caller
   * applies the hit), or 'throw' at the release frame of a flare throw.
   */
  update(dt: number, c: { speed: number; gait: number; airborne: boolean; eye: THREE.Vector3; look: THREE.Vector3 }, horde: Horde | null): (Spec & { name: string }) | 'throw' | null {
    this.t += dt;
    this.drawT = Math.min(1, this.drawT + dt / 0.35);
    this.updateFlare(dt, horde);
    const h = this.held;
    if (!h) { this.view.visible = false; return null; }
    const set = POSES[h.kind];
    // base: idle with breathing, blending to the run carry with speed; gait sway on top
    const run = Math.min(1, Math.max(0, (c.speed - 5.5) / 3));
    this.runBlend += (run - this.runBlend) * Math.min(1, dt * 6);
    const base = blend(set.idle, set.run, this.runBlend, P(0, 0, 0, 0, 1, 0));
    const moving = Math.min(1, c.speed / 4);
    base.g.y += Math.sin(this.t * 1.7) * 0.006 * (1 - moving) + (Math.abs(Math.sin(c.gait)) - 0.5) * 0.035 * moving;
    base.g.x += Math.cos(c.gait) * 0.022 * moving;
    if (c.airborne) { base.g.y += 0.05; base.g.z += 0.04; }
    let out = base, stiff = 28, event: (Spec & { name: string }) | 'throw' | null = null;
    if (this.drawT < 1) {
      out = blend(set.draw, base, easeOutBack(this.drawT), P(0, 0, 0, 0, 1, 0)); stiff = 34;
    } else if (this.swingT >= 0) {
      const kind = this.swingKind, dur = kind === 'flares' ? 0.45 : SPECS[kind as MeleeKind].dur;
      const impact = kind === 'flares' ? 0.55 : SPECS[kind as MeleeKind].impact;
      this.swingT += dt / dur;
      const u = this.swingT, [wind, mid, end] = set.swings[this.swingI % set.swings.length];
      const tmp = P(0, 0, 0, 0, 1, 0);
      if (u < 0.3) out = blend(base, wind, ease(u / 0.3), tmp);                                   // wind-up (anticipation)
      else if (u < 0.42) out = blend(wind, mid, Math.pow((u - 0.3) / 0.12, 1.4), tmp);          // strike: accelerating
      else if (u < 0.56) out = blend(mid, end, 1 - Math.pow(1 - (u - 0.42) / 0.14, 2), tmp);   // follow-through: decelerating
      else if (u < 0.7) out = blend(end, end, 0, tmp);                                           // hold
      else out = blend(end, base, ease((u - 0.7) / 0.3), tmp);                                   // recover
      stiff = u > 0.28 && u < 0.6 ? 90 : 40;
      if (!this.struck && u >= impact) { this.struck = true; event = kind === 'flares' ? 'throw' : SPECS[kind as MeleeKind]; }
      if (u >= 1) this.swingT = -1;
    }
    this.pose.g.copy(out.g); this.pose.b.copy(out.b);
    this.stiff = stiff;
    if (event === 'throw') this.throwFlare(c.eye, c.look);
    return event;
  }
  stiff = 28;
  /** hand targets for the body: katana is two-handed (left hand lower on the grip) except at a sprint */
  handTargets() {
    const h = this.held;
    if (!h) return null;
    const left = h.kind === 'katana' && this.runBlend < 0.6 ? reach(this.pose.g.clone().addScaledVector(this.pose.b, -0.11), SHOULDER_L) : null;
    return { right: reach(this.pose.g.clone(), SHOULDER_R), left, blade: this.pose.b.clone(), stiff: this.stiff };
  }
  /** put the model in the hand where the arm actually reached (view space) */
  attach(handView: THREE.Vector3, show: boolean) {
    const h = this.held;
    this.view.visible = show && !!h;
    for (const [k, m] of Object.entries(this.models)) m.visible = !!h && k === h.kind;
    if (!h) return;
    const m = this.models[h.kind];
    m.position.copy(handView).addScaledVector(this.pose.b, h.kind === 'katana' ? -0.03 : -0.02);
    m.quaternion.setFromUnitVectors(qUp, this.pose.b);
    if (h.kind === 'flares') m.visible = h.count > 0 && !(this.swingT > 0.55);
  }

  // ---- flares -----------------------------------------------------------------------------------
  private throwFlare(eye: THREE.Vector3, dir: THREE.Vector3) {
    const h = this.held;
    if (!h || h.kind !== 'flares' || h.count <= 0) return;
    if (--h.count === 0) this.slots[this.active] = null;
    this.removeFlare();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 4 }));
    const light = new THREE.PointLight(0xff3a20, 8, 22, 1.6);
    mesh.add(light); mesh.position.copy(eye).addScaledVector(dir, 0.6);
    this.scene.add(mesh);
    this.flare = { mesh, light, vel: dir.clone().multiplyScalar(17).add(new THREE.Vector3(0, 3, 0)), landed: false, t: 0 };
  }
  private removeFlare() { if (this.flare) { this.scene.remove(this.flare.mesh); this.flare.light.dispose(); this.flare = null; } }
  private updateFlare(dt: number, horde: Horde | null) {
    const f = this.flare;
    if (!f) return;
    f.t += dt;
    f.light.intensity = 6 + Math.sin(f.t * 37) * 1.5 + Math.sin(f.t * 11) * 1.5; // flicker
    if (!f.landed) {
      f.vel.y -= 20 * dt;
      const step = f.vel.clone().multiplyScalar(dt), len = step.length();
      const hit = this.world.raycast(f.mesh.position.x, f.mesh.position.y, f.mesh.position.z, step.x / len, step.y / len, step.z / len, len + 0.05);
      if (hit) {
        f.mesh.position.set(hit.x + hit.nx * 0.05, hit.y + hit.ny * 0.05, hit.z + hit.nz * 0.05);
        if (hit.ny > 0.6) { f.landed = true; f.mesh.rotation.z = Math.PI / 2; if (horde) horde.lure = { x: hit.x, y: hit.y, z: hit.z, t: 10 }; }
        else f.vel.set(hit.nx * 2, 0, hit.nz * 2); // off a wall: drop
      } else f.mesh.position.add(step);
      if (f.t > 4 && !f.landed) this.removeFlare();
    }
    if (f.t > 11) this.removeFlare();
  }
}
