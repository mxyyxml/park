/**
 * Procedural PBR texture generation (albedo / normal / roughness) on canvases.
 * Everything is generated at startup — no external assets — but authored like texture work:
 * layered noise, panel seams, stains, grain direction, height-derived normal maps.
 */
import * as THREE from 'three';

// ---- noise ------------------------------------------------------------------------------------
function hash2(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** tileable value noise at integer period */
function vnoise(x: number, y: number, period: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = (a: number) => ((a % period) + period) % period;
  const a = hash2(p(xi), p(yi), seed), b = hash2(p(xi + 1), p(yi), seed);
  const c = hash2(p(xi), p(yi + 1), seed), d = hash2(p(xi + 1), p(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, basePeriod: number, oct: number, seed: number) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x * f, y * f, basePeriod * f, seed + i * 17) * amp;
    n += amp; amp *= 0.5; f *= 2;
  }
  return s / n;
}

export interface TexSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }

type Gen = (u: number, v: number, x: number, y: number) => { r: number; g: number; b: number; h: number; rough: number };

function makeSet(size: number, gen: Gen, normalStrength = 2.0, srgb = true): TexSet {
  const alb = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = gen(x / size, y / size, x, y);
    const i = y * size + x;
    alb[i * 4] = o.r * 255; alb[i * 4 + 1] = o.g * 255; alb[i * 4 + 2] = o.b * 255; alb[i * 4 + 3] = 255;
    const rr = Math.max(0, Math.min(1, o.rough)) * 255;
    rough[i * 4] = rr; rough[i * 4 + 1] = rr; rough[i * 4 + 2] = rr; rough[i * 4 + 3] = 255;
    height[i] = o.h;
  }
  const nor = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hx = (xx: number, yy: number) => height[((yy + size) % size) * size + ((xx + size) % size)];
    const dx = (hx(x + 1, y - 1) + 2 * hx(x + 1, y) + hx(x + 1, y + 1)) - (hx(x - 1, y - 1) + 2 * hx(x - 1, y) + hx(x - 1, y + 1));
    const dy = (hx(x - 1, y + 1) + 2 * hx(x, y + 1) + hx(x + 1, y + 1)) - (hx(x - 1, y - 1) + 2 * hx(x, y - 1) + hx(x + 1, y - 1));
    let nx = -dx * normalStrength, ny = dy * normalStrength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * size + x) * 4;
    nor[i] = (nx * 0.5 + 0.5) * 255; nor[i + 1] = (ny * 0.5 + 0.5) * 255; nor[i + 2] = (nz * 0.5 + 0.5) * 255; nor[i + 3] = 255;
  }
  const tex = (data: Uint8ClampedArray, color: boolean) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (color && srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: tex(alb, true), normalMap: tex(nor, false), roughnessMap: tex(rough, false) };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** White architectural concrete: formwork panels, tie holes, pores, faint water staining. 1 tile = 4 m. */
export function concreteSet(size = 512, warm = 0, dark = 0): TexSet {
  return makeSet(size, (u, v) => {
    const n = fbm(u * 8, v * 8, 8, 5, 3);
    const big = fbm(u * 2, v * 2, 2, 3, 11);
    const pores = vnoise(u * 420, v * 420, 420, 7);
    const pore = pores > 0.9 ? (pores - 0.9) * 3 : 0;
    // formwork panels 1.33 x 2 m inside a 4 m tile → 3 x 2 grid
    const pu = (u * 3) % 1, pv = (v * 2) % 1;
    const seam = Math.min(pu, 1 - pu) < 0.006 || Math.min(pv, 1 - pv) < 0.006 ? 1 : 0;
    // tie holes
    const tx = Math.abs(((u * 6) % 1) - 0.5), ty = Math.abs(((v * 4) % 1) - 0.5);
    const tie = Math.hypot(tx * 1.5, ty) < 0.025 ? 1 : 0;
    // vertical rain streaks
    const streak = Math.pow(fbm(u * 24, v * 1.5, 24, 3, 21), 3) * 0.6;
    let base = 0.86 - dark * 0.45 + (n - 0.5) * 0.08 + (big - 0.5) * 0.06 - streak * 0.12 - pore * 0.12 - seam * 0.1 - tie * 0.25;
    base = clamp01(base);
    return {
      r: base * (1 + warm * 0.04), g: base * (1 + warm * 0.015), b: base * (1 - warm * 0.03),
      h: n * 0.35 + big * 0.2 - pore * 0.3 - seam * 1.0 - tie * 0.8,
      rough: 0.82 + (n - 0.5) * 0.15 + streak * 0.1 - seam * 0.1,
    };
  }, 2.2);
}

export function gravelSet(size = 512): TexSet {
  return makeSet(size, (u, v) => {
    // stones: cellular-ish via thresholded noise layers
    const a = vnoise(u * 90, v * 90, 90, 1), b2 = vnoise(u * 160, v * 160, 160, 2), c = fbm(u * 6, v * 6, 6, 3, 3);
    const stone = Math.max(a, b2 * 0.9);
    const g = 0.48 + stone * 0.25 + (c - 0.5) * 0.12;
    return { r: g * 1.02, g: g, b: g * 0.97, h: stone * 1.4, rough: 0.95 };
  }, 3.0);
}

export function roofSet(size = 512): TexSet {
  // light grey roofing membrane with welded seams every 2 m and walkway pads
  return makeSet(size, (u, v) => {
    const n = fbm(u * 10, v * 10, 10, 4, 5);
    const pv = (v * 2) % 1;
    const seam = pv < 0.012 ? 1 : 0;
    const dirt = Math.pow(fbm(u * 3, v * 3, 3, 4, 9), 2);
    const g = 0.7 + (n - 0.5) * 0.06 - dirt * 0.18 + seam * 0.05;
    return { r: g, g: g, b: g * 1.01, h: n * 0.2 + seam * 0.8, rough: 0.7 + dirt * 0.2 };
  }, 1.5);
}

export function metalSet(size = 256, painted = false): TexSet {
  return makeSet(size, (u, v) => {
    const brushed = fbm(u * 2, v * 120, 2, 3, 13);
    const n = fbm(u * 6, v * 6, 6, 4, 4);
    const g = painted ? 0.92 + (n - 0.5) * 0.04 : 0.62 + (brushed - 0.5) * 0.12 + (n - 0.5) * 0.05;
    return { r: g, g: g, b: g * 1.01, h: painted ? n * 0.2 : brushed * 0.3, rough: painted ? 0.45 + n * 0.15 : 0.32 + brushed * 0.2 };
  }, 1.0);
}

export function woodSet(size = 256): TexSet {
  return makeSet(size, (u, v) => {
    const plank = Math.floor(u * 8);
    const pu = (u * 8) % 1;
    const gap = pu < 0.04 ? 1 : 0;
    const grain = fbm(u * 8 + plank * 3.1, v * 60, 8, 3, 30 + plank);
    const tone = 0.55 + hash2(plank, 0, 5) * 0.15;
    const g = tone * (0.85 + grain * 0.3) * (gap ? 0.4 : 1);
    return { r: g * 1.12, g: g * 0.86, b: g * 0.62, h: grain * 0.3 - gap, rough: 0.7 };
  }, 2.0);
}

export function grassSet(size = 256): TexSet {
  return makeSet(size, (u, v) => {
    const n = fbm(u * 40, v * 40, 40, 4, 2), m = fbm(u * 4, v * 4, 4, 3, 8);
    const g = 0.28 + n * 0.25;
    return { r: g * 0.55 + m * 0.05, g: g * 1.05, b: g * 0.38, h: n, rough: 0.95 };
  }, 2.5);
}

export function asphaltSet(size = 512): TexSet {
  return makeSet(size, (u, v) => {
    const n = fbm(u * 64, v * 64, 64, 3, 41), m = fbm(u * 4, v * 4, 4, 4, 43);
    const g = 0.17 + n * 0.08 + (m - 0.5) * 0.06;
    return { r: g, g: g, b: g * 1.04, h: n, rough: 0.9 - m * 0.2 };
  }, 1.5);
}

export function tileSet(size = 256, polish = false): TexSet {
  return makeSet(size, (u, v) => {
    const pu = (u * 4) % 1, pv = (v * 4) % 1;
    const grout = Math.min(pu, 1 - pu, pv, 1 - pv) < 0.012 ? 1 : 0;
    const n = fbm(u * 16, v * 16, 16, 3, 51);
    const t = hash2(Math.floor(u * 4), Math.floor(v * 4), 3);
    const g = (polish ? 0.62 : 0.72) + t * 0.06 + (n - 0.5) * 0.05 - grout * 0.25;
    return { r: g, g: g * 0.99, b: g * 0.97, h: -grout, rough: polish ? 0.18 + n * 0.1 + grout * 0.6 : 0.6 + grout * 0.3 };
  }, 1.5);
}

export function solarSet(size = 256): TexSet {
  return makeSet(size, (u, v) => {
    const cu = (u * 6) % 1, cv = (v * 10) % 1;
    const line = Math.min(cu, 1 - cu) < 0.03 || Math.min(cv, 1 - cv) < 0.03 ? 1 : 0;
    const finger = ((v * 120) % 1) < 0.08 ? 1 : 0;
    const g = line ? 0.75 : 0.07 + finger * 0.04;
    return { r: g * 0.8, g: g * 0.85, b: g * 1.3 + (line ? 0 : 0.08), h: line * 0.5, rough: line ? 0.5 : 0.12 };
  }, 1.0);
}

/** Fabric weave for clothing. */
export function fabricSet(size = 256): TexSet {
  return makeSet(size, (u, v) => {
    const wu = Math.sin(u * Math.PI * 2 * 64), wv = Math.sin(v * Math.PI * 2 * 64);
    const weave = (wu * 0.5 + 0.5) * ((Math.floor(v * 64) % 2) ? 1 : 0.5) + (wv * 0.5 + 0.5) * ((Math.floor(u * 64) % 2) ? 0.5 : 1);
    const n = fbm(u * 8, v * 8, 8, 3, 61);
    const g = 0.85 + n * 0.15;
    return { r: g, g, b: g, h: weave * 0.5, rough: 0.85 };
  }, 1.2);
}

/** Advertising / signage atlas: 4x4 cells of original abstract designs. */
export function adAtlas(): THREE.Texture {
  const S = 1024, C = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const brands = ['NOVA', 'HALCYON', 'KINESIS', 'VANTA', 'AERO', 'ORBITAL', 'LUMEN', 'PARALLAX', 'STRATA', 'HELIX', 'ZENITH', 'CIRRUS', 'TERRA', 'VECTOR', 'APEX', 'SOLACE'];
  const palettes = [['#f4f4f2', '#d8202a', '#151515'], ['#0f1a24', '#4fc3ff', '#ffffff'], ['#d8202a', '#ffffff', '#151515'], ['#ececec', '#151515', '#ff8a00'],
    ['#101010', '#f2f2f2', '#d8202a'], ['#e9f3f7', '#1a6fa8', '#0d1b2a'], ['#ffd400', '#151515', '#ffffff'], ['#1d1d1d', '#00e0b8', '#ffffff']];
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * C, y = Math.floor(i / 4) * C;
    const [bg, fg, tx] = palettes[i % palettes.length];
    g.save(); g.beginPath(); g.rect(x, y, C, C); g.clip();
    g.fillStyle = bg; g.fillRect(x, y, C, C);
    g.fillStyle = fg;
    const k = i % 4;
    if (k === 0) { g.beginPath(); g.arc(x + C * 0.68, y + C * 0.42, C * 0.3, 0, Math.PI * 2); g.fill(); }
    else if (k === 1) { for (let s = 0; s < 6; s++) g.fillRect(x + s * C / 6, y + C * (0.15 + s * 0.08), C / 12, C * 0.6); }
    else if (k === 2) { g.beginPath(); g.moveTo(x, y + C); g.lineTo(x + C, y + C * 0.15); g.lineTo(x + C, y + C); g.fill(); }
    else { g.fillRect(x + C * 0.1, y + C * 0.1, C * 0.8, C * 0.04); g.fillRect(x + C * 0.1, y + C * 0.55, C * 0.5, C * 0.25); }
    g.fillStyle = tx;
    g.font = `900 ${C * 0.16}px "Helvetica Neue", Arial, sans-serif`;
    g.textBaseline = 'alphabetic';
    g.fillText(brands[i], x + C * 0.08, y + C * 0.9);
    g.font = `500 ${C * 0.055}px "Helvetica Neue", Arial, sans-serif`;
    g.fillText(['MOVE FREELY', 'THE CITY IS YOURS', 'ELEVATE', 'BEYOND LIMITS'][i % 4], x + C * 0.08, y + C * 0.66 + (k === 3 ? C * 0.2 : 0));
    g.restore();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
