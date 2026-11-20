import { CollisionWorld, Surface } from '../src/physics/collision';
import { emptyInput, InputFrame, PlayerController, PState } from '../src/player/PlayerController';

export const DT = 1 / 120;

export function flatWorld(): CollisionWorld {
  const w = new CollisionWorld();
  w.add(-200, -1, -200, 200, 0, 200, Surface.Concrete);
  return w;
}

export function makePlayer(w: CollisionWorld, x = 0, y = 0, z = 0, yaw = 0) {
  const p = new PlayerController(w);
  p.spawn(x, y, z, yaw);
  return p;
}

export type Script = (t: number, p: PlayerController) => Partial<InputFrame>;

/** Run the controller for `seconds`, collecting visited states and events. */
export function run(p: PlayerController, seconds: number, script: Script, stopWhen?: (p: PlayerController) => boolean) {
  const states = new Set<PState>();
  const events: string[] = [];
  let prevJump = false, prevCrouch = false;
  const steps = Math.round(seconds / DT);
  let maxY = -Infinity;
  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    const s = script(t, p);
    const inp = { ...emptyInput(), ...s };
    inp.jumpPressed = s.jumpPressed ?? (!!inp.jump && !prevJump);
    inp.crouchPressed = s.crouchPressed ?? (!!inp.crouch && !prevCrouch);
    prevJump = !!inp.jump; prevCrouch = !!inp.crouch;
    p.update(DT, inp);
    states.add(p.state);
    for (const e of p.events) events.push(e.type);
    maxY = Math.max(maxY, p.pos.y);
    if (stopWhen && stopWhen(p)) break;
  }
  return { states, events, maxY };
}

export const sprint: Script = () => ({ moveY: 1, sprint: true });
