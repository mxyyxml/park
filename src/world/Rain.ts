/**
 * Rain: streaks falling in a box that follows the camera. All motion happens in the vertex
 * shader (positions wrap around the camera), so it costs one draw call and no CPU per drop.
 */
import * as THREE from 'three';

const N = 7000, BOX = 38, HEIGHT = 28, FALL = 15;

export class Rain {
  mesh: THREE.LineSegments;
  private u = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(1.6, 0.8) }, uAlpha: { value: 0.22 } };

  constructor() {
    const seed = new Float32Array(N * 2 * 3), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      for (let k = 0; k < 2; k++) { seed.set([x, y, z], (i * 2 + k) * 3); end[i * 2 + k] = k; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aEnd;
        uniform float uTime; uniform vec3 uCam; uniform vec2 uWind;
        varying float vFade;
        void main() {
          vec3 size = vec3(${BOX.toFixed(1)}, ${HEIGHT.toFixed(1)}, ${BOX.toFixed(1)});
          vec3 vel = vec3(uWind.x, -${FALL.toFixed(1)}, uWind.y);
          // world-anchored drops falling along vel, wrapped into a box around the camera
          vec3 rel = fract(position + (vel * uTime - uCam) / size) - 0.5;
          vec3 wp = uCam + rel * size - vel * aEnd * 0.045;
          vFade = 1.0 - smoothstep(0.3, 0.5, length(rel.xz));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uAlpha; varying float vFade;
        void main() { gl_FragColor = vec4(0.75, 0.8, 0.88, uAlpha * vFade); }`,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'rain';
  }

  update(dt: number, cam: THREE.Vector3) {
    if (!this.mesh.visible) return;
    this.u.uTime.value += dt;
    this.u.uCam.value.copy(cam);
  }
}
