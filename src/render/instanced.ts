import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Anchor } from '../world/builder';
import { withFog } from './materials';

export async function loadModel(url: string): Promise<THREE.Object3D | null> {
  try { return (await new GLTFLoader().loadAsync(url)).scene; }
  catch (e) { console.warn('model unavailable', url, e); return null; }
}

/**
 * Draw one model at many anchors with one InstancedMesh per mesh in the model.
 * The model is placed with its base on the anchor; `size` is its target height in metres.
 */
export function instanceModel(model: THREE.Object3D, anchors: Anchor[], size: number): THREE.Group {
  const group = new THREE.Group();
  model.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(model);
  const k = size / (bbox.max.y - bbox.min.y);
  const fit = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-(bbox.min.x + bbox.max.x) / 2, -bbox.min.y, -(bbox.min.z + bbox.max.z) / 2));
  const place = new THREE.Matrix4(), rot = new THREE.Matrix4(), m = new THREE.Matrix4();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((x) => withFog(x));
    const inst = new THREE.InstancedMesh(mesh.geometry, Array.isArray(mesh.material) ? mats : mats[0], anchors.length);
    anchors.forEach((a, i) => {
      rot.makeRotationY(-(a.a ?? 0) * Math.PI / 2);
      place.makeTranslation(a.x, a.y, a.z).multiply(rot);
      m.copy(place).multiply(fit).multiply(mesh.matrixWorld);
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = true; inst.receiveShadow = true;
    inst.computeBoundingSphere();
    group.add(inst);
  });
  return group;
}
