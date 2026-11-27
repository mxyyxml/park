import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/physics/collision';
import { emptyInput, PlayerController, PState, type InputFrame } from '../src/player/PlayerController';

const DT = 1 / 120;

describe('parkour chaining', () => {
  it('sprint -> jump -> wall-run -> wall-jump -> grapple swing -> fling -> landing, without stopping', () => {
    const w = new CollisionWorld();
    w.add(-300, -1, -300, 300, 0, 300);           // street
    w.add(-4, 0, -40, 4, 10, 0);                  // roof A: start here, running toward -z
    w.add(0.9, 8, -75, 1.5, 18, -40);             // a billboard wall to the right, over the gap
    w.add(-6, 0, -140, 6, 10, -88);               // roof B far beyond
    w.add(-2, 26, -66, 2, 27, -62);               // a beam high over the gap to swing from
    const p = new PlayerController(w);
    p.spawn(0, 10, -2, 0);
    const seen: string[] = [];
    let walljumped = false, fired = false, released = false, minSpeed = 99, startSpeed = 0;
    for (let t = 0; t < 12 && !(released && p.state === PState.Ground && p.pos.z < -90 && t > 2); t += DT) {
      const f: InputFrame = { ...emptyInput(), moveY: 1, sprint: true };
      if (p.state === PState.Ground && p.pos.z < -38 && !fired) { f.jump = f.jumpPressed = true; }       // leap off roof A at the edge
      if (p.state === PState.WallRun && p.stateTime > 0.35 && !walljumped) { f.jump = f.jumpPressed = true; walljumped = true; }
      if (walljumped && !fired && p.state === PState.Air) {                                            // hook the beam ahead
        const ex = p.pos.x, ey = p.pos.y + 1.6, ez = p.pos.z, d = Math.hypot(-ex, 26 - ey, -64 - ez);
        const tg = p.grappleTarget(ex, ey, ez, -ex / d, (26 - ey) / d, (-64 - ez) / d);
        if (tg) { p.fireHook(tg); fired = true; }
      }
      if (p.state === PState.Grapple && p.pos.z < -66 && p.vel.y > -1 && !released) { f.jump = f.jumpPressed = true; released = true; }
      p.update(DT, f);
      if (seen.at(-1) !== p.state) seen.push(p.state);
      if (t > 1.5 && t < 1.6) startSpeed = p.hSpeed;
      if (t > 1.6 && p.state !== PState.Dead && p.state !== PState.Hang && p.state !== PState.Traverse) minSpeed = Math.min(minSpeed, p.hSpeed); // a ledge hang is a deliberate stop
      if (p.state === PState.Dead) break;
    }
    console.log('chain:', seen.join(' -> '), `| start ${startSpeed.toFixed(1)} m/s, slowest ${minSpeed.toFixed(1)} m/s, end ${p.hSpeed.toFixed(1)} m/s at z ${p.pos.z.toFixed(0)}`);
    expect(seen).not.toContain(PState.Dead);
    for (const s of [PState.Air, PState.WallRun, PState.Grapple]) expect(seen).toContain(s);
    expect(p.pos.z).toBeLessThan(-90);             // made it to roof B
    expect(p.pos.y).toBeCloseTo(10, 0);
    expect(minSpeed).toBeGreaterThan(3);           // never brought to a stop along the way
    expect(p.hSpeed).toBeGreaterThan(4);           // running again after the climb, not standing
  });
});
