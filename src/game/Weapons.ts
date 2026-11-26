/**
 * Melee weapons and flares: what you carry, the weapon you see in your hand (swing animation on
 * the camera), and thrown flares that burn red and lure the infected.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '../physics/collision';
import type { Horde } from './Infected';

export type WeaponId = 'kick' | 'katana' | 'pipe';
type Spec = { range: number; arc: number; dmg: number; push: number; floor: boolean; tankStagger: boolean };
/** reach, swing width (cos of half-angle), damage, push; katana cuts wide and deep, the pipe floors */
export const SPECS: Record<Exclude<WeaponId, 'kick'>, Spec & { cooldown: number; name: string }> = {
  katana: { name: 'Katana', range: 2.7, arc: 0.2, dmg: 2, push: 3, floor: false, tankStagger: true, cooldown: 0.35 },
  pipe: { name: 'Steel pipe', range: 2.4, arc: 0.45, dmg: 1, push: 11, floor: true, tankStagger: true, cooldown: 0.65 },
};

export class Weapons {
  owned = new Set<WeaponId>(['kick']);
  equipped: WeaponId = 'kick';
  flares = 0;
  cd = 0;
  private swingT = 0;
  private view = new THREE.Group();
  private models: Partial<Record<WeaponId, THREE.Object3D>> = {};
  private flare: { mesh: THREE.Mesh; light: THREE.PointLight; vel: THREE.Vector3; landed: boolean; t: number } | null = null;

  constructor(private scene: THREE.Scene, camera: THREE.Camera, private world: CollisionWorld) {
    const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const black = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: 0x9a1418, roughness: 0.6 });
    // katana: curved-looking blade (tapered box), round guard, wrapped grip; held blade-up, right hand
    const kat = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.74, 0.032), steel);
    blade.geometry.translate(0, 0.37 + 0.13, 0);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.08, 4), steel); tip.position.y = 0.91; tip.scale.set(0.6, 1, 1);
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), black); guard.position.y = 0.125;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.24, 8), red); grip.position.y = 0;
    kat.add(blade, tip, guard, grip);
    // steel pipe with tape wrap
    const pipe = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 12), new THREE.MeshStandardMaterial({ color: 0x6b6e72, metalness: 0.9, roughness: 0.45 }));
    tube.position.y = 0.3;
    const tape = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 12), black); tape.position.y = 0;
    pipe.add(tube, tape);
    this.models = { katana: kat, pipe };
    for (const m of [kat, pipe]) { m.visible = false; m.traverse((o) => { (o as THREE.Mesh).castShadow = false; }); this.view.add(m); }
    this.view.position.set(0.3, -0.28, -0.45);
    camera.add(this.view);
  }

  give(w: WeaponId) { this.owned.add(w); this.equip(w); }
  equip(w: WeaponId) {
    if (!this.owned.has(w)) return;
    this.equipped = w;
    for (const [k, m] of Object.entries(this.models)) m!.visible = k === w;
  }
  reset() { this.owned = new Set(['kick']); this.equip('kick'); this.flares = 0; this.removeFlare(); }
  setVisible(v: boolean) { this.view.visible = v; }
  get label() { return (this.equipped === 'kick' ? 'Kick' : SPECS[this.equipped].name) + (this.flares ? ` · flares ${this.flares}` : ''); }

  /** strike with the equipped weapon (the kick is handled by the caller); returns how many were hit */
  swing(horde: Horde, px: number, py: number, pz: number, yaw: number, airborne: boolean): number {
    if (this.equipped === 'kick') return 0;
    const s = SPECS[this.equipped];
    this.cd = s.cooldown; this.swingT = 0.28;
    // a running or falling strike cuts deeper / hits harder
    return horde.hit(px, py, pz, yaw, airborne ? { ...s, dmg: s.dmg + 1, push: s.push * 1.3 } : s);
  }

  /** throw a flare from the eye along the view; it lands, burns red for 10 s and lures the infected */
  throwFlare(eye: THREE.Vector3, dir: THREE.Vector3) {
    if (this.flares <= 0) return false;
    this.flares--;
    this.removeFlare();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 4 }));
    const light = new THREE.PointLight(0xff3a20, 8, 22, 1.6);
    mesh.add(light); mesh.position.copy(eye).addScaledVector(dir, 0.6);
    this.scene.add(mesh);
    this.flare = { mesh, light, vel: dir.clone().multiplyScalar(17).add(new THREE.Vector3(0, 3, 0)), landed: false, t: 0 };
    return true;
  }
  private removeFlare() { if (this.flare) { this.scene.remove(this.flare.mesh); this.flare.light.dispose(); this.flare = null; } }

  update(dt: number, horde: Horde | null) {
    this.cd = Math.max(0, this.cd - dt);
    // swing: from raised-right across and down to the left, then back
    this.swingT = Math.max(0, this.swingT - dt);
    const u = this.swingT > 0 ? 1 - this.swingT / 0.28 : 0, k = Math.sin(u * Math.PI);
    this.view.rotation.set(-0.35 - k * 1.4, 0.25 + k * 0.9, -0.5 + k * 1.6);
    this.view.position.set(0.3 - k * 0.25, -0.28 + k * 0.08, -0.45 - k * 0.15);
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
        else { f.vel.set(hit.nx * 2, 0, hit.nz * 2); } // bounced off a wall: drop
      } else f.mesh.position.add(step);
      if (f.t > 4 && !f.landed) this.removeFlare();
    }
    if (f.t > 11) this.removeFlare();
  }
}
