import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { emptyInput, PlayerController, PState } from '../src/player/PlayerController';

import { CollisionWorld } from '../src/physics/collision';

describe('grappling hook (any surface)', () => {
  const b = new WorldBuilder(false);
  const city = buildCity(b);
  const tall = city.buildings.filter((q) => q.h >= 20 && q.kind !== 'skeleton');

  it('targets whatever is under the crosshair, not too close and not out of range', () => {
    const p = new PlayerController(b.world);
    const bl = tall[0], cx = (bl.minX + bl.maxX) / 2;
    p.spawn(cx, 0, bl.minZ - 10, Math.PI);
    expect(p.grappleTarget(cx, 1.6, bl.minZ - 10, 0, 0.6, 0.8)).not.toBeNull(); // facade 10 m ahead, aiming up
    expect(p.grappleTarget(cx, 1.6, bl.minZ - 1.5, 0, 0.6, 0.8)).toBeNull();  // too close
    expect(p.grappleTarget(cx, 1.6, bl.minZ - 10, 0, 1, 0)).toBeNull();     // open sky
    expect(p.grappleTarget(cx, 1.6, bl.minZ - 10, 0, -0.3, 0.95)).toBeNull(); // the street: nothing to swing from
  });

  it('from the street, grappling the top of a facade gets you onto the roof', () => {
    let tried = 0, made = 0;
    for (const bl of tall) {
      const cx = (bl.minX + bl.maxX) / 2, sz = bl.minZ - 10;
      const g = b.world.groundHeight(cx, sz, 3, 6);
      if (!g || g.y > 0.5 || b.world.overlapCylinder(cx, g.y + 0.05, sz, 0.4, 1.7)) continue;
      const p = new PlayerController(b.world);
      p.spawn(cx, g.y, sz, Math.PI);
      for (let i = 0; i < 30; i++) p.update(1 / 120, emptyInput());
      // aim just below the roof edge
      const ey = p.pos.y + 1.6, ty = bl.h - 0.6, d = Math.hypot(bl.minZ - sz, ty - ey);
      const t = p.grappleTarget(cx, ey, sz, 0, (ty - ey) / d, (bl.minZ - sz) / d);
      if (!t || t.y > bl.h || t.y < bl.h - 1.5) continue; // something else in the way
      tried++;
      p.startGrapple(t);
      for (let i = 0; i < 120 * 6 && !(p.state === PState.Ground && p.pos.y > bl.h - 0.5); i++) {
        const f = emptyInput(); f.moveY = p.state === PState.Grapple ? 0 : 1;
        f.grapple = p.state === PState.Grapple; // hold to reel up the wall
        p.update(1 / 120, f);
      }
      if (p.state === PState.Ground && Math.abs(p.pos.y - bl.h) < 1.2) made++;
    }
    console.log(`grapple reel: ${made}/${tried} reached the roof`);
    expect(tried).toBeGreaterThanOrEqual(3);
    expect(made / tried).toBeGreaterThanOrEqual(0.8);
  });

  // a lone overhead beam to swing from, high above a deadly floor
  const swingWorld = () => { const w = new CollisionWorld(); w.add(-3, 30, -21, 3, 31, -19); w.add(-300, -1, -300, 300, 0, 300); return w; };
  const fire = (p: PlayerController, tx: number, ty: number, tz: number) => {
    const ex = p.pos.x, ey = p.pos.y + 1.6, ez = p.pos.z, d = Math.hypot(tx - ex, ty - ey, tz - ez);
    const t = p.grappleTarget(ex, ey, ez, (tx - ex) / d, (ty - ey) / d, (tz - ez) / d);
    expect(t).not.toBeNull();
    p.startGrapple(t!);
  };

  it('swings: falling on the rope becomes a forward arc that builds speed, and letting go keeps it', () => {
    const p = new PlayerController(swingWorld());
    p.spawn(0, 18, -6, 0); p.vel.z = -6; // airborne, moving toward the beam
    fire(p, 0, 30, -20);
    let maxSpeed = 0, minY = 99;
    for (let i = 0; i < 120 * 1.6; i++) { p.update(1 / 120, emptyInput()); maxSpeed = Math.max(maxSpeed, p.hSpeed); minY = Math.min(minY, p.pos.y); }
    expect(p.state).toBe(PState.Grapple);
    expect(maxSpeed).toBeGreaterThan(9);           // the arc turns height into speed
    expect(maxSpeed).toBeLessThanOrEqual(22.01);   // but never a slingshot
    expect(p.pos.z).toBeLessThan(-20);             // carried past under the anchor
    expect(minY).toBeGreaterThan(1);               // the rope held you off the floor
    const f = emptyInput(); f.jump = f.jumpPressed = true;
    const before = p.hSpeed;
    p.update(1 / 120, f);
    expect(p.state).toBe(PState.Air);
    expect(p.hSpeed).toBeGreaterThan(before * 0.9); // momentum kept on release
  });

  it('chains: fire again in mid-air straight after letting go', () => {
    const w = swingWorld(); w.add(-3, 24, -33, 3, 25, -31); // second beam further on, within reach
    const p = new PlayerController(w);
    p.spawn(0, 18, -6, 0); p.vel.z = -6;
    fire(p, 0, 30, -20);
    for (let i = 0; i < 120 * 1.2; i++) p.update(1 / 120, emptyInput());
    const f = emptyInput(); f.jump = f.jumpPressed = true; p.update(1 / 120, f);
    for (let i = 0; i < 120 * 0.7; i++) p.update(1 / 120, emptyInput()); // short cooldown between swings
    fire(p, 0, 24, -32);
    expect(p.state).toBe(PState.Grapple);
  });

  it('no flying across the map: three swings, then you have to touch down', () => {
    const w = new CollisionWorld();
    for (let k = 0; k < 6; k++) w.add(-3, 36, -15 - k * 12, 3, 37, -13 - k * 12); // a row of beams overhead
    w.add(-300, -1, -300, 300, 0, 300);
    const p = new PlayerController(w);
    p.spawn(0, 25, -6, 0); p.vel.z = -6;
    let fired = 0;
    for (let k = 0; k < 6; k++) {
      // aim at the nearest beam still ahead of you
      const tz = [...Array(6).keys()].map((j) => -14 - j * 12).find((z) => z < p.pos.z - 4)!;
      const ey = p.pos.y + 1.6, d = Math.hypot(36 - ey, tz - p.pos.z);
      const t = p.grappleTarget(p.pos.x, ey, p.pos.z, 0, (36 - ey) / d, (tz - p.pos.z) / d);
      if (!t) break;
      p.startGrapple(t); fired++;
      for (let i = 0; i < 120 * 0.8; i++) p.update(1 / 120, emptyInput());
      const f = emptyInput(); f.jump = f.jumpPressed = true; p.update(1 / 120, f);
      for (let i = 0; i < 120 * 0.7; i++) p.update(1 / 120, emptyInput());
    }
    expect(fired).toBe(3);
  });
});
