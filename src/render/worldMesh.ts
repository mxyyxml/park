import * as THREE from 'three';
import type { WorldBuilder } from '../world/builder';
import type { GeoBatch, MatKey } from '../world/geo';
import type { MaterialLib } from './materials';

function toGeometry(g: GeoBatch): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
  if (g.facade) geo.setAttribute('aFacade', new THREE.Float32BufferAttribute(g.facade, 4));
  if (g.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
  geo.setIndex(g.vcount > 65535 ? new THREE.Uint32BufferAttribute(g.idx, 1) : new THREE.Uint16BufferAttribute(g.idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export interface WorldMeshes { group: THREE.Group; drawCalls: number; triangles: number }

export function buildWorldMeshes(b: WorldBuilder, mats: MaterialLib): WorldMeshes {
  const group = new THREE.Group();
  group.name = 'world';
  let drawCalls = 0, triangles = 0;
  const add = (chunks: Map<string, Map<MatKey, GeoBatch>>, far: boolean) => {
    for (const [, m] of chunks) for (const [key, g] of m) {
      if (g.vcount === 0) continue;
      const mesh = new THREE.Mesh(toGeometry(g), mats.get(key));
      const transparent = key === 'glass';
      mesh.castShadow = !far && !transparent && key !== 'lamp' && key !== 'stripe' && key !== 'screen';
      mesh.receiveShadow = !transparent;
      if (transparent) mesh.renderOrder = 2;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      drawCalls++; triangles += g.idx.length / 3;
    }
  };
  add(b.chunks, false);
  add(b.farChunks, true);
  return { group, drawCalls, triangles };
}
