import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { fogUniforms } from './materials';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1.0 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.08 },
    uShadowTint: { value: new THREE.Vector3(0.96, 0.99, 1.05) },
    uHighTint: { value: new THREE.Vector3(1.04, 1.0, 0.95) },
    uVignette: { value: 0.32 },
    uSpeed: { value: 0.0 },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Vector3(1, 1, 1) },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform float uExposure, uSaturation, uContrast, uVignette, uSpeed, uFlash, uTime;
uniform vec3 uShadowTint, uHighTint, uFlashColor;
varying vec2 vUv;
float h21(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 c = vUv - 0.5;
  // subtle speed-driven chromatic fringe at the screen edges only
  float ca = uSpeed * 0.0035 * dot(c, c) * 4.0;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv - c * ca).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv + c * ca).b;
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  col *= uExposure;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // split toning: cool shadows, warm highlights
  float hl = smoothstep(0.05, 1.2, l);
  col *= mix(uShadowTint, uHighTint, hl);
  col = mix(vec3(l), col, uSaturation);
  // contrast around mid grey in log-ish space
  col = max(col, 0.0);
  col = pow(col / 0.18, vec3(uContrast)) * 0.18;
  // vignette
  float v = 1.0 - uVignette * smoothstep(0.25, 0.95, length(c * vec2(1.25, 1.0)) * 1.3);
  col *= v;
  col = mix(col, uFlashColor, uFlash);
  // fine film grain to break banding
  col += (h21(vUv * 1000.0 + uTime) - 0.5) * 0.004;
  gl_FragColor = vec4(col, 1.0);
}`,
};

/**
 * Sun shafts: screen-space light scattering. Bright pixels near the sun are streaked toward the
 * viewer along rays from the sun's screen position; anything darker (buildings in front of the
 * sun, cloud cores) blocks them.
 */
const ShaftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uVisible: { value: 0 },
    uAspect: { value: 1 },
    uColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uVisible; uniform float uAspect; uniform vec3 uColor;
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  if (uVisible > 0.001) {
    vec2 delta = (vUv - uSun) * (0.9 / 32.0);
    vec2 uv = vUv; float illum = 1.0; float acc = 0.0;
    for (int i = 0; i < 32; i++) {
      uv -= delta;
      vec3 s = texture2D(tDiffuse, uv).rgb;
      float l = max(dot(s, vec3(0.2126, 0.7152, 0.0722)) - 0.82, 0.0);
      acc += l * illum;
      illum *= 0.955;
    }
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float near = 1.0 - smoothstep(0.0, 0.9, length(d));
    col += uColor * acc * 0.06 * near * uVisible;
  }
  gl_FragColor = vec4(col, 1.0);
}`,
};

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer!: EffectComposer;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: Sky;
  sunDir = new THREE.Vector3();
  quality: Quality = 'high';
  grade!: ShaderPass;
  shafts!: ShaderPass;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private smaa: SMAAPass | null = null;
  private shadowSize = 2048;
  private shadowExtent = 70;
  envMap: THREE.Texture | null = null;
  csm: CSM | null = null;
  private csmMats = new Map<THREE.Material, THREE.Material['onBeforeCompile']>();
  private lastFov = 0; private lastAspect = 0;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(85, 1, 0.05, 12000);
    this.scene.add(this.camera);

    // Sky
    this.sky = new Sky();
    this.sky.scale.setScalar(6000);
    const su = this.sky.material.uniforms;
    su.turbidity.value = 3.2;
    su.rayleigh.value = 1.15;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);
    // sun: late-morning light from the south-east, high enough for crisp rooftop shadows
    const elev = THREE.MathUtils.degToRad(38), azim = THREE.MathUtils.degToRad(145);
    this.sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
    su.sunPosition.value.copy(this.sunDir);
    fogUniforms.fogSunDir.value.copy(this.sunDir);

    // the sun proper is a cascaded-shadow light rig (see applyQuality); this light is only
    // used while capturing the environment map
    this.sun = new THREE.DirectionalLight(0xfff1de, 3.4);
    this.sun.position.copy(this.sunDir).multiplyScalar(100);
    this.sun.visible = false;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a8478, 0.65);
    this.scene.add(this.hemi);

    this.scene.fog = new THREE.Fog(0xc9d6e2, 1, 2); // values unused: our fog chunk is density based
    (this.scene.fog as THREE.Fog).color.set(0xc4d2df);

    this.setupPost();
    this.applyQuality(quality);
  }

  private setupPost() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.grade = new ShaderPass(GradeShader);
    this.shafts = new ShaderPass(ShaftShader);
  }

  applyQuality(q: Quality) {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1) : q === 'high' ? Math.min(dpr, 1.5) : dpr;
    this.renderer.setPixelRatio(ratio);
    this.shadowSize = q === 'low' ? 1024 : q === 'medium' ? 2048 : q === 'high' ? 2048 : 4096;
    this.setupCSM(q === 'low' ? 2 : q === 'medium' ? 3 : 4, q === 'low' ? 220 : q === 'medium' ? 380 : 520);
    // rebuild pass chain
    const passes = [...this.composer.passes];
    for (const p of passes.slice(1)) this.composer.removePass(p);
    this.gtao?.dispose?.(); this.bloom?.dispose?.(); this.smaa?.dispose?.();
    this.gtao = null; this.bloom = null; this.smaa = null;
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    if (q === 'high' || q === 'ultra') {
      this.gtao = new GTAOPass(this.scene, this.camera, w, h);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.blendIntensity = 0.85;
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: q === 'ultra' ? 16 : 10, distanceFallOff: 1.0 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(this.gtao);
    }
    if (q !== 'low') {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.55, 0.92);
      this.composer.addPass(this.bloom);
    }
    if (q !== 'low') this.composer.addPass(this.shafts);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    if (q !== 'low') {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }
    this.resize();
  }

  /** Cascaded shadow maps: crisp contact shadows near the runner, whole-building shadows out to the skyline. */
  private setupCSM(cascades: number, maxFar: number) {
    if (this.csm) { this.csm.remove(); this.csm.dispose(); }
    this.csm = new CSM({
      camera: this.camera, parent: this.scene, cascades, maxFar, mode: 'practical',
      shadowMapSize: this.shadowSize, lightDirection: this.sunDir.clone().negate(), lightIntensity: 3.4,
      lightNear: 1, lightFar: 3000, lightMargin: 220, shadowBias: -0.0002,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) l.shadow.normalBias = 0.04;
    this.applyLightColor();
    for (const m of this.csmMats.keys()) this.setupShadowMaterial(m);
    this.lastFov = 0;
  }

  /** Register a lit material with the cascade rig, chaining onto its existing shader hooks. */
  setupShadowMaterial(m: THREE.Material) {
    if (!this.csm) return;
    if (!this.csmMats.has(m)) this.csmMats.set(m, m.onBeforeCompile);
    const base = this.csmMats.get(m)!;
    this.csm.setupMaterial(m);
    const csmHook = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => { base.call(m, sh, r); csmHook.call(m, sh, r); };
    m.needsUpdate = true;
  }

  registerSceneMaterials() {
    this.scene.traverse((o) => {
      const mm = (o as THREE.Mesh).material;
      if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !this.csmMats.has(m)) this.setupShadowMaterial(m);
      }
    });
  }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lastFov = 0;
  }

  /** Build image-based lighting from sky + city, rendered once from above the rooftops. */
  buildEnvironment(center: THREE.Vector3) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(1, 5000, cubeRT);
    cubeCam.position.copy(center);
    // capture without shadows using the plain sun light
    this.renderer.shadowMap.enabled = false;
    const csmLights = this.csm ? this.csm.lights : [];
    for (const l of csmLights) l.visible = false;
    this.sun.visible = true;
    cubeCam.update(this.renderer, this.scene);
    this.sun.visible = false;
    for (const l of csmLights) l.visible = true;
    this.renderer.shadowMap.enabled = true;
    const env = pmrem.fromCubemap(cubeRT.texture).texture;
    this.envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.9;
    cubeRT.dispose();
    pmrem.dispose();
  }

  // ---- photographic sky ----------------------------------------------------------------------
  private photoSky = false;
  private skySun = new THREE.Vector3();
  private skyAngle = 0;

  /**
   * Use an HDRI-derived panorama as the sky. The sun light, its shadows and the fog's sun glow
   * follow the sun found in the image; fog takes the image's horizon colour.
   */
  setPhotoSky(tex: THREE.Texture, sun: number[], horizon: number[]) {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = tex;
    this.scene.backgroundIntensity = 1.12;
    this.sky.visible = false;
    this.skySun.set(sun[0], sun[1], sun[2]).normalize();
    (this.scene.fog as THREE.Fog).color.setRGB(horizon[0], horizon[1], horizon[2], THREE.SRGBColorSpace);
    this.hemi.color.setRGB(horizon[0], horizon[1], horizon[2], THREE.SRGBColorSpace);
    this.photoSky = true;
    this.setSunDir(this.skySun);
  }

  private setSunDir(d: THREE.Vector3) {
    this.sunDir.copy(d);
    fogUniforms.fogSunDir.value.copy(d);
    this.sun.position.copy(d).multiplyScalar(100);
    this.csm?.lightDirection.copy(d).negate();
  }

  // ---- night ---------------------------------------------------------------------------------
  night = false;
  private day: { fog: THREE.Color; hemiC: THREE.Color; hemiI: number; env: number; bg: number; sunC: THREE.Color; exp: number } | null = null;

  /** Moonlit night: dim blue key light, near-black sky, lit windows and lamps carry the scene. */
  setNight(on: boolean) {
    const fog = this.scene.fog as THREE.Fog;
    if (!this.day) this.day = { fog: fog.color.clone(), hemiC: this.hemi.color.clone(), hemiI: this.hemi.intensity, env: this.scene.environmentIntensity, bg: this.scene.backgroundIntensity, sunC: fogUniforms.fogSunColor.value.clone(), exp: this.renderer.toneMappingExposure };
    const d = this.day;
    this.night = on;
    fogUniforms.uNight.value = on ? 1 : 0;
    fog.color.copy(on ? new THREE.Color(0x0a0f1c) : d.fog);
    this.hemi.color.copy(on ? new THREE.Color(0x5a74b8) : d.hemiC);
    this.hemi.intensity = on ? 0.16 : d.hemiI;
    this.scene.environmentIntensity = on ? 0.12 : d.env;
    this.scene.backgroundIntensity = on ? 0.035 : d.bg;
    fogUniforms.fogSunColor.value.copy(on ? new THREE.Color(0x1a2238) : d.sunC);
    this.renderer.toneMappingExposure = on ? 1.15 : d.exp;
    this.applyLightColor();
  }
  private applyLightColor() {
    for (const l of this.csm?.lights ?? []) { l.color.set(this.night ? 0x9fb6ff : 0xfff1de); l.intensity = this.night ? 0.55 : 3.4; }
  }

  /** clouds drift: the panorama turns very slowly and the sun (and every shadow) turns with it */
  private driftSky(dt: number) {
    if (!this.photoSky) return;
    this.skyAngle += dt * 0.0006;
    this.scene.backgroundRotation.y = this.skyAngle;
    this.setSunDir(this.skySun.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.skyAngle));
  }

  /** update the shadow cascades for the current camera */
  updateSun(_focus: THREE.Vector3) {
    if (!this.csm) return;
    const cam = this.camera;
    if (Math.abs(cam.fov - this.lastFov) > 0.6 || Math.abs(cam.aspect - this.lastAspect) > 0.01) {
      this.csm.updateFrustums();
      this.lastFov = cam.fov; this.lastAspect = cam.aspect;
    }
    this.csm.update();
  }

  render(dt: number, speed: number) {
    this.driftSky(dt);
    // sun position on screen for the shafts pass; fades when the sun leaves the view
    const cam = this.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const sp = cam.position.clone().addScaledVector(this.sunDir, 1000).project(cam);
    const facing = fwd.dot(this.sunDir);
    const u = this.shafts.uniforms;
    u.uSun.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    u.uVisible.value = this.night ? 0 : facing > 0 ? THREE.MathUtils.smoothstep(facing, 0.2, 0.7) * (1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(sp.x), Math.abs(sp.y)), 1.0, 1.6)) : 0;
    u.uAspect.value = cam.aspect;
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uSpeed.value = speed;
    this.composer.render(dt);
  }
}
