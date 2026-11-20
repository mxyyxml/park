import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
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
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private smaa: SMAAPass | null = null;
  private shadowSize = 2048;
  private shadowExtent = 70;
  envMap: THREE.Texture | null = null;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(85, 1, 0.04, 4000);
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

    this.sun = new THREE.DirectionalLight(0xfff1de, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.035;
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
  }

  applyQuality(q: Quality) {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1) : q === 'high' ? Math.min(dpr, 1.5) : dpr;
    this.renderer.setPixelRatio(ratio);
    this.shadowSize = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
    this.shadowExtent = q === 'low' ? 45 : 70;
    this.sun.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as any).map = null;
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowExtent; cam.right = this.shadowExtent; cam.top = this.shadowExtent; cam.bottom = -this.shadowExtent;
    cam.near = 1; cam.far = 600; cam.updateProjectionMatrix();
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
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    if (q !== 'low') {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }
    this.resize();
  }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Build image-based lighting from sky + city, rendered once from above the rooftops. */
  buildEnvironment(center: THREE.Vector3) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(1, 5000, cubeRT);
    cubeCam.position.copy(center);
    const fog = this.scene.fog; this.scene.fog = fog;
    this.sun.castShadow = false;
    cubeCam.update(this.renderer, this.scene);
    this.sun.castShadow = true;
    const env = pmrem.fromCubemap(cubeRT.texture).texture;
    this.envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.9;
    cubeRT.dispose();
    pmrem.dispose();
  }

  /** keep the shadow frustum centred on the player, snapped to texels to prevent shimmering */
  updateSun(focus: THREE.Vector3) {
    const d = 250;
    const texel = (this.shadowExtent * 2) / this.shadowSize;
    // snap in light space
    const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), this.sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const p = focus.clone().applyMatrix4(inv);
    p.x = Math.round(p.x / texel) * texel; p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(lightRot);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.sunDir, d);
    this.sun.target.updateMatrixWorld();
  }

  render(dt: number, speed: number) {
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uSpeed.value = speed;
    this.composer.render(dt);
  }
}
