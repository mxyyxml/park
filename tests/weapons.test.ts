import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Weapons } from '../src/game/Weapons';
import { CollisionWorld } from '../src/physics/collision';

const mk = () => { const cam = new THREE.PerspectiveCamera(); const sc = new THREE.Scene(); sc.add(cam); return new Weapons(sc, cam, new CollisionWorld()); };
const ctx = { speed: 0, gait: 0, airborne: false, eye: new THREE.Vector3(), look: new THREE.Vector3(0, 0, -1) };

describe('inventory', () => {
  it('fills empty slots, stacks flares, swaps the hand when full', () => {
    const w = mk();
    expect(w.give('katana')).toBeNull();
    expect(w.give('flares', 3)).toBeNull();
    expect(w.slots.map((s) => s?.kind)).toEqual(['katana', 'flares']);
    expect(w.give('flares', 2)).toBeNull();
    expect(w.slots[1]!.count).toBe(5);
    w.select(0);
    const dropped = w.give('pipe');
    expect(dropped?.kind).toBe('katana');
    expect(w.slots.map((s) => s?.kind)).toEqual(['pipe', 'flares']);
  });
  it('a swing hits exactly once, at the strike frame, not on the press', () => {
    const w = mk(); w.give('katana');
    for (let i = 0; i < 30; i++) w.update(1 / 60, ctx, null); // finish the draw
    expect(w.use()).toBe(true);
    const hits: number[] = [];
    for (let i = 0; i < 60; i++) { const e = w.update(1 / 60, ctx, null); if (e && e !== 'throw') hits.push(i); }
    expect(hits.length).toBe(1);
    expect(hits[0]).toBeGreaterThan(8);      // after the wind-up (~0.19 s at 60 fps)
    expect(w.busy).toBe(false);
  });
  it('throwing the last flare empties its slot; an empty hand means kick', () => {
    const w = mk(); w.give('flares', 1);
    for (let i = 0; i < 30; i++) w.update(1 / 60, ctx, null);
    w.use();
    const evs: string[] = [];
    for (let i = 0; i < 60; i++) { const e = w.update(1 / 60, ctx, null); if (e) evs.push(e === 'throw' ? 'throw' : 'hit'); }
    expect(evs).toEqual(['throw']);
    expect(w.held).toBeNull();
    expect(w.use()).toBe(false);
  });
  it('animation poses stay finite through idle, run, draw and every swing', () => {
    const w = mk(); w.give('katana'); w.give('pipe');
    for (const slot of [0, 1]) {
      w.select(slot);
      for (let k = 0; k < 4; k++) {
        w.use();
        for (let i = 0; i < 60; i++) { w.update(1 / 60, { ...ctx, speed: k * 3, gait: i * 0.3 }, null); const t = w.handTargets()!; expect(Number.isFinite(t.right.x + t.right.y + t.right.z + t.blade.x)).toBe(true); expect(t.blade.length()).toBeCloseTo(1, 3); }
      }
    }
  });
});
