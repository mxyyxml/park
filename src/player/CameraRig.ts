/**
 * First-person camera driven by the body: eye height follows the simulated posture through
 * springs, landings compress the spine, the gait produces bob and sway, wall runs roll the
 * head away from the wall, rolls rotate the view through a full forward somersault.
 * All amplitudes scale with a comfort setting.
 */
import * as THREE from 'three';
import { P, PEvent, PlayerController, PState } from './PlayerController';

class Spring {
  x = 0; v = 0;
  constructor(public k: number, public damp: number) {}
  /** semi-implicit Euler in fixed sub-steps: stable for any frame time */
  step(target: number, dt: number) {
    let n = Math.ceil(dt / (1 / 240));
    const h = dt / Math.max(1, n);
    while (n-- > 0) {
      const a = this.k * (target - this.x) - this.damp * this.v;
      this.v += a * h; this.x += this.v * h;
    }
    return this.x;
  }
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

export class CameraRig {
  eye = new Spring(260, 30);       // eye height above feet
  dip = new Spring(140, 14);       // landing / impact compression
  pitchKick = new Spring(120, 15); // pitch offset from impacts
  rollS = new Spring(60, 14);
  fovS = new Spring(30, 11);
  trauma = 0;
  comfort = 1; // 0..1 scales bob/roll/shake
  baseFov = 85;
  pos = new THREE.Vector3();
  eyePos = new THREE.Vector3();
  yaw = 0; pitch = 0; roll = 0;
  fov = 85;
  private t = 0;
  private bobAmt = 0;
  private lastState: PState = PState.Ground;
  private rollPitch = 0;
  speedNorm = 0;

  constructor() { this.eye.x = 1.68; this.fovS.x = 85; }

  onEvents(events: PEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case 'land': {
          const k = clamp((e.impact - 2) / 14, 0, 1);
          this.dip.v -= 0.6 + k * 4.2;
          this.pitchKick.v -= k * 2.2;
          if (e.hard) this.trauma = Math.min(1, this.trauma + 0.55);
          break;
        }
        case 'jump': this.dip.v -= 0.55; this.pitchKick.v += 0.25; break;
        case 'grab': this.dip.v -= 0.4 + clamp(e.impact / 10, 0, 1) * 2.5; this.pitchKick.v += 0.6 + clamp(e.impact / 10, 0, 1) * 1.5; this.trauma = Math.min(1, this.trauma + clamp(e.impact / 30, 0, 0.3)); break;
        case 'bump': this.trauma = Math.min(1, this.trauma + 0.3); this.pitchKick.v += 1.2; break;
        case 'walljump': this.rollS.v += 0; break;
        case 'handplant': this.dip.v -= 0.5; break;
        case 'death': this.trauma = 1; break;
        case 'roll': this.rollPitch = 0; break;
        case 'mantleJump': this.dip.v -= 1.2; this.pitchKick.v += 1.4; break;
      }
    }
  }

  update(dt: number, p: PlayerController, alpha: number) {
    this.t += dt;
    const c = this.comfort;
    const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
    const py = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
    const pz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha;
    this.pos.set(px, py, pz);
    const speed = p.hSpeed;
    this.speedNorm = clamp((speed - 3) / 7, 0, 1);

    // ---- eye height from posture
    let eyeT = p.height - 0.12;
    let pitchOff = 0, rollT = 0, fovAdd = 0;
    const st = p.state;
    if (st === PState.Slide) { eyeT = 0.78; fovAdd += 4; pitchOff += 0.03; rollT += 0.05 * c; }
    else if (st === PState.Roll) {
      const t = clamp(p.stateTime / P.ROLL_TIME, 0, 1);
      // somersault: camera pitch rotates fully forward, eye dips toward the ground mid-roll
      this.rollPitch = -Math.PI * 2 * smooth(t) * (0.35 + 0.65 * c);
      eyeT = 1.05 - Math.sin(t * Math.PI) * 0.65;
    } else if (st === PState.Hang) eyeT = P.HANG_DROP - 0.32;
    else if (st === PState.WallRun) { rollT += -p.wallSide * 0.2 * c; fovAdd += 3; }
    else if (st === PState.WallClimb) pitchOff += 0.08;
    else if (st === PState.Zip) { fovAdd += 6; rollT += Math.sin(this.t * 1.7) * 0.02 * c; }
    else if (st === PState.Traverse) {
      const t = p.tProgress;
      if (p.tKind === 'pullup') { pitchOff += -0.28 * Math.sin(t * Math.PI) + 0.06; }
      else if (p.tKind === 'speedvault' || p.tKind === 'kongvault') { pitchOff += -0.14 * Math.sin(t * Math.PI); rollT += 0.06 * Math.sin(t * Math.PI) * c; }
      else pitchOff += -0.18 * Math.sin(t * Math.PI);
    } else if (st === PState.Dead) { eyeT = 0.4; }
    if (st !== PState.Roll) this.rollPitch *= Math.max(0, 1 - dt * 20);
    if (p.stumble > 0) { eyeT -= 0.35 * clamp(p.stumble / 0.75, 0, 1); pitchOff -= 0.12 * clamp(p.stumble / 0.75, 0, 1); }
    // snap the spring when the state changes discontinuously into hang to avoid seeing through walls
    if (st !== this.lastState && (st === PState.Hang)) this.eye.v *= 0.5;
    this.lastState = st;
    const eyeH = this.eye.step(eyeT, dt);
    const dip = this.dip.step(0, dt);

    // ---- gait bob (grounded running and wall running)
    const onFeet = st === PState.Ground || st === PState.WallRun;
    const bobTarget = onFeet && speed > 0.4 ? 1 : 0;
    this.bobAmt += (bobTarget - this.bobAmt) * Math.min(1, dt * 8);
    const ph = p.gaitPhase;
    const ampY = (0.014 + 0.032 * this.speedNorm) * this.bobAmt * c;
    const ampX = (0.012 + 0.012 * this.speedNorm) * this.bobAmt * c;
    const bobY = (Math.abs(Math.sin(ph)) - 0.64) * ampY;
    const bobX = Math.cos(ph) * ampX;
    const bobRoll = Math.cos(ph) * 0.006 * this.bobAmt * c * (0.5 + this.speedNorm);
    const bobPitch = (Math.abs(Math.sin(ph)) - 0.5) * 0.008 * this.bobAmt * c;

    // strafe lean & balance
    const lateral = p.vel.x * p.rightX + p.vel.z * p.rightZ;
    if (st === PState.Ground) rollT += -clamp(lateral / 9, -1, 1) * 0.03 * c - p.balance * 0.35 * c;
    const roll = this.rollS.step(rollT, dt);
    const kick = this.pitchKick.step(0, dt);

    // shake (trauma^2 so small hits stay subtle)
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const sh = this.trauma * this.trauma * c;
    const n1 = Math.sin(this.t * 37.1) * Math.sin(this.t * 13.7), n2 = Math.sin(this.t * 29.3 + 1.1) * Math.sin(this.t * 17.9);
    const n3 = Math.sin(this.t * 23.3 + 2.1);

    this.yaw = p.yaw + n1 * sh * 0.02;
    this.pitch = clamp(p.pitch + pitchOff + kick * 0.05 + bobPitch + n2 * sh * 0.02, -1.55, 1.55) + this.rollPitch;
    this.roll = roll + bobRoll + n3 * sh * 0.015;

    // world-space eye with body sway applied along the camera right vector
    this.eyePos.set(px + p.rightX * bobX, py + eyeH + dip * 0.08 + bobY, pz + p.rightZ * bobX);
    // never let the eye sink through a ceiling or float below the body
    if (st === PState.Hang) this.eyePos.y = Math.min(this.eyePos.y, p.ledgeY - 0.12);

    // ---- FOV: widens with speed
    const fovT = this.baseFov + this.speedNorm * 9 * (0.5 + 0.5 * c) + fovAdd;
    this.fov = this.fovS.step(fovT, dt);
  }

  apply(cam: THREE.PerspectiveCamera) {
    cam.position.copy(this.eyePos);
    cam.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}
