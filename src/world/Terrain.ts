/**
 * Landscape around the city: a sculpted heightfield ring (mountain ranges to the north and
 * west, rolling hills, a coastline dropping into the sea to the south-east) and the sea itself.
 * Visual only: it starts beyond the outermost streets, out of the runner's reach.
 *
 * The material blends grass, rock and sand by slope and height using photoscanned aerial
 * textures (Poly Haven, CC0) when available, falling back to flat colours.
 */
import * as THREE from 'three';
import { withFog } from '../render/materials';

// ---- deterministic noise -------------------------------------------------------------------
function hash(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, oct: number) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * a; n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
/** ridged multifractal: sharp crests for mountain ranges */
function ridged(x: number, y: number, oct: number) {
  let s = 0, a = 0.5, f = 1, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let r = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1);
    r = r * r * w;
    w = Math.min(1, r * 2);
    s += r * a; n += a; a *= 0.5; f *= 2.1;
  }
  return s / n;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const TERRAIN_INNER = 1000;  // flat apron where the city's outer streets end
export const SEA_LEVEL = -1.5;

/** Terrain height at world (x, z). Exported so tests can check the shape. */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const ang = Math.atan2(z, x);
  // the coast: the south-east quarter falls away below sea level
  const seaDir = Math.cos(ang - Math.PI * 0.3);           // 1 toward +x+z
  const coast = smooth(0.15, 0.75, seaDir);
  const rise = smooth(TERRAIN_INNER + 120, TERRAIN_INNER + 900, r);
  // ranges: strongest to the north-west, ridged crests, rolling foothills in between
  const rangeDir = 0.55 + 0.45 * Math.cos(ang - Math.PI * 1.25);
  const s = 1 / 900;
  const mountains = Math.pow(ridged(x * s + 13.1, z * s - 7.3, 6), 1.6) * (380 + 520 * smooth(1800, 4200, r)) * rangeDir;
  const hills = (fbm(x / 420 + 3.3, z / 420 + 9.1, 5) - 0.35) * 90;
  let h = rise * Math.max(0, hills + mountains * smooth(1200, 2600, r)) * (1 - coast * 0.97);
  // sea floor shelves down beyond the beach
  h -= coast * smooth(TERRAIN_INNER + 200, TERRAIN_INNER + 1400, r) * 45;
  if (r < TERRAIN_INNER + 60) h = -0.4; // under the city's ground plane
  return h;
}

export interface TerrainTextures { grass?: THREE.Texture; grassN?: THREE.Texture; rock?: THREE.Texture; rockN?: THREE.Texture; sand?: THREE.Texture }

export function buildTerrain(tex: TerrainTextures): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  // polar grid: dense near the city, coarse at the horizon
  const SEG = 384, RINGS = 150, R0 = TERRAIN_INNER, R1 = 9000;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const r = R0 * Math.pow(R1 / R0, Math.pow(t, 1.15));
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      pos.push(x, terrainHeight(x, z), z);
    }
  }
  for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEG; j++) {
    const a = i * (SEG + 1) + j, b = a + SEG + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = withFog(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 }));
  const uniforms = {
    tGrass: { value: tex.grass ?? null }, tGrassN: { value: tex.grassN ?? null },
    tRock: { value: tex.rock ?? null }, tRockN: { value: tex.rockN ?? null }, tSand: { value: tex.sand ?? null },
    uHasTex: { value: tex.grass && tex.rock ? 1 : 0 },
  };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTNormal = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vTWorld;
varying vec3 vTNormal;
uniform sampler2D tGrass; uniform sampler2D tGrassN; uniform sampler2D tRock; uniform sampler2D tRockN; uniform sampler2D tSand;
uniform float uHasTex;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float slope = 1.0 - clamp(vTNormal.y, 0.0, 1.0);
float hgt = vTWorld.y;
float breakup = tNoise(vTWorld.xz / 60.0) * 0.6 + tNoise(vTWorld.xz / 13.0) * 0.4;
float wRock = smoothstep(0.28, 0.5, slope + (breakup - 0.5) * 0.25) + smoothstep(420.0, 700.0, hgt + breakup * 120.0);
wRock = clamp(wRock, 0.0, 1.0);
float wSand = (1.0 - smoothstep(0.5, 4.5, hgt + breakup * 2.0)) * (1.0 - wRock);
float wSnow = smoothstep(760.0, 900.0, hgt + breakup * 90.0) * (1.0 - smoothstep(0.55, 0.75, slope));
vec3 cGrass, cRock, cSand;
if (uHasTex > 0.5) {
  // two scales of each texture mixed to hide tiling at landscape distances
  vec2 uvA = vTWorld.xz / 48.0, uvB = vTWorld.xz / 310.0;
  cGrass = mix(texture2D(tGrass, uvA).rgb, texture2D(tGrass, uvB).rgb, 0.5);
  cRock = mix(texture2D(tRock, uvA * 0.8).rgb, texture2D(tRock, uvB).rgb, 0.5);
  cSand = mix(texture2D(tSand, uvA).rgb, texture2D(tSand, uvB).rgb, 0.5);
} else {
  cGrass = vec3(0.24, 0.31, 0.16); cRock = vec3(0.42, 0.4, 0.38); cSand = vec3(0.62, 0.57, 0.47);
}
cGrass *= 0.85 + 0.3 * breakup;
vec3 tcol = mix(mix(cGrass, cRock, wRock), cSand, wSand);
tcol = mix(tcol, vec3(0.92, 0.94, 0.97), wSnow);
diffuseColor.rgb = tcol;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(0.95, 0.55, wSnow);`);
  };
  mat.customProgramCacheKey = () => 'terrain-v1';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  group.add(mesh);

  // sea: animated normals from two scrolling noise layers, environment reflections from the sky
  const seaGeo = new THREE.RingGeometry(TERRAIN_INNER - 20, 14000, 128, 8);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = withFog(new THREE.MeshStandardMaterial({ color: 0x0f2a36, roughness: 0.08, metalness: 0.15 }));
  const seaU = { uTime: { value: 0 } };
  const prevS = sea.onBeforeCompile;
  sea.onBeforeCompile = (sh, r) => {
    prevS.call(sea, sh, r);
    Object.assign(sh.uniforms, seaU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvSWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSWorld;
uniform float uTime;
float sH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sH(i), sH(i + vec2(1, 0)), f.x), mix(sH(i + vec2(0, 1)), sH(i + vec2(1, 1)), f.x), f.y); }
float waves(vec2 p) { return sN(p / 9.0 + vec2(uTime * 0.05, uTime * 0.03)) * 0.6 + sN(p / 3.1 - vec2(uTime * 0.09, -uTime * 0.04)) * 0.4; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float e = 0.6;
  float h0 = waves(vSWorld.xz), hx = waves(vSWorld.xz + vec2(e, 0.0)), hz = waves(vSWorld.xz + vec2(0.0, e));
  float fade = 1.0 - smoothstep(300.0, 2500.0, length(vSWorld - cameraPosition));
  vec3 wn = normalize(vec3(-(hx - h0) / e * 1.4 * fade, 1.0, -(hz - h0) / e * 1.4 * fade));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`);
  };
  sea.customProgramCacheKey = () => 'sea-v1';
  const seaMesh = new THREE.Mesh(seaGeo, sea);
  seaMesh.position.y = SEA_LEVEL;
  seaMesh.receiveShadow = true;
  seaMesh.onBeforeRender = () => { seaU.uTime.value = performance.now() / 1000; };
  group.add(seaMesh);
  return group;
}
