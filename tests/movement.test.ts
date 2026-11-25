import { describe, expect, it } from 'vitest';
import { CollisionWorld, F, Surface } from '../src/physics/collision';
import { PState } from '../src/player/PlayerController';
import { DT, flatWorld, makePlayer, run, sprint } from './helpers';

// yaw = 0 => forward is -Z
describe('ground locomotion', () => {
  it('jogs at jog speed and builds sprint momentum over time', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    run(p, 1.0, () => ({ moveY: 1 }));
    expect(p.hSpeed).toBeGreaterThan(4.5);
    expect(p.hSpeed).toBeLessThan(5.2);
    run(p, 0.6, sprint);
    const early = p.hSpeed;
    run(p, 3.0, sprint);
    expect(p.hSpeed).toBeGreaterThan(9.2);
    expect(early).toBeLessThan(p.hSpeed - 1); // momentum takes time to build
  });

  it('walks slowly and stops with deceleration rather than instantly', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    run(p, 1.0, () => ({ moveY: 1, walk: true }));
    expect(p.hSpeed).toBeCloseTo(2.0, 1);
    run(p, 3, sprint);
    const s0 = p.hSpeed;
    run(p, 0.1, () => ({}));
    expect(p.hSpeed).toBeGreaterThan(s0 * 0.6); // inertia
    run(p, 1.0, () => ({}));
    expect(p.hSpeed).toBeLessThan(0.01);
  });

  it('turns slower at high speed (speed-dependent turning)', () => {
    const turnAfter = (sprinting: boolean) => {
      const w = flatWorld();
      const p = makePlayer(w);
      run(p, 3, () => ({ moveY: 1, sprint: sprinting }));
      run(p, 0.15, () => ({ moveX: 1, sprint: sprinting })); // ask for 90° right
      return Math.abs(Math.atan2(p.vel.x, -p.vel.z));
    };
    expect(turnAfter(false)).toBeGreaterThan(turnAfter(true) * 1.4);
  });

  it('crouches under a low ceiling and cannot stand until clear', () => {
    const w = flatWorld();
    w.add(-2, 1.3, -6, 2, 2, -3);
    const p = makePlayer(w);
    run(p, 4.5, () => ({ moveY: 1, crouch: true }));
    expect(p.pos.z).toBeLessThan(-6.5);
    expect(p.state).toBe(PState.Ground);
  });

  it('steps up a curb without stopping', () => {
    const w = flatWorld();
    w.add(-5, 0, -10, 5, 0.3, -4);
    const p = makePlayer(w);
    run(p, 2, () => ({ moveY: 1 }));
    expect(p.pos.y).toBeCloseTo(0.3, 2);
    expect(p.pos.z).toBeLessThan(-6);
  });
});

describe('jumping & momentum', () => {
  const jumpDistance = (sprinting: boolean) => {
    const w = flatWorld();
    const p = makePlayer(w);
    run(p, 3, () => ({ moveY: 1, sprint: sprinting }));
    const z0 = p.pos.z;
    run(p, 1.5, (t) => ({ moveY: 1, sprint: sprinting, jump: t < 0.3 }), (q) => q.state === PState.Ground && q.stateTime > 0 && q.pos.z < z0 - 0.5);
    return z0 - p.pos.z;
  };

  it('running faster jumps further', () => {
    const jog = jumpDistance(false);
    const spr = jumpDistance(true);
    expect(spr).toBeGreaterThan(jog * 1.5);
    expect(spr).toBeGreaterThan(5.5);
  });

  it('sprint-jumps a 5m rooftop gap, but a jog cannot', () => {
    const attempt = (sprinting: boolean) => {
      const w = new CollisionWorld();
      w.add(-10, 0, -40, 10, 20, 0); // roof A: top at y=20, edge at z=-40
      w.add(-10, 0, -85, 10, 19.5, -45); // roof B 5m away, 0.5m lower
      w.add(-200, -1, -200, 200, 0, 200, Surface.Concrete, F.DEADLY);
      const p = makePlayer(w, 0, 20, -2);
      const r = run(p, 12, (_t, q) => ({ moveY: 1, sprint: sprinting, jump: q.pos.z < -39.3 && q.pos.z > -40.2 }),
        (q) => q.state === PState.Dead || (q.state === PState.Ground && q.pos.z < -45.5));
      return { p, r };
    };
    const ok = attempt(true);
    expect(ok.p.state).not.toBe(PState.Dead);
    expect(ok.p.pos.y).toBeCloseTo(19.5, 1);
    expect(ok.r.states.has(PState.Hang)).toBe(false); // clean landing
    const jog = attempt(false);
    // a jog only reaches the far wall: at best it catches the ledge (cat leap), never lands clean
    expect(jog.r.states.has(PState.Hang) || jog.p.pos.y < 19).toBe(true);
  });
});

describe('landing physics', () => {
  const drop = (h: number, crouch: boolean) => {
    const w = flatWorld();
    w.add(-3, 0, -3, 3, h, 3);
    const p = makePlayer(w, 0, h, 0);
    const res = run(p, 4, (_t, q) => ({ moveY: 1, crouch: crouch && q.pos.y < 2.5 }));
    return { p, res };
  };

  it('soft drop is fine, big drop stumbles, roll keeps momentum, huge fall kills', () => {
    const small = drop(1.5, false);
    expect(small.res.events).toContain('land');
    expect(small.p.state).not.toBe(PState.Dead);

    const hard = drop(5, false);
    expect(hard.res.events).toContain('land');
    expect(hard.p.state).not.toBe(PState.Dead);

    const rolled = drop(6.5, true);
    expect(rolled.res.events).toContain('roll');
    expect(rolled.p.state).not.toBe(PState.Dead);

    const fatal = drop(14, false);
    expect(fatal.p.state).toBe(PState.Dead);
  });
});

describe('parkour moves', () => {
  it('speed-vaults a waist-high obstacle and keeps momentum', () => {
    const w = flatWorld();
    w.add(-3, 0, -12.4, 3, 1.0, -12); // 1m tall, 0.4m deep
    const p = makePlayer(w);
    const r = run(p, 4, sprint, (q) => q.pos.z < -16);
    expect(r.events).toContain('traverse');
    expect(p.pos.z).toBeLessThan(-14);
    expect(p.hSpeed).toBeGreaterThan(5);
  });

  it('steps up onto a deep waist-high platform while running', () => {
    const w = flatWorld();
    w.add(-3, 0, -30, 3, 0.9, -10);
    const p = makePlayer(w);
    run(p, 3, sprint);
    expect(p.pos.y).toBeCloseTo(0.9, 2);
  });

  it('slides under a low bar conserving momentum', () => {
    const w = flatWorld();
    w.add(-3, 1.1, -14.2, 3, 1.5, -14);
    const p = makePlayer(w, 0, 0, 12);
    run(p, 2.5, sprint);
    const r = run(p, 1.5, (t) => ({ moveY: 1, sprint: true, crouch: t < 0.9 }));
    expect(r.events).toContain('slideStart');
    expect(p.pos.z).toBeLessThan(-15);
  });

  it('grabs a ledge, hangs, then pulls up onto the roof', () => {
    const w = flatWorld();
    w.add(-5, 0, -30, 5, 2.9, -6); // wall face at z=-6, top 2.9
    const p = makePlayer(w, 0, 0, -3);
    const r = run(p, 4, (t, q) => ({ moveY: 1, jump: t > 0.3 && t < 0.4 }), (q) => q.state === PState.Ground && q.pos.y > 2.8);
    expect(r.states.has(PState.Hang) || r.events.includes('traverse')).toBe(true);
    expect(p.pos.y).toBeCloseTo(2.9, 1);
  });

  it('wall-climbs a 4m wall and climbs onto it', () => {
    const w = flatWorld();
    w.add(-5, 0, -30, 5, 4.0, -10);
    const p = makePlayer(w);
    const r = run(p, 5, (t, q) => ({ moveY: 1, sprint: true, jump: q.pos.z < -9.0 && t < 3 }), (q) => q.state === PState.Ground && q.pos.y > 3.9);
    expect(r.states.has(PState.WallClimb)).toBe(true);
    expect(p.pos.y).toBeCloseTo(4.0, 1);
  });

  it('cannot climb a wall far beyond reach', () => {
    const w = flatWorld();
    w.add(-5, 0, -30, 5, 7.0, -10);
    const p = makePlayer(w);
    run(p, 4, (_t, q) => ({ moveY: 1, sprint: true, jump: q.pos.z < -9.0 }));
    expect(p.pos.y).toBeLessThan(1);
  });

  it('wall-runs along a side wall and wall-jumps off it', () => {
    const w = flatWorld();
    w.add(1.0, 0, -60, 1.6, 6, -8); // wall to the right (x=1.0 face)
    const p = makePlayer(w, 0.3, 0, 0);
    let jumped = false;
    const r = run(p, 4, (t, q) => {
      const s: any = { moveY: 1, sprint: true };
      if (q.pos.z < -9 && q.state === PState.Ground) s.jump = true;
      if (q.state === PState.WallRun && q.stateTime > 0.6 && !jumped) { s.jump = true; jumped = true; }
      return s;
    });
    expect(r.states.has(PState.WallRun)).toBe(true);
    expect(r.events).toContain('walljump');
    expect(p.pos.x).toBeLessThan(0); // pushed away from the wall
  });

  it('wall run stays airborne over a gap the player could not jump', () => {
    const w = new CollisionWorld();
    w.add(-6, 0, -20, 6, 10, 0); // roof A
    w.add(-6, 0, -50, 6, 10, -30); // roof B, 10m gap
    w.add(1.2, 0, -35, 2, 16, -15); // billboard wall spanning the gap on the right
    w.add(-200, -1, -200, 200, 0, 200, Surface.Concrete, F.DEADLY);
    const p = makePlayer(w, 0.4, 10, -2);
    const r = run(p, 6, (_t, q) => ({ moveY: 1, sprint: true, jump: q.state === PState.Ground && q.pos.z < -18.8 }),
      (q) => q.state === PState.Dead || (q.state === PState.Ground && q.pos.z < -31));
    expect(r.states.has(PState.WallRun)).toBe(true);
    expect(p.state).not.toBe(PState.Dead);
    expect(p.pos.y).toBeCloseTo(10, 0);
  });

  it('climbs a pipe up to a roof', () => {
    const w = flatWorld();
    w.add(-5, 0, -20, 5, 8, -6); // building face at z=-6
    w.add(-0.08, 0.3, -6.16, 0.08, 8, -6.0, Surface.Metal, F.PIPE);
    const p = makePlayer(w, 0, 0, -3);
    const r = run(p, 10, (t) => ({ moveY: 1, jump: t > 0.2 && t < 0.3 }), (q) => q.state === PState.Ground && q.pos.y > 7.9);
    expect(r.states.has(PState.Pipe)).toBe(true);
    expect(p.pos.y).toBeCloseTo(8, 1);
  });

  it('rides a zipline across a street', () => {
    const w = new CollisionWorld();
    w.add(-6, 0, -10, 6, 20, 2);
    w.add(-6, 0, -60, 6, 14, -40);
    w.add(-200, -1, -200, 200, 0, 200, Surface.Concrete, F.DEADLY);
    const p = makePlayer(w, 0, 20, 0);
    p.ziplines.push({ ax: 0, ay: 22.4, az: -8, bx: 0, by: 16.2, bz: -44 });
    const r = run(p, 8, (_t, q) => ({ moveY: 1, sprint: true, jump: q.pos.z < -6.5 && q.state === PState.Ground }),
      (q) => q.state === PState.Ground && q.pos.z < -41);
    expect(r.states.has(PState.Zip)).toBe(true);
    expect(p.state).toBe(PState.Ground);
    expect(p.pos.y).toBeCloseTo(14, 0);
  });

  it('never tunnels through thin walls at high speed', () => {
    const w = flatWorld();
    w.add(-5, 0, -10.1, 5, 5, -10);
    const p = makePlayer(w);
    p.vel.z = -40;
    for (let i = 0; i < 120; i++) p.update(DT, { moveX: 0, moveY: 1, lookX: 0, lookY: 0, jump: false, jumpPressed: false, crouch: false, crouchPressed: false, sprint: true, walk: false, quickTurn: false, kickPressed: false });
    expect(p.pos.z).toBeGreaterThan(-10);
  });

  it('mantle jump: jumping out of a climb launches further than the plain mantle', () => {
    const run2 = (jumpOut: boolean) => {
      const w = flatWorld();
      w.add(-3, 0, -30, 3, 1.2, -12); // waist-high platform
      const p = makePlayer(w);
      let pressed = false;
      run(p, 4, (_t, q) => {
        const s: any = { moveY: 1, sprint: true };
        if (jumpOut && q.state === PState.Traverse && q.tProgress > 0.6 && !pressed) { s.jump = true; pressed = true; }
        return s;
      }, (q) => q.pos.z < -12.5 && q.state === PState.Ground && q.stateTime > 0.05);
      return p;
    };
    const plain = run2(false), jumped = run2(true);
    expect(jumped.pos.z).toBeLessThan(plain.pos.z - 2); // carried well past where the plain mantle stops
  });

  it('wall run starts from a wider gap and holds the wall', () => {
    const w = flatWorld();
    w.add(1.0, 0, -60, 1.6, 6, -8);
    const p = makePlayer(w, 0.15, 0, 0); // 0.85 m from the wall face
    const r = run(p, 3, (_t, q) => ({ moveY: 1, sprint: true, jump: q.pos.z < -9 && q.state === PState.Ground }));
    expect(r.states.has(PState.WallRun)).toBe(true);
  });
});
