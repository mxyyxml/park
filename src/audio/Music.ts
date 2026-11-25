/**
 * Generative soundtrack, synthesized live with Web Audio. An original four-chord loop at 118 BPM
 * whose layers follow the runner: pad always, drums when running, bass and hats when fast, an
 * arpeggiated lead at top speed. Night Run switches to a darker minor progression.
 */
const BPM = 118, STEP = 60 / BPM / 4; // sixteenth notes
// chord roots (MIDI) and qualities: day = bright, night = dark
const DAY = [[50, 'maj7'], [57, 'maj'], [59, 'min7'], [55, 'maj7']] as const;
const NIGHT = [[45, 'min'], [41, 'maj7'], [43, 'maj'], [40, 'min7']] as const;
const SHAPES: Record<string, number[]> = { maj: [0, 4, 7, 12], maj7: [0, 4, 7, 11], min: [0, 3, 7, 12], min7: [0, 3, 7, 10] };
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private out: GainNode;
  private layers: Record<'pad' | 'drums' | 'bass' | 'lead', GainNode>;
  private next = 0; private step = 0; private timer = 0;
  private noise: AudioBuffer;
  intensity = 0; night = false;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain(); this.out.gain.value = 0.5; this.out.connect(dest);
    const mk = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.out); return g; };
    this.layers = { pad: mk(), drums: mk(), bass: mk(), lead: mk() };
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    if (this.timer) return;
    this.next = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }
  stop() { clearInterval(this.timer); this.timer = 0; }
  setVolume(v: number) { this.out.gain.setTargetAtTime(v * 0.55, this.ctx.currentTime, 0.1); }

  /** 0..1 from the runner's speed (smoothed by the caller) */
  setIntensity(x: number) {
    this.intensity = x;
    const t = this.ctx.currentTime, on = (a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));
    this.layers.pad.gain.setTargetAtTime(0.5, t, 0.5);
    this.layers.drums.gain.setTargetAtTime(on(0.15, 0.35) * 0.8, t, 0.4);
    this.layers.bass.gain.setTargetAtTime(on(0.45, 0.6) * 0.7, t, 0.4);
    this.layers.lead.gain.setTargetAtTime(on(0.75, 0.9) * 0.35, t, 0.6);
  }

  private schedule() {
    while (this.next < this.ctx.currentTime + 0.12) { this.play(this.step, this.next); this.next += STEP; this.step++; }
  }

  private play(s: number, t: number) {
    const prog = this.night ? NIGHT : DAY;
    const bar = Math.floor(s / 16) % prog.length, i = s % 16;
    const [root, q] = prog[bar], notes = SHAPES[q].map((n) => root + n);
    if (i === 0) for (const n of notes) this.tone(this.layers.pad, hz(n + 12), t, STEP * 16, 'sawtooth', 0.05, 900);
    // drums: four on the floor, offbeat snare noise, sixteenth hats
    if (i % 4 === 0) this.kick(t);
    if (i === 4 || i === 12) this.hit(t, 0.35, 1800, 0.12);
    if (i % 2 === 1) this.hit(t, 0.12, 8000, 0.03);
    // bass: root and fifth, syncopated
    if ([0, 3, 6, 8, 11, 14].includes(i)) this.tone(this.layers.bass, hz(root - 12 + (i === 11 ? 7 : 0)), t, STEP * 1.6, 'square', 0.22, 500);
    // lead arpeggio over the chord
    if (i % 2 === 0) this.tone(this.layers.lead, hz(notes[(i / 2) % 4] + 24), t, STEP * 1.5, 'triangle', 0.18, 4000);
  }

  private tone(dest: AudioNode, f: number, t: number, len: number, type: OscillatorType, g: number, cutoff: number) {
    const c = this.ctx, o = c.createOscillator(), a = c.createGain(), lp = c.createBiquadFilter();
    o.type = type; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = cutoff;
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(g, t + Math.min(0.02, len * 0.2)); a.gain.exponentialRampToValueAtTime(0.0005, t + len);
    o.connect(lp).connect(a).connect(dest); o.start(t); o.stop(t + len + 0.05);
  }
  private kick(t: number) {
    const c = this.ctx, o = c.createOscillator(), a = c.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    a.gain.setValueAtTime(0.9, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(a).connect(this.layers.drums); o.start(t); o.stop(t + 0.32);
  }
  private hit(t: number, g: number, f: number, len: number) {
    const c = this.ctx, n = c.createBufferSource(), a = c.createGain(), hp = c.createBiquadFilter();
    n.buffer = this.noise; hp.type = 'highpass'; hp.frequency.value = f;
    a.gain.setValueAtTime(g, t); a.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(hp).connect(a).connect(this.layers.drums); n.start(t); n.stop(t + len + 0.02);
  }
}
