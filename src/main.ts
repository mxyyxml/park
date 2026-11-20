import * as THREE from 'three';
import { Renderer } from './render/Renderer';
import { createMaterials } from './render/materials';
import { buildWorldMeshes } from './render/worldMesh';
import { WorldBuilder } from './world/builder';
import { buildCity } from './world/city';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const r = new Renderer(canvas, (params.get('q') as any) || 'high');
const mats = createMaterials();
const b = new WorldBuilder(true);
const city = buildCity(b);
const wm = buildWorldMeshes(b, mats);
r.scene.add(wm.group);
r.buildEnvironment(new THREE.Vector3(0, 60, 0));
const cam = r.camera;
const v = (params.get('cam') || `${city.spawn.x},${city.spawn.y + 1.7},${city.spawn.z},${city.spawn.yaw},0`).split(',').map(Number);
cam.position.set(v[0], v[1], v[2]);
cam.rotation.set(v[4], v[3], 0, 'YXZ'); if (v[5]) { cam.fov = v[5]; cam.updateProjectionMatrix(); }
r.updateSun(cam.position);
(window as any).__stats = { draws: wm.drawCalls, tris: wm.triangles };
function frame() { r.render(1 / 60, 0); (window as any).__frames = ((window as any).__frames || 0) + 1; requestAnimationFrame(frame); }
frame();
addEventListener('resize', () => r.resize());
