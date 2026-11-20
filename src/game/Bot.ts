/**
 * Autopilot that drives the real PlayerController through a list of waypoints using only
 * player inputs (stick, jump, crouch). Used to validate every time-trial route headless and
 * as the in-game attract/demo mode.
 */
import { CollisionWorld, F } from '../physics/collision';
import { emptyInput, InputFrame, PlayerController, PState } from '../player/PlayerController';

export interface Waypoint { x: number; y: number; z: number; kind?: string; arrive?: number }

const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export class Bot {
  i = 0;
  private jumpHeld = 0;
  private crouchHeld = 0;
  private prevJump = false; private prevCrouch = false;
  stuckT = 0;
  private lastProgress = 0;
  private bestDist = Infinity;
  constructor(public world: CollisionWorld, public wps: Waypoint[]) {}

  get done() { return this.i >= this.wps.length; }

  step(p: PlayerController, dt: number): InputFrame {
    const f = emptyInput();
    if (this.done || p.state === PState.Dead) return f;
    let wp = this.wps[this.i];
    let dx = wp.x - p.pos.x; let dz = wp.z - p.pos.z;
    let dist = Math.hypot(dx, dz);
    const arrive = wp.arrive ?? 1.6;
    let passed = false;
    if (wp.kind === 'ladder' && (p.state === PState.Pipe || p.pos.y > wp.y + 2)) passed = true;
    const nx = this.wps[this.i + 1];
    if (nx && dist < 5 && Math.abs(wp.y - p.pos.y) < 2.6 && wp.kind !== 'strict') {
      // overshot the waypoint along the route (e.g. during a vault): move on
      const ax = nx.x - wp.x, az = nx.z - wp.z;
      passed = (p.pos.x - wp.x) * ax + (p.pos.z - wp.z) * az > 0;
    }
    const vTol = wp.kind === 'strict' ? 0.8 : 2.6;
    if ((dist < arrive || passed) && (Math.abs(wp.y - p.pos.y) < vTol || wp.kind === 'ladder') && p.state !== PState.Air) { this.i++; this.bestDist = Infinity; if (this.done) return f; wp = this.wps[this.i]; dx = wp.x - p.pos.x; dz = wp.z - p.pos.z; dist = Math.hypot(dx, dz); }
    // progress / stuck detection
    const d3 = Math.hypot(dist, wp.y - p.pos.y);
    if (d3 < this.bestDist - 0.3) { this.bestDist = d3; this.lastProgress = 0; } else this.lastProgress += dt;
    this.stuckT = this.lastProgress;

    // steer toward a look-ahead point on the route segment (keeps the runner on the line)
    let tx = wp.x, tz = wp.z;
    const pv = this.i > 0 ? this.wps[this.i - 1] : null;
    if (pv) {
      const sx = wp.x - pv.x, sz = wp.z - pv.z, L = Math.hypot(sx, sz);
      if (L > 1) {
        const ux = sx / L, uz = sz / L;
        const along = (p.pos.x - pv.x) * ux + (p.pos.z - pv.z) * uz;
        const a = Math.min(L, Math.max(0, along) + (p.onBeam ? 1.0 : 2.5));
        tx = pv.x + ux * a; tz = pv.z + uz * a;
      }
    }
    const want = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
    let dyaw = wrap(want - p.yaw);
    if (p.state === PState.Hang || p.state === PState.WallClimb || p.state === PState.Pipe || p.state === PState.Traverse || p.state === PState.Roll) dyaw = 0;
    f.lookX = -Math.max(-6 * dt, Math.min(6 * dt, dyaw));
    f.lookY = -p.pitch * Math.min(1, dt * 5);
    const aligned = Math.abs(dyaw) < 0.5;
    f.moveY = aligned ? 1 : 0.4;
    f.sprint = aligned && dist > 2.5;
    // ease off when closing on a tight waypoint (small platforms)
    if (arrive < 1.5 && dist < 2.8 && p.state === PState.Ground) { f.sprint = false; f.moveY = Math.abs(dyaw) < 0.3 ? Math.min(f.moveY, 0.45) : 0; }
    // brake before a sharp turn at the next waypoint
    const nxt = this.wps[this.i + 1];
    if (nxt && p.state === PState.Ground) {
      const a1 = Math.atan2(wp.x - p.pos.x, wp.z - p.pos.z), a2 = Math.atan2(nxt.x - wp.x, nxt.z - wp.z);
      const turn = Math.abs(wrap(a2 - a1));
      if (turn > 1.0 && dist < p.hSpeed * 0.9 && p.hSpeed > 5) { f.sprint = false; f.moveY = 0; }
    }

    let jump = false, crouch = false;
    const sp = p.hSpeed;
    if (p.state === PState.Ground) {
      // edge ahead with the target beyond: jump at the lip
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const look = 0.45 + sp * 0.045;
      const g = this.world.raycast(p.pos.x + fx * look, p.pos.y + 0.45, p.pos.z + fz * look, 0, -1, 0, 1.1);
      if (!g) {
        // only leap if the waypoint really lies ahead, across the gap; otherwise stop at the lip
        const tdx = (wp.x - p.pos.x) / (dist || 1), tdz = (wp.z - p.pos.z) / (dist || 1);
        const ahead = fx * tdx + fz * tdz;
        if (dist > 1.5 && ahead > 0.85) jump = true;
        else if (p.hSpeed > 0.5) { f.moveY = 0; f.sprint = false; }
      }
      // wall ahead taller than a vault: jump (wall climb) when close
      const wall = this.world.raycast(p.pos.x, p.pos.y + 1.5, p.pos.z, fx, 0, fz, 0.9 + sp * 0.08);
      const wallW = wall ? (Math.abs(wall.nx) > 0.5 ? wall.box.maxZ - wall.box.minZ : wall.box.maxX - wall.box.minX) : 0;
      if (wall && wall.ny === 0 && wallW >= 1.2 && !(wall.box.flags & (F.LADDER | F.PIPE)) && aligned && (wp.y > p.pos.y + 1.0 || wall.t < 0.8)) {
        const top = wall.box.maxY - p.pos.y;
        if (top > 1.4 && top < 4.4) jump = true;
      }
      // steer around narrow obstacles (posts, antennas, vents) in the way
      const fwdHit = this.world.raycast(p.pos.x, p.pos.y + 0.9, p.pos.z, fx, 0, fz, 1.6);
      if (fwdHit && fwdHit.ny === 0) {
        const b = fwdHit.box;
        const w = Math.abs(fwdHit.nx) > 0.5 ? b.maxZ - b.minZ : b.maxX - b.minX;
        if (w < 1.2 && b.maxY - p.pos.y > 1.3) {
          const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
          const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
          const side = (p.pos.x - cx) * rx + (p.pos.z - cz) * rz;
          f.moveX = side >= 0 ? 1 : -1;
          jump = false;
        }
      }
      // a higher platform just ahead: jump up to it (ledge grab / mantle does the rest)
      if (wp.y > p.pos.y + 0.8 && dist < 4.2 && Math.abs(dyaw) < 0.3 && dist > 1.2) {
        const gap = this.world.raycast(p.pos.x + fx * 0.6, p.pos.y + 0.3, p.pos.z + fz * 0.6, 0, -1, 0, 0.6);
        if (!gap) jump = true;
      }
      // zipline start / pipe: jump when close to the waypoint flagged for it
      if ((wp.kind === 'zip') && dist < 2.2) jump = true;
      // balance on beams: correct the sway, walk steadily, never leap off
      if (p.onBeam) { f.moveX = -Math.sign(p.balance) * Math.min(1, Math.abs(p.balance) * 4); f.sprint = false; if (!this.world.raycast(p.pos.x + fx * 1.2, p.pos.y + 0.3, p.pos.z + fz * 1.2, 0, -1, 0, 0.6) && dist > 3) { /* end of beam ahead: drop off only toward the target */ } else jump = false; }
      // stuck: try a jump / wiggle
      if (this.stuckT > 1.5 && this.stuckT < 1.6 && g) jump = true;
      if (this.stuckT > 2.5) f.moveX = Math.sin(this.stuckT * 3);
    } else if (p.state === PState.Air) {
      // brace for big drops with a roll
      if (p.vel.y < -11) {
        const g = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, 0, -1, 0, 2.2);
        if (g) crouch = true;
      }
      if (wp.y > p.pos.y + 2.2 && p.vel.y > -2) {
        // keep jump held for wall-climb into ledges
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        const wall = this.world.raycast(p.pos.x, p.pos.y + 1.2, p.pos.z, fx, 0, fz, 0.9);
        if (wall && !p.climbUsed) jump = true;
      }
    } else if (p.state === PState.Hang) {
      f.moveY = 1;
    } else if (p.state === PState.Pipe) {
      f.moveY = 1;
    } else if (p.state === PState.WallRun) {
      // stay on the wall until the end of the run, or jump off toward a waypoint across
      f.moveY = 1;
    }
    if (p.state === PState.Ground && p.onBeam) {
      const fx2 = -Math.sin(p.yaw), fz2 = -Math.cos(p.yaw);
      const endAhead = !this.world.raycast(p.pos.x + fx2 * 1.0, p.pos.y + 0.3, p.pos.z + fz2 * 1.0, 0, -1, 0, 0.8);
      const along = this.wps[this.i] ? Math.hypot(this.wps[this.i].x - p.pos.x, this.wps[this.i].z - p.pos.z) : 0;
      if (!(endAhead && along < 12)) jump = false;
    }
    f.jump = jump || this.jumpHeld > 0;
    f.jumpPressed = jump && !this.prevJump;
    f.crouch = crouch;
    f.crouchPressed = crouch && !this.prevCrouch;
    this.prevJump = f.jump; this.prevCrouch = f.crouch;
    if (this.jumpHeld > 0) this.jumpHeld -= dt;
    void this.crouchHeld;
    return f;
  }
}

/** Waypoints for a trial: follow its checkpoints, approaching each edge squarely. */
export function waypointsForTrial(cps: { x: number; y: number; z: number }[]): Waypoint[] {
  return cps.map((c) => ({ x: c.x, y: c.y, z: c.z, arrive: 2.4 }));
}
