import { describe, expect, it } from 'vitest';
import { CameraRig } from '../src/player/CameraRig';
import { flatWorld, makePlayer, run, sprint } from './helpers';

describe('camera rig', () => {
  it('stays stable under long frame times (hitches, slow devices)', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const rig = new CameraRig();
    for (let i = 0; i < 200; i++) {
      run(p, 0.1, sprint);
      rig.onEvents(p.events);
      rig.update(0.1, p, 1); // 10 fps
      expect(Number.isFinite(rig.eyePos.y)).toBe(true);
      expect(Math.abs(rig.eyePos.y - p.pos.y)).toBeLessThan(3);
    }
  });
  it('dips on hard landings and recovers to standing eye height', () => {
    const w = flatWorld();
    w.add(-3, 0, -3, 3, 5, 3);
    const p = makePlayer(w, 0, 5, 0);
    const rig = new CameraRig();
    let minEye = Infinity;
    for (let i = 0; i < 360; i++) {
      run(p, 1 / 120, () => ({ moveY: 1 }));
      rig.onEvents(p.events);
      rig.update(1 / 120, p, 1);
      if (p.pos.y < 0.01) minEye = Math.min(minEye, rig.eyePos.y - p.pos.y);
    }
    expect(minEye).toBeLessThan(1.5);
    expect(rig.eyePos.y - p.pos.y).toBeGreaterThan(1.55);
  });
});
