import { Music } from './Music';
/**
 * Procedural audio. Every sound is synthesised at startup into AudioBuffers (no assets):
 * surface-specific footsteps, cloth, breathing, wind, landings, slides, hand contacts,
 * zipline whine, city ambience, traffic, horns, birds, mechanical hums. Gameplay drives
 * parameters every frame (speed → wind, exertion → breathing, height → traffic vs wind).
 */
import { Surface } from '../physics/collision';
import type { PEvent } from '../player/PlayerController';

const SR = 44100;
type Buf = AudioBuffer;

function rngGen(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }

/** Minimal biquad for offline synthesis */
class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  static make(type: 'lp' | 'hp' | 'bp', f: number, q: number) {
    const bq = new BQ(); bq.set(type, f, q); return bq;
  }
  set(type: 'lp' | 'hp' | 'bp', f: number, q: number) {
    const w = 2 * Math.PI * Math.min(f, SR * 0.45) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2; const a0 = 1 + al;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * cs) / a0; this.a2 = (1 - al) / a0;
  }
  p(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  amb!: GainNode;
  reverb!: ConvolverNode;
  reverbSend!: GainNode;
  volume = 0.8;
  private bufs = new Map<string, Buf[]>();
  private loops: Record<string, { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }> = {};
  private exertion = 0;
  private breathT = 0;
  private breathPhase = 0;
  private ambT = 0;
  private nextHorn = 6;
  private nextBird = 3;
  private nextTraffic = 2;
  private speed = 0;
  private height = 0;
  ready = false;

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx({ sampleRate: SR });
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.amb = ctx.createGain(); this.amb.gain.value = 0.9; this.amb.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(1.8, 2.6);
    this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = 0.18;
    this.reverbSend.connect(this.reverb).connect(this.master);
    this.generate();
    this.startLoops();
    this.ready = true;
  }

  music: Music | null = null;
  private musicVol = 0.5;
  /** soundtrack on/off for play modes; intensity follows speed, night picks the dark progression */
  setMusic(on: boolean, night = false) {
    if (!this.ctx) return;
    if (!this.music) this.music = new Music(this.ctx, this.master);
    this.music.night = night;
    this.music.setVolume(this.musicVol);
    if (on) this.music.start(); else this.music.stop();
  }
  setMusicVolume(v: number) { this.musicVol = v; this.music?.setVolume(v); }
  setVolume(v: number) { this.volume = v; if (this.master) this.master.gain.value = v; }

  // ---- synthesis ------------------------------------------------------------------------------
  private buf(len: number, fn: (i: number, t: number) => number, norm = 0.9): Buf {
    const n = Math.floor(len * SR);
    const b = this.ctx!.createBuffer(1, n, SR);
    const d = b.getChannelData(0);
    let peak = 1e-6;
    for (let i = 0; i < n; i++) { d[i] = fn(i, i / SR); peak = Math.max(peak, Math.abs(d[i])); }
    if (norm > 0) for (let i = 0; i < n; i++) d[i] *= norm / peak;
    return b;
  }

  private impulse(len: number, decay: number): Buf {
    const n = Math.floor(len * SR);
    const b = this.ctx!.createBuffer(2, n, SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); const r = rngGen(77 + c);
      const lp = BQ.make('lp', 5000, 0.7);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // early reflections off nearby facades + diffuse tail
        const er = (i % 2200 < 30 && t < 0.15) ? 0.6 : 0;
        d[i] = lp.p(r() * Math.pow(1 - t, decay) + er * r());
      }
    }
    return b;
  }

  private add(name: string, b: Buf) { if (!this.bufs.has(name)) this.bufs.set(name, []); this.bufs.get(name)!.push(b); }

  private generate() {
    // footsteps per surface, several variations each
    for (let v = 0; v < 6; v++) {
      const r = rngGen(100 + v);
      const pf = 1 + (r() * 0.1);
      // concrete: crisp scuff + body thump
      { const bp = BQ.make('bp', 2600 * pf, 0.9), hp = BQ.make('hp', 600, 0.7);
        this.add('step_concrete', this.buf(0.16, (_i, t) => {
          const scuff = bp.p(hp.p(r())) * Math.exp(-t * 55) * (t < 0.002 ? t / 0.002 : 1);
          const thump = Math.sin(2 * Math.PI * (95 * pf) * t * (1 - t * 2)) * Math.exp(-t * 38) * 0.9;
          const grit = r() * Math.exp(-t * 90) * 0.15;
          return scuff * 1.4 + thump + grit;
        })); }
      // gravel: many grains
      { const grains: [number, number][] = []; for (let k = 0; k < 26; k++) grains.push([Math.abs(r()) * 0.09, 1500 + Math.abs(r()) * 4000]);
        const bp = BQ.make('bp', 3000, 0.6);
        this.add('step_gravel', this.buf(0.18, (_i, t) => {
          let s = 0; for (const [gt] of grains) { const d = t - gt; if (d > 0 && d < 0.012) s += r() * Math.exp(-d * 400); }
          return bp.p(s) * 1.2 + Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t * 40) * 0.5;
        })); }
      // metal: thump + ringing partials
      { const f0 = 210 + v * 23;
        this.add('step_metal', this.buf(0.42, (_i, t) => {
          const ring = (Math.sin(2 * Math.PI * f0 * t) * 0.5 + Math.sin(2 * Math.PI * f0 * 2.76 * t) * 0.35 + Math.sin(2 * Math.PI * f0 * 5.4 * t) * 0.2) * Math.exp(-t * 14);
          return ring * 0.7 + r() * Math.exp(-t * 70) * 0.5 + Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 30) * 0.6;
        })); }
      // glass: tick + high ring
      { this.add('step_glass', this.buf(0.3, (_i, t) => {
          const ring = (Math.sin(2 * Math.PI * (2300 + v * 90) * t) + 0.6 * Math.sin(2 * Math.PI * (3900 + v * 120) * t)) * Math.exp(-t * 22);
          return ring * 0.35 + r() * Math.exp(-t * 160) * 0.8 + Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t * 45) * 0.5;
        })); }
      // wood: hollow knock
      { const bp = BQ.make('bp', 900, 1.4);
        this.add('step_wood', this.buf(0.2, (_i, t) => bp.p(r()) * Math.exp(-t * 40) * 1.2 + Math.sin(2 * Math.PI * (170 + v * 8) * t) * Math.exp(-t * 28) * 0.8)); }
      // grass: soft swish
      { const lp = BQ.make('lp', 2200, 0.7), hp = BQ.make('hp', 300, 0.7);
        this.add('step_grass', this.buf(0.2, (_i, t) => lp.p(hp.p(r())) * Math.sin(Math.PI * Math.min(1, t / 0.2)) * 0.9 + Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 40) * 0.35)); }
      // rubber: dull thud
      { const lp = BQ.make('lp', 900, 0.7);
        this.add('step_rubber', this.buf(0.15, (_i, t) => lp.p(r()) * Math.exp(-t * 45) + Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t * 35) * 0.9)); }
      // cloth rustle
      { const bp = BQ.make('bp', 1800 + v * 200, 0.8);
        this.add('cloth', this.buf(0.22, (_i, t) => bp.p(r()) * Math.sin(Math.PI * Math.min(1, t / 0.22)) * (0.6 + 0.4 * Math.sin(t * 90)))); }
      // hand slap on surfaces
      { const hp = BQ.make('hp', 900, 0.7);
        this.add('hand', this.buf(0.12, (_i, t) => hp.p(r()) * Math.exp(-t * 80) + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 50) * 0.5)); }
      // breath: exhale (stronger) and inhale (softer, higher)
      { const bp = BQ.make('bp', 900 + v * 60, 1.2), bp2 = BQ.make('bp', 1900 + v * 50, 2), lp = BQ.make('lp', 3000, 0.7);
        this.add('exhale', this.buf(0.32, (_i, t) => { const e = Math.sin(Math.PI * Math.pow(t / 0.32, 0.6)); const n = r(); return lp.p(bp.p(n) * 0.8 + bp2.p(n) * 0.4) * e; }));
        const bp3 = BQ.make('bp', 1400 + v * 70, 1.5);
        this.add('inhale', this.buf(0.26, (_i, t) => bp3.p(r()) * Math.sin(Math.PI * t / 0.26) * 0.6)); }
    }
    // impacts
    for (let v = 0; v < 3; v++) {
      const r = rngGen(300 + v);
      const lp = BQ.make('lp', 400, 0.8);
      this.add('land', this.buf(0.5, (_i, t) => Math.sin(2 * Math.PI * (60 + v * 6) * t * (1 - t)) * Math.exp(-t * 12) + lp.p(r()) * Math.exp(-t * 18) * 1.5));
      const bp = BQ.make('bp', 600, 0.5);
      this.add('slideStart', this.buf(0.35, (_i, t) => bp.p(r()) * Math.exp(-t * 6) * Math.min(1, t * 50)));
      const sw = BQ.make('bp', 400, 1.2);
      this.add('whoosh', this.buf(0.45, (_i, t) => { sw.set('bp', 300 + t * 2400, 1.2); return sw.p(r()) * Math.sin(Math.PI * t / 0.45); }));
    }
    // loops
    const r = rngGen(9);
    { const lp = BQ.make('lp', 700, 0.7); this.add('windLoop', this.buf(4, (i) => { const x = lp.p(r()); const n = 4 * SR; const f = Math.min(1, Math.min(i, n - i) / 4000); return x * f; })); }
    { let b = 0; this.add('cityLoop', this.buf(6, (i) => { b = b * 0.995 + r() * 0.06; const n = 6 * SR; const f = Math.min(1, Math.min(i, n - i) / 6000); return (b + Math.sin(i / SR * 2 * Math.PI * 55) * 0.02) * f; })); }
    { const bp = BQ.make('bp', 1400, 0.9); this.add('slideLoop', this.buf(2, (i) => { const n = 2 * SR; const f = Math.min(1, Math.min(i, n - i) / 2000); return (bp.p(r()) + r() * 0.15) * f; })); }
    { const bp = BQ.make('bp', 1200, 4); this.add('zipLoop', this.buf(2, (i, t) => { const n = 2 * SR; const f = Math.min(1, Math.min(i, n - i) / 2000); return (bp.p(r()) * 0.7 + Math.sin(2 * Math.PI * 930 * t) * 0.2 * (1 + Math.sin(t * 40) * 0.3)) * f; })); }
    { this.add('humLoop', this.buf(2, (i, t) => { const n = 2 * SR; const f = Math.min(1, Math.min(i, n - i) / 2000); return (Math.sin(2 * Math.PI * 120 * t) * 0.5 + Math.sin(2 * Math.PI * 240 * t) * 0.2 + r() * 0.1) * f; })); }
    { const lp = BQ.make('lp', 1800, 0.7); this.add('steamLoop', this.buf(2, (i) => { const n = 2 * SR; const f = Math.min(1, Math.min(i, n - i) / 2000); return lp.p(r()) * f; })); }
    { this.add('droneLoop', this.buf(1, (i, t) => { const n = SR; const f = Math.min(1, Math.min(i, n - i) / 1500); return (Math.sin(2 * Math.PI * 180 * t) * 0.4 + Math.sin(2 * Math.PI * 362 * t) * 0.3 + Math.sin(2 * Math.PI * 541 * t) * 0.2 + r() * 0.15) * f; })); }
    { const lp = BQ.make('lp', 1200, 0.6); this.add('trainLoop', this.buf(3, (i, t) => { const n = 3 * SR; const f = Math.min(1, Math.min(i, n - i) / 3000); return (lp.p(r()) * 0.8 + Math.sin(2 * Math.PI * 92 * t) * 0.2 + Math.sin(2 * Math.PI * 440 * t) * 0.05) * f; })); }
    // one-shots
    this.add('chime', this.buf(1.2, (_i, t) => [880, 1320, 1760].reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (3 + k * 2)) * (t > k * 0.06 ? 1 : 0), 0)));
    this.add('collect', this.buf(1.0, (_i, t) => [1046, 1568, 2093, 2637].reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 5) * (t > k * 0.05 ? 1 : 0), 0)));
    this.add('finish', this.buf(2.0, (_i, t) => [523, 659, 784, 1046].reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 1.6) * (t > k * 0.11 ? 1 : 0) * (1 + 0.3 * Math.sin(2 * Math.PI * 5 * t)), 0)));
    { const lp = BQ.make('lp', 300, 0.7); this.add('death', this.buf(1.6, (_i, t) => Math.sin(2 * Math.PI * 45 * t) * Math.exp(-t * 2.5) + lp.p(r()) * Math.exp(-t * 4) * 2)); }
    // infected: throaty groans (formant-filtered growl with a falling pitch), kick impact, player hit
    for (let v = 0; v < 3; v++) {
      const bp1 = BQ.make('bp', 520 + v * 90, 3), bp2 = BQ.make('bp', 1150 + v * 140, 4), len = 1.1 + v * 0.3;
      this.add('groan', this.buf(len, (_i, t) => {
        const f0 = 92 - v * 9 - t * 18 + Math.sin(t * 7 + v) * 6;
        const src = ((t * f0) % 1) * 2 - 1 + r() * 0.35;
        const env = Math.min(1, t * 6) * Math.min(1, (len - t) * 3) * (0.75 + 0.25 * Math.sin(t * 23));
        return (bp1.p(src) + bp2.p(src) * 0.5) * env;
      }));
    }
    { const lp = BQ.make('lp', 700, 0.8); this.add('kick', this.buf(0.35, (_i, t) => Math.sin(2 * Math.PI * (110 - t * 160) * t) * Math.exp(-t * 14) + lp.p(r()) * Math.exp(-t * 30) * 1.5)); }
    { const lp = BQ.make('lp', 900, 0.7); this.add('hurt', this.buf(0.5, (_i, t) => (lp.p(r()) * 1.2 + Math.sin(2 * Math.PI * 70 * t)) * Math.exp(-t * 7))); }
    for (let v = 0; v < 3; v++) {
      const f1 = 330 + v * 40, f2 = f1 * 1.26;
      this.add('horn', this.buf(0.9, (_i, t) => { const env = Math.min(1, t * 30) * Math.min(1, (0.9 - t) * 10); const saw = (f: number) => ((t * f) % 1) * 2 - 1; return (saw(f1) + saw(f2)) * env * 0.5; }));
      this.add('bird', this.buf(0.35, (_i, t) => { const f = 3200 + Math.sin(t * 60 + v) * 900 + v * 300; return Math.sin(2 * Math.PI * f * t) * Math.sin(Math.PI * Math.min(1, t / 0.35)) * (Math.sin(t * 90) > -0.2 ? 1 : 0); }));
      const lp = BQ.make('lp', 900, 0.7);
      this.add('carPass', this.buf(4, (_i, t) => { const e = Math.exp(-Math.pow((t - 2) / 0.9, 2)); return lp.p(r()) * e + Math.sin(2 * Math.PI * (70 - (t - 2) * 6) * t) * e * 0.3; }));
    }
  }

  private play(name: string, gain = 1, rate = 1, reverb = 0.25, pan = 0): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    const list = this.bufs.get(name);
    if (!list) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = gain;
    let node: AudioNode = src.connect(g);
    if (pan !== 0) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(this.sfx);
    if (reverb > 0) { const s = this.ctx.createGain(); s.gain.value = reverb; node.connect(s).connect(this.reverbSend); }
    src.start();
    return src;
  }

  private startLoops() {
    const mk = (name: string, bus: AudioNode, ftype: BiquadFilterType, freq: number) => {
      const ctx = this.ctx!;
      const src = ctx.createBufferSource(); src.buffer = this.bufs.get(name)![0]; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = ftype; filter.frequency.value = freq;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(bus);
      src.start();
      this.loops[name] = { src, gain, filter };
    };
    mk('windLoop', this.sfx, 'lowpass', 600);
    mk('cityLoop', this.amb, 'lowpass', 900);
    mk('slideLoop', this.sfx, 'bandpass', 1200);
    mk('zipLoop', this.sfx, 'bandpass', 1500);
    this.loops.cityLoop.gain.gain.value = 0.55;
  }

  // ---- spatial emitters ------------------------------------------------------------------------
  private emitters: { panner: PannerNode; gain: GainNode; src: AudioBufferSourceNode; base: number }[] = [];
  addEmitter(name: string, x: number, y: number, z: number, gain: number, refDist = 6, rate = 1) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.bufs.get(name)![0]; src.loop = true; src.playbackRate.value = rate;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = refDist; panner.rolloffFactor = 1.4; panner.maxDistance = 600;
    panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(panner).connect(this.amb);
    src.start(ctx.currentTime + Math.random());
    const e = { panner, gain: g, src, base: gain };
    this.emitters.push(e);
    return e;
  }
  moveEmitter(e: { panner: PannerNode } | null, x: number, y: number, z: number) {
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    e.panner.positionX.setTargetAtTime(x, t, 0.05); e.panner.positionY.setTargetAtTime(y, t, 0.05); e.panner.positionZ.setTargetAtTime(z, t, 0.05);
  }

  /** one-shot sound at a world position (HRTF), e.g. an infected groan */
  playAt(name: string, x: number, y: number, z: number, gain = 1, rate = 1) {
    if (!this.ctx || !this.bufs.has(name)) return;
    const ctx = this.ctx, list = this.bufs.get(name)!;
    const src = ctx.createBufferSource(); src.buffer = list[Math.floor(Math.random() * list.length)]; src.playbackRate.value = rate;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 3; panner.rolloffFactor = 1.3;
    panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(panner).connect(this.sfx);
    src.start();
  }
  /** player feedback sounds without position */
  playFx(name: 'kick' | 'hurt', g = 0.7) { this.play(name, g, 0.95 + Math.random() * 0.1, 0.2); }

  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02); l.positionY.setTargetAtTime(y, t, 0.02); l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02); l.forwardY.setTargetAtTime(fy, t, 0.02); l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  }

  // ---- gameplay hooks --------------------------------------------------------------------------
  private stepName(s: Surface) {
    return ['step_concrete', 'step_metal', 'step_glass', 'step_gravel', 'step_wood', 'step_grass', 'step_rubber'][s] ?? 'step_concrete';
  }

  onEvents(events: PEvent[]) {
    if (!this.ready) return;
    for (const e of events) {
      switch (e.type) {
        case 'footstep': {
          const sp = Math.min(1, e.speed / 9.5);
          this.play(this.stepName(e.surface), 0.18 + sp * 0.32, 0.92 + Math.random() * 0.12 + sp * 0.06, 0.12, e.foot ? 0.12 : -0.12);
          if (Math.random() < 0.35 + sp * 0.4) this.play('cloth', 0.05 + sp * 0.06, 0.9 + Math.random() * 0.3, 0);
          this.exertion = Math.min(1, this.exertion + sp * 0.012);
          break;
        }
        case 'jump': this.play('whoosh', 0.16, 1.1, 0.1); this.play(this.stepName(e.surface), 0.35, 0.85, 0.15); this.play('exhale', 0.22 + this.exertion * 0.2, 1.05, 0.05); this.breathT = 0.25; break;
        case 'land': {
          const k = Math.min(1, e.impact / 14);
          this.play('land', 0.2 + k * 0.7, 1.1 - k * 0.3, 0.3);
          this.play(this.stepName(e.surface), 0.4 + k * 0.4, 0.8, 0.2, -0.1);
          this.play(this.stepName(e.surface), 0.35 + k * 0.3, 0.85, 0.0, 0.1);
          this.play('cloth', 0.15 + k * 0.1, 0.8, 0);
          if (e.hard) this.play('exhale', 0.6, 0.85, 0.05);
          break;
        }
        case 'roll': this.play('cloth', 0.35, 0.7, 0); this.play('land', 0.4, 1.3, 0.1); this.play('whoosh', 0.18, 0.7, 0); break;
        case 'slideStart': this.play('slideStart', 0.35, 1, 0.1); break;
        case 'wallrunStart': this.play('hand', 0.3, 1.0, 0.15, e.side * 0.4); this.play('whoosh', 0.12, 0.9, 0.1); break;
        case 'walljump': this.play('hand', 0.35, 1.1, 0.1); this.play('whoosh', 0.2, 1.2, 0.1); break;
        case 'wallclimbStart': this.play('step_concrete', 0.45, 0.9, 0.2); break;
        case 'climbStep': this.play('hand', 0.22, 0.9 + Math.random() * 0.2, 0.1, Math.random() - 0.5); break;
        case 'grab': this.play('hand', 0.5, 0.95, 0.2, -0.2); this.play('hand', 0.45, 1.05, 0.2, 0.2); this.play('exhale', 0.3 + Math.min(0.3, e.impact / 30), 0.9, 0.05); if (e.impact > 5) this.play('land', 0.3, 1.4, 0.2); break;
        case 'handplant': this.play('hand', 0.42, 1.0, 0.15); break;
        case 'traverse': this.play('cloth', 0.25, 1.0, 0); if (e.kind === 'pullup') this.play('exhale', 0.4, 0.95, 0.05); else this.play('whoosh', 0.14, 1.3, 0); break;
        case 'pipeGrab': this.play('step_metal', 0.4, 1.4, 0.2); this.play('hand', 0.3, 1, 0.1); break;
        case 'bump': this.play('land', 0.4, 1.5, 0.2); this.play('exhale', 0.4, 0.9, 0); break;
        case 'death': this.play('death', 0.9, 1, 0.5); break;
        case 'quickturn': this.play('cloth', 0.2, 1.2, 0); break;
        case 'mantleJump': this.play('whoosh', 0.3, 1.35, 0.1); this.play('exhale', 0.35, 1.05, 0); break;
      }
    }
  }

  playUi(name: 'chime' | 'collect' | 'finish' | 'whoosh', g = 0.5) { this.play(name, g, 1, 0.3); }

  /** Per-frame continuous parameters. */
  update(dt: number, speed: number, height: number, sliding: boolean, ziplining: boolean, grounded: boolean, timeScale = 1) {
    if (!this.ctx || !this.ready) return;
    const t = this.ctx.currentTime;
    this.speed += (speed - this.speed) * Math.min(1, dt * 4);
    this.music?.setIntensity(Math.min(1, this.speed / 13));
    this.height = height;
    const sn = Math.min(1, this.speed / 12);
    // wind: rises with speed and altitude
    const hn = Math.min(1, Math.max(0, (height - 10) / 60));
    const w = this.loops.windLoop;
    w.gain.gain.setTargetAtTime(0.03 + hn * 0.06 + sn * sn * 0.5, t, 0.1);
    w.filter.frequency.setTargetAtTime(350 + sn * 2400 + hn * 300, t, 0.1);
    // city ambience: quieter and duller with altitude
    const c = this.loops.cityLoop;
    c.gain.gain.setTargetAtTime(0.5 * (1 - hn * 0.5), t, 0.5);
    c.filter.frequency.setTargetAtTime(900 - hn * 500, t, 0.5);
    this.loops.slideLoop.gain.gain.setTargetAtTime(sliding ? 0.08 + sn * 0.25 : 0, t, 0.04);
    this.loops.slideLoop.filter.frequency.setTargetAtTime(700 + sn * 1500, t, 0.05);
    this.loops.zipLoop.gain.gain.setTargetAtTime(ziplining ? 0.1 + sn * 0.2 : 0, t, 0.05);
    this.loops.zipLoop.src.playbackRate.setTargetAtTime(0.7 + sn * 0.8, t, 0.1);
    // breathing: rate & volume track exertion
    const target = speed > 6.5 ? 1 : speed > 3 ? 0.45 : 0.12;
    this.exertion += (target - this.exertion) * dt * (target > this.exertion ? 0.12 : 0.06);
    this.breathT -= dt * timeScale;
    if (this.breathT <= 0) {
      const period = 2.8 - this.exertion * 1.9;
      this.breathPhase ^= 1;
      if (this.breathPhase) this.play('inhale', 0.03 + this.exertion * 0.12, 1 + this.exertion * 0.1, 0);
      else this.play('exhale', 0.04 + this.exertion * 0.18, 1 + this.exertion * 0.1, 0);
      this.breathT = period / 2;
    }
    // distant life
    this.ambT += dt;
    if (this.ambT > this.nextHorn) { this.nextHorn = this.ambT + 7 + Math.random() * 16; this.play('horn', 0.025 * (1 - hn * 0.6), 0.9 + Math.random() * 0.2, 0.9, Math.random() * 1.6 - 0.8); }
    if (this.ambT > this.nextBird) { this.nextBird = this.ambT + 4 + Math.random() * 10; const n = 1 + Math.floor(Math.random() * 3); for (let i = 0; i < n; i++) setTimeout(() => this.play('bird', 0.03, 0.9 + Math.random() * 0.3, 0.4, Math.random() * 1.6 - 0.8), i * 180); }
    if (this.ambT > this.nextTraffic) { this.nextTraffic = this.ambT + 1.5 + Math.random() * 4; this.play('carPass', 0.06 * (1 - hn * 0.7), 0.8 + Math.random() * 0.4, 0.6, Math.random() * 1.6 - 0.8); }
    void grounded;
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}
