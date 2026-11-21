/** Sculpted character assets (built by tools/blender/sculpt_assets.py) loaded from public/assets/models. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export interface CharacterAssets {
  hand: THREE.Object3D;
  sleeveUpper: THREE.BufferGeometry;
  sleeveFore: THREE.BufferGeometry;
  shoe: THREE.Object3D;
  torso: THREE.Object3D;
  pelvis: THREE.Object3D;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  head: THREE.Object3D;
}

function firstGeometry(o: THREE.Object3D) {
  let g: THREE.BufferGeometry | null = null;
  o.traverse((c) => { if (!g && (c as THREE.Mesh).isMesh) g = (c as THREE.Mesh).geometry; });
  if (!g) throw new Error('asset has no mesh');
  return g as THREE.BufferGeometry;
}

/** Returns null when the files can't be loaded; the body then keeps its procedural meshes. */
export async function loadCharacterAssets(base = './assets/models/'): Promise<CharacterAssets | null> {
  try {
    const loader = new GLTFLoader();
    const names = ['hand', 'sleeve_upper', 'sleeve_fore', 'shoe', 'torso', 'pelvis', 'thigh', 'shin', 'head'];
    const [hand, su, sf, shoe, torso, pelvis, thigh, shin, head] = (await Promise.all(names.map((n) => loader.loadAsync(`${base}${n}.json`)))).map((g) => g.scene);
    return { hand, sleeveUpper: firstGeometry(su), sleeveFore: firstGeometry(sf), shoe, torso, pelvis, thigh: firstGeometry(thigh), shin: firstGeometry(shin), head };
  } catch (e) {
    console.warn('character assets unavailable, using procedural body', e);
    return null;
  }
}

/** Clone an asset (skinned-safe) and swap its glTF materials for the game's by material name. */
export function instantiate(src: THREE.Object3D, mats: Record<string, THREE.Material>): THREE.Object3D {
  const o = cloneSkinned(src);
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false; // skinned bounds don't follow the bones
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const mapped = list.map((x) => mats[x.name.replace(/\.\d+$/, '')] ?? x);
    m.material = Array.isArray(m.material) ? mapped : mapped[0];
  });
  return o;
}
