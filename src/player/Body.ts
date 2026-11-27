/**
 * Procedural full-body runner: arms + hands (with articulated fingers), torso, legs and shoes,
 * animated by two-bone IK toward procedurally chosen targets. Hands reach for real world contact
 * points (ledges, walls, vault obstacles, pipes, ziplines); feet follow the gait phase of the
 * simulation so footstep sounds, camera bob and visible steps stay in sync.
 *
 * Used for the first-person body (arms in view space, legs/torso in world space) and for
 * ghost/replay runners (everything driven by a recorded driver).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { P, PState, TraverseKind } from './PlayerController';
import type { TexSet } from '../render/textures';
import { withFog } from '../render/materials';
import { CharacterAssets, instantiate } from './assets';

/** The subset of controller state the body needs (PlayerController satisfies it; ghosts fake it). */
export interface BodyDriver {
  state: PState; stateTime: number;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number; pitch: number;
  gaitPhase: number; height: number; crouched: boolean; airTime: number; stumble: number;
  wallNX: number; wallNZ: number; wallSide: number; wallPointX: number; wallPointZ: number; alongX: number; alongZ: number;
  ledgeX: number; ledgeY: number; ledgeZ: number;
  tKind: TraverseKind; tHand: { x: number; y: number; z: number }; tDirX: number; tDirZ: number; tDur: number;
  pipe: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number } | null; pipeNX: number; pipeNZ: number; pipeClimbPhase: number;
  zip: { ax: number; ay: number; az: number; bx: number; by: number; bz: number } | null; zipT: number;
  balance: number;
}

// Scratch vectors: during update() V() hands out pooled vectors (reset each call, never stored past
// the frame); outside it (construction, persistent fields) it allocates as usual.
const POOL = Array.from({ length: 768 }, () => new THREE.Vector3());
let pooling = false, pIdx = 0;
const V = (x = 0, y = 0, z = 0) => (pooling && pIdx < POOL.length ? POOL[pIdx++].set(x, y, z) : new THREE.Vector3(x, y, z));

/**
 * Shadow-only parts of the first-person body: the mesh draws nothing for the camera (draw range
 * collapsed just before its camera draw) but still renders into the sun's shadow maps.
 */
function setSeen(o: THREE.Object3D, seen: boolean) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.userData.shadowHooks) {
      m.userData.shadowHooks = true;
      m.onBeforeRender = (_r, _s, _c, geo) => geo.setDrawRange(0, m.userData.hidden ? 0 : Infinity);
      m.onBeforeShadow = (_r, _o, _c, _sc, geo) => geo.setDrawRange(0, Infinity);
    }
    m.userData.hidden = !seen;
  });
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---- geometry helpers ----------------------------------------------------------------------
/** Tapered limb along +Y (0..len) with rounded ends and an optional muscle bulge. */
function limbGeo(len: number, r0: number, r1: number, bulge = 0, flatten = 1, seg = 14): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 14;
  // bottom cap
  for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + (i / 4) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(0.0015, Math.cos(a) * r0), Math.sin(a) * r0 * 0.6)); }
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const r = r0 + (r1 - r0) * t + bulge * Math.sin(Math.PI * Math.pow(t, 0.8));
    pts.push(new THREE.Vector2(r, t * len));
  }
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(0.0015, Math.cos(a) * r1), len + Math.sin(a) * r1 * 0.6)); }
  const g = new THREE.LatheGeometry(pts, seg);
  g.scale(1, 1, flatten);
  return g;
}

function setSegment(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, ref: THREE.Vector3) {
  const y = V().subVectors(b, a);
  const len = y.length();
  if (len < 1e-5) return;
  y.divideScalar(len);
  let x = V().crossVectors(y, ref);
  if (x.lengthSq() < 1e-6) x = V().crossVectors(y, new THREE.Vector3(0, 0, 1));
  x.normalize();
  const z = V().crossVectors(x, y).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  obj.quaternion.setFromRotationMatrix(m);
  obj.position.copy(a);
}

/** Two-bone IK: returns elbow/knee position. Target is clamped to reach. */
function ik(S: THREE.Vector3, T: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, outE: THREE.Vector3, outT: THREE.Vector3) {
  const dir = V().subVectors(T, S);
  let d = dir.length();
  if (d < 1e-5) { dir.set(0, -1, 0); d = 1e-5; } else dir.divideScalar(d);
  d = clamp(d, Math.abs(a - b) + 0.01, a + b - 0.002);
  outT.copy(S).addScaledVector(dir, d);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pv = V().subVectors(pole, S);
  pv.addScaledVector(dir, -pv.dot(dir));
  if (pv.lengthSq() < 1e-8) pv.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pv.normalize();
  outE.copy(S).addScaledVector(dir, a * cosA).addScaledVector(pv, a * sinA);
}

// ---- hand ----------------------------------------------------------------------------------
/** Sculpted palm: tapered toward the wrist, arched back, padded heel and thenar. */
function palmGeo(side: number): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(0.08, 0.09, 0.028, 5, 0.012);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = (y + 0.045) / 0.09; // 0 wrist .. 1 knuckles
    x *= 0.84 + 0.16 * t;
    const across = x / 0.042;
    if (z > 0) z += 0.0035 * (1 - across * across) * (0.4 + 0.6 * t); // arched back of hand
    else {
      const thenar = Math.max(0, -across * side) * Math.sin(Math.PI * Math.min(1, t * 1.4));
      z -= 0.005 * thenar + 0.0025 * Math.sin(Math.PI * t); // fleshy palm
    }
    y -= 0.007 * Math.max(0, across * side) * t; // knuckle line slopes toward the little finger
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

class Hand {
  group = new THREE.Group();
  fingers: THREE.Group[][] = [];
  thumb: THREE.Group[] = [];
  curl = 0.4;
  constructor(public side: number, skin: THREE.Material, glove: THREE.Material, accent: THREE.Material, nail: THREE.Material, pad: THREE.Material) {
    // local frame: +Y fingers, +Z back of hand, palm faces -Z; thumb on the -side*X side
    // fingerless glove: bare back of hand and fingers; the glove is a palm grip, knuckle guard and wrist strap
    const palm = new THREE.Mesh(palmGeo(side), skin);
    palm.position.set(0, 0.046, 0);
    const shell = new THREE.Mesh(palmGeo(side), glove);
    shell.scale.set(1.04, 0.9, 1.12); shell.position.set(0, 0.042, -0.0035);
    const guard = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.016, 0.008, 3, 0.004), pad);
    guard.position.set(0, 0.083, 0.016);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(0.058, 0.05, 0.006, 3, 0.003), pad);
    grip.position.set(0, 0.04, -0.02);
    // glove back panel only over the lower half of the back of the hand
    const backPanel = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.03, 0.006, 3, 0.003), glove);
    backPanel.position.set(0, 0.026, 0.016);
    this.group.add(shell, backPanel);
    void palm;
    const strap = new THREE.Mesh(new RoundedBoxGeometry(0.078, 0.018, 0.034, 3, 0.008), glove);
    strap.position.set(0, 0.006, 0);
    const tab = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.016, 0.006, 2, 0.002), accent);
    tab.position.set(0.012 * side, 0.006, 0.019);
    this.group.add(palm, guard, grip, strap, tab);
    // fingers: index, middle, ring, little
    const lens = [[0.041, 0.025, 0.02], [0.045, 0.028, 0.021], [0.043, 0.027, 0.02], [0.033, 0.02, 0.018]];
    const rad = [0.0093, 0.0096, 0.009, 0.0079];
    for (let f = 0; f < 4; f++) {
      const chain: THREE.Group[] = [];
      let parent: THREE.Object3D = this.group;
      const x = (-0.029 + f * 0.0193) * side;
      const r = rad[f];
      for (let k = 0; k < 3; k++) {
        const j = new THREE.Group();
        j.position.set(k === 0 ? x : 0, k === 0 ? 0.091 - Math.max(0, f - 1) * 0.005 - (f === 0 ? 0.002 : 0) : lens[f][k - 1], 0);
        const r0 = r * (1 - k * 0.09), r1 = r * (0.9 - k * 0.1);
        const seg = new THREE.Mesh(limbGeo(lens[f][k], r0, r1, 0.0006, 0.82, 10), skin);
        const joint = new THREE.Mesh(new THREE.SphereGeometry(r0 * 1.02, 10, 8), skin);
        joint.scale.set(1, 1, 0.84);
        j.add(seg, joint);
        if (k === 2) {
          const n = new THREE.Mesh(new RoundedBoxGeometry(r1 * 1.4, lens[f][k] * 0.55, 0.002, 2, 0.0009), nail);
          n.position.set(0, lens[f][k] * 0.58, r1 * 0.78);
          j.add(n);
        }
        parent.add(j);
        chain.push(j);
        parent = j;
      }
      this.fingers.push(chain);
    }
    // thumb: metacarpal (gloved), proximal, distal with nail
    let parent: THREE.Object3D = this.group;
    const tl = [0.034, 0.03, 0.026];
    for (let k = 0; k < 3; k++) {
      const j = new THREE.Group();
      if (k === 0) { j.position.set(-0.03 * side, 0.016, -0.008); j.rotation.set(-0.35, 0, 0.75 * side); }
      else j.position.set(0, tl[k - 1], 0);
      const r0 = 0.0118 - k * 0.0011;
      const seg = new THREE.Mesh(limbGeo(tl[k], r0, r0 * 0.88, 0.001, 0.85, 10), k < 1 ? glove : skin);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(r0, 10, 8), k < 1 ? glove : skin);
      j.add(seg, joint);
      if (k === 2) {
        const n = new THREE.Mesh(new RoundedBoxGeometry(r0 * 1.3, tl[k] * 0.5, 0.002, 2, 0.0009), nail);
        n.position.set(0, tl[k] * 0.6, r0 * 0.75);
        j.add(n);
      }
      parent.add(j); this.thumb.push(j); parent = j;
    }
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }
  setCurl(c: number) {
    this.curl = c;
    for (let f = 0; f < 4; f++) {
      const ch = this.fingers[f];
      const cc = c * (0.88 + f * 0.06);
      ch[0].rotation.x = -cc * 1.3; ch[1].rotation.x = -cc * 1.55; ch[2].rotation.x = -cc * 1.05;
      ch[0].rotation.z = (f - 1.5) * 0.07 * this.side * (1 - c);
    }
    // thumb closes across the palm as the grip tightens
    this.thumb[0].rotation.z = (0.75 - c * 0.35) * this.side;
    this.thumb[0].rotation.x = -0.35 - c * 0.45;
    this.thumb[1].rotation.x = -c * 0.6;
    this.thumb[2].rotation.x = -c * 0.75;
  }
}

interface HandLike { group: THREE.Group; curl: number; side: number; setCurl(c: number): void }

/** Sculpted, skinned hand from hand.glb: finger bones are curled about their local X axis. */
class SculptedHand implements HandLike {
  group = new THREE.Group();
  curl = 0.4;
  private fingers: THREE.Bone[][] = [];
  private thumb: THREE.Bone[] = [];
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private sign = 1;
  constructor(public side: number, src: THREE.Object3D, mats: Record<string, THREE.Material>) {
    const o = instantiate(src, mats);
    // the asset is a right hand (thumb on -X); mirror it for the left
    if (side < 0) o.scale.x = -1;
    this.group.add(o);
    const bone = (n: string) => { const b = o.getObjectByName(n) as THREE.Bone; this.rest.set(b, b.quaternion.clone()); return b; };
    for (let f = 0; f < 4; f++) this.fingers.push([0, 1, 2].map((k) => bone(`f${f}_${k}`)));
    this.thumb = [0, 1, 2].map((k) => bone(`t_${k}`));
    // which rotation direction closes the fingers toward the palm (-Z) depends on the exported bone frames
    const tip = this.fingers[1][2];
    this.group.updateMatrixWorld(true);
    const z0 = tip.getWorldPosition(new THREE.Vector3()).z;
    this.bend(this.fingers[1][0], 0.5);
    this.group.updateMatrixWorld(true);
    const z1 = tip.getWorldPosition(new THREE.Vector3()).z;
    this.sign = z1 < z0 ? 1 : -1;
    this.bend(this.fingers[1][0], 0);
  }
  private bend(b: THREE.Bone, a: number) {
    b.quaternion.copy(this.rest.get(b)!).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a * this.sign));
  }
  setCurl(c: number) {
    this.curl = c;
    for (let f = 0; f < 4; f++) {
      const cc = c * (0.88 + f * 0.06);
      this.bend(this.fingers[f][0], cc * 1.3); this.bend(this.fingers[f][1], cc * 1.55); this.bend(this.fingers[f][2], cc * 1.05);
    }
    this.bend(this.thumb[0], 0.25 + c * 0.45); this.bend(this.thumb[1], c * 0.6); this.bend(this.thumb[2], c * 0.75);
  }
}

// ---- shoe ----------------------------------------------------------------------------------
function buildShoe(white: THREE.Material, red: THREE.Material, dark: THREE.Material, side: number): THREE.Group {
  const g = new THREE.Group(); // origin at ankle; +Z forward (toe), +Y up
  const sole = new THREE.Mesh(new RoundedBoxGeometry(0.098, 0.034, 0.285, 3, 0.014), white);
  sole.position.set(0, -0.058, 0.055);
  const out = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.012, 0.29, 2, 0.005), red);
  out.position.set(0, -0.077, 0.055);
  const upper = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), white);
  upper.scale.set(0.047, 0.05, 0.135); upper.position.set(0, -0.03, 0.06);
  const toe = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), white);
  toe.scale.set(0.046, 0.03, 0.06); toe.position.set(0, -0.04, 0.145);
  const heel = new THREE.Mesh(new RoundedBoxGeometry(0.09, 0.07, 0.07, 3, 0.02), dark);
  heel.position.set(0, -0.015, -0.045);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.012, 8, 16), dark);
  collar.rotation.x = Math.PI / 2; collar.position.set(0, 0.012, -0.005);
  const swoosh = new THREE.Mesh(new RoundedBoxGeometry(0.004, 0.018, 0.12, 1, 0.002), red);
  swoosh.position.set(0.048 * side, -0.035, 0.05); swoosh.rotation.x = -0.25;
  g.add(sole, out, upper, toe, heel, collar, swoosh);
  for (let i = 0; i < 4; i++) {
    const lace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.008), dark);
    lace.position.set(0, 0.005 - i * 0.008, 0.035 + i * 0.022); lace.rotation.x = -0.4;
    g.add(lace);
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

interface Arm { upper: THREE.Mesh; fore: THREE.Mesh; cuff: THREE.Mesh; wrist: THREE.Mesh; hand: HandLike; elbow: THREE.Mesh; shoulderCap: THREE.Mesh;
  pos: THREE.Vector3; vel: THREE.Vector3; side: number }
interface Leg { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh; shoe: THREE.Group; side: number }

export interface BodyMaterials { skin: THREE.Material; glove: THREE.Material; jacket: THREE.Material; accent: THREE.Material; pants: THREE.Material; shoeWhite: THREE.Material; dark: THREE.Material; nail: THREE.Material; pad: THREE.Material; hair: THREE.Material }

export function makeBodyMaterials(fabric: TexSet | null, ghost = false): BodyMaterials {
  if (ghost) {
    const m = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1a1a, emissiveIntensity: 0.6, transparent: true, opacity: 0.4, depthWrite: false, roughness: 0.4 });
    return { skin: m, glove: m, jacket: m, accent: m, pants: m, shoeWhite: m, dark: m, nail: m, pad: m, hair: m };
  }
  const fab = (color: number, rough = 0.85) => {
    const p: THREE.MeshStandardMaterialParameters = { color, roughness: rough };
    if (fabric) { p.normalMap = fabric.normalMap; p.normalScale = new THREE.Vector2(0.6, 0.6); }
    const mm = withFog(new THREE.MeshStandardMaterial(p));
    if (fabric) { const t = fabric.normalMap.clone(); t.repeat.set(6, 6); t.needsUpdate = true; mm.normalMap = t; }
    return mm;
  };
  return {
    skin: withFog(new THREE.MeshPhysicalMaterial({ color: 0xc98f72, roughness: 0.5, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xff8a6a), clearcoat: 0.05 })),
    nail: withFog(new THREE.MeshStandardMaterial({ color: 0xe8b4a4, roughness: 0.25 })),
    pad: withFog(new THREE.MeshStandardMaterial({ color: 0x3a3c41, roughness: 0.9 })),
    hair: withFog(new THREE.MeshStandardMaterial({ color: 0x1b1512, roughness: 0.55, metalness: 0.05 })),
    glove: withFog(new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.7 })),
    jacket: fab(0xe9e9e6),
    accent: withFog(new THREE.MeshStandardMaterial({ color: 0xc8161e, roughness: 0.55 })),
    pants: fab(0x2c2f34, 0.9),
    shoeWhite: withFog(new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 })),
    dark: withFog(new THREE.MeshStandardMaterial({ color: 0x222326, roughness: 0.75 })),
  };
}

export class RunnerBody {
  root = new THREE.Group();      // world-space parts (legs, torso, head for ghosts)
  armRoot = new THREE.Group();   // arms: positioned in world each frame
  arms: Arm[] = [];
  legs: Leg[] = [];
  torso: THREE.Object3D;
  hips: THREE.Object3D;
  head: THREE.Group | null = null;
  firstPerson: boolean;
  private bodyYaw = 0;
  private t = 0;
  private landT = 9;
  private footSpring = [V(), V()];
  private footInit = false;
  visible = true;
  /**
   * Held item (first person): view-space targets for the gripping hand(s) and the blade direction,
   * set every frame by the weapon animation. Ignored during moves that need the hands (climb, hang...).
   */
  held: { right: THREE.Vector3; left: THREE.Vector3 | null; blade: THREE.Vector3; stiff: number } | null = null;
  /** where the right hand really is (view space) after the spring and IK: the weapon attaches here */
  rightHandView = new THREE.Vector3();

  // arm geometry constants
  static UPPER = 0.29; static FORE = 0.27;
  static THIGH = 0.44; static SHIN = 0.43;

  constructor(m: BodyMaterials, firstPerson: boolean, assets: CharacterAssets | null = null) {
    this.firstPerson = firstPerson;
    const matMap: Record<string, THREE.Material> = { skin: m.skin, glove: m.glove, pad: m.pad, nail: m.nail, accent: m.accent,
      jacket: m.jacket, shoe_white: m.shoeWhite, shoe_mid: m.shoeWhite, shoe_red: m.accent, shoe_dark: m.dark,
      pants: m.pants, hair: m.hair, dark: m.dark, metal: m.dark };
    for (const side of [-1, 1]) {
      const upper = new THREE.Mesh(assets ? assets.sleeveUpper : limbGeo(RunnerBody.UPPER, 0.05, 0.042, 0.008, 0.9), m.jacket);
      const fore = new THREE.Mesh(assets ? assets.sleeveFore : limbGeo(RunnerBody.FORE * 0.72, 0.043, 0.036, 0.004, 0.9), m.jacket);
      const cuff = new THREE.Mesh(limbGeo(0.03, 0.039, 0.037, 0, 0.9), m.accent);
      const wrist = new THREE.Mesh(limbGeo(RunnerBody.FORE * 0.26, 0.031, 0.027, 0.002, 0.8), m.skin);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.044, 12, 8), m.jacket);
      const hand: HandLike = assets ? new SculptedHand(side, assets.hand, matMap) : new Hand(side, m.skin, m.glove, m.accent, m.nail, m.pad);
      // seam stripe down the outside of the sleeve, watch on the left wrist
      for (const [limb, len, r] of [[upper, RunnerBody.UPPER, 0.049], [fore, RunnerBody.FORE * 0.72, 0.042]] as [THREE.Mesh, number, number][]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.008, len * 0.92, 0.004), m.accent);
        st.position.set(0, len * 0.5, r * 0.9 * side);
        limb.add(st);
      }
      if (side < 0) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 20), m.dark);
        band.rotation.x = Math.PI / 2; band.position.y = 0.035; band.scale.set(1, 0.85, 1);
        const face = new THREE.Mesh(new RoundedBoxGeometry(0.028, 0.03, 0.008, 2, 0.003), m.dark);
        face.position.set(0, 0.035, 0.032);
        const screenM = new THREE.MeshStandardMaterial({ color: 0x101418, emissive: 0xd8202a, emissiveIntensity: 0.6, roughness: 0.2 });
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.022), screenM);
        scr.position.set(0, 0.035, 0.0365);
        wrist.add(band, face, scr);
      }
      const shoulderCap = new THREE.Mesh(new THREE.SphereGeometry(0.068, 14, 10), m.jacket);
      shoulderCap.scale.set(1, 0.85, 1);
      shoulderCap.visible = !firstPerson;
      for (const o of [upper, fore, cuff, wrist, elbow, shoulderCap]) { o.castShadow = true; o.receiveShadow = true; }
      this.armRoot.add(upper, fore, cuff, wrist, elbow, shoulderCap, hand.group);
      this.arms.push({ upper, fore, cuff, wrist, hand, elbow, shoulderCap, pos: V(), vel: V(), side });
    }
    for (const side of [-1, 1]) {
      const thigh = new THREE.Mesh(assets ? assets.thigh : limbGeo(RunnerBody.THIGH, 0.088, 0.062, 0.01, 0.92), m.pants);
      const shin = new THREE.Mesh(assets ? assets.shin : limbGeo(RunnerBody.SHIN, 0.06, 0.042, 0.012, 0.92), m.pants);
      if (side < 0) thigh.scale.z = -1; // cargo pocket on the outside of each leg
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 8), m.pants);
      let shoe: THREE.Group;
      if (assets) { shoe = new THREE.Group(); const s2 = instantiate(assets.shoe, matMap); if (side < 0) s2.scale.x = -1; shoe.add(s2); }
      else shoe = buildShoe(m.shoeWhite, m.accent, m.dark, side);
      for (const o of [thigh, shin, knee]) { o.castShadow = true; o.receiveShadow = true; }
      this.root.add(thigh, shin, knee, shoe);
      this.legs.push({ thigh, shin, knee, shoe, side });
    }
    // torso (jacket) — lathe profile, front zipper & red stripe
    const prof = [[0.002, -0.02], [0.14, 0.0], [0.155, 0.1], [0.16, 0.22], [0.185, 0.36], [0.2, 0.45], [0.15, 0.53], [0.07, 0.56], [0.002, 0.565]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const tg = new THREE.LatheGeometry(prof, 18);
    tg.scale(1, 1, 0.62);
    this.torso = assets ? new THREE.Group().add(instantiate(assets.torso, matMap)) : new THREE.Mesh(tg, m.jacket);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.5, 0.012), m.accent);
    stripe.position.set(0.03, 0.26, 0.112);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.48, 0.006), m.dark);
    zip.position.set(0, 0.26, 0.114);
    if (!assets) this.torso.add(stripe, zip);
    this.hips = assets ? new THREE.Group().add(instantiate(assets.pelvis, matMap)) : new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.16, 0.2, 3, 0.06), m.pants);
    this.torso.castShadow = true; this.hips.castShadow = true;
    this.root.add(this.torso, this.hips);
    {
      // the head exists in first person too, as a shadow-only part (see SHADOW_LAYER)
      this.head = new THREE.Group();
      // skull with a narrower jaw and forward chin (head local: -Z forward)
      const sg = new THREE.SphereGeometry(0.1, 28, 20);
      const sp = sg.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < sp.count; i++) {
        let x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i);
        if (y < 0) { const k = -y / 0.1; x *= 1 - 0.22 * k; z *= 1 - 0.08 * k; if (z < 0) z -= 0.012 * k; }
        sp.setXYZ(i, x * 0.92, y * 1.12, z);
      }
      sg.computeVertexNormals();
      const skull = new THREE.Mesh(sg, m.skin);
      const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.104, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), m.hair);
      hairCap.scale.set(0.95, 1.12, 1.03); hairCap.position.set(0, 0.012, 0.006); hairCap.rotation.x = -0.18;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.034, 8), m.skin);
      nose.rotation.x = -Math.PI / 2 + 0.25; nose.position.set(0, -0.012, -0.1);
      const head = this.head;
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), m.skin);
        ear.scale.set(0.45, 1, 0.75); ear.position.set(sx * 0.091, 0.0, 0.01);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), m.dark);
        eye.position.set(sx * 0.032, 0.012, -0.088);
        const brow = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.006, 0.008, 1, 0.002), m.hair);
        brow.position.set(sx * 0.033, 0.03, -0.092); brow.rotation.z = sx * -0.12;
        if (!assets) head.add(ear, eye, brow);
      }
      const lips = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.006, 0.008, 1, 0.003), m.accent);
      (lips.material as THREE.Material) = m.skin;
      lips.position.set(0, -0.058, -0.088);
      const neck = new THREE.Mesh(limbGeo(0.08, 0.046, 0.044), m.skin);
      neck.position.y = -0.165;
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.022, 10, 20), m.jacket);
      collar.rotation.x = Math.PI / 2; collar.position.y = -0.155;
      const tie = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.007, 8, 14), m.accent);
      tie.position.set(0, 0.04, 0.1); tie.rotation.x = 0.6;
      if (assets) head.add(instantiate(assets.head, matMap));
      else head.add(skull, hairCap, nose, lips, neck, collar, tie);
      // ponytail: a short verlet chain hanging from the tie, swung by the body's motion
      for (let i = 0; i < 6; i++) {
        const r0 = 0.024 * (1 - i * 0.12), r1 = 0.024 * (1 - (i + 1) * 0.12);
        const seg = new THREE.Mesh(limbGeo(0.052, r0, Math.max(0.004, r1), 0.003, 0.8, 10), m.hair);
        seg.castShadow = true;
        this.tailMeshes.push(seg);
        this.root.add(seg);
        this.tailPts.push(new THREE.Vector3()); this.tailPrev.push(new THREE.Vector3());
      }
      this.tailPts.push(new THREE.Vector3()); this.tailPrev.push(new THREE.Vector3());
      head.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      this.root.add(this.head);
    }
    this.installViewHooks();
  }

  /** every body mesh restores its own draw range (geometry can be shared with other bodies) */
  private installViewHooks() { setSeen(this.root, true); setSeen(this.armRoot, true); }

  setVisible(v: boolean) { this.visible = v; this.root.visible = v; this.armRoot.visible = v; }

  /**
   * view: camera world matrix (first person) or a synthesized head frame (ghost).
   */
  update(dt: number, d: BodyDriver, view: THREE.Matrix4, eyePos: THREE.Vector3, feet: THREE.Vector3) {
    pooling = true; pIdx = 0;
    try { this.pose(dt, d, view, eyePos, feet); } finally { pooling = false; }
  }
  private pose(dt: number, d: BodyDriver, view: THREE.Matrix4, eyePos: THREE.Vector3, feet: THREE.Vector3) {
    this.t += dt;
    const st = d.state;
    const speed = Math.hypot(d.vel.x, d.vel.z);
    const sn = clamp((speed - 2) / 7, 0, 1);
    if (st === PState.Dead) { this.setVisible(false); return; }
    if (!this.visible) this.setVisible(true);

    // ---- body orientation: follows camera yaw; legs bias toward the movement direction
    let targetYaw = d.yaw;
    if (st === PState.WallRun) targetYaw = Math.atan2(-d.alongX, -d.alongZ);
    else if (st === PState.Hang || st === PState.WallClimb) targetYaw = Math.atan2(d.wallNX, d.wallNZ);
    else if (st === PState.Pipe) targetYaw = Math.atan2(d.pipeNX, d.pipeNZ);
    let dy = targetYaw - this.bodyYaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.bodyYaw += dy * Math.min(1, dt * 10);
    const fwd = V().set(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw));
    const right = V().set(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw));
    const up = V().set(0, 1, 0);

    // ---- pelvis & torso
    const eyeH = eyePos.y - feet.y;
    const lean = st === PState.Ground ? sn * 0.18 : st === PState.Slide ? -0.35 : 0.1;
    const pelvis = V().copy(feet).addScaledVector(up, clamp(eyeH - 0.8, 0.22, 1.0));
    pelvis.x = eyePos.x - fwd.x * (0.1 + lean * 0.3); pelvis.z = eyePos.z - fwd.z * (0.1 + lean * 0.3);
    if (st === PState.Slide) pelvis.y = feet.y + 0.3;
    if (st === PState.Hang) pelvis.y = d.ledgeY - 1.05;
    this.hips.position.copy(pelvis);
    this.hips.rotation.set(0, this.bodyYaw, 0);
    this.torso.position.copy(pelvis).addScaledVector(up, 0.03);
    this.torso.rotation.set(-lean, this.bodyYaw, 0, 'YXZ');
    if (this.head) {
      this.head.position.copy(eyePos).addScaledVector(fwd, -0.06).addScaledVector(up, 0.02);
      this.head.rotation.set(d.pitch * 0.5, d.yaw, 0, 'YXZ');
      this.updateTail(dt);
    }
    // in first person: hide the torso when it would intersect the near plane (looking down steeply)
    if (this.firstPerson) {
      // first person: what the camera may see vs. what only casts a shadow. The camera sits inside the
      // head, and during slides/rolls inside the torso and legs, so those switch to shadow-only.
      const lowCam = st === PState.Slide || st === PState.Roll || (st === PState.Traverse && d.tKind === 'pullup');
      const torsoSeen = !lowCam && d.pitch > -1.25;
      const legsSeen = st !== PState.Roll;
      const key = (torsoSeen ? 1 : 0) | (legsSeen ? 2 : 0);
      if (key !== this.fpViewKey) {
        this.fpViewKey = key;
        for (const o of [this.torso, this.hips]) setSeen(o, torsoSeen);
        for (const L of this.legs) for (const o of [L.thigh, L.shin, L.knee, L.shoe]) setSeen(o, legsSeen);
        if (this.head) setSeen(this.head, false);
        for (const t of this.tailMeshes) setSeen(t, false);
      }
    }

    // ---- legs
    this.updateLegs(dt, d, pelvis, feet, fwd, right, up, speed, sn);

    // ---- arms
    this.updateArms(dt, d, view, eyePos, fwd, right, up, speed, sn);
  }

  private updateLegs(dt: number, d: BodyDriver, pelvis: THREE.Vector3, feet: THREE.Vector3,
                     fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, speed: number, sn: number) {
    const st = d.state;
    // movement basis
    const mv = speed > 0.5 ? V().set(d.vel.x / speed, 0, d.vel.z / speed) : fwd.clone();
    const mr = V().set(-mv.z, 0, mv.x).negate(); // right of movement
    mr.set(mv.z * -1, 0, mv.x).multiplyScalar(-1);
    const mRight = V().crossVectors(mv, up).normalize(); // (fwd x up) = right
    const targets = [V(), V()];
    const poles = [V(), V()];
    const footDir = [mv.clone(), mv.clone()];
    const footPitch = [0, 0];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const hip = V().copy(pelvis).addScaledVector(right, 0.1 * side).addScaledVector(up, -0.04);
      let T = V();
      let pole = V().copy(hip).addScaledVector(fwd, 1).addScaledVector(up, -0.3);
      const ph = d.gaitPhase + (i === 0 ? 0 : Math.PI);
      if (st === PState.Ground || st === PState.Traverse && (d.tKind === 'stepup')) {
        if (speed > 0.35) {
          const s = ((ph / (Math.PI * 2)) % 1 + 1) % 1;
          const L = clamp(0.12 + speed * 0.075, 0.12, 0.78);
          const lift = 0.06 + speed * 0.028;
          let off: number, hgt: number;
          if (s < 0.5) { off = L - 4 * L * s; hgt = 0; }
          else { const u = (s - 0.5) * 2; off = -L + 2 * L * smooth(u); hgt = lift * Math.sin(u * Math.PI); footPitch[i] = -0.5 * Math.sin(u * Math.PI) * sn; }
          T.copy(feet).addScaledVector(mv, off + 0.05).addScaledVector(mRight, 0.1 * side).addScaledVector(up, 0.08 + hgt);
          if (s < 0.5 && s > 0.35) footPitch[i] = 0.6 * (s - 0.35) / 0.15 * sn; // heel lift at toe-off
        } else {
          T.copy(feet).addScaledVector(fwd, i === 0 ? 0.06 : -0.02).addScaledVector(right, 0.12 * side).addScaledVector(up, 0.08);
        }
        if (d.crouched) T.addScaledVector(fwd, 0.12);
      } else if (st === PState.Air) {
        const rising = d.vel.y > 0;
        const tuck = rising ? smooth(d.airTime / 0.25) : 1 - smooth(-d.vel.y / 8);
        const lead = i === 0 ? 1 : -1;
        T.copy(pelvis).addScaledVector(up, -0.82 + tuck * 0.32).addScaledVector(fwd, 0.08 + lead * 0.18 * (0.5 + 0.5 * sn) + tuck * 0.08)
          .addScaledVector(right, 0.12 * side);
      } else if (st === PState.Slide) {
        if (i === 1) T.copy(pelvis).addScaledVector(fwd, 0.78).addScaledVector(up, -0.24).addScaledVector(right, 0.06);
        else { T.copy(pelvis).addScaledVector(fwd, 0.25).addScaledVector(up, -0.28).addScaledVector(right, -0.2); pole.copy(hip).addScaledVector(right, -1).addScaledVector(up, 0.4); }
        footPitch[i] = i === 1 ? 0.5 : 0.2;
      } else if (st === PState.Roll) {
        T.copy(pelvis).addScaledVector(up, -0.2).addScaledVector(fwd, 0.2).addScaledVector(right, 0.1 * side);
      } else if (st === PState.WallRun) {
        // feet strike the wall surface alternately
        const n = V().set(d.wallNX, 0, d.wallNZ);
        const along = V().set(d.alongX, 0, d.alongZ);
        const s = ((ph / (Math.PI * 2)) % 1 + 1) % 1;
        const off = s < 0.5 ? 0.35 - 1.4 * s : -0.35 + 0.7 * smooth((s - 0.5) * 2);
        const nearWall = (i === 0) === (d.wallSide < 0);
        const wallP = V().set(d.wallPointX, pelvis.y, d.wallPointZ).addScaledVector(n, 0.12);
        T.copy(nearWall ? wallP : pelvis).addScaledVector(along, off).addScaledVector(up, -0.68 + (s >= 0.5 ? 0.15 * Math.sin((s - 0.5) * 2 * Math.PI) : 0));
        if (!nearWall) T.addScaledVector(n, 0.15);
        footDir[i].copy(along);
      } else if (st === PState.WallClimb || st === PState.Hang) {
        const n = V().set(d.wallNX, 0, d.wallNZ);
        const wallP = V().set(d.wallPointX || pelvis.x - n.x * 0.3, pelvis.y, d.wallPointZ || pelvis.z - n.z * 0.3);
        if (st === PState.Hang) { wallP.set(d.ledgeX, pelvis.y, d.ledgeZ); }
        const step = Math.sin(this.t * (st === PState.WallClimb ? 14 : 2) + i * Math.PI);
        T.copy(wallP).addScaledVector(n, 0.12 + (st === PState.Hang ? 0.05 : 0)).addScaledVector(right, 0.12 * side)
          .addScaledVector(up, st === PState.Hang ? -0.8 + step * 0.03 : -0.55 + step * 0.18);
        footDir[i].set(-n.x, 0, -n.z);
        pole.copy(hip).addScaledVector(n, -1).addScaledVector(up, -0.5);
        footPitch[i] = -0.3;
      } else if (st === PState.Traverse) {
        const t = clamp(d.stateTime / d.tDur, 0, 1);
        if (d.tKind === 'speedvault') {
          const swing = Math.sin(t * Math.PI);
          T.copy(pelvis).addScaledVector(up, -0.62 + swing * 0.2).addScaledVector(right, (0.12 + swing * 0.38) * (i === 0 ? 1 : 0.6))
            .addScaledVector(fwd, 0.15 + (i === 0 ? 0.12 : -0.05));
          pole.copy(hip).addScaledVector(right, 1).addScaledVector(fwd, 0.5);
        } else if (d.tKind === 'kongvault') {
          const swing = Math.sin(t * Math.PI);
          T.copy(pelvis).addScaledVector(up, -0.7 + swing * 0.45).addScaledVector(fwd, 0.15 + swing * 0.2).addScaledVector(right, 0.1 * side);
        } else {
          // mantle / pull-up: lead knee comes up onto the ledge
          const lead = i === 1;
          const k = lead ? smooth((t - 0.2) / 0.5) : smooth((t - 0.5) / 0.5);
          T.copy(pelvis).addScaledVector(up, -0.85 + k * 0.5).addScaledVector(fwd, 0.05 + k * 0.25).addScaledVector(right, 0.11 * side);
        }
      } else if (st === PState.Pipe) {
        const n = V().set(d.pipeNX, 0, d.pipeNZ);
        const c = Math.sin(d.pipeClimbPhase + i * Math.PI);
        T.copy(pelvis).addScaledVector(n, -0.12).addScaledVector(up, -0.6 + c * 0.12).addScaledVector(right, 0.13 * side);
        footDir[i].set(-n.x, 0, -n.z);
      } else if (st === PState.Zip) {
        T.copy(pelvis).addScaledVector(up, -0.82).addScaledVector(fwd, 0.18 + (i === 0 ? 0.08 : -0.04)).addScaledVector(right, 0.11 * side);
      } else {
        T.copy(pelvis).addScaledVector(up, -0.82).addScaledVector(right, 0.11 * side);
      }
      targets[i] = T; poles[i] = pole;
      void hip;
    }
    // kick: the right leg snaps forward and up, then recoils
    if (this.kickT > 0) {
      const e = Math.sin((1 - this.kickT / 0.4) * Math.PI);
      targets[1] = V().copy(pelvis).addScaledVector(fwd, 0.1 + 0.78 * e).addScaledVector(up, -0.82 + 0.5 * e).addScaledVector(right, 0.1);
      footDir[1].copy(fwd); footPitch[1] = -0.7 * e;
      this.kickT = Math.max(0, this.kickT - dt);
    }
    // smooth feet slightly when changing modes (avoid pops), fast enough not to lag the gait
    if (!this.footInit) { this.footSpring[0].copy(targets[0]); this.footSpring[1].copy(targets[1]); this.footInit = true; }
    const k = Math.min(1, dt * 30);
    for (let i = 0; i < 2; i++) {
      // integrate relative to the pelvis so the spring does not lag behind fast movement
      const rel = V().subVectors(this.footSpring[i], this.lastPelvis.lengthSq() ? this.lastPelvis : pelvis).add(pelvis);
      rel.lerp(targets[i], k);
      this.footSpring[i].copy(rel);
    }
    this.lastPelvis.copy(pelvis);
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      const side = i === 0 ? -1 : 1;
      const hip = V().copy(pelvis).addScaledVector(right, 0.1 * side).addScaledVector(up, -0.04);
      const knee = V(), ankle = V();
      ik(hip, this.footSpring[i], RunnerBody.THIGH, RunnerBody.SHIN, poles[i], knee, ankle);
      setSegment(L.thigh, hip, knee, right);
      setSegment(L.shin, knee, ankle, right);
      L.knee.position.copy(knee);
      // shoe orientation
      const fd = footDir[i].clone(); fd.y = 0; if (fd.lengthSq() < 1e-4) fd.copy(fwd); fd.normalize();
      L.shoe.position.copy(ankle);
      L.shoe.rotation.set(0, Math.atan2(fd.x, fd.z), 0, 'YXZ');
      L.shoe.rotateX(footPitch[i]);
    }
  }
  private lastPelvis = V();
  private kickT = 0;
  kick() { this.kickT = 0.4; }
  private fpViewKey = -1;
  private tailPts: THREE.Vector3[] = [];
  private tailPrev: THREE.Vector3[] = [];
  private tailMeshes: THREE.Mesh[] = [];
  private tailInit = false;

  /** verlet ponytail: anchored at the hair tie, gravity + damping + fixed segment lengths */
  private updateTail(dt: number) {
    if (!this.head || !this.tailPts.length) return;
    this.head.updateMatrixWorld();
    const anchor = new THREE.Vector3(0, 0.03, 0.11).applyMatrix4(this.head.matrixWorld);
    const back = new THREE.Vector3(0, -0.4, 1).transformDirection(this.head.matrixWorld);
    const segL = 0.05;
    if (!this.tailInit) {
      for (let i = 0; i < this.tailPts.length; i++) { this.tailPts[i].copy(anchor).addScaledVector(back, segL * i); this.tailPrev[i].copy(this.tailPts[i]); }
      this.tailInit = true;
    }
    const h = Math.min(dt, 1 / 30);
    const center = new THREE.Vector3(0, 0, 0).applyMatrix4(this.head.matrixWorld);
    for (let i = 1; i < this.tailPts.length; i++) {
      const p = this.tailPts[i], q = this.tailPrev[i];
      const vx = (p.x - q.x) * 0.94, vy = (p.y - q.y) * 0.94, vz = (p.z - q.z) * 0.94;
      q.copy(p);
      p.x += vx; p.y += vy - 9.8 * h * h; p.z += vz;
    }
    for (let it = 0; it < 4; it++) {
      this.tailPts[0].copy(anchor);
      for (let i = 1; i < this.tailPts.length; i++) {
        const a = this.tailPts[i - 1], b = this.tailPts[i];
        const d = V().subVectors(b, a); const L = d.length() || 1e-5;
        b.copy(a).addScaledVector(d, segL / L);
        // keep the hair outside the skull and neck
        const c = V().subVectors(b, center); const cl = c.length();
        if (cl < 0.12) b.copy(center).addScaledVector(c, 0.12 / Math.max(cl, 1e-4));
      }
      // slight stiffness: first segment leans back from the tie
      this.tailPts[1].lerp(V().copy(anchor).addScaledVector(back, segL), 0.25);
    }
    for (let i = 0; i < this.tailMeshes.length; i++) setSegment(this.tailMeshes[i], this.tailPts[i], this.tailPts[i + 1], V(1, 0, 0));
  }

  private updateArms(dt: number, d: BodyDriver, view: THREE.Matrix4, eyePos: THREE.Vector3,
                     fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, speed: number, sn: number) {
    const st = d.state;
    const inv = new THREE.Matrix4().copy(view).invert();
    const toLocal = (w: THREE.Vector3) => w.clone().applyMatrix4(inv);
    const t = this.t;
    for (const arm of this.arms) {
      const s = arm.side;
      // shoulder in view space
      const shoulder = new THREE.Vector3(0.19 * s, -0.25, 0.13);
      let target = new THREE.Vector3();
      let pole = new THREE.Vector3(0.6 * s, -0.7, 0.4);
      let stiff = 16; // spring response (1/s)
      let curl = 0.55;
      let palmN: THREE.Vector3 | null = null; // world palm normal for contacts
      let fingerDir: THREE.Vector3 | null = null;
      const ph = d.gaitPhase;
      if (st === PState.Ground) {
        if (speed > 0.4) {
          const swing = Math.cos(ph) * (s > 0 ? 1 : -1);
          const a = 0.25 + 0.75 * sn;
          target.set(s * (0.17 - 0.04 * Math.max(0, swing) * a), -0.42 + 0.14 * Math.max(0, swing) * a - 0.04 * (1 - a), -0.08 - 0.26 * swing * a);
          curl = 0.75;
          stiff = 22;
        } else {
          target.set(0.24 * s, -0.66, 0.04 + Math.sin(t * 1.3 + s) * 0.01);
          curl = 0.35;
        }
        if (d.stumble > 0) { target.set(0.22 * s, -0.55, -0.4); curl = 0.1; }
      } else if (st === PState.Air) {
        const rise = d.vel.y > 0 ? 1 : 0;
        const fall = smooth(-d.vel.y / 10);
        target.set(s * (0.24 + fall * 0.12), -0.26 + rise * 0.06 - fall * 0.02, -0.34 + fall * 0.06);
        curl = 0.25 + rise * 0.2;
        stiff = 12;
      } else if (st === PState.Slide) {
        if (s < 0) { target.set(-0.34, -0.62, 0.08); curl = 0.1; } // trailing hand toward the ground
        else { target.set(0.22, -0.28, -0.36); curl = 0.4; }
        stiff = 14;
      } else if (st === PState.Roll) {
        target.set(0.16 * s, -0.3, -0.28); curl = 0.8; stiff = 25;
      } else if (st === PState.WallRun) {
        const n = new THREE.Vector3(d.wallNX, 0, d.wallNZ);
        const along = new THREE.Vector3(d.alongX, 0, d.alongZ);
        const wallHand = (s > 0) === (d.wallSide > 0);
        if (wallHand) {
          const w = new THREE.Vector3(d.wallPointX, eyePos.y - 0.12, d.wallPointZ).addScaledVector(along, 0.55).addScaledVector(n, 0.03);
          target = toLocal(w); palmN = n.clone().negate(); fingerDir = up.clone().addScaledVector(along, 0.6).normalize();
          curl = 0.15; stiff = 18;
        } else { target.set(0.36 * s, -0.22, -0.32); curl = 0.3; }
      } else if (st === PState.WallClimb) {
        const n = new THREE.Vector3(d.wallNX, 0, d.wallNZ);
        const cyc = Math.floor(d.stateTime / 0.18) + (s > 0 ? 1 : 0);
        const reach = cyc % 2 === 0 ? 0.22 : -0.05;
        const w = new THREE.Vector3(d.wallPointX, eyePos.y + reach, d.wallPointZ).addScaledVector(n, 0.03).addScaledVector(right, 0.2 * s);
        target = toLocal(w); palmN = n.clone().negate(); fingerDir = up.clone(); curl = 0.25; stiff = 30;
      } else if (st === PState.Hang) {
        const n = new THREE.Vector3(d.wallNX, 0, d.wallNZ);
        const tan = new THREE.Vector3(-n.z, 0, n.x);
        const shim = Math.sin(d.gaitPhase) * 0.04;
        const w = new THREE.Vector3(d.ledgeX, d.ledgeY + 0.025, d.ledgeZ).addScaledVector(tan, (0.24 + shim * s) * s * (tan.dot(right) > 0 ? 1 : -1)).addScaledVector(n, -0.06);
        target = toLocal(w); palmN = up.clone().negate(); fingerDir = n.clone().negate(); curl = 0.65; stiff = 40;
      } else if (st === PState.Traverse) {
        const tt = clamp(d.stateTime / d.tDur, 0, 1);
        const n = new THREE.Vector3(-d.tDirX, 0, -d.tDirZ);
        const tan = new THREE.Vector3(-n.z, 0, n.x);
        const handW = new THREE.Vector3(d.tHand.x, d.tHand.y + 0.02, d.tHand.z);
        const both = d.tKind !== 'speedvault';
        const planted = d.tKind === 'pullup' ? tt < 0.8 : tt < 0.6;
        if ((both || s < 0) && planted) {
          const w = handW.clone().addScaledVector(tan, (both ? 0.22 : 0.05) * s * (tan.dot(right) > 0 ? 1 : -1));
          if (d.tKind === 'speedvault' || d.tKind === 'kongvault') w.addScaledVector(n, -0.12);
          target = toLocal(w); palmN = up.clone().negate(); fingerDir = n.clone().negate(); curl = 0.3; stiff = 45;
        } else { target.set(0.26 * s, -0.3, -0.34); curl = 0.4; stiff = 14; }
      } else if (st === PState.Pipe && d.pipe) {
        const b = d.pipe;
        const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
        const n = new THREE.Vector3(d.pipeNX, 0, d.pipeNZ);
        const c = Math.sin(d.pipeClimbPhase + (s > 0 ? 0 : Math.PI));
        const hw = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) > 0.4 ? 0.22 : 0.0;
        const w = new THREE.Vector3(cx, eyePos.y + 0.12 + c * 0.16, cz).addScaledVector(n, 0.1).addScaledVector(right, (0.05 + hw) * s);
        target = toLocal(w); palmN = n.clone().negate(); fingerDir = up.clone(); curl = 0.8; stiff = 35;
      } else if (st === PState.Zip && d.zip) {
        const z = d.zip;
        const dir = new THREE.Vector3(z.bx - z.ax, z.by - z.ay, z.bz - z.az).normalize();
        const w = new THREE.Vector3(z.ax + (z.bx - z.ax) * d.zipT, z.ay + (z.by - z.ay) * d.zipT, z.az + (z.bz - z.az) * d.zipT)
          .addScaledVector(dir, s * 0.06).addScaledVector(up, -0.03);
        target = toLocal(w); palmN = up.clone(); fingerDir = right.clone().multiplyScalar(-s); curl = 0.9; stiff = 40;
      } else {
        target.set(0.24 * s, -0.66, 0.05);
      }
      // holding a weapon: the animation drives the gripping hand(s) on the ground, in the air and in slides
      const H = this.held;
      if (H && (st === PState.Ground || st === PState.Air || st === PState.Slide || st === PState.Grapple) && (s > 0 || H.left)) {
        target = (s > 0 ? H.right : H.left!).clone();
        stiff = H.stiff; curl = 0.97;
        // fist around the grip: fingers wrap across the handle, knuckles forward
        const bv = H.blade.clone().transformDirection(view);
        const across = V().crossVectors(V().setFromMatrixColumn(view, 0), bv).normalize(); // perpendicular to the handle
        if (across.lengthSq() > 0.5) fingerDir = across;
        pole = new THREE.Vector3(0.7 * s, -0.8, 0.2);
      }
      // landing: brace
      // spring in view space
      if (arm.pos.lengthSq() === 0) arm.pos.copy(target);
      const k = stiff * stiff, c = 2 * stiff * 0.9;
      let n = Math.ceil(Math.min(dt, 0.1) / (1 / 240));
      const h = Math.min(dt, 0.1) / Math.max(1, n);
      while (n-- > 0) {
        const acc = V().subVectors(target, arm.pos).multiplyScalar(k).addScaledVector(arm.vel, -c);
        arm.vel.addScaledVector(acc, h);
        arm.pos.addScaledVector(arm.vel, h);
      }
      arm.hand.setCurl(arm.hand.curl + (curl - arm.hand.curl) * Math.min(1, dt * 12));
      // IK in view space, then to world
      const E = V(), Tt = V();
      ik(shoulder, arm.pos, RunnerBody.UPPER, RunnerBody.FORE, pole, E, Tt);
      if (s > 0) this.rightHandView.copy(Tt);
      const Sw = shoulder.clone().applyMatrix4(view), Ew = E.applyMatrix4(view), Tw = Tt.applyMatrix4(view);
      const rightW = V().setFromMatrixColumn(view, 0);
      setSegment(arm.upper, Sw, Ew, rightW);
      arm.shoulderCap.position.copy(Sw);
      arm.elbow.position.copy(Ew);
      const foreDir = V().subVectors(Tw, Ew).normalize();
      const foreEnd = V().copy(Ew).addScaledVector(foreDir, RunnerBody.FORE * 0.72);
      setSegment(arm.fore, Ew, foreEnd, rightW);
      setSegment(arm.cuff, foreEnd, V().copy(foreEnd).addScaledVector(foreDir, 0.03), rightW);
      setSegment(arm.wrist, foreEnd, Tw, rightW);
      // hand orientation
      const hy = fingerDir ? fingerDir.clone() : foreDir.clone();
      let hz: THREE.Vector3;
      if (palmN) hz = palmN.clone().negate(); // back of hand opposite the palm
      else {
        // palm faces inward (medial) and slightly down while running
        const medial = rightW.clone().multiplyScalar(-arm.side);
        hz = V().crossVectors(hy, medial).multiplyScalar(arm.side).normalize();
        if (hz.lengthSq() < 0.5) hz.set(0, 1, 0);
      }
      const hx = V().crossVectors(hy, hz).normalize();
      hz.crossVectors(hx, hy).normalize();
      arm.hand.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(hx, hy, hz));
      arm.hand.group.position.copy(Tw);
      // when fingers lead (contact), offset so the palm centre sits on the contact
      if (fingerDir) arm.hand.group.position.addScaledVector(hy, -0.03);
    }
    void fwd;
  }
}
