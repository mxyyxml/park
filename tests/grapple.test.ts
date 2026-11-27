import { describe, expect, it } from 'vitest';
import { WorldBuilder } from '../src/world/builder';
import { buildCity } from '../src/world/city';
import { CollisionWorld } from '../src/physics/collision';
import { emptyInput, PlayerController, PState, type InputFrame } from '../src/player/PlayerController';

const DT = 1 / 120;
/** aim from the eye at a world point and fire the hook (it flies, then attaches) */
function fireAt(p: PlayerController, tx: number, ty: number, tz: number) {
  const ex = p.pos.x, ey = p.pos.y + 1.6, ez = p.pos.z, d = Math.hypot(tx - ex, ty - ey, tz - ez);
  const t = p.grappleTarget(ex, ey, ez, (tx - ex) / d, (ty - ey) / d, (tz - ez) / d);
  if (t) p.fireHook(t);
  return t;
}
function sim(p: PlayerController, secs: number, input: (p: PlayerController, t: number) => Partial<InputFrame> = () => ({}), until?: (p: PlayerController) => boolean) {
  const states = new Set<string>();
  for (let t = 0; t < secs; t += DT) {
    p.update(DT, { ...emptyInput(), ...input(p, t) });
    states.add(p.state);
    if (p.state === PState.Dead || until?.(p)) break;
  }
  return states;
}
const onTop = (h: number) => (p: PlayerController) => p.state === PState.Ground && Math.abs(p.pos.y - h) < 0.6;
const flat = () => { const w = new CollisionWorld(); w.add(-300, -1, -300, 300, 0, 300); return w; };

describe('grappling hook: every direction', () => {
  const b = new WorldBuilder(false);
  const city = buildCity(b);
  const tall = city.buildings.filter((q) => q.h >= 20 && q.kind !== 'skeleton');

  it('the hook flies to the target and attaches on arrival, not instantly', () => {
    const w = flat(); w.add(-3, 30, -21, 3, 31, -19);
    const p = new PlayerController(w); p.spawn(0, 0, 0, 0);
    expect(fireAt(p, 0, 30, -20)).not.toBeNull();
    expect(p.state).toBe(PState.Ground);
    p.update(DT, emptyInput());
    expect(p.hook).not.toBeNull();
    sim(p, 0.4, () => ({}), (q) => q.state === PState.Grapple);
    expect(p.state).toBe(PState.Grapple);
    expect(p.grapple!.y).toBeCloseTo(30, 0);
  });

  it('1. street to rooftop: aim at the top of a facade, hold to reel, end up on the roof', () => {
    let tried = 0, made = 0;
    for (const bl of tall) {
      const cx = (bl.minX + bl.maxX) / 2, sz = bl.minZ - 10;
      const g = b.world.groundHeight(cx, sz, 3, 6);
      if (!g || g.y > 0.5 || b.world.overlapCylinder(cx, g.y + 0.05, sz, 0.4, 1.7)) continue;
      const p = new PlayerController(b.world); p.spawn(cx, g.y, sz, Math.PI);
      sim(p, 0.2);
      const t = fireAt(p, cx, bl.h - 0.6, bl.minZ);
      if (!t || t.y > bl.h || t.y < bl.h - 1.5) continue;
      tried++;
      sim(p, 6, (q) => ({ grapple: q.state === PState.Grapple || !!q.hook, moveY: q.state === PState.Grapple ? 0 : 1 }), onTop(bl.h));
      if (onTop(bl.h)(p)) made++;
    }
    console.log(`street->roof: ${made}/${tried}`);
    expect(tried).toBeGreaterThan(10);
    expect(made / tried).toBeGreaterThanOrEqual(0.8);
  });

  it('2. rooftop to a higher rooftop', () => {
    const w = flat(); w.add(-10, 0, -5, 0, 10, 5); w.add(14, 0, -5, 24, 26, 5); // low roof, tall building 14 m away
    const p = new PlayerController(w); p.spawn(-3, 10, 0, -Math.PI / 2);
    expect(fireAt(p, 14, 25.4, 0)).not.toBeNull();
    sim(p, 6, (q) => ({ grapple: true, moveY: q.state === PState.Grapple ? 0 : 1 }), onTop(26));
    expect(onTop(26)(p)).toBe(true);
  });

  it('3. rooftop down to a lower rooftop: aim below, it pulls you down there', () => {
    const w = flat(); w.add(-10, 0, -5, 0, 30, 5); w.add(14, 0, -5, 24, 12, 5); // high roof, low roof below and ahead
    const p = new PlayerController(w); p.spawn(-0.8, 30, 0, -Math.PI / 2); // at the edge
    expect(fireAt(p, 18, 12, 0)).not.toBeNull();          // a point on the lower roof
    const st = sim(p, 6, () => ({}), onTop(12));
    expect(st.has('dead')).toBe(false);
    expect(onTop(12)(p)).toBe(true);
  });

  it('4. horizontal: across a street to a roof at the same height', () => {
    const w = flat(); w.add(-10, 0, -5, 0, 20, 5); w.add(20, 0, -5, 30, 20, 5); // 20 m gap
    const p = new PlayerController(w); p.spawn(-2, 20, 0, -Math.PI / 2);
    expect(fireAt(p, 21, 20, 0)).not.toBeNull();          // the far roof's near edge
    const st = sim(p, 6, () => ({}), (q) => q.pos.x > 20 && q.state === PState.Ground);
    expect(st.has('dead')).toBe(false);
    expect(p.pos.x).toBeGreaterThan(20);
    expect(p.pos.y).toBeCloseTo(20, 0);
  });

  // a beam over a 26 m gap between two roofs
  const gapWorld = () => { const w = flat(); w.add(-20, 0, -5, 0, 20, 5); w.add(26, 0, -5, 110, 20, 5); w.add(10, 34, -2, 14, 35, 2); return w; }; // the far roof is long: a good swing carries you a long way

  it('5 + 6. running off a roof, swing under a beam and let go at the top of the arc to land across the gap', () => {
    const p = new PlayerController(gapWorld()); p.spawn(-12, 20, 0, -Math.PI / 2);
    sim(p, 2, () => ({ moveY: 1, sprint: true }), (q) => q.pos.x > -4);
    const runSpeed = p.hSpeed;
    expect(fireAt(p, 12, 34, 0)).not.toBeNull();
    let peak = 0, released = false;
    const st = sim(p, 8, (q) => {
      peak = Math.max(peak, q.hSpeed);
      // let go once past the beam and rising
      if (q.state === PState.Grapple && q.pos.x > 16 && q.vel.y > 0 && !released) { released = true; return { jump: true, jumpPressed: true }; }
      return { moveY: 1 };                                 // keep pushing forward: grab the far ledge if short
    }, (q) => released && q.state === PState.Ground);
    expect(st.has('dead')).toBe(false);
    expect(peak).toBeGreaterThan(runSpeed);               // the swing adds speed
    expect(p.pos.x).toBeGreaterThan(26);                  // across
    expect(p.pos.y).toBeCloseTo(20, 0);
  });

  it('7. fired mid-jump: attaches in the air and swings', () => {
    const p = new PlayerController(gapWorld()); p.spawn(-3, 20, 0, -Math.PI / 2);
    sim(p, 0.6, (q, t) => ({ moveY: 1, sprint: true, jump: t < 0.4 && q.pos.x > -2, jumpPressed: t < 0.4 && q.pos.x > -2 }), (q) => q.state === PState.Air && q.pos.y > 20.5);
    expect(p.state).toBe(PState.Air);
    expect(fireAt(p, 12, 34, 0)).not.toBeNull();
    sim(p, 0.5, () => ({}), (q) => q.state === PState.Grapple);
    expect(p.state).toBe(PState.Grapple);
  });

  it('8. releasing at high speed keeps the speed (and adds a little)', () => {
    const w = flat(); w.add(-3, 40, -1, 3, 41, 1);
    const p = new PlayerController(w); p.spawn(16, 38.5 - 1.5, 0, 0); p.grounded = false;
    p.startGrapple({ x: 0, y: 39.7, z: 0, nx: 0, ny: -1, nz: 0 });
    sim(p, 1.5, () => ({}), (q) => q.hSpeed > 15);
    const before = p.hSpeed;
    expect(before).toBeGreaterThan(15);
    p.update(DT, { ...emptyInput(), jump: true, jumpPressed: true });
    expect(p.state).toBe(PState.Air);
    expect(p.hSpeed).toBeGreaterThan(before * 1.1);
  });

  it('9. standing right against a wall, grappling its top edge lands you on the roof (no getting stuck)', () => {
    const w = flat(); w.add(0, 0, -10, 10, 18, 10);
    const p = new PlayerController(w); p.spawn(-0.6, 0, 0, -Math.PI / 2);
    expect(fireAt(p, 0, 17.4, 0)).not.toBeNull();
    sim(p, 6, (q) => ({ grapple: q.state === PState.Grapple, moveY: q.state === PState.Grapple ? 0 : 1 }), onTop(18));
    expect(onTop(18)(p)).toBe(true);
  });

  it('10. a ledge with an overhang above the target does not trap you under it', () => {
    const w = flat(); w.add(0, 0, -10, 10, 18, 10); w.add(-1.2, 17.6, -10, 0, 18.2, 10); // cornice sticking out 1.2 m
    const p = new PlayerController(w); p.spawn(-5, 0, 0, -Math.PI / 2);
    expect(fireAt(p, 0, 15, 0)).not.toBeNull();             // the wall just under the cornice
    const st = sim(p, 6, (q) => ({ grapple: q.state === PState.Grapple, moveY: 1 }), (q) => q.state === PState.Ground && q.pos.y > 17);
    expect(st.has('dead')).toBe(false);
    expect(p.state === PState.Grapple).toBe(false);          // not left hanging/grinding
  });

  it('11. chaining: let go and hook the next beam, again and again', () => {
    const w = flat();
    for (let k = 0; k < 8; k++) w.add(-3, 36, -15 - k * 12, 3, 37, -13 - k * 12);
    const p = new PlayerController(w); p.spawn(0, 25, -6, 0); p.vel.z = -6;
    let fired = 0;
    for (let k = 0; k < 8; k++) {
      const tz = [...Array(8).keys()].map((j) => -14 - j * 12).find((z) => z < p.pos.z - 4);
      if (tz === undefined || !fireAt(p, 0, 36, tz)) break;
      fired++;
      sim(p, 0.9, () => ({}));
      p.update(DT, { ...emptyInput(), jump: true, jumpPressed: true });
      sim(p, 0.25, () => ({}));
    }
    expect(fired).toBeGreaterThanOrEqual(5);
  });

  it('rappel: step off a roof, hook its edge above you and hold S to lower yourself down the wall', () => {
    const w = flat(); w.add(0, 0, -10, 12, 30, 10);
    const p = new PlayerController(w); p.spawn(-0.6, 25, 0, Math.PI / 2); // hanging a few metres down the wall
    p.grounded = false;
    p.startGrapple({ x: -0.5, y: 29.6, z: 0, nx: -1, ny: 0, nz: 0 });     // the wall just under the roof edge
    let maxFall = 0;
    const st = sim(p, 14, (q) => { maxFall = Math.max(maxFall, -q.vel.y); return { moveY: -1 }; }, (q) => q.pos.y < 1.5);
    expect(st.has('dead')).toBe(false);
    expect(p.pos.y).toBeLessThan(1.5);
    expect(maxFall).toBeLessThan(10);                        // lowered under control, not dropped
  });

  it('the rope is rigid and keeps the swing\'s energy', () => {
    const w = flat(); w.add(-3, 40, -1, 3, 41, 1);
    const p = new PlayerController(w);
    p.spawn(12, 39 - 1.5, 0, 0); p.vel.x = p.vel.y = p.vel.z = 0; p.grounded = false;
    p.startGrapple({ x: 0, y: 39.7, z: 0, nx: 0, ny: -1, nz: 0 });
    let maxLen = 0, top = -99;
    sim(p, 2.6, (q) => { maxLen = Math.max(maxLen, Math.hypot(q.pos.x, q.pos.y + 1.5 - 39.7, q.pos.z)); if (q.pos.x < 0) top = Math.max(top, q.pos.y); return {}; });
    expect(maxLen).toBeLessThan(12.6);
    expect(top).toBeGreaterThan(39 - 1.5 - 3);
  });
});
