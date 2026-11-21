/**
 * Momentum-based first-person parkour controller.
 *
 * Fixed-timestep (120 Hz) kinematic simulation of a vertical-cylinder character against
 * a static box world. All movement states share one velocity vector so momentum carries
 * naturally between them (sprint -> jump -> wall run -> wall jump -> roll -> slide ...).
 *
 * Headless: no rendering imports. Animation, camera and audio read the public fields and
 * the per-tick event queue.
 */
import { Box, CollisionWorld, F, MoveResult, newMoveResult, Surface, SURFACE_FRICTION } from '../physics/collision';

export enum PState {
  Ground = 'ground',
  Air = 'air',
  Slide = 'slide',
  Roll = 'roll',
  WallRun = 'wallrun',
  WallClimb = 'wallclimb',
  Hang = 'hang',
  Traverse = 'traverse', // scripted: vault / mantle / pull-up / step-up
  Pipe = 'pipe',
  Zip = 'zip',
  Dead = 'dead',
}

export type TraverseKind = 'speedvault' | 'kongvault' | 'stepup' | 'mantle' | 'pullup' | 'grab';

export interface InputFrame {
  moveX: number; // strafe right +
  moveY: number; // forward +
  lookX: number; // radians this frame (yaw delta, + = turn right)
  lookY: number; // radians this frame (pitch delta, + = look up)
  jump: boolean; jumpPressed: boolean;
  crouch: boolean; crouchPressed: boolean;
  sprint: boolean; walk: boolean;
  quickTurn: boolean;
}

export function emptyInput(): InputFrame {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0, jump: false, jumpPressed: false, crouch: false,
    crouchPressed: false, sprint: false, walk: false, quickTurn: false };
}

export type PEvent =
  | { type: 'footstep'; surface: Surface; speed: number; foot: 0 | 1; wall?: boolean }
  | { type: 'jump'; speed: number; surface: Surface }
  | { type: 'land'; impact: number; surface: Surface; speed: number; hard: boolean }
  | { type: 'roll' }
  | { type: 'slideStart'; surface: Surface }
  | { type: 'slideEnd' }
  | { type: 'wallrunStart'; side: number; surface: Surface }
  | { type: 'wallrunEnd' }
  | { type: 'walljump' }
  | { type: 'wallclimbStart' }
  | { type: 'climbStep'; surface: Surface }
  | { type: 'grab'; impact: number; surface: Surface }
  | { type: 'traverse'; kind: TraverseKind; surface: Surface }
  | { type: 'handplant'; surface: Surface }
  | { type: 'pipeGrab' }
  | { type: 'zipStart' }
  | { type: 'zipEnd' }
  | { type: 'bump'; speed: number }
  | { type: 'death'; cause: 'fall' | 'void' }
  | { type: 'quickturn' }
  | { type: 'mantleJump' };

export interface Ledge {
  y: number; x: number; z: number; nx: number; nz: number;
  hangFree: boolean; canClimb: boolean; topX: number; topZ: number; box: Box;
}

export interface Zipline { ax: number; ay: number; az: number; bx: number; by: number; bz: number }

// ---- tunables -------------------------------------------------------------------------------
export const P = {
  R: 0.3,
  H_STAND: 1.8,
  H_CROUCH: 1.15,
  H_SLIDE: 0.95,
  G: 20,
  TERMINAL: 48,
  WALK: 2.0,
  JOG: 4.9,
  SPRINT_BASE: 7.0,
  SPRINT_MAX: 9.6,
  FLOW_BUILD: 1.5, // seconds of straight sprinting to reach max flow
  ACCEL_LOW: 24,
  ACCEL_HIGH: 7.5,
  STOP_DECEL: 17,
  JUMP_V: 6.3,
  JUMP_BOOST: 0.55,
  EDGE_BOOST: 0.45,
  AIR_ACCEL: 3.2,
  COYOTE: 0.12,
  JUMP_BUFFER: 0.15,
  STEP: 0.42,
  SLIDE_MIN_SPEED: 4.0,
  SLIDE_DECEL: 2.6,
  ROLL_TIME: 0.62,
  ROLL_WINDOW: 0.45,
  HARD_LAND: 12.5,
  FATAL_LAND: 17.5,
  FATAL_LAND_ROLL: 20.5,
  WALLRUN_MIN_SPEED: 3.6,
  HANG_DROP: 2.02, // feet below ledge while hanging
};

const tmpRes = newMoveResult();

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
function smooth01(a: number, b: number, x: number) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const notClimbable = (b: Box) => !(b.flags & (F.PIPE | F.LADDER));
/** extent of a box face along the horizontal tangent of normal (nx,nz) */
function faceWidth(b: Box, nx: number, nz: number) { return Math.abs(nx) > 0.5 ? b.maxZ - b.minZ : b.maxX - b.minX; }
function wrapAngle(a: number) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

export class PlayerController {
  world: CollisionWorld;
  ziplines: Zipline[] = [];

  // kinematic state
  pos = { x: 0, y: 0, z: 0 };
  prevPos = { x: 0, y: 0, z: 0 };
  vel = { x: 0, y: 0, z: 0 };
  yaw = 0; pitch = 0;
  height = P.H_STAND;
  state: PState = PState.Ground;
  stateTime = 0;
  time = 0;

  // ground / gait
  grounded = true;
  ground: Box | null = null;
  surface: Surface = Surface.Concrete;
  flow = 0; // sprint momentum 0..1
  crouched = false;
  gaitPhase = 0; // radians, advances with distance travelled
  lastFoot: 0 | 1 = 0;
  stumble = 0; // hard-landing recovery timer
  balance = 0; balanceVel = 0; onBeam = false;

  // timers
  coyote = 0;
  jumpBuffer = 0;
  crouchBufferT = 99; // time since crouch pressed
  airTime = 0;
  fallStartY = 0;
  climbUsed = false;
  wallCooldown = 0;
  lastWallNX = 0; lastWallNZ = 0;
  yawAssist = 0; // remaining yaw rotation to apply smoothly
  yawAssistRate = 0;
  lastImpact = 0;

  // wall run
  wallNX = 0; wallNZ = 0; wallSide = 0; // side: +1 wall on right, -1 left
  alongX = 0; alongZ = 0; wallSpeed = 0; wallRunMax = 1; wallSurface: Surface = Surface.Concrete;
  wallPointX = 0; wallPointZ = 0;

  // ledge / climb
  ledgeY = 0; ledgeX = 0; ledgeZ = 0; // ledge contact point (centre, on wall top edge)
  canClimbLedge = false;
  grabT = 0; grabFromX = 0; grabFromY = 0; grabFromZ = 0;

  // traverse (scripted)
  tKind: TraverseKind = 'mantle';
  tDur = 0.5;
  tFrom = { x: 0, y: 0, z: 0 };
  tTo = { x: 0, y: 0, z: 0 };
  tTopY = 0;
  tExit = { x: 0, y: 0, z: 0 };
  tHand = { x: 0, y: 0, z: 0 }; // where hands plant
  tDirX = 0; tDirZ = 0;
  tEndHeight = P.H_STAND;

  // pipe
  pipe: Box | null = null; pipeNX = 0; pipeNZ = 0; pipeLadder = false; pipeClimbPhase = 0;
  // zip
  zip: Zipline | null = null; zipT = 0; zipSpeed = 0;

  events: PEvent[] = [];
  /** Safe positions for respawn after falls (updated while grounded on non-deadly surfaces). */
  lastSafe = { x: 0, y: 0, z: 0, yaw: 0 };
  deadTime = 0;
  comfortAutoTurn = true;

  constructor(world: CollisionWorld) { this.world = world; }

  spawn(x: number, y: number, z: number, yaw: number) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.prevPos.x = x; this.prevPos.y = y; this.prevPos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.yaw = yaw; this.pitch = 0; this.yawAssist = 0;
    this.height = P.H_STAND;
    this.flow = 0; this.stumble = 0; this.crouched = false;
    this.setState(PState.Ground);
    this.grounded = true;
    this.lastSafe = { x, y, z, yaw };
    this.climbUsed = false;
  }

  // ---- helpers ------------------------------------------------------------------------------
  get fwdX() { return -Math.sin(this.yaw); }
  get fwdZ() { return -Math.cos(this.yaw); }
  get rightX() { return Math.cos(this.yaw); }
  get rightZ() { return -Math.sin(this.yaw); }
  get hSpeed() { return Math.hypot(this.vel.x, this.vel.z); }

  private setState(s: PState) {
    if (this.state === PState.Slide && s !== PState.Slide) this.events.push({ type: 'slideEnd' });
    if (this.state === PState.WallRun && s !== PState.WallRun) this.events.push({ type: 'wallrunEnd' });
    if (this.state === PState.Zip && s !== PState.Zip) this.events.push({ type: 'zipEnd' });
    this.state = s; this.stateTime = 0;
  }

  private canStand(h = P.H_STAND) {
    return !this.world.overlapCylinder(this.pos.x, this.pos.y + 0.03, this.pos.z, P.R * 0.95, h - 0.04);
  }

  private move(dt: number, step: number): MoveResult {
    const r = this.world.moveCylinder(this.pos, this.vel, this.vel.x * dt, this.vel.y * dt, this.vel.z * dt,
      P.R, this.height, step, tmpRes);
    return r;
  }

  private wish(input: InputFrame) {
    let mx = input.moveX, my = input.moveY;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    const wx = this.fwdX * my + this.rightX * mx;
    const wz = this.fwdZ * my + this.rightZ * mx;
    return { x: wx, z: wz, mag: Math.min(1, m), fwd: my };
  }

  /** Horizontal wall ray. Returns hit with a horizontal normal or null. */
  private wallRay(ox: number, oy: number, oz: number, dx: number, dz: number, dist: number, skipClimbables = false) {
    const h = this.world.raycast(ox, oy, oz, dx, 0, dz, dist, skipClimbables ? notClimbable : undefined);
    if (!h || h.ny !== 0) return null;
    return h;
  }

  /**
   * Find a grabbable ledge on a wall with horizontal normal (nx,nz) hit at (hx,hz).
   * Searches tops between feet+minRel and feet+maxRel.
   */
  detectLedge(hx: number, hz: number, nx: number, nz: number, minRel: number, maxRel: number): Ledge | null {
    const px = hx - nx * 0.18, pz = hz - nz * 0.18;
    const top = this.pos.y + maxRel + 0.05;
    const h = this.world.raycast(px, top, pz, 0, -1, 0, maxRel - minRel + 0.05);
    if (!h || h.ny !== 1) return null;
    if (h.box.flags & (F.NO_GRAB | F.PIPE)) return null;
    // the found top must not be covered (space for hands)
    if (this.world.overlapCylinder(px, h.y + 0.01, pz, 0.12, 0.35)) return null;
    // the wall face must actually reach this top (not a floating overhang far behind)
    const faceProbe = this.world.raycast(hx + nx * 0.5, h.y - 0.08, hz + nz * 0.5, -nx, 0, -nz, 0.9);
    if (!faceProbe) return null;
    // hanging body space
    const hangX = faceProbe.x + nx * (P.R + 0.03), hangZ = faceProbe.z + nz * (P.R + 0.03);
    const hangFree = !this.world.overlapCylinder(hangX, h.y - P.HANG_DROP + 0.05, hangZ, P.R * 0.9, P.HANG_DROP - 0.15);
    // standing space on top after pull-up
    const topX = faceProbe.x - nx * (P.R + 0.2), topZ = faceProbe.z - nz * (P.R + 0.2);
    const canClimb = !this.world.overlapCylinder(topX, h.y + 0.02, topZ, P.R * 0.95, P.H_CROUCH);
    return { y: h.y, x: faceProbe.x, z: faceProbe.z, nx, nz, hangFree, canClimb, topX, topZ, box: h.box };
  }

  // ---- main update --------------------------------------------------------------------------
  update(dt: number, input: InputFrame) {
    this.events.length = 0;
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
    this.time += dt; this.stateTime += dt;

    // look
    this.yaw = wrapAngle(this.yaw - input.lookX);
    this.pitch = clamp(this.pitch + input.lookY, -1.48, 1.48);
    if (Math.abs(this.yawAssist) > 1e-4) {
      const step = Math.sign(this.yawAssist) * Math.min(Math.abs(this.yawAssist), this.yawAssistRate * dt);
      this.yaw = wrapAngle(this.yaw + step); this.yawAssist -= step;
    }
    if (input.quickTurn && this.state !== PState.Dead && this.state !== PState.Traverse) {
      this.startAutoTurn(Math.PI, 0.22);
      this.events.push({ type: 'quickturn' });
    }

    if (input.jumpPressed) this.jumpBuffer = P.JUMP_BUFFER;
    else if (this.state !== PState.Traverse) this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (input.crouchPressed) this.crouchBufferT = 0; else this.crouchBufferT += dt;
    this.coyote = Math.max(0, this.coyote - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);

    switch (this.state) {
      case PState.Ground: this.updateGround(dt, input); break;
      case PState.Air: this.updateAir(dt, input); break;
      case PState.Slide: this.updateSlide(dt, input); break;
      case PState.Roll: this.updateRoll(dt, input); break;
      case PState.WallRun: this.updateWallRun(dt, input); break;
      case PState.WallClimb: this.updateWallClimb(dt, input); break;
      case PState.Hang: this.updateHang(dt, input); break;
      case PState.Traverse: this.updateTraverse(dt, input); break;
      case PState.Pipe: this.updatePipe(dt, input); break;
      case PState.Zip: this.updateZip(dt, input); break;
      case PState.Dead: this.deadTime += dt; break;
    }

    if (this.state !== PState.Dead && this.pos.y < -30) this.die('void');
  }

  startAutoTurn(angle: number, dur: number) {
    this.yawAssist = angle; this.yawAssistRate = Math.abs(angle) / dur;
  }

  die(cause: 'fall' | 'void') {
    this.setState(PState.Dead);
    this.deadTime = 0;
    this.vel.x = this.vel.z = 0; this.vel.y = 0;
    this.events.push({ type: 'death', cause });
  }

  // ---- ground -------------------------------------------------------------------------------
  private targetSpeed(input: InputFrame, w: { mag: number; fwd: number }) {
    if (w.mag < 0.05) return 0;
    let base: number;
    if (this.crouched) base = 2.3;
    else if (input.walk) base = P.WALK;
    else if (input.sprint && w.fwd > 0.3) base = P.SPRINT_BASE + (P.SPRINT_MAX - P.SPRINT_BASE) * this.flow;
    else base = P.JOG;
    // analog magnitude: walk..base
    base = Math.max(Math.min(base, P.WALK), base * w.mag);
    if (w.fwd < -0.3) base = Math.min(base, P.JOG * 0.7); // backpedal
    if (this.onBeam) base = Math.min(base, input.sprint ? 5.5 : 3.0);
    if (this.stumble > 0) base *= 0.35;
    return base;
  }

  private groundMove(dt: number, input: InputFrame, friction: number, turnScale = 1) {
    const w = this.wish(input);
    let s = this.hSpeed;
    const target = this.targetSpeed(input, w);
    if (target > 0) {
      let dx = s > 0.05 ? this.vel.x / s : w.x / (w.mag || 1);
      let dz = s > 0.05 ? this.vel.z / s : w.z / (w.mag || 1);
      const wx = w.x / (w.mag || 1), wz = w.z / (w.mag || 1);
      const cur = Math.atan2(dx, dz), want = Math.atan2(wx, wz);
      let diff = wrapAngle(want - cur);
      if (s < 1.5) { dx = wx; dz = wz; diff = 0; }
      else if (Math.abs(diff) > 2.3 && s > 3) {
        // reversing at speed: skid to a stop first
        s = Math.max(0, s - 22 * friction * dt);
      } else {
        const turnRate = (16 - 12.2 * smooth01(4, 9.5, s)) * turnScale; // rad/s, speed-dependent
        const step = clamp(diff, -turnRate * dt, turnRate * dt);
        const a = cur + step;
        dx = Math.sin(a); dz = Math.cos(a);
        s -= Math.abs(step) * s * 0.12; // carving costs a little speed
      }
      if (s < target) {
        const t = clamp((s - P.JOG) / (P.SPRINT_MAX - P.JOG), 0, 1);
        const acc = (s < P.JOG ? P.ACCEL_LOW : P.ACCEL_HIGH * (1 - 0.65 * t)) * Math.min(1, friction);
        s = Math.min(target, s + acc * dt);
      } else {
        s = Math.max(target, s - 9 * friction * dt);
      }
      this.vel.x = dx * s; this.vel.z = dz * s;
    } else {
      s = Math.max(0, s - P.STOP_DECEL * friction * dt);
      const k = this.hSpeed > 1e-5 ? s / this.hSpeed : 0;
      this.vel.x *= k; this.vel.z *= k;
    }
    // flow (sprint momentum) builds when running fast and straight
    const fwdDot = s > 0.1 ? (this.vel.x * this.fwdX + this.vel.z * this.fwdZ) / s : 0;
    if (input.sprint && s > P.SPRINT_BASE - 0.6 && fwdDot > 0.85) this.flow = Math.min(1, this.flow + dt / P.FLOW_BUILD);
    else if (s < P.JOG + 0.5) this.flow = Math.max(0, this.flow - dt / 0.5);
    else this.flow = Math.max(0, this.flow - dt / 2.5);
  }

  private advanceGait(dt: number, speed: number, wall = false) {
    if (speed < 0.3) { this.gaitPhase = this.gaitPhase; return; }
    // stride length grows with speed
    const stride = 0.7 + speed * 0.13; // metres per step
    const prev = this.gaitPhase;
    this.gaitPhase += (speed * dt / stride) * Math.PI;
    if (Math.floor(prev / Math.PI) !== Math.floor(this.gaitPhase / Math.PI)) {
      this.lastFoot = (this.lastFoot ^ 1) as 0 | 1;
      this.events.push({ type: 'footstep', surface: wall ? this.wallSurface : this.surface, speed, foot: this.lastFoot, wall });
    }
  }

  private updateGround(dt: number, input: InputFrame) {
    this.airTime = 0;
    this.climbUsed = false;
    if (this.stumble > 0) this.stumble -= dt;
    const friction = SURFACE_FRICTION[this.surface] ?? 1;

    // crouch / stand
    if (input.crouch) {
      if (!this.crouched && input.crouchPressed && this.hSpeed > P.SLIDE_MIN_SPEED && !this.onBeam) {
        this.startSlide(); return;
      }
      this.crouched = true;
    } else if (this.crouched && this.canStand()) this.crouched = false;
    const targetH = this.crouched ? P.H_CROUCH : P.H_STAND;
    this.height += (targetH - this.height) * Math.min(1, dt * 14);
    if (!this.crouched && this.height < P.H_STAND && this.canStand()) this.height = Math.min(P.H_STAND, this.height + dt * 4);

    this.groundMove(dt, input, friction);
    this.updateBalance(dt, input);

    // jumping & parkour actions
    if (this.jumpBuffer > 0 && this.stumble <= 0.2) {
      if (this.tryWallClimb(true)) return;
      if (this.tryVault(true, input)) return;
      if (!this.crouched || this.canStand()) { this.doJump(input); return; }
    }
    if (this.hSpeed > 3.2 && input.moveY > 0.3 && !this.crouched && this.tryVault(false, input)) return;
    // walking into a ladder / pipe grabs it
    if (input.moveY > 0.5 && this.stateTime > 0.25 && this.tryPipe(input, true)) return;

    // move
    this.vel.y = -2; // keep pressed to ground for step-down
    const preSpeed = this.hSpeed;
    const r = this.move(dt, P.STEP);
    if (r.wall && preSpeed > 5.5) {
      const into = -(r.wallNX * this.vel.x + r.wallNZ * this.vel.z);
      const lost = preSpeed - this.hSpeed;
      if (lost > 3) { this.events.push({ type: 'bump', speed: lost }); this.flow *= 0.3; }
      void into;
    }
    if (r.grounded) { this.ground = r.ground; }
    else {
      // step down / snap
      const sup = this.world.support(this.pos.x, this.pos.y, this.pos.z, P.R * 0.92, P.STEP);
      if (sup) { this.pos.y = sup.maxY; this.ground = sup; }
      else { this.leaveGround(); return; }
    }
    this.vel.y = 0;
    if (this.ground) {
      this.surface = this.ground.surface;
      this.onBeam = !!(this.ground.flags & F.BALANCE);
      if (!(this.ground.flags & F.DEADLY) && !this.onBeam && this.stateTime > 0.2 && this.hSpeed < 6) {
        const near = this.world.support(this.pos.x, this.pos.y, this.pos.z, 0.05, 0.05);
        if (near) { this.lastSafe.x = this.pos.x; this.lastSafe.y = this.pos.y; this.lastSafe.z = this.pos.z; this.lastSafe.yaw = this.yaw; }
      }
    }
    this.advanceGait(dt, this.hSpeed);
  }

  private updateBalance(dt: number, input: InputFrame) {
    if (!this.onBeam) { this.balance *= Math.max(0, 1 - dt * 6); this.balanceVel = 0; return; }
    // inverted pendulum with gait-driven disturbances, corrected by strafe input
    const s = this.hSpeed;
    const disturb = Math.sin(this.time * 2.3) * 0.6 + Math.sin(this.time * 5.1 + 1.3) * 0.3;
    this.balanceVel += (this.balance * 2.2 + disturb * (0.15 + s * 0.08) + input.moveX * 1.6) * dt;
    this.balanceVel *= Math.max(0, 1 - dt * 1.5);
    this.balance += this.balanceVel * dt;
    this.balance = clamp(this.balance, -0.6, 0.6);
    if (Math.abs(this.balance) >= 0.58) {
      // lose balance: stumble off sideways
      const side = Math.sign(this.balance);
      this.vel.x += this.rightX * side * 2.2; this.vel.z += this.rightZ * side * 2.2;
      this.balance = 0; this.balanceVel = 0;
    }
  }

  private leaveGround() {
    this.setState(PState.Air);
    this.coyote = P.COYOTE;
    this.fallStartY = this.pos.y;
    this.grounded = false;
    this.onBeam = false;
    this.airEntrySpeed = this.hSpeed;
  }

  airEntrySpeed = 0;
  jumpHoldT = 0;

  private doJump(input: InputFrame) {
    this.jumpBuffer = 0; this.coyote = 0;
    const s = this.hSpeed;
    let boost = 0;
    if (s > P.JOG && input.moveY > 0.2) boost += P.JUMP_BOOST * (0.4 + 0.6 * this.flow);
    // edge jump: launching close to a drop gives a small "plant" boost
    if (s > 3) {
      const dx = this.vel.x / s, dz = this.vel.z / s;
      const ahead = this.world.support(this.pos.x + dx * 0.55, this.pos.y, this.pos.z + dz * 0.55, 0.1, 0.4);
      if (!ahead) boost += P.EDGE_BOOST;
      this.vel.x += dx * boost; this.vel.z += dz * boost;
    }
    const vy = P.JUMP_V + Math.min(0.5, s * 0.03);
    this.vel.y = vy;
    this.crouched = false;
    this.setState(PState.Air);
    this.grounded = false;
    this.airEntrySpeed = this.hSpeed;
    this.fallStartY = this.pos.y;
    this.jumpHoldT = 0;
    this.events.push({ type: 'jump', speed: s, surface: this.surface });
    this.onBeam = false;
  }

  // ---- air ----------------------------------------------------------------------------------
  private updateAir(dt: number, input: InputFrame) {
    this.airTime += dt;
    this.jumpHoldT += dt;
    // gravity, slightly lower while the jump is held early for a fuller arc
    let g = P.G;
    if (input.jump && this.jumpHoldT < 0.22 && this.vel.y > 0) g *= 0.8;
    this.vel.y = Math.max(-P.TERMINAL, this.vel.y - g * dt);
    // grow back to standing height if space
    if (this.height < P.H_STAND) {
      const nh = Math.min(P.H_STAND, this.height + dt * 3);
      if (!this.world.overlapCylinder(this.pos.x, this.pos.y + 0.02, this.pos.z, P.R * 0.95, nh - 0.02)) this.height = nh;
    }
    if (this.pos.y > this.fallStartY) this.fallStartY = this.pos.y;

    // air control: steer, but never accelerate beyond entry speed
    const w = this.wish(input);
    if (w.mag > 0.05) {
      const cap = Math.max(this.airEntrySpeed, 3.4);
      this.vel.x += w.x * P.AIR_ACCEL * dt; this.vel.z += w.z * P.AIR_ACCEL * dt;
      const s = this.hSpeed;
      if (s > cap) { this.vel.x *= cap / s; this.vel.z *= cap / s; }
    }

    // coyote jump
    if (this.jumpBuffer > 0 && this.coyote > 0) { this.doJump(input); return; }

    // parkour transitions
    if (this.tryZip()) return;
    if (this.tryPipe(input)) return;
    if (this.tryLedgeGrab(input)) return;
    if (this.jumpBuffer > 0 && this.tryWallClimb(false)) return;
    if (this.tryWallRun(input)) return;
    if (this.vel.y < 0 && this.vel.y > -6 && this.hSpeed > 2.5 && this.tryVault(false, input, true)) return;

    const vyBefore = this.vel.y;
    const r = this.move(dt, 0.28);
    if (r.grounded && vyBefore <= 0.5) {
      this.ground = r.ground;
      this.land(-vyBefore, input);
    }
  }

  private land(impact: number, input: InputFrame) {
    const g = this.ground!;
    this.surface = g.surface;
    this.grounded = true;
    this.lastImpact = impact;
    const deadly = !!(g.flags & F.DEADLY);
    const rollWanted = input.crouch || this.crouchBufferT < P.ROLL_WINDOW;
    const fatal = deadly ? impact > 10 : (rollWanted ? impact > P.FATAL_LAND_ROLL : impact > P.FATAL_LAND);
    if (fatal) { this.vel.y = 0; this.die('fall'); return; }
    const s = this.hSpeed;
    if (impact > 9 && rollWanted) {
      this.vel.y = 0;
      this.startRoll();
      this.events.push({ type: 'land', impact, surface: g.surface, speed: s, hard: false });
      return;
    }
    const hard = impact > P.HARD_LAND;
    this.events.push({ type: 'land', impact, surface: g.surface, speed: s, hard });
    this.vel.y = 0;
    if (hard) {
      this.stumble = 0.75;
      this.vel.x *= 0.25; this.vel.z *= 0.25; this.flow = 0;
    } else {
      const keep = 1 - clamp((impact - 6) / 22, 0, 0.22);
      this.vel.x *= keep; this.vel.z *= keep;
      const w = this.wish(input);
      if (w.mag < 0.1 && impact < 10) { this.vel.x *= 0.45; this.vel.z *= 0.45; } // precision landing: stick it
      if (impact > 8) this.flow *= 0.7;
    }
    if (input.crouch && s > P.SLIDE_MIN_SPEED && !hard) { this.startSlide(); return; }
    this.setState(PState.Ground);
    this.gaitPhase = Math.ceil(this.gaitPhase / Math.PI) * Math.PI; // land on a foot
  }

  // ---- slide / roll -------------------------------------------------------------------------
  private startSlide() {
    this.setState(PState.Slide);
    this.crouched = true;
    // small burst on entry, conserving momentum
    const s = this.hSpeed;
    const k = Math.min(s + 0.6, P.SPRINT_MAX + 0.6) / Math.max(s, 1e-3);
    this.vel.x *= k; this.vel.z *= k;
    this.events.push({ type: 'slideStart', surface: this.surface });
  }

  private updateSlide(dt: number, input: InputFrame) {
    this.height += (P.H_SLIDE - this.height) * Math.min(1, dt * 18);
    const friction = SURFACE_FRICTION[this.surface] ?? 1;
    let s = this.hSpeed;
    const decel = P.SLIDE_DECEL * friction + (s < 4 ? 3 : 0);
    s = Math.max(0, s - decel * dt);
    // limited steering
    const w = this.wish(input);
    let dx = this.vel.x / (this.hSpeed || 1), dz = this.vel.z / (this.hSpeed || 1);
    if (w.mag > 0.1) {
      const cur = Math.atan2(dx, dz), want = Math.atan2(w.x, w.z);
      const d = clamp(wrapAngle(want - cur), -1.1 * dt, 1.1 * dt);
      dx = Math.sin(cur + d); dz = Math.cos(cur + d);
    }
    this.vel.x = dx * s; this.vel.z = dz * s; this.vel.y = -2;
    const standOk = this.canStand();
    if (this.jumpBuffer > 0 && standOk) { this.crouched = false; this.doJump(input); return; }
    const r = this.move(dt, P.STEP);
    if (!r.grounded) {
      const sup = this.world.support(this.pos.x, this.pos.y, this.pos.z, P.R * 0.92, 0.3);
      if (sup) { this.pos.y = sup.maxY; this.ground = sup; } else { this.leaveGround(); return; }
    } else this.ground = r.ground;
    if (this.ground) this.surface = this.ground.surface;
    this.vel.y = 0;
    const minT = 0.4;
    if (s < 2.2 || (this.stateTime > minT && !input.crouch && standOk) || this.stateTime > 2.5) {
      this.crouched = !standOk || input.crouch;
      this.setState(PState.Ground);
    }
  }

  private startRoll() {
    this.setState(PState.Roll);
    this.crouched = true;
    this.events.push({ type: 'roll' });
    const s = this.hSpeed;
    const keep = Math.max(s * 0.9, 4.2);
    // roll along velocity (or facing if almost static)
    let dx = this.fwdX, dz = this.fwdZ;
    if (s > 1) { dx = this.vel.x / s; dz = this.vel.z / s; }
    this.vel.x = dx * keep; this.vel.z = dz * keep;
  }

  private updateRoll(dt: number, input: InputFrame) {
    this.height += (P.H_SLIDE - this.height) * Math.min(1, dt * 20);
    const s = this.hSpeed;
    const ns = Math.max(3.8, s - 1.2 * dt);
    let dx = this.vel.x / (s || 1), dz = this.vel.z / (s || 1);
    // limited steering while rolling
    const w = this.wish(input);
    if (w.mag > 0.1) {
      const cur = Math.atan2(dx, dz), want = Math.atan2(w.x, w.z);
      const dd = clamp(wrapAngle(want - cur), -2.2 * dt, 2.2 * dt);
      dx = Math.sin(cur + dd); dz = Math.cos(cur + dd);
    }
    this.vel.x = dx * ns; this.vel.z = dz * ns;
    // jump out of the second half of a roll
    if (this.jumpBuffer > 0 && this.stateTime > P.ROLL_TIME * 0.45 && this.canStand()) { this.crouched = false; this.height = P.H_STAND; this.doJump(input); return; }
    this.vel.y = -2;
    const r = this.move(dt, P.STEP);
    if (!r.grounded) {
      const sup = this.world.support(this.pos.x, this.pos.y, this.pos.z, P.R * 0.92, 0.3);
      if (sup) { this.pos.y = sup.maxY; this.ground = sup; } else { this.leaveGround(); return; }
    } else this.ground = r.ground;
    this.vel.y = 0;
    if (this.stateTime >= P.ROLL_TIME) {
      this.crouched = !this.canStand();
      this.setState(PState.Ground);
      this.gaitPhase = Math.ceil(this.gaitPhase / Math.PI) * Math.PI;
    }
  }

  // ---- wall run -----------------------------------------------------------------------------
  private tryWallRun(input: InputFrame): boolean {
    const s = this.hSpeed;
    if (s < P.WALLRUN_MIN_SPEED || this.vel.y < -5.5 || input.moveY < 0.2) return false;
    if (this.airTime < 0.05 && this.vel.y < 0) return false;
    const vx = this.vel.x / s, vz = this.vel.z / s;
    const midY = this.pos.y + 1.0;
    for (const side of [1, -1]) {
      // perpendicular to the velocity, both sides
      const rx = side === 1 ? -vz : vz, rz = side === 1 ? vx : -vx;
      // check both "diagonal forward" and pure side rays
      const dirs = [[rx, rz], [(rx + vx) * 0.7071, (rz + vz) * 0.7071]];
      for (const [dx, dz] of dirs) {
        const hit = this.wallRay(this.pos.x, midY, this.pos.z, dx, dz, P.R + 0.85);
        if (!hit || (hit.box.flags & (F.NO_WALLRUN | F.PIPE | F.LADDER))) continue;
        const nx = hit.nx, nz = hit.nz;
        if (faceWidth(hit.box, nx, nz) < 1.0) continue;
        const vn = this.vel.x * nx + this.vel.z * nz; // negative = into wall
        if (vn / s < -0.8) continue; // too head-on: that's a wall climb
        const ax0 = this.vel.x - nx * vn, az0 = this.vel.z - nz * vn;
        const along = Math.hypot(ax0, az0);
        if (along < P.WALLRUN_MIN_SPEED * 0.9) continue;
        if (this.wallCooldown > 0 && nx * this.lastWallNX + nz * this.lastWallNZ > 0.9) continue;
        // facing check: don't wall run if looking straight into the wall
        if (-(this.fwdX * nx + this.fwdZ * nz) > 0.92) continue;
        const ax = ax0 / along, az = az0 / along;
        // wall must be tall enough and continue ahead
        const head = this.wallRay(this.pos.x, this.pos.y + 1.75, this.pos.z, -nx, -nz, P.R + 0.8);
        if (!head) continue;
        const ahead = this.wallRay(this.pos.x + ax * 1.2, midY, this.pos.z + az * 1.2, -nx, -nz, P.R + 0.8);
        if (!ahead) continue;
        // available run length: probe along the wall
        let len = 1.2;
        for (let k = 2.4; k <= 12; k += 1.2) {
          if (!this.wallRay(this.pos.x + ax * k, midY, this.pos.z + az * k, -nx, -nz, P.R + 0.9)) break;
          len = k;
        }
        // side relative to camera right
        const camSide = Math.sign(-(nx * this.rightX + nz * this.rightZ)) || 1;
        this.startWallRun(nx, nz, ax, az, along, camSide, hit.box.surface, len, hit.x, hit.z);
        return true;
      }
    }
    return false;
  }

  private startWallRun(nx: number, nz: number, ax: number, az: number, along: number, side: number,
                       surface: Surface, len: number, hx: number, hz: number) {
    this.setState(PState.WallRun);
    this.wallNX = nx; this.wallNZ = nz; this.alongX = ax; this.alongZ = az; this.wallSide = side;
    this.wallSpeed = Math.min(along, P.SPRINT_MAX + 0.8);
    this.wallSurface = surface;
    this.wallPointX = hx; this.wallPointZ = hz;
    // duration depends on entry speed and available surface
    const timeBySpeed = clamp(0.75 + (along - 4) * 0.13, 0.75, 1.45);
    const timeBySurface = (len + 0.6) / Math.max(along, 1);
    this.wallRunMax = Math.min(timeBySpeed, timeBySurface);
    this.vel.y = clamp(Math.max(this.vel.y, 0) * 0.5 + 2.4 + along * 0.12, 2.4, 4.4);
    this.lastWallNX = nx; this.lastWallNZ = nz;
    // snap close to wall
    this.events.push({ type: 'wallrunStart', side, surface });
    this.climbUsed = false;
  }

  private updateWallRun(dt: number, input: InputFrame) {
    const t = this.stateTime;
    const gScale = 0.3 + 0.7 * smooth01(0.15, this.wallRunMax, t);
    this.vel.y = Math.max(-6, this.vel.y - P.G * gScale * dt);
    this.wallSpeed = Math.max(0, this.wallSpeed - 1.3 * dt);
    // stick to the wall, closing any gap left from a wider entry quickly
    const gapHit = this.wallRay(this.pos.x, this.pos.y + 1.0, this.pos.z, -this.wallNX, -this.wallNZ, P.R + 1.0);
    const pull = 0.8 + (gapHit ? Math.max(0, gapHit.t - P.R - 0.03) * 10 : 0);
    this.vel.x = this.alongX * this.wallSpeed - this.wallNX * pull;
    this.vel.z = this.alongZ * this.wallSpeed - this.wallNZ * pull;

    if (this.jumpBuffer > 0 && t > 0.06) { this.wallJump(); return; }
    if (input.crouchPressed) { this.detachWall(1.6); return; }

    const r = this.move(dt, 0.1);
    if (r.grounded) { this.ground = r.ground; this.land(-Math.min(0, this.vel.y), input); return; }
    // wall still there?
    const midY = this.pos.y + 1.0;
    const hit = this.wallRay(this.pos.x, midY, this.pos.z, -this.wallNX, -this.wallNZ, P.R + 0.9);
    if (hit) { this.wallPointX = hit.x; this.wallPointZ = hit.z; this.wallSurface = hit.box.surface; }
    // ledge at end of wall run (wall top within reach)? grab it
    if (!this.wallRay(this.pos.x, this.pos.y + 1.7, this.pos.z, -this.wallNX, -this.wallNZ, P.R + 0.45) && hit) {
      const l = this.detectLedge(hit.x, hit.z, hit.nx, hit.nz, 1.0, 2.35);
      if (l && l.hangFree) { this.startHang(l, false); return; }
    }
    if (!hit || t > this.wallRunMax || this.wallSpeed < 3.0 || r.hitCeiling) { this.detachWall(0.8); return; }
    // a wall in front ends the run (corner) -> allow transition to wall climb
    const front = this.wallRay(this.pos.x, midY, this.pos.z, this.alongX, this.alongZ, P.R + 0.25);
    if (front) { this.detachWall(0.2); return; }
    this.advanceGait(dt, this.wallSpeed * 1.05, true);
  }

  private detachWall(push: number) {
    this.vel.x += this.wallNX * push; this.vel.z += this.wallNZ * push;
    this.wallCooldown = 0.35;
    this.setState(PState.Air);
    this.airEntrySpeed = this.hSpeed;
    this.airTime = 0.1;
  }

  private wallJump() {
    this.jumpBuffer = 0;
    const s = this.wallSpeed;
    const out = 4.6;
    this.vel.x = this.alongX * s * 0.88 + this.wallNX * out;
    this.vel.z = this.alongZ * s * 0.88 + this.wallNZ * out;
    this.vel.y = 6.1;
    this.wallCooldown = 0.45;
    this.lastWallNX = this.wallNX; this.lastWallNZ = this.wallNZ;
    // turn the view partially toward the new heading (comfortable auto-assist)
    if (this.comfortAutoTurn) {
      const want = Math.atan2(-this.vel.x, -this.vel.z);
      const d = wrapAngle(want - this.yaw);
      this.startAutoTurn(d * 0.55, 0.28);
    }
    this.setState(PState.Air);
    this.airEntrySpeed = this.hSpeed;
    this.jumpHoldT = 0;
    this.airTime = 0;
    this.fallStartY = this.pos.y;
    this.events.push({ type: 'walljump' });
    this.events.push({ type: 'jump', speed: s, surface: this.wallSurface });
  }

  // ---- wall climb ---------------------------------------------------------------------------
  climbVy0 = 0;

  private tryWallClimb(fromGround: boolean): boolean {
    if (this.climbUsed) return false;
    if (!fromGround && this.vel.y < -4) return false;
    const fx = this.fwdX, fz = this.fwdZ;
    const reach = P.R + 0.55 + (fromGround ? Math.min(0.9, this.hSpeed * 0.1) : 0.1);
    for (const hy of [1.2, 0.6, 1.7]) {
      const hit = this.wallRay(this.pos.x, this.pos.y + hy, this.pos.z, fx, fz, reach);
      if (!hit || (hit.box.flags & (F.PIPE | F.LADDER))) continue;
      const facing = -(fx * hit.nx + fz * hit.nz);
      if (facing < 0.72) continue;
      if (faceWidth(hit.box, hit.nx, hit.nz) < 0.8) continue; // poles are not climbable walls
      // wall must be higher than a vault: check for something at head height
      const headHit = this.wallRay(this.pos.x, this.pos.y + 1.95, this.pos.z, -hit.nx, -hit.nz, reach + 0.2);
      if (!headHit) {
        // low wall: let ledge/vault logic handle it
        const l = this.detectLedge(hit.x, hit.z, hit.nx, hit.nz, 0.4, 2.3);
        if (l && l.canClimb) {
          this.startClimbOnto(l, fromGround ? 'mantle' : 'mantle');
          return true;
        }
        continue;
      }
      const toward = Math.max(0, -(this.vel.x * hit.nx + this.vel.z * hit.nz));
      this.setState(PState.WallClimb);
      this.wallNX = hit.nx; this.wallNZ = hit.nz; this.wallSurface = hit.box.surface;
      this.wallPointX = hit.x; this.wallPointZ = hit.z;
      this.climbVy0 = clamp(4.6 + toward * 0.22 + Math.max(0, this.vel.y) * 0.2, 4.6, 6.7);
      this.vel.y = this.climbVy0;
      this.vel.x = -hit.nx * 0.5; this.vel.z = -hit.nz * 0.5;
      this.climbUsed = true;
      this.jumpBuffer = 0;
      this.crouched = false;
      this.events.push({ type: 'wallclimbStart' });
      return true;
    }
    return false;
  }

  private updateWallClimb(dt: number, input: InputFrame) {
    const t = this.stateTime;
    this.vel.y -= P.G * (t < 0.35 ? 0.5 : 0.85) * dt;
    // close any remaining gap to the wall quickly (run-up), then stay pressed against it
    const gap = this.wallRay(this.pos.x, this.pos.y + 1.0, this.pos.z, -this.wallNX, -this.wallNZ, 2.0);
    const toWall = gap ? Math.max(0, gap.t - P.R - 0.02) : 0;
    const vin = 0.5 + Math.min(8, toWall * 12);
    this.vel.x = -this.wallNX * vin; this.vel.z = -this.wallNZ * vin;
    // hand-over-hand steps
    const prevStep = Math.floor((t - dt) / 0.18), curStep = Math.floor(t / 0.18);
    if (curStep !== prevStep && this.vel.y > 0) this.events.push({ type: 'climbStep', surface: this.wallSurface });

    // wall climb turn (180° jump off)
    if (this.jumpBuffer > 0 && t > 0.12) {
      this.jumpBuffer = 0;
      this.vel.x = this.wallNX * 4.6; this.vel.z = this.wallNZ * 4.6; this.vel.y = 5.6;
      const want = Math.atan2(-this.wallNX, -this.wallNZ);
      this.startAutoTurn(wrapAngle(want - this.yaw), 0.24);
      this.setState(PState.Air); this.airEntrySpeed = 4.6; this.jumpHoldT = 0; this.airTime = 0;
      this.wallCooldown = 0.3; this.lastWallNX = this.wallNX; this.lastWallNZ = this.wallNZ;
      this.fallStartY = this.pos.y;
      this.events.push({ type: 'walljump' });
      return;
    }
    if (input.crouchPressed) { this.detachWall(1.2); return; }

    const hit = this.wallRay(this.pos.x, this.pos.y + 1.3, this.pos.z, -this.wallNX, -this.wallNZ, P.R + 0.5 + toWall);
    const hx = hit ? hit.x : this.pos.x - this.wallNX * P.R, hz = hit ? hit.z : this.pos.z - this.wallNZ * P.R;
    if (hit) { this.wallPointX = hit.x; this.wallPointZ = hit.z; }
    const l = this.detectLedge(hx, hz, this.wallNX, this.wallNZ, 0.9, 2.35);
    if (l && (l.hangFree || l.canClimb)) {
      if (l.canClimb && l.y - this.pos.y < 1.55) { this.startClimbOnto(l, 'mantle'); return; }
      if (l.hangFree) { this.startHang(l, false); return; }
    }
    const r = this.move(dt, 0.0);
    if (r.grounded && this.vel.y <= 0) { this.ground = r.ground; this.land(0, input); return; }
    if (!hit && !l) {
      // wall ended below the hands without a grabbable ledge: fall
      this.detachWall(0.3); return;
    }
    if (this.vel.y < -1.5 || t > 1.0) { this.detachWall(0.5); return; }
  }

  // ---- ledge grab / hang --------------------------------------------------------------------
  private tryLedgeGrab(input: InputFrame): boolean {
    if (this.vel.y > 3.5) return false;
    const s = this.hSpeed;
    // probe direction: facing, but biased to velocity when moving fast
    let dx = this.fwdX, dz = this.fwdZ;
    if (s > 2) {
      const vx = this.vel.x / s, vz = this.vel.z / s;
      if (vx * dx + vz * dz > 0.3) { dx = (dx + vx) * 0.5; dz = (dz + vz) * 0.5; const m = Math.hypot(dx, dz); dx /= m; dz /= m; }
    }
    const want = input.moveY > 0.1 || input.jump;
    if (!want) return false;
    for (const hy of [1.5, 1.0, 1.9, 0.5]) {
      const hit = this.wallRay(this.pos.x, this.pos.y + hy, this.pos.z, dx, dz, P.R + 0.5 + Math.min(0.4, s * 0.03));
      if (!hit || (hit.box.flags & (F.PIPE | F.LADDER))) continue;
      const facing = -(this.fwdX * hit.nx + this.fwdZ * hit.nz);
      if (facing < 0.35) continue;
      const l = this.detectLedge(hit.x, hit.z, hit.nx, hit.nz, 0.35, 2.35);
      if (!l) continue;
      const rel = l.y - this.pos.y;
      if (rel < 0.35) continue;
      // low ledge while moving: quick mantle onto it
      if (l.canClimb && rel < 1.55) { this.startClimbOnto(l, rel < 1.0 ? 'stepup' : 'mantle'); return true; }
      if (l.hangFree && rel >= 1.0) { this.startHang(l, s > 4); return true; }
    }
    return false;
  }

  private startHang(l: Ledge, catLeap: boolean) {
    this.wallNX = l.nx; this.wallNZ = l.nz;
    const impact = Math.hypot(this.hSpeed, this.vel.y);
    this.setState(PState.Hang);
    this.ledgeY = l.y; this.ledgeX = l.x; this.ledgeZ = l.z; this.canClimbLedge = l.canClimb;
    this.grabT = 0; this.grabFromX = this.pos.x; this.grabFromY = this.pos.y; this.grabFromZ = this.pos.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.wallSurface = l.box.surface;
    this.height = P.H_STAND;
    this.events.push({ type: 'grab', impact: catLeap ? impact : impact * 0.5, surface: l.box.surface });
    this.climbUsed = true;
    this.flow *= 0.5;
  }

  private updateHang(dt: number, input: InputFrame) {
    const nx = this.wallNX, nz = this.wallNZ;
    const hangX = this.ledgeX + nx * (P.R + 0.03), hangZ = this.ledgeZ + nz * (P.R + 0.03);
    const hangY = this.ledgeY - P.HANG_DROP;
    if (this.grabT < 1) {
      this.grabT = Math.min(1, this.grabT + dt / 0.14);
      const e = 1 - (1 - this.grabT) * (1 - this.grabT);
      this.pos.x = this.grabFromX + (hangX - this.grabFromX) * e;
      this.pos.y = this.grabFromY + (hangY - this.grabFromY) * e;
      this.pos.z = this.grabFromZ + (hangZ - this.grabFromZ) * e;
      return;
    }
    this.pos.x = hangX; this.pos.y = hangY; this.pos.z = hangZ;
    const lookAway = this.fwdX * nx + this.fwdZ * nz;
    if (this.stateTime < 0.18) return;
    if (this.jumpBuffer > 0 && lookAway > 0.2) {
      // jump off backwards in look direction
      this.jumpBuffer = 0;
      this.vel.x = this.fwdX * 4.2 + nx * 1.5; this.vel.z = this.fwdZ * 4.2 + nz * 1.5; this.vel.y = 5.4;
      this.setState(PState.Air); this.airEntrySpeed = this.hSpeed; this.jumpHoldT = 0; this.airTime = 0;
      this.fallStartY = this.pos.y; this.wallCooldown = 0.3;
      this.events.push({ type: 'jump', speed: 0, surface: this.wallSurface });
      return;
    }
    if (input.crouchPressed) {
      this.vel.x = nx * 0.8; this.vel.z = nz * 0.8; this.vel.y = 0;
      this.setState(PState.Air); this.airEntrySpeed = 1; this.airTime = 0.2; this.climbUsed = true;
      this.fallStartY = this.pos.y;
      return;
    }
    if ((input.moveY > 0.5 || this.jumpBuffer > 0) && this.canClimbLedge) {
      this.jumpBuffer = 0;
      const topX = this.ledgeX - nx * (P.R + 0.25), topZ = this.ledgeZ - nz * (P.R + 0.25);
      this.beginTraverse('pullup', { x: topX, y: this.ledgeY, z: topZ }, 0.82, -nx, -nz, 0.5, this.ledgeY);
      this.tHand.x = this.ledgeX; this.tHand.y = this.ledgeY; this.tHand.z = this.ledgeZ;
      return;
    }
    // shimmy along the ledge
    if (Math.abs(input.moveX) > 0.2) {
      // tangent pointing to camera-right along the wall
      let tx = -nz, tz = nx;
      if (tx * this.rightX + tz * this.rightZ < 0) { tx = -tx; tz = -tz; }
      const dir = Math.sign(input.moveX);
      const step = 1.3 * dt * dir;
      const nlx = this.ledgeX + tx * step, nlz = this.ledgeZ + tz * step;
      // ledge continues? probe a bit further ahead in the direction of motion
      const probeX = nlx + tx * dir * 0.35, probeZ = nlz + tz * dir * 0.35;
      const top = this.world.raycast(probeX - nx * 0.15, this.ledgeY + 0.3, probeZ - nz * 0.15, 0, -1, 0, 0.45);
      const bodyFree = !this.world.overlapCylinder(probeX + nx * (P.R + 0.03), hangY + 0.05, probeZ + nz * (P.R + 0.03), P.R * 0.9, P.HANG_DROP - 0.2);
      if (top && Math.abs(top.y - this.ledgeY) < 0.08 && bodyFree) {
        this.ledgeX = nlx; this.ledgeZ = nlz;
        const stand = !this.world.overlapCylinder(nlx - nx * (P.R + 0.25), this.ledgeY + 0.02, nlz - nz * (P.R + 0.25), P.R * 0.95, P.H_CROUCH);
        this.canClimbLedge = stand;
        this.gaitPhase += dt * 6;
      }
    }
    // keep the view roughly toward the wall
    const want = Math.atan2(nx, nz); // facing -n => yaw where fwd = -n
    const d = wrapAngle(this.yaw - want);
    if (Math.abs(d) > 1.9) this.yaw = wrapAngle(want + Math.sign(d) * 1.9);
  }

  // ---- traversal (vault / mantle / pull-up) ------------------------------------------------
  private startClimbOnto(l: Ledge, kind: TraverseKind) {
    const nx = l.nx, nz = l.nz;
    const rel = l.y - this.pos.y;
    const s = this.hSpeed;
    const dur = kind === 'stepup' ? 0.26 + rel * 0.08 : clamp(0.36 + rel * 0.14 - s * 0.012, 0.32, 0.6);
    const exitSpeed = Math.max(s * (kind === 'stepup' ? 0.85 : 0.65), kind === 'stepup' ? 2.5 : 2.0);
    this.beginTraverse(kind, { x: l.topX, y: l.y, z: l.topZ }, dur, -nx, -nz, exitSpeed, l.y);
    this.tHand.x = l.x; this.tHand.y = l.y; this.tHand.z = l.z;
    this.wallNX = nx; this.wallNZ = nz;
    this.events.push({ type: 'handplant', surface: l.box.surface });
  }

  private beginTraverse(kind: TraverseKind, to: { x: number; y: number; z: number }, dur: number,
                        dirX: number, dirZ: number, exitSpeed: number, topY: number, endHeight = P.H_STAND) {
    this.setState(PState.Traverse);
    this.tKind = kind; this.tDur = dur;
    this.tFrom.x = this.pos.x; this.tFrom.y = this.pos.y; this.tFrom.z = this.pos.z;
    this.tTo.x = to.x; this.tTo.y = to.y; this.tTo.z = to.z;
    this.tTopY = topY; this.tDirX = dirX; this.tDirZ = dirZ;
    this.tExit.x = dirX * exitSpeed; this.tExit.z = dirZ * exitSpeed; this.tExit.y = 0;
    this.tEndHeight = endHeight;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.events.push({ type: 'traverse', kind, surface: this.surface });
  }

  /** 0..1 progress of the current traversal */
  get tProgress() { return clamp(this.stateTime / this.tDur, 0, 1); }

  private updateTraverse(dt: number, input: InputFrame) {
    const p = this.tProgress;
    const k = this.tKind;
    const f = this.tFrom, to = this.tTo;
    let hx: number, hy: number, hz: number;
    if (k === 'pullup') {
      // phase 1: raise body (feet from hang to ledge level); phase 2: roll forward onto the top
      const p1 = smooth01(0, 0.62, p), p2 = smooth01(0.5, 1, p);
      hx = f.x + (to.x - f.x) * p2; hz = f.z + (to.z - f.z) * p2;
      hy = f.y + (to.y + 0.05 - f.y) * p1;
      this.height = P.H_STAND - 0.6 * Math.sin(Math.PI * clamp(p * 1.1, 0, 1));
    } else if (k === 'speedvault' || k === 'kongvault') {
      // horizontal: constant speed; vertical: arc clearing the obstacle top
      hx = f.x + (to.x - f.x) * p; hz = f.z + (to.z - f.z) * p;
      const clear = this.tTopY + (k === 'kongvault' ? 0.12 : 0.06);
      const peakT = 0.45;
      if (p < peakT) { const e = smooth01(0, peakT, p); hy = f.y + (clear - f.y) * Math.sin(e * Math.PI / 2); }
      else { const e = smooth01(peakT, 1, p); hy = clear + (to.y - clear) * (1 - Math.cos(e * Math.PI / 2)); }
      this.height = P.H_STAND - 0.45 * Math.sin(Math.PI * p);
    } else {
      // mantle / step-up: rise then move forward
      const p1 = smooth01(0, 0.6, p), p2 = smooth01(0.25, 1, p);
      hx = f.x + (to.x - f.x) * p2; hz = f.z + (to.z - f.z) * p2;
      hy = f.y + (to.y + 0.02 - f.y) * p1;
      this.height = P.H_STAND - 0.5 * Math.sin(Math.PI * p);
    }
    this.pos.x = hx; this.pos.y = hy; this.pos.z = hz;
    // mantle jump (Dying Light style): jump in the back half of a climb/vault to launch off the top
    const late = k === 'pullup' ? 0.62 : 0.5;
    if (this.jumpBuffer > 0 && p >= late && !this.world.overlapCylinder(hx, hy + 0.02, hz, P.R * 0.95, P.H_STAND - 0.05)) {
      this.jumpBuffer = 0;
      const sp = Math.hypot(this.tExit.x, this.tExit.z) + 2.4;
      this.vel.x = this.tDirX * sp; this.vel.z = this.tDirZ * sp; this.vel.y = P.JUMP_V + 0.9;
      this.height = P.H_STAND; this.crouched = false;
      this.setState(PState.Air); this.airEntrySpeed = sp; this.airTime = 0; this.jumpHoldT = 0;
      this.fallStartY = this.pos.y; this.climbUsed = false;
      this.events.push({ type: 'mantleJump' }, { type: 'jump', speed: sp, surface: this.surface });
      return;
    }
    if (this.stateTime >= this.tDur) {
      this.pos.x = to.x; this.pos.y = to.y; this.pos.z = to.z;
      this.vel.x = this.tExit.x; this.vel.z = this.tExit.z; this.vel.y = 0;
      // keep forward input momentum: if player still pushing, allow carrying more speed
      this.height = this.canStand() ? P.H_STAND : P.H_CROUCH;
      this.crouched = this.height < P.H_STAND;
      const sup = this.world.support(this.pos.x, this.pos.y, this.pos.z, P.R * 0.92, 0.12);
      if (sup) {
        this.ground = sup; this.surface = sup.surface;
        this.setState(PState.Ground);
        if (k === 'speedvault' || k === 'kongvault') this.events.push({ type: 'land', impact: 2.5, surface: sup.surface, speed: this.hSpeed, hard: false });
      } else {
        this.setState(PState.Air); this.airEntrySpeed = Math.max(3, this.hSpeed); this.airTime = 0.1;
        this.fallStartY = this.pos.y;
      }
    }
    void input;
  }

  /**
   * Vault / step-up detection against a low obstacle ahead along the velocity direction.
   * fromJump: player pressed jump (allows lower speeds). airborne: called from air state near the end of a jump.
   */
  private tryVault(fromJump: boolean, input: InputFrame, airborne = false): boolean {
    let s = this.hSpeed;
    let dx: number, dz: number;
    if (s > 0.5) { dx = this.vel.x / s; dz = this.vel.z / s; } else { dx = this.fwdX; dz = this.fwdZ; s = 0; }
    if (!fromJump && s < 3.2) return false;
    if (dx * this.fwdX + dz * this.fwdZ < 0.35) return false;
    const reach = P.R + 0.3 + s * (airborne ? 0.06 : 0.1);
    let hit = null;
    for (const hy of [0.35, 0.75, 1.1]) {
      const h = this.wallRay(this.pos.x, this.pos.y + hy, this.pos.z, dx, dz, reach);
      if (h && !(h.box.flags & (F.PIPE | F.LADDER))) { hit = h; break; }
    }
    if (!hit) return false;
    const nx = hit.nx, nz = hit.nz;
    if (-(dx * nx + dz * nz) < 0.55) return false;
    // obstacle top
    const top = this.world.raycast(hit.x - nx * 0.06, this.pos.y + 1.6, hit.z - nz * 0.06, 0, -1, 0, 1.6);
    if (!top || top.ny !== 1) return false;
    const h = top.y - this.pos.y;
    if (h < 0.38 || h > 1.4) return false;
    // clearance above the obstacle for the body to pass
    const cx = hit.x - nx * 0.25, cz = hit.z - nz * 0.25;
    if (this.world.overlapCylinder(cx, top.y + 0.02, cz, 0.22, 1.0)) return false;
    // measure depth: where does the top end?
    let depth = -1;
    for (let k = 0.2; k <= 2.0; k += 0.15) {
      const px = hit.x + dx * k, pz = hit.z + dz * k;
      const g = this.world.raycast(px, top.y + 0.05, pz, 0, -1, 0, 0.3);
      if (!g) { depth = k; break; }
    }
    const surface = top.box.surface;
    if (depth > 0 && depth <= 1.7 && s >= 2.5) {
      // land point beyond the obstacle
      const along = depth + P.R + 0.3 + Math.min(1.2, s * 0.08);
      const lx = hit.x + dx * along, lz = hit.z + dz * along;
      const g = this.world.raycast(lx, top.y + 0.3, lz, 0, -1, 0, 3.0);
      let ly = g ? g.y : top.y - 1.0;
      if (g && g.y > top.y + 0.01) return false;
      // free path over? check standing clearance at the landing point
      if (this.world.overlapCylinder(lx, ly + 0.05, lz, P.R * 0.95, P.H_STAND - 0.1)) {
        if (!g) return false;
        // try closer landing
        return false;
      }
      if (!g) {
        // nothing to land on within reach: only a deliberate jump-vault launches into a drop,
        // and never over barriers (railings)
        if (!fromJump || (top.box.flags & F.NO_GRAB)) return false;
        ly = Math.max(this.pos.y - 0.5, top.y - 1.2);
      }
      // obstacle must be a vault-able height relative to the landing too
      const kind: TraverseKind = h > 1.05 ? 'kongvault' : 'speedvault';
      const dist = Math.hypot(lx - this.pos.x, lz - this.pos.z);
      const vs = Math.max(s, 4.2);
      const dur = clamp(dist / (vs * 0.95), 0.32, 0.7);
      const exit = Math.max(s * (kind === 'kongvault' ? 1.02 : 0.95), 3.8);
      this.wallNX = nx; this.wallNZ = nz;
      this.beginTraverse(kind, { x: lx, y: ly, z: lz }, dur, dx, dz, exit, top.y);
      this.tHand.x = hit.x - nx * 0.15 + dx * 0.05; this.tHand.y = top.y; this.tHand.z = hit.z - nz * 0.15;
      this.events.push({ type: 'handplant', surface });
      return true;
    }
    // platform: step up onto it
    const ux = hit.x - nx * (P.R + 0.2), uz = hit.z - nz * (P.R + 0.2);
    if (this.world.overlapCylinder(ux, top.y + 0.02, uz, P.R * 0.95, P.H_CROUCH)) return false;
    if (!fromJump && h > 1.0 && s < 4) return false;
    const kind: TraverseKind = h < 0.9 ? 'stepup' : 'mantle';
    const dur = kind === 'stepup' ? clamp(0.22 + h * 0.1, 0.24, 0.34) : clamp(0.42 - s * 0.012, 0.3, 0.45);
    this.wallNX = nx; this.wallNZ = nz;
    this.beginTraverse(kind, { x: ux, y: top.y, z: uz }, dur, dx, dz, Math.max(s * (kind === 'stepup' ? 0.9 : 0.75), 2), top.y);
    this.tHand.x = hit.x - nx * 0.15; this.tHand.y = top.y; this.tHand.z = hit.z - nz * 0.15;
    this.events.push({ type: 'handplant', surface });
    void input;
    return true;
  }

  // ---- pipes & ladders ----------------------------------------------------------------------
  private tryPipe(input: InputFrame, fromGround = false): boolean {
    if (this.wallCooldown > 0.1 && this.pipe) return false;
    const list = this.world.query(this.pos.x - 1, this.pos.z - 1, this.pos.x + 1, this.pos.z + 1, this.pos.y, this.pos.y + 2.2);
    for (const b of list) {
      if (!(b.flags & (F.PIPE | F.LADDER))) continue;
      const handY = this.pos.y + 1.9;
      if (handY < b.minY + 0.5 || this.pos.y + 0.6 > b.maxY) continue;
      const cx = Math.max(b.minX, Math.min(this.pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(this.pos.z, b.maxZ));
      const ox = this.pos.x - cx, oz = this.pos.z - cz;
      const d = Math.hypot(ox, oz);
      if (d > P.R + (fromGround ? 0.2 : 0.45) || d < 1e-4) continue;
      const tx = -ox / d, tz = -oz / d; // toward pipe
      if (fromGround && (this.fwdX * tx + this.fwdZ * tz < 0.6 || (b.flags & F.PIPE && b.minY > this.pos.y + 1.0))) continue;
      if (this.fwdX * tx + this.fwdZ * tz < 0.3 && !(input.moveY > 0.5 && (this.vel.x * tx + this.vel.z * tz) > 1)) continue;
      // axis-aligned outward normal for stable attachment
      let nx = 0, nz = 0;
      if (Math.abs(ox) > Math.abs(oz)) nx = Math.sign(ox); else nz = Math.sign(oz);
      if (this.pipe === b && this.stateTime < 0.4) continue;
      this.pipe = b; this.pipeNX = nx; this.pipeNZ = nz; this.pipeLadder = !!(b.flags & F.LADDER);
      this.setState(PState.Pipe);
      this.jumpBuffer = 0;
      this.vel.x = this.vel.z = 0; this.vel.y = 0;
      this.events.push({ type: 'pipeGrab' });
      this.climbUsed = false;
      return true;
    }
    return false;
  }

  private updatePipe(dt: number, input: InputFrame) {
    const b = this.pipe!;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const hx = (b.maxX - b.minX) / 2, hz = (b.maxZ - b.minZ) / 2;
    const tx = cx + this.pipeNX * (hx + P.R + 0.04), tz = cz + this.pipeNZ * (hz + P.R + 0.04);
    this.pos.x += (tx - this.pos.x) * Math.min(1, dt * 18);
    this.pos.z += (tz - this.pos.z) * Math.min(1, dt * 18);
    const up = this.pipeLadder ? 2.6 : 1.9;
    let vy = 0;
    if (input.crouch) vy = -5.5;
    else if (input.moveY > 0.2) vy = up * (0.55 + 0.45 * Math.abs(Math.sin(this.pipeClimbPhase)));
    else if (input.moveY < -0.2) vy = -2.4;
    const prevPhase = this.pipeClimbPhase;
    this.pipeClimbPhase += Math.abs(vy) * dt * 3.2;
    if (Math.floor(prevPhase / Math.PI) !== Math.floor(this.pipeClimbPhase / Math.PI) && vy > 0)
      this.events.push({ type: 'climbStep', surface: this.pipeLadder ? Surface.Metal : Surface.Metal });
    this.pos.y += vy * dt;
    this.vel.y = vy;
    // top: hands reach the top of the pipe -> look for a ledge to climb onto
    const handY = this.pos.y + 2.05;
    if (handY >= b.maxY - 0.05) {
      this.pos.y = b.maxY - 2.05;
      if (input.moveY > 0.2) {
        const dirs: [number, number][] = [[-this.pipeNX, -this.pipeNZ], [this.fwdX, this.fwdZ]];
        for (const [dx, dz] of dirs) {
          const hit = this.wallRay(this.pos.x, this.pos.y + 1.6, this.pos.z, dx, dz, 1.6, true);
          if (!hit) continue;
          const l = this.detectLedge(hit.x, hit.z, hit.nx, hit.nz, 0.8, 2.6);
          if (l && l.canClimb) {
            this.startClimbOnto(l, 'mantle');
            this.tDur = 0.6;
            this.tKind = 'pullup';
            return;
          }
        }
        // otherwise mount any walkable surface within reach at the top (crane jibs, tanks, platforms)
        const ins = [[-this.pipeNX, -this.pipeNZ], [-this.pipeNZ, this.pipeNX], [this.pipeNZ, -this.pipeNX]];
        for (const [dx, dz] of ins) for (let d = 0.6; d <= 1.9; d += 0.25) {
          const qx = this.pos.x + dx * d, qz = this.pos.z + dz * d;
          const top = this.world.raycast(qx, b.maxY + 1.4, qz, 0, -1, 0, 1.9, notClimbable);
          if (!top || top.ny !== 1 || top.y < b.maxY - 0.4) continue;
          if (this.world.overlapCylinder(qx, top.y + 0.03, qz, P.R * 0.9, P.H_CROUCH)) continue;
          this.beginTraverse('pullup', { x: qx, y: top.y, z: qz }, 0.65, dx, dz, 0.5, top.y);
          this.tHand.x = this.pos.x + dx * 0.4; this.tHand.y = top.y; this.tHand.z = this.pos.z + dz * 0.4;
          return;
        }
      }
    }
    // bottom
    if (this.pos.y <= b.minY - 0.05 || (vy < 0 && this.world.support(this.pos.x, this.pos.y, this.pos.z, P.R * 0.9, 0.05))) {
      const sup = this.world.support(this.pos.x, this.pos.y + 0.05, this.pos.z, P.R * 0.9, 0.3);
      if (sup) { this.pos.y = sup.maxY; this.ground = sup; this.surface = sup.surface; this.setState(PState.Ground); return; }
      if (this.pos.y < b.minY - 0.6) { this.releasePipe(0.5, 0); return; }
    }
    if (this.jumpBuffer > 0 && this.stateTime > 0.2) {
      this.jumpBuffer = 0;
      // jump off: away from the pipe, toward camera if looking away
      let jx = this.fwdX, jz = this.fwdZ;
      if (jx * this.pipeNX + jz * this.pipeNZ < 0.1) { jx = this.pipeNX; jz = this.pipeNZ; }
      this.releasePipe(4.3, 5.3, jx, jz);
      this.events.push({ type: 'jump', speed: 0, surface: Surface.Metal });
    }
  }

  private releasePipe(h: number, vy: number, dx = this.pipeNX, dz = this.pipeNZ) {
    this.vel.x = dx * h; this.vel.z = dz * h; this.vel.y = vy;
    this.setState(PState.Air); this.airEntrySpeed = h; this.airTime = 0; this.jumpHoldT = 0;
    this.wallCooldown = 0.4; this.fallStartY = this.pos.y;
  }

  // ---- ziplines -----------------------------------------------------------------------------
  private tryZip(): boolean {
    if (this.wallCooldown > 0 && this.zip) return false;
    const hx = this.pos.x, hy = this.pos.y + 2.05, hz = this.pos.z;
    for (const z of this.ziplines) {
      const dx = z.bx - z.ax, dy = z.by - z.ay, dz = z.bz - z.az;
      const L2 = dx * dx + dy * dy + dz * dz;
      let t = ((hx - z.ax) * dx + (hy - z.ay) * dy + (hz - z.az) * dz) / L2;
      if (t < 0.02 || t > 0.96) continue;
      const px = z.ax + dx * t, py = z.ay + dy * t, pz = z.az + dz * t;
      const d = Math.hypot(hx - px, (hy - py) * 0.7, hz - pz);
      if (d > 0.75) continue;
      if (py < hy - 0.9) continue;
      const L = Math.sqrt(L2);
      const along = (this.vel.x * dx + this.vel.y * dy + this.vel.z * dz) / L;
      this.zip = z; this.zipT = t; this.zipSpeed = Math.max(4, along);
      this.setState(PState.Zip);
      this.events.push({ type: 'zipStart' });
      return true;
    }
    return false;
  }

  private updateZip(dt: number, input: InputFrame) {
    const z = this.zip!;
    const dx = z.bx - z.ax, dy = z.by - z.ay, dz = z.bz - z.az;
    const L = Math.hypot(dx, dy, dz);
    const sinSlope = -dy / L;
    this.zipSpeed = Math.min(16, this.zipSpeed + (P.G * 0.5 * sinSlope - 0.4) * dt);
    this.zipSpeed = Math.max(this.zipSpeed, 3);
    this.zipT += this.zipSpeed * dt / L;
    const hx = z.ax + dx * this.zipT, hy = z.ay + dy * this.zipT, hz = z.az + dz * this.zipT;
    this.pos.x = hx; this.pos.y = hy - 2.05; this.pos.z = hz;
    this.vel.x = dx / L * this.zipSpeed; this.vel.y = dy / L * this.zipSpeed; this.vel.z = dz / L * this.zipSpeed;
    const release = this.zipT >= 0.97 || this.jumpBuffer > 0 || input.crouchPressed ||
      this.world.overlapCylinder(this.pos.x, this.pos.y + 0.1, this.pos.z, P.R * 0.9, 1.6);
    if (release) {
      this.jumpBuffer = 0;
      if (this.vel.y < 0) this.vel.y *= 0.3;
      this.vel.y += 2.5;
      this.setState(PState.Air); this.airEntrySpeed = this.hSpeed; this.airTime = 0; this.wallCooldown = 0.5;
      this.fallStartY = this.pos.y;
    }
  }
}
