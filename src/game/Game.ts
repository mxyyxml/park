import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { createMaterials, MaterialLib, withFog } from '../render/materials';
import { buildWorldMeshes } from '../render/worldMesh';
import { WorldBuilder } from '../world/builder';
import { buildCity, CityInfo } from '../world/city';
import { Dynamic } from '../world/Dynamic';
import { emptyInput, InputFrame, PEvent, PlayerController, PState } from '../player/PlayerController';
import { CameraRig } from '../player/CameraRig';
import { makeBodyMaterials, RunnerBody } from '../player/Body';
import { loadCharacterAssets } from '../player/assets';
import { instanceModel, loadModel, pickParts } from '../render/instanced';
import { buildTerrain } from '../world/Terrain';
import { Input } from '../core/Input';
import { AudioEngine } from '../audio/AudioEngine';
import { buildTrials, TrialDef } from './Trials';
import { Horde, InfectedView } from './Infected';
import { Combo } from './Combo';
import { Weapons, ITEM_NAME, type Item, type ItemKind } from './Weapons';
import { Story, CHAPTERS, VOICE_LOGS, type StoryPlaces, type Vec as SVec, type Ending } from './Story';
import { Rain } from '../world/Rain';
import { Bot } from './Bot';
import { decodeGhost, encodeGhost, ghostCode, GhostPlayback, GhostRecorder, parseGhostCode } from './Ghost';
import { Save, Settings } from './Save';
import { fmt, UI } from '../ui/UI';

const DT = 1 / 120;
/** primary input is a finger (phones/tablets); touchscreen laptops with a mouse keep desktop controls */
function isTouchDevice() { return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches; }
/** WebGL support and whether the GPU looks like integrated or software graphics (school laptops, Chromebooks). */
export function probeGpu(): { ok: boolean; weak: boolean; software: boolean; name: string } {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { ok: false, weak: true, software: false, name: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const software = /swiftshader|llvmpipe|software|basic render/i.test(name);
    return { ok: true, weak: software || /intel|uhd|iris|mali|adreno|powervr|vivante|videocore/i.test(name), software, name };
  } catch { return { ok: false, weak: true, software: false, name: '' }; }
}
/** The browser is drawing 3D on the CPU (graphics acceleration off or the GPU driver blocked): a few frames per second at best. */
function showSoftwareWarning() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:1000;max-width:min(560px,calc(100% - 32px));padding:14px 18px;background:#b3261e;color:#fff;font:14px/1.45 system-ui,sans-serif;border-radius:6px;cursor:pointer;box-shadow:0 4px 16px #0006';
  d.innerHTML = '<b>Your browser is not using the graphics card</b>, so the game will run very slowly.<br>Chrome/Edge: Settings → System → turn on <i>Use graphics acceleration when available</i>, then relaunch. Check at <i>chrome://gpu</i>. On a managed school computer this may be locked by IT.<br><small>Click to dismiss</small>';
  d.onclick = () => d.remove();
  document.body.append(d);
}
function localStorageHasSettings() { try { return !!localStorage.getItem('skyline-runner/v1'); } catch { return false; } }
const CALIB_VERSION = 9;

type Mode = 'loading' | 'attract' | 'free' | 'trial' | 'replay';

export class Game {
  r!: Renderer;
  ui: UI;
  save = new Save();
  input: Input;
  audio = new AudioEngine();
  mats!: MaterialLib;
  builder!: WorldBuilder;
  city!: CityInfo;
  trials: TrialDef[] = [];
  player!: PlayerController;
  rig = new CameraRig();
  body!: RunnerBody;
  ghostBody!: RunnerBody;      // translucent PB ghost while racing
  showBody!: RunnerBody;       // opaque third-person runner (replays, attract)
  dynamic!: Dynamic;
  mode: Mode = 'loading';
  paused = false;
  private acc = 0;
  private last = performance.now();
  private pendingPress: InputFrame | null = null;
  private frameEvents: PEvent[] = [];
  private shardMeshes: { mesh: THREE.Object3D; id: number; base: THREE.Vector3 }[] = [];
  private cpGroup = new THREE.Group();
  private cpBeams: THREE.Mesh[] = [];
  // trial state
  trial: TrialDef | null = null;
  private trialTime = 0;
  private trialRunning = false;
  private countdown = 0;
  private cpIndex = 0;
  private splits: number[] = [];
  private respawnPoint = { x: 0, y: 0, z: 0, yaw: 0 };
  private recorder: GhostRecorder | null = null;
  private lastRun: Float32Array | null = null;
  private raceGhost: GhostPlayback | null = null;
  // replay / attract
  private replay: GhostPlayback | null = null;
  private replayTime = 0;
  private replaySpeed = 1;
  private replayReturn: (() => void) | null = null;
  private camShot = 0; private camShotT = 0;
  private camPos = new THREE.Vector3(); private camLook = new THREE.Vector3();
  private demo: { p: PlayerController; bot: Bot; rec: GhostRecorder } | null = null;
  private demoTrial = 0;
  private deadT = 0;
  // ---- Night Run
  private horde!: Horde;
  private infView!: InfectedView;
  private charAssets: Awaited<ReturnType<typeof loadCharacterAssets>> = null;
  private nightRun = false;
  private hp = 100;
  private sinceHit = 99;
  private kickCD = 0;
  private kills = 0;
  private combo = new Combo();
  private rain!: Rain;
  private weapons!: Weapons;
  private survived = 0;
  private fps = 60; private fpsAcc = 0; private fpsN = 0;
  private debugOn = false;
  private helpT = 0;
  autopilot: Bot | null = null; // test hook: drive the player with the bot
  private feetInterp = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.ui = new UI();
    this.input = new Input(canvas);
  }

  private async yieldUI() { await new Promise((r) => setTimeout(r, 0)); }

  async init() {
    const params = new URLSearchParams(location.search);
    const s = this.save.settings;
    const gpu = probeGpu();
    if (!gpu.ok) throw new Error('WebGL 2 is not available. Turn on hardware acceleration in the browser settings (chrome://settings/system), update the browser, or try Chrome/Edge.');
    if (params.get('q')) { s.quality = params.get('q') as Settings['quality']; s.autoQuality = false; }
    else if (!localStorageHasSettings() && (isTouchDevice() || gpu.weak)) s.quality = 'low';
    if (gpu.software) showSoftwareWarning();
    this.ui.setLoading(0.05, 'Initialising renderer');
    await this.yieldUI();
    this.r = new Renderer(this.canvas, s.quality);
    this.ui.setLoading(0.12, 'Generating materials');
    await this.yieldUI();
    this.mats = await createMaterials();
    this.ui.setLoading(0.35, 'Building the district');
    await this.yieldUI();
    const aircon = await loadModel('./assets/models/aircon.json');
    this.builder = new WorldBuilder(true);
    this.builder.aircon = !!aircon;
    this.city = buildCity(this.builder);
    this.ui.setLoading(0.55, 'Assembling geometry');
    await this.yieldUI();
    const wm = buildWorldMeshes(this.builder, this.mats);
    this.r.scene.add(wm.group);
    if (aircon) this.r.scene.add(instanceModel(aircon, this.builder.anchors.filter((a) => a.type === 'aircon'), 1.02));
    // sourced props (Poly Haven, decimated for the game): one instanced draw per part
    const props: [string, number, ((n: string) => boolean) | null][] = [
      ['barrel', 0.9, null], ['plant', 0.75, null], ['barrier', 0.82, null],
      ['hydrant', 0.78, (n) => !n.includes('aged')],
      ['trashcan', 0.9, (n) => !n.includes('rust') && !n.includes('lid')],
    ];
    await Promise.all(props.map(async ([name, height, keep]) => {
      const m = await loadModel(`./assets/models/${name}.json`);
      const anchors = this.builder.anchors.filter((a) => a.type === name);
      if (m && anchors.length) this.r.scene.add(instanceModel(keep ? pickParts(m, keep) : m, anchors, height));
    }));
    // landscape and sea around the city, and the photographic sky
    this.r.scene.add(buildTerrain(this.mats.terrain));
    try {
      const [skyTex, skyMeta] = await Promise.all([
        new THREE.TextureLoader().loadAsync('./assets/sky/sky.jpg'),
        new THREE.FileLoader().loadAsync('./assets/sky/sky.json').then((t) => JSON.parse(t as string)),
      ]);
      this.r.setPhotoSky(skyTex, skyMeta.sun, skyMeta.horizon);
    } catch (e) { console.warn('photo sky unavailable, keeping the procedural sky', e); }
    (window as any).__stats = { draws: wm.drawCalls, tris: wm.triangles, colliders: this.builder.world.boxes.length };
    for (const l of this.builder.lights) {
      const pl = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
      pl.position.set(l.x, l.y, l.z);
      this.r.scene.add(pl);
    }
    this.ui.setLoading(0.65, 'Lighting the skyline');
    await this.yieldUI();
    this.r.buildEnvironment(new THREE.Vector3(0, 70, 0));

    // player & bodies
    this.player = new PlayerController(this.builder.world);
    this.player.ziplines = this.builder.ziplines;
    const charAssets = await loadCharacterAssets();
    this.charAssets = charAssets;
    this.body = new RunnerBody(makeBodyMaterials(this.mats.fabric), true, charAssets);
    this.r.scene.add(this.body.root, this.body.armRoot);
    this.ghostBody = new RunnerBody(makeBodyMaterials(null, true), false, charAssets);
    this.ghostBody.setVisible(false);
    this.r.scene.add(this.ghostBody.root, this.ghostBody.armRoot);
    this.showBody = new RunnerBody(makeBodyMaterials(this.mats.fabric), false, charAssets);
    this.showBody.setVisible(false);
    this.r.scene.add(this.showBody.root, this.showBody.armRoot);

    this.ui.setLoading(0.72, 'Waking the city');
    await this.yieldUI();
    this.dynamic = new Dynamic(this.city, this.builder.anchors, this.mats.get('lampRed'), this.mats.screen, this.audio);
    this.r.scene.add(this.dynamic.group);
    this.buildShards();
    this.r.scene.add(this.cpGroup);

    // trials + medal calibration with the autopilot (cached)
    this.ui.setLoading(0.8, 'Calibrating time trials');
    await this.yieldUI();
    // routes are checked by the autopilot once, then cached with their medal times (see buildTrials)
    this.trials = buildTrials(this.city, this.builder.world, this.builder.ziplines, this.save.data.calib, String(CALIB_VERSION));
    this.save.flush();

    this.buildRope();
    this.rain = new Rain();
    this.r.scene.add(this.rain.mesh);
    this.horde = new Horde(this.builder.world);
    this.weapons = new Weapons(this.r.scene, this.r.camera, this.builder.world);
    this.infView = new InfectedView(64, this.charAssets);
    this.infView.group.visible = false;
    this.r.scene.add(this.infView.group);
    // every lit material joins the cascaded shadow rig (after all scene content exists)
    this.r.registerSceneMaterials();
    this.applySettings();
    this.input.onPausePressed = () => this.onPauseKey();
    this.input.onRestartPressed = () => { if (this.mode === 'trial' && !this.paused) this.startTrial(this.trial!, true); };
    window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.debugOn = !this.debugOn; this.ui.debug.classList.toggle('hidden', !this.debugOn); } });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && !this.input.fallbackLook && (this.mode === 'free' || this.mode === 'trial') && !this.paused && !this.ui.menuOpen) this.pause();
    });
    this.canvas.addEventListener('click', () => {
      this.audio.init();
      if ((this.mode === 'free' || this.mode === 'trial') && !this.paused) this.input.lock(true);
    });
    this.ui.prompt.addEventListener('click', () => { this.input.lock(true); });
    // touch devices: on-screen controls, and no pointer lock needed
    const touchDevice = isTouchDevice();
    if (touchDevice) {
      const tl = this.ui.touchLayer;
      this.input.enableTouch(tl, tl.querySelector('.up') as HTMLElement, tl.querySelector('.down') as HTMLElement);
      this.input.fallbackLook = true;
      this.input.onTouchStick = (x, y, ox, oy, on) => this.ui.showStick(x, y, ox, oy, on);
      (tl.querySelector('.pause') as HTMLElement).addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); this.onPauseKey(); }, { passive: false });
      tl.addEventListener('touchstart', () => this.audio.init(), { once: true });
    }
    window.addEventListener('resize', () => this.r.resize());

    this.ui.setLoading(1, 'Ready');
    this.ui.hideLoading();
    (window as any).__game = this;

    const auto = params.get('autostart');
    if (auto === 'free') this.startFree();
    else if (auto && auto.startsWith('trial:')) { const t = this.trials.find((x) => x.id === auto.slice(6)); if (t) this.startTrial(t, false); }
    else this.toMenu();
    if (params.get('bot') && (this.mode === 'free' || this.mode === 'trial')) {
      const t = this.trial ?? this.trials.find((x) => x.id === params.get('bot')) ?? this.trials[1];
      if (this.mode === 'free') this.player.spawn(t.start.x, t.start.y, t.start.z, t.start.yaw);
      this.autopilot = new Bot(this.builder.world, t.wps);
      // test hook: fast-forward the autopilot run without rendering
      const ff = Number(params.get('ff') || 0);
      for (let i = 0; i < ff * 120; i++) { this.player.update(DT, this.autopilot.step(this.player, DT)); if (this.mode === 'trial' && this.countdown <= 0) this.trialTime += DT; }
      this.countdown = Math.min(this.countdown, ff > 0 ? 0 : this.countdown);
      if (ff > 0 && this.mode === 'trial') this.trialRunning = true;
      this.rig.eye.x = this.player.height - 0.12;
    }
    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------------------------------
  applySettings() {
    const s = this.save.settings;
    this.input.sensitivity = 0.0022 * s.sensitivity;
    this.input.invertY = s.invertY;
    this.rig.comfort = s.comfort;
    this.rig.baseFov = s.fov;
    this.player.comfortAutoTurn = s.autoTurn;
    this.audio.setVolume(s.volume);
    this.audio.setMusicVolume(s.music);
    if (this.rain) this.applyWeather();
    this.setShadowCasters();
    this.ui.applySettings(s);
    if (this.r.quality !== s.quality) this.r.applyQuality(s.quality);
  }

  private buildShards() {
    const geo = new THREE.OctahedronGeometry(0.28, 0);
    geo.scale(0.7, 1.3, 0.7);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1010, emissiveIntensity: 2.2, roughness: 0.2, metalness: 0.3 });
    const core = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const c of this.city.collectibles) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, mat);
      const k = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), core);
      g.add(m, k);
      g.position.set(c.x, c.y, c.z);
      g.visible = !this.save.data.shards.includes(c.id);
      this.r.scene.add(g);
      this.shardMeshes.push({ mesh: g, id: c.id, base: new THREE.Vector3(c.x, c.y, c.z) });
    }
  }

  private buildCheckpointBeams() {
    this.cpGroup.clear();
    this.cpBeams = [];
    if (!this.trial) return;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1, 0.08, 0.08) }, uTime: { value: 0 }, uActive: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uActive; varying vec2 vUv;
        void main(){ float a = (1.0 - vUv.y) * 0.55 * uActive; a *= 0.7 + 0.3 * sin(uTime * 4.0 - vUv.y * 10.0);
          float edge = pow(abs(sin(vUv.x * 3.14159 * 6.0)), 6.0) * 0.25; gl_FragColor = vec4(uColor * (a + edge * a), a); }`,
    });
    for (let i = 0; i < this.trial.checkpoints.length; i++) {
      const c = this.trial.checkpoints[i];
      const m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, 7, 32, 1, true), mat.clone());
      m.position.set(c.x, c.y + 3.5, c.z);
      if (i === this.trial.checkpoints.length - 1) (m.material as THREE.ShaderMaterial).uniforms.uColor.value = new THREE.Color(1, 1, 1);
      this.cpGroup.add(m);
      this.cpBeams.push(m);
    }
  }

  // ---------------------------------------------------------------------------------- flow
  toMenu() {
    this.endStoryState();
    this.mode = 'attract';
    this.paused = false;
    this.setNightRun(false);
    this.trial = null; this.cpGroup.clear();
    this.input.unlock();
    this.input.enabled = false;
    this.ui.showHud(false);
    this.body.setVisible(false);
    this.ghostBody.setVisible(false);
    this.startDemo();
    const n = this.save.data.shards.length;
    this.ui.mainMenu({
      onFree: () => { this.audio.init(); this.startFree(); },
      onNight: () => { this.audio.init(); this.startNight(); },
      onStory: () => this.ui.storyMenu(this.save.data.storyChapter ?? 0, CHAPTERS, {
        onPlay: (ch) => { this.audio.init(); this.startStory(ch); },
        onBack: () => this.toMenu(),
      }),
      onChallenges: () => this.ui.challengesMenu(this.save.data.best, {
        onRush: () => { this.audio.init(); this.startChallenge('rush'); },
        onLava: () => { this.audio.init(); this.startChallenge('lava'); },
        onBack: () => this.toMenu(),
      }),
      onTrials: () => this.showTrials(),
      onSettings: () => this.ui.settingsMenu(this.save.settings, () => { this.applySettings(); this.save.flush(); }, () => this.toMenu()),
      onControls: () => this.ui.controlsMenu(() => this.toMenu()),
      shards: `${n} / ${this.city.collectibles.length}`,
    });
  }

  showTrials() {
    this.ui.trialsMenu(this.trials, this.save, {
      onRun: (t) => { this.audio.init(); this.startTrial(t, false); },
      onReplay: (t) => { const g = this.save.trial(t.id).ghost; if (g) this.startReplay(decodeGhost(g), () => this.showTrials(), t); },
      onShare: (t) => {
        const code = ghostCode(t.id, this.save.trial(t.id).ghost!);
        const fallback = () => window.prompt('Copy this ghost code and send it to a friend:', code);
        if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => window.alert(`Ghost code for ${t.name} copied. Send it to a friend; they paste it under "Race a friend's ghost".`), fallback);
        else fallback();
      },
      onRaceCode: () => {
        const text = window.prompt("Paste a friend's ghost code:");
        if (!text) return;
        const r = parseGhostCode(text, this.trials.map((x) => x.id));
        if ('error' in r) { window.alert(r.error); return; }
        this.audio.init();
        this.startTrial(this.trials.find((x) => x.id === r.trialId)!, false, r.data);
        this.ui.toast("Friend's ghost", 'race the red runner', true, 2.5);
      },
      onBack: () => this.toMenu(),
    });
  }

  private enterPlay() {
    this.ui.touchLayer.classList.toggle('hidden', !this.input.touch.active);
    this.demo = null;
    this.showBody.setVisible(false);
    this.ui.closeMenu();
    this.ui.showHud(true);
    this.input.enabled = true;
    this.paused = false;
    this.ui.prompt.classList.add('hidden');
    this.input.lock();
    this.body.setVisible(true);
    this.rig.eye.x = 1.68;
    this.ui.setShards(this.save.data.shards.length, this.city.collectibles.length);
  }

  // ---- grappling hook: rope (thin segments that sag when slack), claw, attach flash
  private ropeSegs!: THREE.InstancedMesh;
  private hookMesh!: THREE.Group;
  private flash!: THREE.Mesh; private flashT = 0;
  private static ROPE_N = 16;
  private buildRope() {
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });
    const seg = new THREE.CylinderGeometry(0.013, 0.013, 1, 5); seg.translate(0, 0.5, 0);
    this.ropeSegs = new THREE.InstancedMesh(seg, ropeMat, Game.ROPE_N);
    this.ropeSegs.frustumCulled = false; this.ropeSegs.visible = false;
    this.hookMesh = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 6), steel);
    for (let k = 0; k < 3; k++) { const prong = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.12, 4), steel); prong.position.set(Math.cos(k * 2.1) * 0.04, 0.06, Math.sin(k * 2.1) * 0.04); prong.rotation.z = Math.cos(k * 2.1) * 0.9; prong.rotation.x = -Math.sin(k * 2.1) * 0.9; this.hookMesh.add(prong); }
    this.hookMesh.add(shaft); this.hookMesh.visible = false;
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    this.flash.visible = false;
    this.r.scene.add(this.ropeSegs, this.hookMesh, this.flash);
  }
  private ropeTmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), a: new THREE.Vector3(), b: new THREE.Vector3(), d: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  /** rain setting: visuals, wet shading, sound and slide grip (menus stay dry) */
  private applyWeather() {
    const on = this.save.settings.rain && this.mode !== 'attract';
    this.rain.mesh.visible = on;
    this.r.setRain(on);
    this.audio.setRain(on);
    this.player.wet = on ? 1 : 0;
  }
  /** aim, fire / release on press, and draw rope + hook from the real hand */
  private updateGrapple(f: { grapplePressed: boolean }) {
    const p = this.player, cam = this.r.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const target = p.grappleTarget(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z);
    this.ui.reticle.classList.toggle('grapple', !!target); // red ring: something to grapple in range
    if (f.grapplePressed) {
      if (target) { p.fireHook(target); this.audio.playUi('whoosh', 0.5); }
      else if (p.state === PState.Grapple) p.releaseGrapple(0, 0.1); // tap again: let go, keep your speed
    }
    for (const e of this.frameEvents) if (e.type === 'grappleStart' && p.grapple) { this.flash.position.set(p.grapple.x, p.grapple.y, p.grapple.z); this.flashT = 0.25; this.audio.playFx('kick', 0.25); }
    this.flashT = Math.max(0, this.flashT - 1 / 60);
    this.flash.visible = this.flashT > 0;
    if (this.flash.visible) { (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashT / 0.25; this.flash.scale.setScalar(1 + (0.25 - this.flashT) * 6); }
    // rope: from the right hand to the hook (in flight) or the anchor
    const end = p.hook ? p.hook : p.state === PState.Grapple ? p.grapple : null;
    this.ropeSegs.visible = this.hookMesh.visible = !!end;
    if (!end) return;
    const T = this.ropeTmp;
    const hand = T.a.copy(this.body.rightHandView).applyMatrix4(cam.matrixWorld);
    const tip = T.b.set(end.x, end.y, end.z);
    const len = hand.distanceTo(tip);
    // sag: a slack rope (hook still flying, or anchor closer than the rope length) droops
    const slack = p.hook ? Math.min(1.2, len * 0.04) : Math.max(0, Math.min(2, (p.ropeLen - len) * 0.5));
    const N = Game.ROPE_N;
    let prev = T.d.copy(hand);
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      const pt = T.s.copy(hand).lerp(tip, u); pt.y -= Math.sin(u * Math.PI) * slack;
      const dir = pt.clone().sub(prev), l = dir.length();
      T.q.setFromUnitVectors(T.up, dir.divideScalar(l || 1));
      T.m.compose(prev, T.q, new THREE.Vector3(1, l, 1));
      this.ropeSegs.setMatrixAt(i - 1, T.m);
      prev = prev.copy(pt);
    }
    this.ropeSegs.instanceMatrix.needsUpdate = true;
    this.hookMesh.position.copy(tip);
    this.hookMesh.quaternion.setFromUnitVectors(T.up, T.d.copy(tip).sub(hand).normalize());
  }


  // ---- story
  private story: Story | null = null;
  private storyObj: { text: string; target: SVec | null } = { text: '', target: null };
  private pickups: THREE.Object3D[] = [];
  private storyPlaces(): StoryPlaces {
    const stash = this.trials[0].checkpoints.at(-1)!;
    const shards = [...this.city.collectibles].sort((a, b) => Math.hypot(a.x - stash.x, a.z - stash.z) - Math.hypot(b.x - stash.x, b.z - stash.z)).slice(0, 3);
    const spireTop = this.city.spireRoute.at(-1)!;
    // the supply cache: the trial checkpoint closest to halfway between the stash and the Spire
    const mid = { x: (stash.x + spireTop.x) / 2, z: (stash.z + spireTop.z) / 2 };
    const cps = this.trials.flatMap((t) => t.checkpoints).filter((c) => c.y < 40);
    const supplies = cps.sort((a, b) => Math.hypot(a.x - mid.x, a.z - mid.z) - Math.hypot(b.x - mid.x, b.z - mid.z))[0];
    const race = this.trials.find((t) => t.id === 'crosstown') ?? this.trials[1];
    return { stash, shards, supplies, spireTop, raceFinish: race.checkpoints.at(-1)! };
  }
  // ---- Vesper: a rival runner driven by the autopilot along a trial route, drawn with the full body
  private rival: { p: PlayerController; bot: Bot; acc: number } | null = null;
  private startRival(mode: 'chase' | 'race' | null) {
    this.rival = null;
    this.showBody.setVisible(false);
    if (!mode) return;
    const route = (mode === 'chase' ? this.trials.find((t) => t.id === 'spire') : this.trials.find((t) => t.id === 'crosstown')) ?? this.trials[0];
    const rp = new PlayerController(this.builder.world);
    rp.ziplines = this.builder.ziplines;
    rp.spawn(route.start.x, route.start.y, route.start.z, route.start.yaw);
    const bot = new Bot(this.builder.world, route.wps);
    if (mode === 'chase') for (let i = 0; i < 120 * 1.6; i++) rp.update(DT, bot.step(rp, DT)); // a head start
    // you start at the line: behind Vesper for the chase, beside her for the race
    const st = route.start, side = mode === 'race' ? 1.6 : 0;
    this.player.spawn(st.x + Math.cos(st.yaw) * side, st.y, st.z - Math.sin(st.yaw) * side, st.yaw);
    this.rival = { p: rp, bot, acc: 0 };
    this.showBody.setVisible(true);
  }
  private updateRival(dt: number) {
    const R = this.rival;
    if (!R) return null;
    R.acc += dt;
    while (R.acc >= DT) { R.p.update(DT, R.bot.step(R.p, DT)); R.acc -= DT; }
    if (R.p.state === PState.Dead) { const l = R.p.lastSafe; R.p.spawn(l.x, l.y, l.z, l.yaw); }
    this.driveShowBody(dt, R.p);
    return { x: R.p.pos.x, y: R.p.pos.y, z: R.p.pos.z, finished: R.bot.done };
  }
  startStory(chapter: number) {
    this.startFree();
    this.weapons.reset();
    // resuming a later chapter: you already found what came before
    if (chapter >= 1) this.weapons.give('katana');
    if (chapter >= 5) this.weapons.give('flares');
    const P = this.storyPlaces();
    // where each chapter resumes (the chase and race place you at their start line themselves)
    const spawnAt = [this.city.spawn, P.stash, P.stash, P.stash, P.raceFinish, P.spireTop][chapter];
    this.player.spawn(spawnAt.x, spawnAt.y, spawnAt.z, 'yaw' in spawnAt ? (spawnAt as { yaw: number }).yaw : 0);
    const spire = this.city.buildings[this.city.special.spire];
    this.story = new Story(P, {
      say: (lines) => this.ui.radio(lines),
      objective: (text, target, timer) => { this.storyObj = { text, target }; this.ui.setCheckpoints(0, 0, `${CHAPTERS[this.story?.chapter ?? chapter].toUpperCase()}<br>${text}`); this.ui.setTimer(timer ?? null); },
      rival: (mode) => this.startRival(mode),
      fail: (why) => {
        if (this.storyFailT > 0) return;
        this.storyFailT = 2.2;
        this.ui.toast(why, 'retrying the chapter', true, 2.2);
        this.ui.setFade(0.6, true);
      },
      choose: (prompt, options) => {
        this.paused = true; this.input.unlock();
        this.ui.storyChoice(prompt, options, (i) => { this.paused = false; this.ui.closeMenu(); this.input.lock(); this.story?.choose(i); });
      },
      // story items appear on the ground at your feet: free slots fill by themselves, a full inventory asks to swap
      give: (item) => this.dropItem({ kind: item, count: item === 'flares' ? 3 : 1 }, this.player.pos, item === 'flares' ? 0.9 : item === 'pipe' ? -0.9 : 0),
      night: (on) => {
        if (on === this.nightRun) return;
        this.setNightRun(on);
        if (on) { this.horde.populate(this.city.buildings, this.player.pos); this.hp = 100; }
      },
      spawnClimber: () => {
        // over a random edge of the Spire's top, toward the middle
        const cx = (spire.minX + spire.maxX) / 2, cz = (spire.minZ + spire.maxZ) / 2, a = Math.random() * Math.PI * 2;
        const hx = (spire.maxX - spire.minX) / 2, hz = (spire.maxZ - spire.minZ) / 2, k = Math.min(hx / Math.abs(Math.cos(a) || 1e-3), hz / Math.abs(Math.sin(a) || 1e-3));
        const ex = cx + Math.cos(a) * k * 0.98, ez = cz + Math.sin(a) * k * 0.98, top = this.builder.world.groundHeight(ex - Math.cos(a), ez - Math.sin(a), spire.h + 20, 30);
        this.horde.addClimber(ex, top ? top.y : spire.h, ez, -Math.cos(a), -Math.sin(a));
      },
      end: (ending) => this.storyEnd(ending),
    });
    this.save.data.storyChapter = Math.max(this.save.data.storyChapter ?? 0, chapter); this.save.flush();
    this.story.start(chapter);
    this.buildPickups();
  }
  /** glowing caches at the stash and the supply point (shown until picked up) */
  private buildPickups() {
    for (const o of this.pickups) this.disposeItem(o);
    this.pickups = [];
    const P = this.storyPlaces();
    for (const v of [P.stash, P.supplies]) {
      const g = new THREE.Group();
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 }));
      crate.position.y = 0.25;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.06, 0.52), new THREE.MeshStandardMaterial({ color: 0xd4141c, emissive: 0xd4141c, emissiveIntensity: 1.5 }));
      lid.position.y = 0.52;
      g.add(crate, lid); g.position.set(v.x, v.y, v.z);
      this.r.scene.add(g); this.pickups.push(g);
    }
  }
  private updateStory(dt: number, f: { kickPressed: boolean; weapon: number; throwPressed: boolean; kickOnly: boolean; swapPressed: boolean }) {
    const s = this.story!, p = this.player;
    // day chapters: weapons still switch and swing (nothing to hit until night)
    if (!this.nightRun) this.updateWeapons(dt, f);
    const rival = this.updateRival(dt);
    if (this.storyFailT > 0 && (this.storyFailT -= dt) <= 0) { const ch = s.chapter; this.ui.setFade(0); this.startStory(ch); return; } // retry the chapter
    if (this.storyFailT <= 0) s.update(dt, p.pos, p.state !== PState.Dead, rival);
    // caches disappear once taken
    if (this.pickups.length === 2) { this.pickups[0].visible = s.chapter === 0; this.pickups[1].visible = s.chapter === 4 && s.step === 0; }
    for (const o of this.pickups) o.rotation.y += dt;
    const t = this.storyObj.target;
    this.pointMarker(t ? new THREE.Vector3(t.x, t.y + 1.2, t.z) : null);
  }
  private storyFailT = 0;
  private storyEnd(ending: Ending) {
    this.save.data.storyChapter = 0; this.save.data.storyDone = true; this.save.flush();
    setTimeout(() => {
      if (!this.story) return;
      this.paused = true; this.input.unlock(); this.audio.suspend();
      this.ui.storyEnd({ ending, kills: this.kills, onBack: () => { this.audio.resume(); this.toMenu(); } });
    }, 9000);
  }
  private endStoryState() {
    if (!this.story) return;
    this.clearGround();
    this.startRival(null);
    this.storyFailT = 0;
    this.story = null;
    for (const o of this.pickups) this.disposeItem(o);
    this.pickups = [];
    this.ui.radio([]);
    this.ui.setMarker(0, 0, false, false, 0);
  }

  // ---- challenges
  private challenge: 'rush' | 'lava' | null = null;
  private challengeT = 0; private rushCount = 0;
  private lavaPlane: THREE.Mesh | null = null;

  startChallenge(kind: 'rush' | 'lava') {
    this.startFree();
    this.challenge = kind;
    this.challengeT = kind === 'rush' ? 180 : 0;
    this.rushCount = 0;
    if (kind === 'rush') for (const s of this.shardMeshes) s.mesh.visible = true;
    if (kind === 'lava') {
      if (!this.lavaPlane) {
        // glowing street level: a thin emissive sheet just above the asphalt
        this.lavaPlane = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: 0xff4a10, transparent: true, opacity: 0.55, depthWrite: false }));
        this.lavaPlane.position.y = 0.12;
        this.r.scene.add(this.lavaPlane);
      }
      this.lavaPlane.visible = true;
    }
    this.ui.setCheckpoints(0, 0, kind === 'rush' ? 'SHARD RUSH' : 'FLOOR IS LAVA');
    this.ui.toast(kind === 'rush' ? 'Shard Rush' : 'Floor is Lava', kind === 'rush' ? '3:00 · find the red shards' : 'one life · stay off the street', true, 3);
  }
  private endChallenge() {
    const kind = this.challenge!;
    this.combo.bank();
    const score = kind === 'rush' ? this.rushCount : this.combo.score;
    const prev = this.save.data.best[kind] ?? 0;
    if (score > prev) this.save.data.best[kind] = score;
    this.save.flush();
    this.stopChallenge();
    this.paused = true; this.input.unlock(); this.audio.suspend();
    this.ui.challengeResult({
      title: kind === 'rush' ? 'SHARD RUSH' : 'FLOOR IS LAVA',
      score: kind === 'rush' ? `${score} shard${score === 1 ? '' : 's'}` : String(score),
      best: String(Math.max(prev, score)), isBest: score > prev && score > 0,
      onRetry: () => { this.audio.resume(); this.startChallenge(kind); },
      onBack: () => { this.audio.resume(); this.toMenu(); },
    });
  }
  /** back to normal: shards show the saved collection again, no lava */
  private stopChallenge() {
    if (this.challenge === 'rush') for (const s of this.shardMeshes) s.mesh.visible = !this.save.data.shards.includes(s.id);
    if (this.lavaPlane) this.lavaPlane.visible = false;
    this.challenge = null;
  }
  private updateChallenge(dt: number) {
    const p = this.player;
    if (this.challenge === 'rush') {
      this.challengeT -= dt;
      this.ui.setTimer(Math.max(0, this.challengeT));
      this.ui.setCheckpoints(0, 0, `SHARD RUSH<br>${this.rushCount} FOUND`);
      if (this.challengeT <= 0) this.endChallenge();
    } else if (this.challenge === 'lava') {
      if (p.state !== PState.Dead) this.challengeT += dt;
      this.ui.setTimer(this.challengeT);
      if (p.grounded && p.pos.y < 1.2 && p.state !== PState.Dead) p.die('fall');
    }
  }

  /**
   * Shadow casting costs one extra draw per cascade. Only the playable district casts shadows (the far
   * skyline's would be lost in the outer cascade anyway, and it's what made towers slow), and small
   * instanced props (one big draw that can't be culled) cast only on High and Ultra.
   */
  private setShadowCasters() {
    if (!this.city) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of this.city.buildings) { minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX); minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ); }
    const pad = 30, hiQ = this.r.quality === 'high' || this.r.quality === 'ultra';
    this.r.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.shadowFixed) return;
      if (m.userData.castDefault === undefined) m.userData.castDefault = m.castShadow;
      if (!m.userData.castDefault) return;
      if ((m as THREE.InstancedMesh).isInstancedMesh && m.parent?.name !== 'infected') { m.castShadow = hiQ; return; }
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const c = m.geometry.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld);
      m.castShadow = c.x > minX - pad && c.x < maxX + pad && c.z > minZ - pad && c.z < maxZ + pad;
    });
    // district casters get a per-frame distance check in cullDetail
    this.casters = [];
    this.r.scene.getObjectByName('world')?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.castShadow) this.casters.push({ mesh: m, c: m.geometry.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld) });
    });
  }

  /**
   * Small detail (railings, lamps, fittings, foliage, screens, cables...) is invisible past a couple of
   * hundred metres but costs a draw per chunk: hide it beyond 230 m. Building shells, glass, roofs and
   * streets always draw, so the skyline is unchanged. Checked every few frames.
   */
  private detail: { mesh: THREE.Mesh; c: THREE.Vector3 }[] | null = null;
  private casters: { mesh: THREE.Mesh; c: THREE.Vector3 }[] = [];
  private cullT = 0;
  private cullDetail() {
    if ((this.cullT = (this.cullT + 1) % 6) !== 0) return;
    if (!this.detail) {
      const DETAIL = new Set(['metal', 'metalDark', 'metalPainted', 'red', 'wood', 'rubber', 'lamp', 'lampRed', 'lampWarm', 'screen', 'cable', 'stripe', 'foliage', 'foliageDark', 'trunk', 'solar', 'tile', 'water', 'gravel']);
      this.detail = [];
      this.r.scene.getObjectByName('world')?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !DETAIL.has(m.userData.matKey)) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        this.detail!.push({ mesh: m, c: m.geometry.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld) });
      });
    }
    const cam = this.r.camera.position, R2 = 230 * 230, S2 = 260 * 260;
    for (const d of this.detail) d.mesh.visible = (d.c.x - cam.x) ** 2 + (d.c.z - cam.z) ** 2 < R2;
    // shadows only from geometry near you: far shadows are lost in the outer cascade anyway
    for (const d of this.casters) d.mesh.castShadow = (d.c.x - cam.x) ** 2 + (d.c.z - cam.z) ** 2 < S2;
  }

  /** leave Night Run state; lighting follows the Night setting */
  private setNightRun(on: boolean) {
    if (this.challenge) this.stopChallenge();
    this.nightRun = on;
    // Night Run arms you: katana in hand, flares in the other slot; more lie on the roofs (the story keeps what you found)
    if (!this.story) {
      this.weapons.reset();
      this.clearGround();
      if (on) { this.weapons.give('katana'); this.weapons.give('flares'); this.scatterItems(); }
    }
    this.ui.setWeapon(on || this.story ? this.weapons.label : null);
    this.combo = new Combo();
    this.ui.setCombo(this.mode === 'free' ? this.combo : null);
    this.infView.group.visible = on;
    this.ui.setHealth(on ? 100 : null);
    this.r.setNight(on || (this.save.settings.night && this.mode !== 'attract'));
    this.applyWeather();
    this.audio.setMusic(this.mode === 'free' || this.mode === 'trial', on);
  }

  startNight() {
    this.startFree();
    this.setNightRun(true);
    this.hp = 100; this.sinceHit = 99; this.kills = 0; this.survived = 0;
    this.horde.populate(this.city.buildings, this.city.spawn);
    this.ui.setCheckpoints(0, 0, 'NIGHT RUN');
    this.ui.toast('Night Run', 'Stay off the streets. F to kick.', true, 3);
  }

  startFree() {
    this.mode = 'free';
    this.endStoryState();
    this.setNightRun(false);
    this.trial = null; this.cpGroup.clear();
    this.ghostBody.setVisible(false);
    const s = this.city.spawn;
    this.player.spawn(s.x, s.y, s.z, s.yaw);
    this.enterPlay();
    this.ui.setTimer(null);
    this.ui.setCheckpoints(0, 0, 'FREE RUN');
    if (!this.save.data.seenHelp) { this.ui.showHelp(true); this.helpT = 22; this.save.data.seenHelp = true; this.save.flush(); }
    else { this.ui.showHelp(true); this.helpT = 8; }
  }

  /** `friendGhost`: race a pasted ghost instead of your own best (kept for restarts of this trial) */
  private friendGhost: { id: string; data: Float32Array } | null = null;
  startTrial(t: TrialDef, instant: boolean, friendGhost?: Float32Array) {
    this.endStoryState();
    if (friendGhost) this.friendGhost = { id: t.id, data: friendGhost };
    else if (!instant || this.friendGhost?.id !== t.id) this.friendGhost = null;
    this.mode = 'trial';
    this.setNightRun(false);
    this.trial = t;
    this.buildCheckpointBeams();
    this.player.spawn(t.start.x, t.start.y, t.start.z, t.start.yaw);
    this.respawnPoint = { ...t.start };
    this.cpIndex = 0; this.splits = []; this.trialTime = 0; this.trialRunning = false;
    this.countdown = instant ? 1.0 : 3.0;
    this.recorder = new GhostRecorder();
    const pb = this.save.trial(t.id);
    this.raceGhost = this.friendGhost ? new GhostPlayback(this.friendGhost.data) : pb.ghost ? new GhostPlayback(decodeGhost(pb.ghost)) : null;
    this.ghostBody.setVisible(!!this.raceGhost);
    this.enterPlay();
    this.ui.showHelp(false);
    this.ui.setTimer(0);
    this.ui.setCheckpoints(0, t.checkpoints.length, t.name.toUpperCase());
  }

  private finishTrial() {
    const t = this.trial!;
    this.trialRunning = false;
    this.recorder?.record(0, this.player, true);
    this.lastRun = this.recorder ? this.recorder.data() : null;
    const rec = this.save.trial(t.id);
    rec.runs++;
    const isPB = rec.best == null || this.trialTime < rec.best;
    if (isPB) { rec.best = this.trialTime; rec.splits = [...this.splits]; if (this.lastRun) rec.ghost = encodeGhost(this.lastRun); }
    this.save.flush();
    this.audio.playUi('finish', 0.5);
    this.input.unlock();
    this.input.enabled = false;
    const time = this.trialTime;
    setTimeout(() => {
      if (this.mode !== 'trial') return;
      this.paused = true;
      this.ui.results({
        trial: t, time, best: rec.best, isPB, splits: this.splits,
        onRetry: () => this.startTrial(t, true),
        onReplay: () => { if (this.lastRun) this.startReplay(this.lastRun, () => this.showTrials(), t); },
        onBack: () => { this.mode = 'attract'; this.showTrials(); this.startDemo(); this.ui.showHud(false); this.body.setVisible(false); this.ghostBody.setVisible(false); this.cpGroup.clear(); },
      });
    }, 900);
  }

  startReplay(data: Float32Array, onExit: () => void, t?: TrialDef) {
    this.mode = 'replay';
    this.demo = null;
    this.replay = new GhostPlayback(data);
    this.replayTime = 0; this.replaySpeed = 1;
    this.replayReturn = onExit;
    this.trial = t ?? null;
    if (t) this.buildCheckpointBeams();
    this.input.unlock();
    this.input.enabled = false;
    this.paused = false;
    this.ui.closeMenu();
    this.ui.showHud(true);
    this.ui.showHelp(false);
    this.ui.setCheckpoints(0, 0, 'REPLAY  ·  [1] 0.25×  [2] 1×  [3] 2×  ·  ESC exit');
    this.body.setVisible(false);
    this.ghostBody.setVisible(false);
    this.showBody.setVisible(true);
    this.camShotT = 0;
    const onKey = (e: KeyboardEvent) => {
      if (this.mode !== 'replay') { window.removeEventListener('keydown', onKey); return; }
      if (e.code === 'Digit1') this.replaySpeed = 0.25;
      if (e.code === 'Digit2') this.replaySpeed = 1;
      if (e.code === 'Digit3') this.replaySpeed = 2;
    };
    window.addEventListener('keydown', onKey);
  }

  private exitReplay() {
    this.showBody.setVisible(false);
    this.replay = null;
    this.mode = 'attract';
    this.ui.showHud(false);
    this.cpGroup.clear();
    this.startDemo();
    (this.replayReturn ?? (() => this.toMenu()))();
  }

  private startDemo() {
    const t = this.trials[this.demoTrial % this.trials.length];
    if (!t) return;
    const p = new PlayerController(this.builder.world);
    p.ziplines = this.builder.ziplines;
    p.spawn(t.start.x, t.start.y, t.start.z, t.start.yaw);
    this.demo = { p, bot: new Bot(this.builder.world, t.wps), rec: new GhostRecorder() };
    this.showBody.setVisible(true);
    this.camShotT = 0;
  }

  private onPauseKey() {
    if (this.mode === 'replay') { this.exitReplay(); return; }
    if (this.mode !== 'free' && this.mode !== 'trial') return;
    if (this.paused) { if (!this.ui.menuOpen || this.ui.menu.querySelector('h1')?.textContent === 'PAUSED') this.resume(); }
    else this.pause();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.input.unlock();
    this.audio.suspend();
    const back = () => this.pauseMenu();
    this.pauseMenu = () => this.ui.pauseMenu({
      inTrial: this.mode === 'trial',
      onResume: () => this.resume(),
      onRestart: () => { this.audio.resume(); if (this.trial) this.startTrial(this.trial, true); },
      onRespawn: () => { this.audio.resume(); this.respawn(); this.resume(); },
      onSettings: () => this.ui.settingsMenu(this.save.settings, () => { this.applySettings(); this.save.flush(); }, back),
      onControls: () => this.ui.controlsMenu(back),
      onQuit: () => { this.audio.resume(); this.toMenu(); },
    });
    this.pauseMenu();
  }
  private pauseMenu = () => {};

  resume() {
    this.paused = false;
    this.ui.closeMenu();
    this.audio.resume();
    this.input.lock();
    this.last = performance.now();
  }

  private respawn() {
    const p = this.player;
    if (this.nightRun) { this.hp = 100; this.sinceHit = 99; }
    if (this.mode === 'trial') { const r = this.respawnPoint; p.spawn(r.x, r.y, r.z, r.yaw); }
    else { const s = p.lastSafe; p.spawn(s.x, s.y, s.z, s.yaw); }
    if (this.nightRun) this.horde.clearAround(p.pos.x, p.pos.z, 10);
    this.ui.setFade(0);
  }

  /** Step the quality preset down while play stays under 24 fps for 4 s (until the player picks one). */
  private slowT = 0;
  private autoQualityCheck(dt: number) {
    const s = this.save.settings;
    if (!s.autoQuality || this.paused || (this.mode !== 'free' && this.mode !== 'trial')) { this.slowT = 0; return; }
    this.slowT = this.fps < 24 ? this.slowT + dt : 0;
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    const i = order.indexOf(s.quality);
    if (this.slowT < 4 || i <= 0) return;
    this.slowT = 0;
    s.quality = order[i - 1];
    this.applySettings(); this.save.flush();
    this.ui.toast(`Quality lowered to ${s.quality.toUpperCase()}`, 'to keep the game smooth (change in Settings)');
  }

  // ---------------------------------------------------------------------------------- loop
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    this.fpsAcc += Math.min(dt, 2); this.fpsN++;  // measure real frame time, before the physics clamp
    if (dt > 0.1) dt = 0.1;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; this.autoQualityCheck(0.5); }
    (window as any).__frames = ((window as any).__frames || 0) + 1;
    this.ui.tick(dt);

    // slow motion eases in and out; the world and the runner run on scaled time, the screen does not
    if (this.slowMoT > 0 && !this.paused) this.slowMoT -= dt;
    const slowTarget = this.slowMoT > 0 && (this.mode === 'free' || this.mode === 'trial') ? 1 : 0;
    this.slowAmt += (slowTarget - this.slowAmt) * Math.min(1, dt * (slowTarget ? 12 : 5));
    const gdt = dt * (1 - this.slowAmt * (1 - this.slowScale));
    if (this.mode === 'attract') this.updateAttract(dt);
    else if (this.mode === 'replay') this.updateReplay(dt);
    else if (this.mode === 'free' || this.mode === 'trial') this.updatePlay(gdt);

    this.dynamic.update(gdt, this.r.camera.position);
    this.rain.update(gdt, this.r.camera.position);
    this.animateShards(dt);
    for (const b of this.cpBeams) (b.material as THREE.ShaderMaterial).uniforms.uTime.value += dt;
    this.cullDetail();
    this.r.updateSun(this.r.camera.position);
    const speed = this.mode === 'free' || this.mode === 'trial' ? this.player.hSpeed : 0;
    this.r.render(dt, Math.max(0, (speed - 6) / 4) * this.save.settings.comfort, this.slowAmt);
    if (this.debugOn) this.updateDebug();
  };

  private updatePlay(dt: number) {
    const p = this.player;
    if (this.paused) { this.ui.prompt.classList.add('hidden'); return; }
    this.ui.prompt.classList.toggle('hidden', this.input.active || this.input.enabled === false);
    // input
    let f = this.input.sample(dt);
    if (this.autopilot) f = this.autopilot.step(p, dt);
    if (this.pendingPress) {
      f.jumpPressed ||= this.pendingPress.jumpPressed; f.crouchPressed ||= this.pendingPress.crouchPressed; f.quickTurn ||= this.pendingPress.quickTurn; f.kickPressed ||= this.pendingPress.kickPressed; f.grapplePressed ||= this.pendingPress.grapplePressed; f.throwPressed ||= this.pendingPress.throwPressed; f.weapon ||= this.pendingPress.weapon; f.kickOnly ||= this.pendingPress.kickOnly; f.swapPressed ||= this.pendingPress.swapPressed;
      f.lookX += this.pendingPress.lookX; f.lookY += this.pendingPress.lookY;
      this.pendingPress = null;
    }
    // trial countdown freezes movement (look allowed)
    if (this.mode === 'trial' && this.countdown > 0) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      this.ui.countdown(this.countdown > 0 ? String(n) : '');
      if (this.countdown <= 0) { this.trialRunning = true; this.ui.countdown('GO'); setTimeout(() => this.ui.countdown(''), 500); this.audio.playUi('chime', 0.35); }
      const frozen = emptyInput(); frozen.lookX = f.lookX; frozen.lookY = f.lookY; f = frozen;
    }
    this.updateGrapple(f);
    // fixed-step simulation
    this.acc += dt;
    let ticks = 0;
    this.frameEvents.length = 0;
    while (this.acc >= DT && ticks < 10) {
      const inp = ticks === 0 ? f : { ...f, jumpPressed: false, crouchPressed: false, quickTurn: false, kickPressed: false, grapplePressed: false, throwPressed: false, weapon: 0, kickOnly: false, swapPressed: false, lookX: 0, lookY: 0 };
      p.update(DT, inp);
      for (const e of p.events) this.frameEvents.push(e);
      if (this.trialRunning) { this.trialTime += DT; this.recorder?.record(DT, p); }
      this.acc -= DT; ticks++;
      if (this.mode === 'trial' && this.trialRunning) this.checkCheckpoints();
      if (!this.trialRunning && this.mode === 'trial' && this.countdown <= 0) break;
    }
    if (ticks === 0) this.pendingPress = f;
    const alpha = this.acc / DT;
    // events → camera, audio, game
    this.rig.onEvents(this.frameEvents);
    this.audio.onEvents(this.frameEvents);
    if (this.mode === 'free') {
      this.combo.feed(this.frameEvents);
      this.combo.update(dt, p.hSpeed);
      this.ui.setCombo(this.combo);
    }
    for (const e of this.frameEvents) if (e.type === 'jump' && e.speed > 7.5) {
      // launching fast over a big drop: a moment of slow motion over the gap
      const k = 0.7, gx = p.pos.x + p.vel.x * k, gz = p.pos.z + p.vel.z * k;
      const below = this.builder.world.groundHeight(gx, gz, p.pos.y + 0.5, 40);
      if (!below || p.pos.y - below.y > 7) this.slowMo(0.4, 0.55);
    }
    for (const e of this.frameEvents) if (e.type === 'death') { this.deadT = 1.9; this.ui.setFade(0.45, true); }
    if (p.state === PState.Dead) {
      this.deadT -= dt;
      if (this.deadT < 0.75) this.ui.setFade(1); // black out after the collapse
      if (this.deadT <= 0 && this.challenge === 'lava') { this.deadT = 99; this.endChallenge(); }
      else if (this.deadT <= 0) { this.respawn(); this.ui.toast(this.mode === 'trial' ? 'Checkpoint' : 'Respawned', '', false, 1.0); }
    }
    if (this.nightRun) this.updateNightRun(dt, f);
    if (this.challenge) this.updateChallenge(dt);
    if (this.story) this.updateStory(dt, f);
    // camera & body
    this.rig.update(dt, p, alpha);
    this.rig.apply(this.r.camera);
    this.r.camera.updateMatrixWorld();
    this.feetInterp.set(this.rig.pos.x, this.rig.pos.y, this.rig.pos.z);
    // holding a weapon: its animation drives the arms; it goes away for climbs, hangs and other hand-on moves
    const armed = (this.nightRun || !!this.story) && !!this.weapons.held;
    const holdOk = armed && (p.state === PState.Ground || p.state === PState.Air || p.state === PState.Slide);
    this.body.held = holdOk ? this.weapons.handTargets() : null;
    // grappling: the right arm reaches along the rope toward the hook / anchor
    const gEnd = p.hook ?? (p.state === PState.Grapple ? p.grapple : null);
    if (gEnd) {
      const inv = this.r.camera.matrixWorldInverse;
      const dirV = new THREE.Vector3(gEnd.x, gEnd.y, gEnd.z).applyMatrix4(inv).normalize();
      const right = new THREE.Vector3(0.19, -0.25, 0.13).addScaledVector(dirV, 0.5);
      this.body.held = { right, left: p.hook ? null : right.clone().add(new THREE.Vector3(-0.1, -0.12, 0.08)), blade: dirV, stiff: 45 };
    }
    this.body.update(dt, p, this.r.camera.matrixWorld, this.rig.eyePos, this.feetInterp);
    this.weapons.attach(this.body.rightHandView, holdOk && !gEnd);
    // PB ghost
    if (this.raceGhost && this.mode === 'trial') {
      this.raceGhost.seek(this.trialTime);
      const g = this.raceGhost;
      const eye = new THREE.Vector3(g.pos.x, g.pos.y + Math.max(0.8, g.height - 0.12), g.pos.z);
      const view = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(g.pitch, g.yaw, 0, 'YXZ')).setPosition(eye);
      const near = eye.distanceTo(this.rig.eyePos) < 1.2;
      this.ghostBody.setVisible(!near && this.trialTime < g.duration + 0.5);
      if (!near) this.ghostBody.update(dt, g, view, eye, new THREE.Vector3(g.pos.x, g.pos.y, g.pos.z));
    }
    // audio listener & continuous
    const cam = this.r.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z);
    this.audio.update(dt, p.state === PState.Zip ? p.zipSpeed : Math.hypot(p.vel.x, p.vel.y * 0.6, p.vel.z), p.pos.y, p.state === PState.Slide, p.state === PState.Zip, p.grounded);
    // shards
    for (const s of this.shardMeshes) {
      if (!s.mesh.visible) continue;
      if (s.base.distanceToSquared(new THREE.Vector3(p.pos.x, p.pos.y + 1, p.pos.z)) < 1.6 * 1.6) {
        s.mesh.visible = false;
        if (!this.save.data.shards.includes(s.id)) this.save.data.shards.push(s.id);
        if (this.challenge === 'rush') this.rushCount++;
        this.save.flush();
        this.audio.playUi('collect', 0.45);
        this.ui.toast('Voice log', `${this.save.data.shards.length} / ${this.city.collectibles.length}`, true);
        this.ui.radio([VOICE_LOGS[s.id % VOICE_LOGS.length]]);
        this.ui.setShards(this.save.data.shards.length, this.city.collectibles.length);
      }
    }
    // HUD
    this.ui.setSpeed(p.hSpeed, p.flow);
    if (this.mode === 'trial') {
      const pb = this.save.trial(this.trial!.id).splits;
      const split = pb && this.cpIndex > 0 && pb[this.cpIndex - 1] != null && this.splitShowT > 0 ? this.splits[this.cpIndex - 1] - pb[this.cpIndex - 1] : null;
      this.splitShowT -= dt;
      this.ui.setTimer(this.trialTime, split);
      this.updateMarker();
    } else if (!this.story) this.ui.setMarker(0, 0, false, false, 0); // the story points its own marker
    if (this.helpT > 0) { this.helpT -= dt; if (this.helpT <= 0 || (this.mode === 'free' && p.hSpeed > 1 && this.helpT < 14)) { if (this.helpT <= 0) this.ui.fadeHelp(); } }
  }
  private splitShowT = 0;
  // ---- slow motion
  private slowMoT = 0; private slowAmt = 0; private slowScale = 0.35;
  /** slow time to `scale` for `secs` of real time (big jumps, takedowns) */
  private slowMo(scale: number, secs: number) {
    if (!this.save.settings.slowMo || this.mode === 'trial') return; // never in timed runs
    this.slowScale = scale; this.slowMoT = Math.max(this.slowMoT, secs);
  }

  /**
   * Inventory and held weapon, shared by Night Run and the story: 1/2 select a slot, F uses what's in
   * hand (a swing, or a flare throw), G quick-throws a flare, R swaps with an item on the ground.
   * Returns true when the runner should kick (V, or F with an empty hand).
   */
  private updateWeapons(dt: number, f: { kickPressed: boolean; weapon: number; throwPressed: boolean; kickOnly: boolean; swapPressed: boolean }) {
    const p = this.player, W = this.weapons, alive = p.state !== PState.Dead;
    if (f.weapon) W.select(f.weapon - 1);
    if (f.throwPressed && alive) {
      const fl = W.slots.findIndex((x) => x?.kind === 'flares');
      if (fl < 0) this.ui.toast('No flares', '', true, 0.8); else { W.select(fl); W.use(); }
    }
    let kick = f.kickOnly && alive;
    if (f.kickPressed && alive) { if (W.use()) this.audio.playUi('whoosh', W.held?.kind === 'pipe' ? 0.35 : 0.5); else kick = true; }
    const cam = this.r.camera, look = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const ev = W.update(dt, { speed: p.hSpeed, gait: p.gaitPhase, airborne: !p.grounded, eye: cam.position.clone(), look }, this.nightRun ? this.horde : null);
    if (ev && ev !== 'throw' && this.nightRun) {
      // the strike frame: running, sliding or falling strikes cut deeper and push harder
      const air = !p.grounded || p.state === PState.Slide || p.hSpeed > 7;
      const hits = this.horde.hit(p.pos.x, p.pos.y, p.pos.z, p.yaw, air ? { ...ev, dmg: ev.dmg + 1, push: ev.push * 1.3 } : ev);
      if (hits) { this.audio.playFx('kick', 0.8); this.rig.onEvents([{ type: 'bump', speed: 4 }]); this.combo.add(ev.name === 'Katana' ? 'slash' : 'smash'); this.slowMo(0.3, 0.1); }
    }
    if (ev === 'throw') this.audio.playUi('whoosh', 0.4);
    this.updateGround(f.swapPressed);
    this.ui.setWeapon(W.label);
    return kick;
  }

  // ---- items lying on the ground
  private ground: { item: Item; mesh: THREE.Object3D; pos: THREE.Vector3; armed: boolean }[] = [];
  private dropItem(item: Item, at: { x: number; y: number; z: number }, side = 0) {
    const g = new THREE.Group();
    const col = item.kind === 'flares' ? 0xff3020 : item.kind === 'katana' ? 0xd9dde2 : 0x8a8e94;
    const body = new THREE.Mesh(item.kind === 'flares' ? new THREE.BoxGeometry(0.3, 0.12, 0.18) : new THREE.BoxGeometry(item.kind === 'katana' ? 0.98 : 0.8, 0.04, 0.05),
      new THREE.MeshStandardMaterial({ color: col, metalness: item.kind === 'flares' ? 0 : 0.9, roughness: 0.3, emissive: item.kind === 'flares' ? 0x801008 : 0x000000 }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.52, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd4141c, transparent: true, opacity: 0.8 }));
    ring.position.y = 0.03;
    body.position.y = 0.45;
    g.add(body, ring);
    const pos = new THREE.Vector3(at.x + side, at.y, at.z);
    g.position.copy(pos);
    this.r.scene.add(g);
    // items you drop (or that appear under you) wait until you've stepped away
    this.ground.push({ item, mesh: g, pos, armed: false });
  }
  /** remove a ground item and free its GPU resources */
  private disposeItem(o: THREE.Object3D) {
    this.r.scene.remove(o);
    o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  }
  private clearGround() { for (const g of this.ground) this.disposeItem(g.mesh); this.ground = []; }
  /** Night Run: spare weapons and flare packs on roofs along the trial routes (known reachable spots) */
  private scatterItems() {
    const spots = this.trials.flatMap((t) => t.checkpoints).filter((c) => c.y > 5 && c.y < 40);
    const kinds: ItemKind[] = ['pipe', 'flares', 'katana', 'flares', 'pipe', 'flares', 'katana', 'flares'];
    for (let i = 0; i < kinds.length && i * 3 < spots.length; i++) { const c = spots[(i * 3 + 1) % spots.length]; this.dropItem({ kind: kinds[i], count: kinds[i] === 'flares' ? 2 : 1 }, c); this.ground.at(-1)!.armed = true; }
  }
  private updateGround(swap: boolean) {
    const p = this.player.pos, W = this.weapons;
    let prompt: string | null = null;
    for (const g of [...this.ground]) {
      g.mesh.children[0].rotation.y += 0.02; g.mesh.children[0].position.y = 0.45 + Math.sin(performance.now() / 400 + g.pos.x) * 0.05;
      const near = Math.hypot(p.x - g.pos.x, p.z - g.pos.z) < 1.3 && Math.abs(p.y - g.pos.y) < 1.5;
      if (!near) { if (!g.armed && Math.hypot(p.x - g.pos.x, p.z - g.pos.z) > 1.8) g.armed = true; continue; }
      if (!g.armed) continue;
      const fits = (g.item.kind === 'flares' && W.slots.some((x) => x?.kind === 'flares')) || W.slots.some((x) => !x);
      if (fits || swap) {
        const dropped = W.give(g.item.kind, g.item.count);
        this.disposeItem(g.mesh); this.ground.splice(this.ground.indexOf(g), 1);
        this.audio.playUi('collect', 0.4);
        this.ui.toast(ITEM_NAME[g.item.kind] + (g.item.kind === 'flares' ? ` +${g.item.count}` : ''), g.item.kind === 'flares' ? 'F or G to throw' : 'F to strike', true, 1.4);
        if (dropped) this.dropItem(dropped, g.pos);
        break;
      }
      prompt = `R: swap for ${ITEM_NAME[g.item.kind]}`;
    }
    this.ui.setPrompt(prompt);
  }

  private updateNightRun(dt: number, f: { kickPressed: boolean; weapon: number; throwPressed: boolean; kickOnly: boolean; swapPressed: boolean }) {
    const p = this.player, alive = p.state !== PState.Dead;
    const kickWanted = this.updateWeapons(dt, f);
    const air = !p.grounded || p.state === PState.Slide;
    // kick: a dropkick when running fast, sliding or airborne
    this.kickCD -= dt;
    if (kickWanted && this.kickCD <= 0 && alive) {
      this.kickCD = 0.55;
      const power = (8 + p.hSpeed * 0.6) * (air ? 1.5 : 1);
      const hits = this.horde.kick(p.pos.x, p.pos.y, p.pos.z, p.yaw, power);
      this.rig.onEvents([{ type: 'bump', speed: 4 }]);
      this.audio.playFx('kick', hits ? 0.9 : 0.35);
      this.body.kick();
      if (hits) { this.combo.add(power >= 12 ? 'dropkick' : 'kick'); this.slowMo(0.3, 0.12); }
    }
    this.horde.update(dt, { x: p.pos.x, y: p.pos.y, z: p.pos.z, alive });
    for (const kind of this.horde.deaths) {
      this.kills++;
      if (this.kills % 4 === 0) { const st = this.weapons.slots.find((x) => x?.kind === 'flares'); if (st) { st.count++; this.ui.toast('+1 flare', '', false, 0.8); } }
      this.combo.add(kind === 'mutant' ? 'mutantDown' : kind === 'runner' ? 'runnerDown' : 'takedown');
      if (kind === 'mutant') { this.ui.toast('Mutant down', '', true, 1.2); this.slowMo(0.2, 0.8); }
      else this.slowMo(0.25, 0.4);
    }
    this.horde.deaths.length = 0;
    for (const e of this.horde.events) {
      if (e.type === 'groan') this.audio.playAt('groan', e.x, e.y, e.z, e.kind === 'mutant' ? 1.1 : 0.8, (e.kind === 'runner' ? 1.35 : e.kind === 'mutant' ? 0.6 : 0.9) + Math.random() * 0.2);
      else if (e.type === 'hit' && alive) {
        this.hp -= e.dmg; this.sinceHit = 0;
        const dx = p.pos.x - e.fromX, dz = p.pos.z - e.fromZ, d = Math.hypot(dx, dz) || 1;
        p.vel.x += dx / d * e.knock; p.vel.z += dz / d * e.knock;
        if (e.knock > 8) p.vel.y = Math.max(p.vel.y, 3); // a mutant's blow lifts you off your feet
        this.rig.onEvents([{ type: 'bump', speed: 4 }]);
        this.audio.playFx('hurt', 0.8);
        this.ui.flashHurt();
        if (this.hp <= 0) p.die('infected');
      }
    }
    this.sinceHit += dt;
    if (alive && this.sinceHit > 4) this.hp = Math.min(100, this.hp + 12 * dt);
    if (alive) this.survived += dt;
    this.ui.setHealth(this.hp);
    if (!this.story) {
      this.ui.setTimer(this.survived);
      this.ui.setCheckpoints(0, 0, `NIGHT RUN<br>${this.kills} DOWN`);
    }
    this.infView.update(this.horde.list, this.survived);
  }

  private checkCheckpoints() {
    const t = this.trial!;
    const c = t.checkpoints[this.cpIndex];
    if (!c) return;
    const p = this.player.pos;
    if (Math.hypot(p.x - c.x, p.z - c.z) < c.r + 0.5 && Math.abs(p.y - c.y) < 3) {
      this.splits.push(this.trialTime);
      this.cpIndex++;
      this.splitShowT = 2.5;
      const beam = this.cpBeams[this.cpIndex - 1];
      if (beam) beam.visible = false;
      this.respawnPoint = { x: p.x, y: p.y, z: p.z, yaw: this.player.yaw };
      this.ui.setCheckpoints(this.cpIndex, t.checkpoints.length, t.name.toUpperCase());
      if (this.cpIndex >= t.checkpoints.length) this.finishTrial();
      else this.audio.playUi('chime', 0.3);
    }
  }

  private updateMarker() {
    const t = this.trial!;
    const c = t.checkpoints[this.cpIndex];
    for (let i = 0; i < this.cpBeams.length; i++) {
      const u = (this.cpBeams[i].material as THREE.ShaderMaterial).uniforms;
      u.uActive.value = i === this.cpIndex ? 1 : i === this.cpIndex + 1 ? 0.35 : 0;
      this.cpBeams[i].visible = i >= this.cpIndex && i <= this.cpIndex + 1;
    }
    if (!c || !this.save.settings.runnerVision) { this.ui.setMarker(0, 0, false, false, 0); return; }
    this.pointMarker(new THREE.Vector3(c.x, c.y + 1.2, c.z));
  }

  /** on-screen marker for a world point (clamped to the screen edge when off-screen); null hides it */
  private pointMarker(v: THREE.Vector3 | null) {
    if (!v) { this.ui.setMarker(0, 0, false, false, 0); return; }
    const cam = this.r.camera;
    const dist = v.distanceTo(cam.position);
    v.project(cam);
    const w = window.innerWidth, h = window.innerHeight;
    let x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
    const behind = v.z > 1;
    let off = behind || x < 30 || x > w - 30 || y < 30 || y > h - 30;
    if (behind) { x = w - x; y = h - 40; }
    if (off) { x = Math.max(30, Math.min(w - 30, x)); y = Math.max(40, Math.min(h - 40, y)); off = true; }
    this.ui.setMarker(x, y, true, off, dist);
  }

  // --------------------------------------------------------------------- cinematic cameras
  private cinematic(dt: number, target: { pos: { x: number; y: number; z: number }; vel: { x: number; z: number }; yaw: number }) {
    this.camShotT -= dt;
    const tp = new THREE.Vector3(target.pos.x, target.pos.y + 1.2, target.pos.z);
    const sp = Math.hypot(target.vel.x, target.vel.z);
    const dir = sp > 0.5 ? new THREE.Vector3(target.vel.x / sp, 0, target.vel.z / sp) : new THREE.Vector3(-Math.sin(target.yaw), 0, -Math.cos(target.yaw));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    if (this.camShotT <= 0) {
      this.camShot = (this.camShot + 1 + Math.floor(Math.random() * 3)) % 4;
      this.camShotT = 3.5 + Math.random() * 2.5;
      // fixed shots get placed once
      if (this.camShot === 2) this.camPos.copy(tp).addScaledVector(dir, 9).addScaledVector(side, 3).add(new THREE.Vector3(0, -0.6, 0));
      if (this.camShot === 3) this.camPos.copy(tp).addScaledVector(side, -7).add(new THREE.Vector3(0, 6, 0));
      this.camLook.copy(tp);
    }
    let want: THREE.Vector3;
    if (this.camShot === 0) want = tp.clone().addScaledVector(dir, -4.2).addScaledVector(side, 0.9).add(new THREE.Vector3(0, 0.9, 0));          // chase
    else if (this.camShot === 1) want = tp.clone().addScaledVector(side, 4.5).addScaledVector(dir, 1.5).add(new THREE.Vector3(0, 0.4, 0));      // tracking side
    else want = this.camPos.clone();                                                                                                           // fixed / crane
    if (this.camShot <= 1) this.camPos.lerp(want, Math.min(1, dt * 3.5));
    // keep fixed cameras from drifting too far
    if (this.camShot >= 2 && this.camPos.distanceTo(tp) > 28) this.camShotT = 0;
    this.camLook.lerp(tp, Math.min(1, dt * 6));
    const cam = this.r.camera;
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    if (Math.abs(cam.fov - 60) > 0.1) { cam.fov = 60; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  private driveShowBody(dt: number, d: GhostPlayback | PlayerController) {
    const eye = new THREE.Vector3(d.pos.x, d.pos.y + Math.max(0.8, d.height - 0.12), d.pos.z);
    const view = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(d.pitch * 0.6, d.yaw, 0, 'YXZ')).setPosition(eye);
    this.showBody.update(dt, d, view, eye, new THREE.Vector3(d.pos.x, d.pos.y, d.pos.z));
  }

  private updateAttract(dt: number) {
    if (!this.demo) { this.startDemo(); if (!this.demo) return; }
    const d = this.demo;
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 10) { d.p.update(DT, d.bot.step(d.p, DT)); this.acc -= DT; n++; }
    if (d.bot.done || d.p.state === PState.Dead || d.bot.stuckT > 6) { this.demoTrial++; this.startDemo(); return; }
    this.driveShowBody(dt, d.p);
    this.cinematic(dt, d.p);
    const cam = this.r.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z);
  }

  private updateReplay(dt: number) {
    const g = this.replay!;
    this.replayTime += dt * this.replaySpeed;
    if (this.replayTime > g.duration + 1.5) { this.exitReplay(); return; }
    g.seek(Math.min(this.replayTime, g.duration));
    this.driveShowBody(dt * this.replaySpeed, g);
    this.cinematic(dt, g);
    this.ui.setTimer(Math.min(this.replayTime, g.duration));
    this.ui.setMarker(0, 0, false, false, 0);
  }

  private animateShards(dt: number) {
    const t = performance.now() / 1000;
    for (const s of this.shardMeshes) {
      if (!s.mesh.visible) continue;
      s.mesh.rotation.y += dt * 1.6;
      s.mesh.position.y = s.base.y + Math.sin(t * 2 + s.id) * 0.12;
    }
  }

  private updateDebug() {
    const p = this.mode === 'attract' && this.demo ? this.demo.p : this.player;
    const info = this.r.renderer.info;
    this.ui.debug.textContent = [
      `fps ${this.fps.toFixed(0)}  (${(1000 / this.fps).toFixed(1)} ms)  quality ${this.r.quality}`,
      `draw calls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k`,
      `state ${p.state}  t ${p.stateTime.toFixed(2)}`,
      `speed ${p.hSpeed.toFixed(2)} m/s  vy ${p.vel.y.toFixed(2)}  flow ${p.flow.toFixed(2)}`,
      `pos ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}  yaw ${p.yaw.toFixed(2)}`,
      `surface ${p.surface}  grounded ${p.grounded}  trial ${this.trial ? fmt(this.trialTime) : '-'}`,
    ].join('\n');
  }
}

export { withFog };
