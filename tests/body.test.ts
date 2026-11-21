import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeBodyMaterials, RunnerBody } from '../src/player/Body';
import { PState } from '../src/player/PlayerController';
import { flatWorld, makePlayer, run, sprint } from './helpers';

const hidden = (o: THREE.Object3D) => { let h = true; o.traverse((c) => { if ((c as THREE.Mesh).isMesh && !c.userData.hidden) h = false; }); return h; };

describe('first-person body visibility', () => {
  it('hides the torso from the camera while sliding and rolling, legs while rolling, head always', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const body = new RunnerBody(makeBodyMaterials(null), true);
    const view = new THREE.Matrix4();
    const step = () => body.update(1 / 60, p, view, new THREE.Vector3(p.pos.x, p.pos.y + p.height - 0.12, p.pos.z), new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z));
    run(p, 2, sprint); step();
    expect(p.state).toBe(PState.Ground);
    expect(hidden(body.torso)).toBe(false);
    expect(hidden(body.head!)).toBe(true);
    run(p, 0.2, () => ({ moveY: 1, sprint: true, crouch: true })); step();
    expect(p.state).toBe(PState.Slide);
    expect(hidden(body.torso)).toBe(true);
    expect(hidden(body.legs[0].thigh)).toBe(false);
    (p as any).state = PState.Roll; step();
    expect(hidden(body.legs[0].thigh)).toBe(true);
  });
});
