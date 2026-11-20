/**
 * Ghost recording / playback. Frames capture everything the procedural body needs, so a ghost
 * replays with the same animation the player saw (hands on ledges, wall-run steps, rolls...).
 */
import { PState, TraverseKind, PlayerController } from '../player/PlayerController';
import type { BodyDriver } from '../player/Body';

const STATES: PState[] = [PState.Ground, PState.Air, PState.Slide, PState.Roll, PState.WallRun, PState.WallClimb, PState.Hang, PState.Traverse, PState.Pipe, PState.Zip, PState.Dead];
const TKINDS: TraverseKind[] = ['speedvault', 'kongvault', 'stepup', 'mantle', 'pullup', 'grab'];
export const GHOST_HZ = 30;
const N = 34;

export class GhostRecorder {
  frames: number[] = [];
  private acc = 0;
  record(dt: number, p: PlayerController, force = false) {
    this.acc += dt;
    if (!force && this.acc < 1 / GHOST_HZ) return;
    this.acc = 0;
    this.frames.push(p.pos.x, p.pos.y, p.pos.z, p.yaw, p.pitch, STATES.indexOf(p.state), p.stateTime, p.gaitPhase, p.height,
      p.vel.x, p.vel.y, p.vel.z, p.wallNX, p.wallNZ, p.wallSide, p.wallPointX, p.wallPointZ, p.alongX, p.alongZ,
      p.ledgeX, p.ledgeY, p.ledgeZ, TKINDS.indexOf(p.tKind), p.tHand.x, p.tHand.y, p.tHand.z, p.tDirX, p.tDirZ, p.tDur,
      p.crouched ? 1 : 0, p.airTime, p.stumble, p.balance, p.pipeClimbPhase);
  }
  get length() { return this.frames.length / N; }
  data(): Float32Array { return new Float32Array(this.frames); }
}

export function encodeGhost(f: Float32Array): string {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function decodeGhost(s: string): Float32Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Float32Array(b.buffer);
}

/** A BodyDriver reconstructed from recorded frames at an arbitrary time. */
export class GhostPlayback implements BodyDriver {
  state = PState.Ground; stateTime = 0;
  pos = { x: 0, y: 0, z: 0 }; vel = { x: 0, y: 0, z: 0 };
  yaw = 0; pitch = 0; gaitPhase = 0; height = 1.8; crouched = false; airTime = 0; stumble = 0;
  wallNX = 0; wallNZ = 0; wallSide = 0; wallPointX = 0; wallPointZ = 0; alongX = 0; alongZ = 0;
  ledgeX = 0; ledgeY = 0; ledgeZ = 0;
  tKind: TraverseKind = 'mantle'; tHand = { x: 0, y: 0, z: 0 }; tDirX = 0; tDirZ = 0; tDur = 0.5;
  pipe = null; pipeNX = 0; pipeNZ = 0; pipeClimbPhase = 0;
  zip = null; zipT = 0; balance = 0;
  time = 0;
  constructor(public data: Float32Array) {}
  get duration() { return (this.data.length / N - 1) / GHOST_HZ; }
  get hSpeed() { return Math.hypot(this.vel.x, this.vel.z); }

  seek(t: number) {
    this.time = t;
    const n = this.data.length / N;
    if (n < 1) return;
    const f = Math.max(0, Math.min(n - 1.001, t * GHOST_HZ));
    const i = Math.floor(f), k = f - i;
    const a = i * N, b = Math.min(n - 1, i + 1) * N, d = this.data;
    const L = (o: number) => d[a + o] + (d[b + o] - d[a + o]) * k;
    const LA = (o: number) => { let x = d[b + o] - d[a + o]; while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return d[a + o] + x * k; };
    this.pos.x = L(0); this.pos.y = L(1); this.pos.z = L(2);
    this.yaw = LA(3); this.pitch = L(4);
    const si = d[a + 5]; this.state = STATES[si] ?? PState.Ground;
    this.stateTime = d[a + 6] + (d[b + 5] === si ? (d[b + 6] - d[a + 6]) * k : k / GHOST_HZ);
    this.gaitPhase = L(7); this.height = L(8);
    this.vel.x = L(9); this.vel.y = L(10); this.vel.z = L(11);
    this.wallNX = d[a + 12]; this.wallNZ = d[a + 13]; this.wallSide = d[a + 14];
    this.wallPointX = L(15); this.wallPointZ = L(16); this.alongX = d[a + 17]; this.alongZ = d[a + 18];
    this.ledgeX = L(19); this.ledgeY = L(20); this.ledgeZ = L(21);
    this.tKind = TKINDS[d[a + 22]] ?? 'mantle';
    this.tHand.x = d[a + 23]; this.tHand.y = d[a + 24]; this.tHand.z = d[a + 25];
    this.tDirX = d[a + 26]; this.tDirZ = d[a + 27]; this.tDur = d[a + 28];
    this.crouched = d[a + 29] > 0.5; this.airTime = L(30); this.stumble = L(31); this.balance = L(32); this.pipeClimbPhase = L(33);
  }
}
