/**
 * Living-city systems: drones, maglev train, street traffic, bird flocks, steam, fans,
 * blinking beacons, cycling ad screens and a drifting cloud layer.
 */
import * as THREE from 'three';
import type { Anchor } from './builder';
import type { CityInfo } from './city';
import type { AudioEngine } from '../audio/AudioEngine';
import { withFog, windUniforms } from '../render/materials';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3(1, 1, 1);
const tmpP = new THREE.Vector3();
const tmpO = new THREE.Vector3();
const tmpL = new THREE.Matrix4();
const ORIGIN = new THREE.Vector3();

function softSprite(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Drone { group: THREE.Group; rotors: THREE.Object3D[]; cx: number; cz: number; y: number; rx: number; rz: number; sp: number; ph: number; light: THREE.Mesh; emitter: any }
interface Bird { p: THREE.Vector3; v: THREE.Vector3; flap: number }

export class Dynamic {
  group = new THREE.Group();
  private drones: Drone[] = [];
  private train: THREE.Group;
  private trainX = -1500;
  private trainDir = 1;
  private trainWait = 6;
  private trainEmitter: any = null;
  private cars!: THREE.InstancedMesh;
  private carLights!: THREE.InstancedMesh;
  private carState: { lane: number; t: number; speed: number }[] = [];
  private lanes: CityInfo['lanes'];
  private birds: Bird[] = [];
  private birdMesh!: THREE.InstancedMesh;
  private flockCenter = new THREE.Vector3();
  private flockHome = new THREE.Vector3();
  private flockScare = 0;
  private steam: { pts: THREE.Points; anchor: Anchor; ages: Float32Array; vel: Float32Array }[] = [];
  private fans: THREE.InstancedMesh | null = null;
  private fanAnchors: Anchor[] = [];
  private beaconMat: THREE.MeshStandardMaterial;
  private screenMat: THREE.MeshStandardMaterial;
  private t = 0;
  private flagU = { uTime: { value: 0 } };
  private dust!: THREE.Points;
  private dustVel: Float32Array = new Float32Array(0);
  private screenT = 0;

  constructor(city: CityInfo, anchors: Anchor[], beaconMat: THREE.Material, screenMat: THREE.MeshStandardMaterial, private audio: AudioEngine) {
    this.beaconMat = beaconMat as THREE.MeshStandardMaterial;
    this.screenMat = screenMat;
    this.lanes = city.lanes;
    const white = withFog(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.35, metalness: 0.2 }));
    const dark = withFog(new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.5, metalness: 0.4 }));
    const red = withFog(new THREE.MeshStandardMaterial({ color: 0xc8161e, roughness: 0.45 }));
    const glass = withFog(new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.05, metalness: 0.9 }));
    const redLight = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 5 });

    // ---- drones
    const b = city.bounds;
    for (let i = 0; i < 7; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.5), white);
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.38), dark); pod.position.y = -0.17;
      g.add(body, pod);
      const rotors: THREE.Object3D[] = [];
      for (const [x, z] of [[-0.42, -0.42], [0.42, -0.42], [0.42, 0.42], [-0.42, 0.42]]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.6), white);
        arm.position.set(x / 2, 0, z / 2); arm.lookAt(new THREE.Vector3(x, 0, z)); g.add(arm);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 6, 20), white); ring.rotation.x = Math.PI / 2; ring.position.set(x, 0.04, z); g.add(ring);
        const rot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.008, 0.04), dark); rot.position.set(x, 0.06, z); g.add(rot); rotors.push(rot);
      }
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), redLight); light.position.y = -0.3; g.add(light);
      g.traverse((o) => { o.castShadow = true; });
      this.group.add(g);
      const d: Drone = { group: g, rotors, cx: b.minX + Math.random() * (b.maxX - b.minX), cz: b.minZ + Math.random() * (b.maxZ - b.minZ),
        y: 34 + Math.random() * 30, rx: 30 + Math.random() * 60, rz: 25 + Math.random() * 50, sp: 0.05 + Math.random() * 0.06, ph: Math.random() * 10, light,
        emitter: audio.addEmitter('droneLoop', 0, 40, 0, 0.18, 4, 0.9 + Math.random() * 0.3) };
      this.drones.push(d);
    }

    // ---- maglev train
    this.train = new THREE.Group();
    const carLen = 24;
    for (let i = 0; i < 6; i++) {
      const car = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.BoxGeometry(carLen - 0.6, 3.4, 3.2), white);
      shell.position.y = 2.2;
      const win = new THREE.Mesh(new THREE.BoxGeometry(carLen - 2, 1.0, 3.25), glass); win.position.y = 2.7;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(carLen - 0.6, 0.25, 3.26), red); stripe.position.y = 1.7;
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(carLen - 1.2, 0.6, 2.6), dark); skirt.position.y = 0.35;
      car.add(shell, win, stripe, skirt);
      if (i === 0 || i === 5) {
        const nose = new THREE.Mesh(new THREE.SphereGeometry(1.7, 16, 10, 0, Math.PI), white);
        nose.scale.set(1, 1, 2.6); nose.rotation.y = i === 0 ? Math.PI / 2 : -Math.PI / 2; nose.position.set(i === 0 ? (carLen / 2 - 0.3) : -(carLen / 2 - 0.3), 2.2, 0);
        car.add(nose);
      }
      car.position.x = -i * carLen;
      car.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
      this.train.add(car);
    }
    this.train.position.set(this.trainX, city.trainPath.y, city.trainPath.z);
    this.group.add(this.train);
    this.trainEmitter = audio.addEmitter('trainLoop', this.trainX, city.trainPath.y, city.trainPath.z, 0.0, 25);

    // ---- traffic
    const carGeo = new THREE.BoxGeometry(1.9, 1.35, 4.4);
    carGeo.translate(0, 0.85, 0);
    const carMat = withFog(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.6 }));
    const N = 160;
    this.cars = new THREE.InstancedMesh(carGeo, carMat, N);
    const palette = [0xf2f2f2, 0x1d1f22, 0x8a9096, 0xc8161e, 0x2b4a6b, 0xd0d0d0];
    for (let i = 0; i < N; i++) {
      this.cars.setColorAt(i, new THREE.Color(palette[i % palette.length]));
      this.carState.push({ lane: i % this.lanes.length, t: Math.random(), speed: 10 + Math.random() * 6 });
    }
    this.cars.castShadow = false; this.cars.receiveShadow = true;
    const lgGeo = new THREE.BoxGeometry(1.7, 0.2, 4.5); lgGeo.translate(0, 0.9, 0);
    this.carLights = new THREE.InstancedMesh(lgGeo, new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2a1a, emissiveIntensity: 2.5 }), N);
    this.group.add(this.cars, this.carLights);

    // ---- birds
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.18, -0.35, 0, 0.05, 0, 0.02, 0.1, 0, 0, -0.18, 0.35, 0, 0.05, 0, 0.02, 0.1], 3));
    bg.computeVertexNormals();
    this.birdMesh = new THREE.InstancedMesh(bg, withFog(new THREE.MeshStandardMaterial({ color: 0x2a2a2e, side: THREE.DoubleSide, roughness: 0.9 })), 40);
    const home = anchors.find((a) => a.type === 'beacon') ?? { x: 0, y: 40, z: 0 };
    this.flockHome.set(home.x * 0.2, 45, home.z * 0.2);
    this.flockCenter.copy(this.flockHome);
    for (let i = 0; i < 40; i++) this.birds.push({ p: new THREE.Vector3().copy(this.flockHome).add(new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 12)), v: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(6), flap: Math.random() * 6 });
    this.group.add(this.birdMesh);

    // ---- steam
    const sprite = softSprite();
    for (const a of anchors.filter((x) => x.type === 'steam')) {
      const n = 40;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const mat = new THREE.PointsMaterial({ map: sprite, size: 2.2, transparent: true, opacity: 0.35, depthWrite: false, color: 0xffffff, sizeAttenuation: true });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      const ages = new Float32Array(n).map(() => Math.random() * 4);
      this.steam.push({ pts, anchor: a, ages, vel: new Float32Array(n * 3).map(() => (Math.random() - 0.5) * 0.4) });
      this.group.add(pts);
      audio.addEmitter('steamLoop', a.x, a.y, a.z, 0.12, 3);
    }

    // ---- fans
    this.fanAnchors = anchors.filter((a) => a.type === 'fan');
    if (this.fanAnchors.length) {
      const fg = new THREE.BoxGeometry(1, 0.03, 0.18);
      const merged: THREE.BufferGeometry[] = [];
      void merged;
      this.fans = new THREE.InstancedMesh(fg, dark, this.fanAnchors.length * 3);
      this.group.add(this.fans);
      for (const a of this.fanAnchors) audio.addEmitter('humLoop', a.x, a.y, a.z, 0.08, 3);
    }
    this.buildFlags(anchors.filter((a) => a.type === 'flag'));
    this.buildDust();

  }

  /** flags on rooftop poles: cloth waving in the wind (vertex shader), shadow-casting */
  private buildFlags(anchors: Anchor[]) {
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 160;
      const g = c.getContext('2d')!;
      g.fillStyle = '#f2f2f0'; g.fillRect(0, 0, 256, 160);
      g.fillStyle = '#c8161e'; g.fillRect(0, 0, 256, 54); g.fillRect(0, 106, 256, 54);
      g.fillStyle = '#151515'; g.beginPath(); g.arc(128, 80, 18, 0, Math.PI * 2); g.fill();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const mat = withFog(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85 }));
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev.call(mat, sh, r);
      Object.assign(sh.uniforms, this.flagU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float fx = uv.x; // 0 at the pole, 1 at the free edge
float wave = sin(fx * 7.0 - uTime * 6.0 + position.y * 2.0) * 0.18 + sin(fx * 13.0 - uTime * 9.5) * 0.05;
transformed.z += wave * fx;
transformed.y -= fx * fx * 0.12;`);
    };
    for (const a of anchors) {
      const geo = new THREE.PlaneGeometry(1.8, 1.1, 24, 10);
      geo.translate(0.9, -0.55, 0);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(a.x, a.y, a.z);
      m.rotation.y = a.a ?? 0;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
    }
  }

  /** wind-borne dust and grit drifting past the runner; denser with height and speed */
  private buildDust() {
    const n = 220;
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) p[i] = (Math.random() - 0.5) * 40;
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.dustVel = new Float32Array(n).map(() => 0.6 + Math.random() * 0.8);
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xd9d2c4, size: 0.02, transparent: true, opacity: 0.3, depthWrite: false, sizeAttenuation: true }));
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  update(dt: number, player: THREE.Vector3) {
    this.t += dt;
    const t = this.t;
    this.flagU.uTime.value = t;
    windUniforms.uWindTime.value = t;
    // dust: drift with the wind, wrap around the player
    const dpos = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
    const wx = 1.6 + Math.sin(t * 0.2) * 0.8, wz = 0.7;
    for (let i = 0; i < this.dustVel.length; i++) {
      let x = dpos.getX(i) + wx * this.dustVel[i] * dt, y = dpos.getY(i) + Math.sin(t * 1.3 + i) * 0.1 * dt, z = dpos.getZ(i) + wz * this.dustVel[i] * dt;
      if (x - player.x > 20) x -= 40; if (x - player.x < -20) x += 40;
      if (z - player.z > 20) z -= 40; if (z - player.z < -20) z += 40;
      if (y - player.y > 8) y -= 14; if (y - player.y < -6) y += 14;
      dpos.setXYZ(i, x, y, z);
    }
    dpos.needsUpdate = true;
    (this.dust.material as THREE.PointsMaterial).opacity = 0.1 + Math.min(0.15, Math.max(0, player.y - 15) / 120);
    // drones
    for (const d of this.drones) {
      const a = t * d.sp + d.ph;
      const x = d.cx + Math.sin(a) * d.rx, z = d.cz + Math.sin(a * 1.7) * d.rz, y = d.y + Math.sin(a * 2.3) * 3;
      const dx = Math.cos(a) * d.rx * d.sp, dz = Math.cos(a * 1.7) * 1.7 * d.rz * d.sp;
      d.group.position.set(x, y, z);
      d.group.rotation.set(dz * 0.02, Math.atan2(dx, dz), -dx * 0.02);
      for (const r of d.rotors) r.rotation.y += dt * 60;
      (d.light.material as THREE.MeshStandardMaterial).emissiveIntensity = (Math.sin(t * 6 + d.ph) > 0.7 ? 6 : 0.3);
      this.audio.moveEmitter(d.emitter, x, y, z);
    }
    // train
    if (this.trainWait > 0) { this.trainWait -= dt; }
    else {
      this.trainX += this.trainDir * 38 * dt;
      if (this.trainX > 1500 || this.trainX < -1500) { this.trainDir *= -1; this.trainWait = 20 + Math.random() * 25; this.train.rotation.y = this.trainDir > 0 ? 0 : Math.PI; }
      this.train.position.x = this.trainX;
      if (this.trainEmitter) {
        this.audio.moveEmitter(this.trainEmitter, this.trainX - this.trainDir * 60, this.train.position.y, this.train.position.z);
        this.trainEmitter.gain.gain.value = 0.9;
      }
    }
    // traffic
    for (let i = 0; i < this.carState.length; i++) {
      const c = this.carState[i];
      const L = this.lanes[c.lane];
      const len = Math.hypot(L.x1 - L.x0, L.z1 - L.z0);
      c.t += c.speed * dt / len;
      if (c.t > 1) { c.t -= 1; }
      const x = L.x0 + (L.x1 - L.x0) * c.t, z = L.z0 + (L.z1 - L.z0) * c.t;
      const yaw = Math.atan2(L.x1 - L.x0, L.z1 - L.z0);
      tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      tmpP.set(x, 0.15, z);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.cars.setMatrixAt(i, tmpM);
      this.carLights.setMatrixAt(i, tmpM);
    }
    this.cars.instanceMatrix.needsUpdate = true;
    this.carLights.instanceMatrix.needsUpdate = true;
    // birds: wheel around their home, scatter when the player comes close
    const dp = player.distanceTo(this.flockCenter);
    if (dp < 18 && this.flockScare <= 0) { this.flockScare = 6; this.flockHome.set(player.x + (Math.random() - 0.5) * 160, 40 + Math.random() * 25, player.z + (Math.random() - 0.5) * 160); }
    this.flockScare -= dt;
    this.flockCenter.lerp(this.flockHome, dt * (this.flockScare > 0 ? 0.6 : 0.05));
    for (let i = 0; i < this.birds.length; i++) {
      const bd = this.birds[i];
      const to = tmpP.copy(this.flockCenter).sub(bd.p);
      const orbit = tmpO.set(-to.z, 0, to.x).normalize().multiplyScalar(4);
      bd.v.addScaledVector(to, dt * 0.35).addScaledVector(orbit, dt * 0.8);
      if (this.flockScare > 4) bd.v.y += dt * 6;
      const sp = bd.v.length(); const maxS = this.flockScare > 0 ? 14 : 8;
      if (sp > maxS) bd.v.multiplyScalar(maxS / sp);
      bd.p.addScaledVector(bd.v, dt);
      bd.flap += dt * (this.flockScare > 0 ? 22 : 10);
      tmpQ.setFromRotationMatrix(tmpL.lookAt(ORIGIN, bd.v, THREE.Object3D.DEFAULT_UP));
      const s = 1 + Math.sin(bd.flap) * 0.5;
      tmpS.set(s, 1, 1);
      tmpM.compose(bd.p, tmpQ, tmpS);
      this.birdMesh.setMatrixAt(i, tmpM);
    }
    tmpS.set(1, 1, 1);
    this.birdMesh.instanceMatrix.needsUpdate = true;
    // steam
    for (const s of this.steam) {
      const pos = s.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      const near = Math.abs(s.anchor.x - player.x) + Math.abs(s.anchor.z - player.z) < 220;
      s.pts.visible = near;
      if (!near) continue;
      for (let i = 0; i < s.ages.length; i++) {
        s.ages[i] += dt;
        if (s.ages[i] > 4) s.ages[i] = 0;
        const a = s.ages[i];
        pos.setXYZ(i, s.anchor.x + s.vel[i * 3] * a * 2 + a * 0.6, s.anchor.y + a * 1.6, s.anchor.z + s.vel[i * 3 + 2] * a * 2);
      }
      pos.needsUpdate = true;
    }
    // fans
    if (this.fans) {
      let k = 0;
      for (const a of this.fanAnchors) for (let j = 0; j < 3; j++) {
        tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t * 9 + j * Math.PI / 3);
        tmpP.set(a.x, a.y, a.z); tmpS.set((a.a ?? 1) * 1.8, 1, 1);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.fans.setMatrixAt(k++, tmpM);
      }
      tmpS.set(1, 1, 1);
      this.fans.instanceMatrix.needsUpdate = true;
    }
    // beacons & screens
    this.beaconMat.emissiveIntensity = Math.sin(t * 2.4) > 0.6 ? 8 : 0.4;
    this.screenT += dt;
    if (this.screenT > 7) {
      this.screenT = 0;
      const m = this.screenMat.map!;
      m.offset.x = (m.offset.x + 0.25) % 1;
      if (m.offset.x < 0.01) m.offset.y = (m.offset.y + 0.25) % 1;
      if (this.screenMat.emissiveMap) this.screenMat.emissiveMap.offset.copy(m.offset);
    }
  }
}
