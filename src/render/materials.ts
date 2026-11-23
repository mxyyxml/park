import * as THREE from 'three';
import type { MatKey } from '../world/geo';
import * as T from './textures';

export const PALETTE = {
  red: new THREE.Color('#c8161e'),
  white: new THREE.Color('#f2f1ee'),
};

/**
 * Atmospheric height fog with sun in-scattering, injected into every standard material.
 * Replaces three's linear fog: density falls off with altitude so rooftops stay crisp
 * while the streets and the far skyline dissolve into haze.
 */
export const fogUniforms = {
  fogSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.5).normalize() },
  fogSunColor: { value: new THREE.Color('#ffe2b8') },
  fogHeightFalloff: { value: 0.012 },
  fogDensity: { value: 0.00042 },
};

/** shared wind clock for vegetation and flags (advanced by the game loop) */
export const windUniforms = { uWindTime: { value: 0 } };

/** Wind sway: gusting, height-weighted displacement on world-space merged foliage. */
function withWind<M extends THREE.Material>(m: M, amount: number): M {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, windUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float gust = 0.6 + 0.4 * sin(uWindTime * 0.31 + wp.x * 0.013) * sin(uWindTime * 0.17 + wp.z * 0.011);
  float ph = uWindTime * 1.9 + wp.x * 0.35 + wp.z * 0.27 + wp.y * 0.5;
  transformed.x += sin(ph) * ${amount.toFixed(3)} * gust;
  transformed.z += cos(ph * 0.83) * ${amount.toFixed(3)} * 0.6 * gust;
  transformed.y += sin(ph * 1.7) * ${amount.toFixed(3)} * 0.25;
}`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|wind';
  return m;
}

export function installFogChunks() {
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  uniform float fogHeightFalloff;
  uniform float fogDensity;
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  vec3 fogRay = vFogWorldPos - cameraPosition;
  float fogDist = length(fogRay);
  vec3 fogDir = fogRay / max(fogDist, 1e-3);
  // analytic integral of exp(-k*h) density along the ray
  float hfK = fogHeightFalloff;
  float hfH0 = max(cameraPosition.y, 0.0);
  float hfDY = fogRay.y;
  float fogAmt;
  if (abs(hfDY) > 0.01) {
    fogAmt = fogDensity * exp(-hfK * hfH0) * (1.0 - exp(-hfK * hfDY)) / (hfK * hfDY) * fogDist;
  } else {
    fogAmt = fogDensity * exp(-hfK * hfH0) * fogDist;
  }
  // aerial perspective: beyond the city, distance alone thickens the haze (mountains go blue-grey)
  fogAmt += max(fogDist - 900.0, 0.0) * 0.00016;
  float fogFactor = 1.0 - exp(-max(fogAmt, 0.0));
  float sunAmt = pow(max(dot(fogDir, fogSunDir), 0.0), 8.0);
  vec3 fogCol = mix(fogColor, fogSunColor, sunAmt * 0.6);
  // sky occlusion in street canyons: less skylight reaches surfaces near street level
  gl_FragColor.rgb *= mix(0.6, 1.0, smoothstep(0.0, 36.0, vFogWorldPos.y));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
#endif`;
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #ifdef USE_INSTANCING
    vFogWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #endif
#endif`;
}

function withFog<M extends THREE.Material>(m: M): M {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    Object.assign(shader.uniforms, fogUniforms);
    prev.call(m, shader, r);
  };
  return m;
}

function std(p: THREE.MeshStandardMaterialParameters) { return withFog(new THREE.MeshStandardMaterial(p)); }

/**
 * Detail layer: re-sample the material's own normal and albedo maps at a higher frequency
 * (rotated to break up tiling) so surfaces keep micro-detail at arm's length, fading out with
 * distance so far surfaces don't shimmer.
 */
export function addDetail<M extends THREE.MeshStandardMaterial>(m: M, scale: number, strength: number): M {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  float dDist = length(vViewPosition);
  float dFade = 1.0 - smoothstep(6.0, 28.0, dDist);
  mat2 dRot = mat2(0.8, -0.6, 0.6, 0.8);
  vec3 dAlb = texture2D(map, dRot * vMapUv * ${scale.toFixed(2)}).rgb;
  float dLum = dot(dAlb, vec3(0.333));
  diffuseColor.rgb *= mix(1.0, 0.72 + dLum * 0.56, 0.5 * dFade);
#endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#if defined(USE_NORMALMAP_TANGENTSPACE) && defined(USE_MAP)
  {
    vec3 dN = texture2D(normalMap, dRot * vNormalMapUv * ${scale.toFixed(2)}).xyz * 2.0 - 1.0;
    dN.xy *= normalScale * ${strength.toFixed(2)} * dFade;
    normal = normalize(normal + tbn * vec3(dN.xy, 0.0));
  }
#endif`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + `|detail${scale}`;
  return m;
}

/**
 * Facade material: procedural curtain-wall / ribbon / punched / fin facades with
 * interior-mapped rooms behind glass (parallax rooms with floor, ceiling, back wall, lamps).
 * Per-vertex attribute aFacade = (style, seed, floorHeight, cellWidth).
 */
function facadeMaterial(concrete: T.TexSet, brick: T.TexSet | null): THREE.MeshStandardMaterial {
  const m = std({ color: 0xffffff, roughness: 0.6, metalness: 0.0, map: concrete.map, normalMap: concrete.normalMap });
  m.normalScale.set(0.6, 0.6);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r);
    shader.uniforms.tBrick = { value: brick?.map ?? concrete.map };
    shader.uniforms.uBrick = { value: brick ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aFacade;
varying vec4 vFacade;
varying vec3 vFWPos;
varying vec3 vFWNormal;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vFacade = aFacade;
vFWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vFacade;
varying vec3 vFWPos;
varying vec3 vFWNormal;
uniform sampler2D tBrick;
uniform float uBrick;
float fHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fAA(float edge, float x, float w) { return smoothstep(edge - w, edge + w, x); }
// interior mapping: returns room colour seen through a window cell
vec3 fRoom(vec2 f, vec2 cellSize, vec3 V, vec3 T, vec3 N, vec2 cid, float seed, float detail, out float lit) {
  vec3 dir = vec3(dot(V, T), V.y, dot(V, -N));
  float depth = cellSize.x * 2.4;
  vec3 pos = vec3(f.x * cellSize.x, f.y * cellSize.y, 0.0);
  vec3 bound = vec3(cellSize.x, cellSize.y, depth);
  vec3 tPlane = (step(0.0, dir) * bound - pos) / dir;
  tPlane = mix(tPlane, vec3(1e5), step(abs(dir), vec3(1e-4)));
  float t = min(min(tPlane.x, tPlane.y), tPlane.z);
  vec3 hit = pos + dir * t;
  float rnd = fHash(cid + seed);
  float rnd2 = fHash(cid.yx * 1.7 + seed * 3.1);
  lit = step(0.74, rnd);
  vec3 wallCol = mix(vec3(0.78, 0.76, 0.72), vec3(0.62, 0.66, 0.7), rnd2);
  if (rnd2 > 0.9) wallCol = vec3(0.7, 0.2, 0.18);
  vec3 col;
  float d = hit.z / depth;
  if (t == tPlane.y) {
    if (dir.y < 0.0) { col = vec3(0.30, 0.285, 0.27); }
    else { col = vec3(0.8) + lit * 0.9 * (1.0 - smoothstep(0.0, 0.6, abs(hit.x / cellSize.x - 0.5))); }
  } else if (t == tPlane.z) {
    col = wallCol * 0.9;
    // furniture silhouette band along the back wall
    col *= 1.0 - 0.45 * smoothstep(0.95, 0.75, hit.y) * (0.5 + 0.5 * detail);
  } else {
    col = wallCol * 0.72;
  }
  col *= mix(1.0, 0.45, d);                 // darker deeper in
  float lamp = lit * (0.9 + rnd2 * 0.8);
  return col * (0.07 + lamp * 0.55) * mix(vec3(1.0), vec3(1.0, 0.92, 0.8), lit);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float fStyle = floor(vFacade.x + 0.5);
float fSeed = floor(vFacade.y + 0.5) * 0.731;
vec2 fCell = vec2(vFacade.w, vFacade.z);
vec3 fN = normalize(vFWNormal);
vec3 fT = normalize(vec3(-fN.z, 0.0, fN.x));
vec2 fUV = vec2(dot(vFWPos, fT), vFWPos.y);
vec2 fGrid = fUV / fCell;
vec2 fCid = floor(fGrid);
vec2 fF = fract(fGrid);
vec2 fW = fwidth(fGrid) * 1.2 + 1e-4;
float fWin = 0.0;   // window mask
float fFrameDark = 0.0;
float fSpandrel = 0.0;
if (fStyle < 0.5) {         // curtain wall
  fWin = fAA(0.03, fF.x, fW.x) * (1.0 - fAA(0.97, fF.x, fW.x)) * fAA(0.16, fF.y, fW.y) * (1.0 - fAA(0.985, fF.y, fW.y));
  fSpandrel = (1.0 - fAA(0.16, fF.y, fW.y));
  fFrameDark = 1.0;
} else if (fStyle < 1.5) {  // ribbon windows
  fWin = fAA(0.36, fF.y, fW.y) * (1.0 - fAA(0.9, fF.y, fW.y)) * fAA(0.015, fF.x, fW.x) * (1.0 - fAA(0.985, fF.x, fW.x));
} else if (fStyle < 2.5) {  // punched windows in concrete
  fWin = fAA(0.22, fF.x, fW.x) * (1.0 - fAA(0.78, fF.x, fW.x)) * fAA(0.3, fF.y, fW.y) * (1.0 - fAA(0.86, fF.y, fW.y));
} else {                    // vertical fins
  fWin = fAA(0.22, fF.x, fW.x) * (1.0 - fAA(0.96, fF.x, fW.x)) * fAA(0.12, fF.y, fW.y) * (1.0 - fAA(0.98, fF.y, fW.y));
}
float fIsWall = 1.0 - step(0.5, abs(fN.y));
fWin *= fIsWall;
// ground floor lobby
fWin *= step(5.0, vFWPos.y);
vec3 fV = normalize(vFWPos - cameraPosition);
float fLit;
float fDetail = 1.0 - smoothstep(0.012, 0.04, max(fW.x, fW.y));
vec3 fRoomCol = fRoom(clamp(fF, 0.0, 1.0), fCell, fV, fT, fN, fCid, fSeed, fDetail, fLit);
// fade detail with distance (avoid aliasing): blend to average
float fFar = smoothstep(0.08, 0.3, max(fW.x, fW.y));
vec3 fGlassTint = mix(vec3(0.20, 0.26, 0.31), vec3(0.24, 0.27, 0.29), fract(fSeed * 7.3));
vec3 fFrameCol = fFrameDark > 0.5 ? mix(vec3(0.2, 0.22, 0.24), vec3(0.85), fSpandrel * 0.0) : diffuseColor.rgb * mix(0.95, 1.05, fract(fSeed * 3.7));
// half of the punched-window (industrial) facades are factory brick instead of concrete
if (uBrick > 0.5 && fStyle > 1.5 && fStyle < 2.5 && fract(fSeed * 0.37) < 0.5) fFrameCol = texture2D(tBrick, vMapUv * 1.6).rgb * 0.95;
if (fFrameDark > 0.5) fFrameCol = mix(vec3(0.16, 0.18, 0.2), vec3(0.3, 0.32, 0.34), fSpandrel);
vec3 fAlb = mix(fFrameCol, fGlassTint, fWin);
float fWinAvg = fStyle < 0.5 ? 0.8 : fStyle < 1.5 ? 0.52 : fStyle < 2.5 ? 0.3 : 0.65;
fAlb = mix(fAlb, mix(fFrameCol, fGlassTint, fWinAvg * fIsWall), fFar);
float fWinF = mix(fWin, fWinAvg * fIsWall, fFar);
diffuseColor.rgb = fAlb;
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.06 + 0.04 * fract(fSeed * 11.0), fWinF);
if (fFrameDark > 0.5) roughnessFactor = mix(0.35, roughnessFactor, fWinF);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.72, fWinF);
if (fFrameDark > 0.5) metalnessFactor = mix(0.6, metalnessFactor, fWinF);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(mix(normal, normalize((viewMatrix * vec4(fN, 0.0)).xyz), fWinF));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float fFres = pow(1.0 - max(dot(-fV, fN), 0.0), 3.0);
vec3 fRoomAvg = vec3(0.035, 0.034, 0.033) * (1.0 + 0.8 * fract(fSeed * 13.1));
totalEmissiveRadiance += mix(fRoomCol, fRoomAvg, fFar) * fWinF * (1.0 - fFres) * 0.85;`);
  };
  m.customProgramCacheKey = () => 'facade-v3';
  return m;
}

export interface MaterialLib {
  get(k: MatKey): THREE.Material;
  envIntensity(v: number): void;
  all: THREE.Material[];
  screen: THREE.MeshStandardMaterial;
  fabric: T.TexSet;
  terrain: { grass?: THREE.Texture; rock?: THREE.Texture; sand?: THREE.Texture };
}

export async function createMaterials(): Promise<MaterialLib> {
  installFogChunks();
  const [sConcrete, sDark, sWarm, sGravel, sAsphalt, sMetal, sPave, sWood, sGrass, sTerrazzo, sBrick] = await Promise.all([
    T.loadScan('concrete_wall_001', 2), T.loadScan('concrete_wall_006', 2), T.loadScan('concrete_wall_008', 2),
    T.loadScan('bicolour_gravel', 2), T.loadScan('asphalt_02', 10),
    T.loadScan('metal_plate', 2), T.loadScan('concrete_pavement', 1.5), T.loadScan('wood_planks_grey', 2),
    T.loadScan('leafy_grass', 2), T.loadScan('terrazzo_tiles', 2), T.loadScan('factory_brick', 1),
  ]);
  // landscape colour maps (seen from far away: colour only)
  const L = new THREE.TextureLoader();
  const terrainTex = await Promise.all(['aerial_grass_rock', 'aerial_rocks_02', 'aerial_beach_01'].map((id) => L.loadAsync(`./assets/tex/${id}_diff.jpg`)
    .then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }).catch(() => undefined)));
  const concrete = sConcrete ?? T.concreteSet(1024, 0.4);
  const concreteDark = sDark ?? T.concreteSet(512, 0, 1);
  const concreteWarm = sWarm ?? T.concreteSet(512, 1.0);
  const gravel = sGravel ?? T.gravelSet(1024);
  const roof = T.roofSet(1024);
  const metal = sMetal ?? T.metalSet(256);
  const metalP = T.metalSet(256, true);
  const wood = sWood ?? T.woodSet(256);
  const grass = sGrass ?? T.grassSet(256);
  const asphalt = sAsphalt ?? T.asphaltSet(512);
  const tile = T.tileSet(256);
  const floorPolish = sTerrazzo ?? T.tileSet(256, true);
  const solar = T.solarSet(256);
  const fabric = T.fabricSet(256);
  const ads = T.adAtlas();

  const ts = (s: T.TexSet, extra: THREE.MeshStandardMaterialParameters = {}, ns = 1) => {
    const m = std({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, aoMap: s.aoMap ?? null, ...extra });
    m.normalScale.set(ns, ns);
    return addDetail(m, 4.7, 0.55);
  };

  const screen = std({ map: ads, emissiveMap: ads, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.35, metalness: 0.1 });
  const mats: Record<MatKey, THREE.Material> = {
    concrete: ts(concrete, { vertexColors: true }),
    concreteDark: ts(concreteDark, { color: 0xb8b8b8 }),
    concreteWarm: ts(concreteWarm, { color: 0xf3eee6 }),
    roof: ts(roof),
    gravel: ts(gravel, {}, 1.2),
    metal: ts(metal, { metalness: 0.85, color: 0xd8dadc }),
    metalDark: ts(metal, { metalness: 0.7, color: 0x3a3d40 }),
    metalPainted: ts(metalP, { metalness: 0.15, vertexColors: true }),
    red: ts(metalP, { color: PALETTE.red, metalness: 0.1, roughness: 0.5 }),
    glass: withFog(new THREE.MeshStandardMaterial({ color: 0xbfd8e0, roughness: 0.04, metalness: 0.6, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide })),
    glassDark: std({ color: 0x1b2328, roughness: 0.05, metalness: 0.8 }),
    wood: ts(wood),
    grass: ts(grass),
    foliage: withWind(std({ color: 0x5b8a3a, roughness: 0.8, vertexColors: true, flatShading: true }), 0.07),
    foliageDark: withWind(std({ color: 0x3e6b2c, roughness: 0.9, vertexColors: true, flatShading: true }), 0.06),
    trunk: std({ color: 0x5a4636, roughness: 0.9 }),
    facade: facadeMaterial(concrete, sBrick),
    lamp: std({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 3.0, roughness: 0.4 }),
    lampRed: std({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 6.0 }),
    lampWarm: std({ color: 0xfff2dc, emissive: 0xffd9a0, emissiveIntensity: 3.0 }),
    asphalt: ts(asphalt),
    sidewalk: ts(sPave ?? tile, { color: sPave ? 0xffffff : 0xd8d6d0 }),
    interiorFloor: ts(floorPolish, { color: 0xc8c6c2 }),
    interiorWall: std({ color: 0xf0efec, roughness: 0.85 }),
    rubber: std({ color: 0x2a2a2a, roughness: 0.95 }),
    screen,
    water: std({ color: 0x1d3540, roughness: 0.02, metalness: 0.9 }),
    tile: ts(tile),
    solar: ts(solar, { metalness: 0.5 }),
    cable: std({ color: 0x222222, roughness: 0.6, metalness: 0.5 }),
    stripe: std({ color: 0xf0efe8, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  // gravel & roofs: concrete-ish base
  // the scanned concrete is mid-grey; lift it toward the district's white architectural concrete
  (mats.concrete as THREE.MeshStandardMaterial).color.set(0xf4f3f0);
  if (sConcrete) (mats.concrete as THREE.MeshStandardMaterial).color.setRGB(1.45, 1.44, 1.42);
  if (sWarm) (mats.concreteWarm as THREE.MeshStandardMaterial).color.setRGB(1.25, 1.22, 1.18);
  const all = Object.values(mats);
  return {
    get: (k) => mats[k],
    envIntensity: (v) => { for (const m of all) if ((m as THREE.MeshStandardMaterial).envMapIntensity !== undefined) (m as THREE.MeshStandardMaterial).envMapIntensity = v; },
    all,
    screen,
    fabric,
    terrain: { grass: terrainTex[0], rock: terrainTex[1], sand: terrainTex[2] },
  };
}

export { withFog, std };
