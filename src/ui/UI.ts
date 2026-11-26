import type { TrialDef } from '../game/Trials';
import type { Save, Settings } from '../game/Save';

export function fmt(t: number | null | undefined): string {
  if (t == null || !isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export function medalOf(t: TrialDef, time: number | null): 'gold' | 'silver' | 'bronze' | 'none' {
  if (time == null) return 'none';
  if (time <= t.medals[0]) return 'gold';
  if (time <= t.medals[1]) return 'silver';
  if (time <= t.medals[2]) return 'bronze';
  return 'none';
}

export class UI {
  root = document.getElementById('ui')!;
  loading: HTMLElement;
  hud: HTMLElement;
  menu: HTMLElement;
  fade: HTMLElement;
  private timer: HTMLElement;
  private cp: HTMLElement;
  private shards: HTMLElement;
  private speed: HTMLElement;
  private marker: HTMLElement;
  private toastEl: HTMLElement;
  private countdownEl: HTMLElement;
  private help: HTMLElement;
  reticle: HTMLElement;
  debug: HTMLElement;
  prompt: HTMLElement;
  private toastT = 0;
  touchLayer: HTMLElement;
  showStick(x: number, y: number, ox: number, oy: number, on: boolean) {
    const st = this.touchLayer.querySelector('.stick') as HTMLElement;
    st.style.opacity = on ? '1' : '0';
    st.style.transform = `translate(${ox - 60}px, ${oy - 60}px)`;
    (st.querySelector('i') as HTMLElement).style.transform = `translate(${x - ox}px, ${y - oy}px)`;
  }

  constructor() {
    this.loading = el('div', { id: 'loading', class: 'layer' }, `<div class="logo">SKYLINE <b>RUNNER</b></div><div class="bar"><i></i></div><div class="msg">Building the city</div>`);
    this.hud = el('div', { id: 'hud', class: 'layer hidden' });
    this.reticle = el('div', { id: 'reticle' });
    this.timer = el('div', { id: 'timer' });
    this.cp = el('div', { id: 'cpcount' });
    this.shards = el('div', { id: 'shards' });
    this.speed = el('div', { id: 'speed' }, `<span class="v">0.0</span> M/S<div class="bar"><i></i></div>`);
    this.marker = el('div', { id: 'marker' }, `<div class="d"></div><div class="m"></div>`);
    this.toastEl = el('div', { id: 'toast' });
    this.countdownEl = el('div', { id: 'countdown' });
    this.help = el('div', { id: 'help', class: 'hidden' }, `
      <b>MOVE</b> <kbd>W A S D</kbd> &nbsp; <b>SPRINT</b> <kbd>SHIFT</kbd><br>
      <b>UP</b> <kbd>SPACE</kbd> jump · wall-run · wall-climb · grab · vault<br>
      <b>DOWN</b> <kbd>CTRL</kbd>/<kbd>C</kbd> slide · roll on landing · drop<br>
      <b>QUICK TURN</b> <kbd>Q</kbd> &nbsp; <b>KICK</b> <kbd>F</kbd> &nbsp; <b>GRAPPLE</b> <kbd>E</kbd> &nbsp; <b>RESTART</b> <kbd>R</kbd><br>
      Touch: left thumb moves (push to the edge to sprint), right thumb looks.<br>
      Build speed before gaps — momentum is everything.`);
    this.debug = el('div', { id: 'debug', class: 'hidden' });
    this.health = el('div', { id: 'health', class: 'hidden' }, '<i></i>');
    this.weaponEl = el('div', { id: 'weapon', class: 'hidden' });
    this.radioEl = el('div', { id: 'radio', class: 'hidden' });
    this.comboEl = el('div', { id: 'combo', class: 'hidden' }, '<div class="move"></div><div class="chain"></div><div class="score"></div>');
    this.hurt = el('div', { id: 'hurt', class: 'layer' });
    this.prompt = el('div', { id: 'prompt', class: 'hidden' }, 'Click to resume');
    this.touchLayer = el('div', { id: 'touch', class: 'hidden' }, `<div class="stick"><i></i></div><button class="tbtn up" aria-label="Up: jump, climb, vault">UP</button><button class="tbtn down" aria-label="Down: slide, roll, drop">DOWN</button><button class="tbtn pause" aria-label="Pause">II</button>`);
    this.hud.append(this.touchLayer);
    this.hud.append(this.reticle, this.timer, this.cp, this.shards, this.speed, this.marker, this.toastEl, this.countdownEl, this.help, this.debug, this.prompt, this.health, this.hurt, this.comboEl, this.weaponEl, this.radioEl, this.toastPrompt);
    this.menu = el('div', { class: 'layer menu hidden' });
    this.fade = el('div', { id: 'fade', class: 'layer' });
    this.root.append(this.hud, this.menu, this.fade, this.loading);
  }

  setLoading(p: number, msg: string) {
    (this.loading.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    (this.loading.querySelector('.msg') as HTMLElement).textContent = msg;
  }
  hideLoading() { this.loading.style.opacity = '0'; setTimeout(() => this.loading.classList.add('hidden'), 650); }

  showHud(v: boolean) { this.hud.classList.toggle('hidden', !v); }
  applySettings(s: Settings) {
    this.reticle.classList.toggle('hidden', !s.reticle);
    this.speed.classList.toggle('hidden', !s.showSpeed);
  }
  showHelp(v: boolean) { this.help.classList.toggle('hidden', !v); this.help.style.opacity = v ? '1' : '0'; }
  fadeHelp() { this.help.style.opacity = '0'; setTimeout(() => this.help.classList.add('hidden'), 900); }

  setTimer(t: number | null, split?: number | null) {
    if (t == null) { this.timer.innerHTML = ''; return; }
    let s = fmt(t);
    if (split != null) s += `<span class="split ${split <= 0 ? 'ahead' : 'behind'}">${split <= 0 ? '−' : '+'}${Math.abs(split).toFixed(2)}</span>`;
    this.timer.innerHTML = s;
  }
  health: HTMLElement; hurt: HTMLElement; comboEl: HTMLElement; weaponEl: HTMLElement;
  radioEl: HTMLElement;
  private radioQ: { who: string; text: string }[] = []; private radioTimer = 0;
  /** radio subtitles: lines queue up and each stays long enough to read; [] clears */
  radio(lines: { who: string; text: string }[]) {
    if (!lines.length) { this.radioQ = []; clearTimeout(this.radioTimer); this.radioEl.classList.add('hidden'); return; }
    const idle = !this.radioQ.length;
    this.radioQ.push(...lines);
    if (idle) this.nextRadio();
  }
  private nextRadio() {
    const l = this.radioQ[0];
    if (!l) { this.radioEl.classList.add('hidden'); return; }
    this.radioEl.innerHTML = `<b class="${l.who === 'KAI' ? 'kai' : ''}">${l.who}</b> ${l.text}`;
    this.radioEl.classList.remove('hidden');
    this.radioTimer = window.setTimeout(() => { this.radioQ.shift(); this.nextRadio(); }, 2200 + l.text.length * 45);
  }

  storyMenu(chapter: number, chapters: string[], o: { onPlay: (ch: number) => void; onBack: () => void }) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'LAST<br><b>SIGNAL</b>'), el('h2', {}, 'A story in four chapters'));
    p.append(el('div', { class: 'foot' }, 'The district is sealed. You are Kai, a rooftop courier. Carry the evacuation plan to the relay on top of the Spire before the night takes the streets.'));
    if (chapter > 0) p.append(this.button(`Continue`, () => o.onPlay(chapter), 'primary', `chapter ${chapter + 1}: ${chapters[chapter]}`));
    p.append(this.button(chapter > 0 ? 'New story' : 'Begin', () => o.onPlay(0), chapter > 0 ? '' : 'primary', `chapter 1: ${chapters[0]}`));
    for (let i = 1; i <= chapter; i++) p.append(this.button(`Chapter ${i + 1}`, () => o.onPlay(i), '', chapters[i]));
    p.append(this.button('Back', o.onBack));
    this.open(p);
  }

  storyEnd(o: { kills: number; onBack: () => void }) {
    const p = el('div', { class: 'panel results' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'SIGNAL<br><b>SENT</b>'));
    p.append(el('div', { class: 'foot' }, `The broadcast went out over the district at dawn. The helicopters landed on the roofs, and the people who had held out up there for three days came out to meet them.<br><br>Infected you put down tonight: ${o.kills}<br><br>LAST SIGNAL · thanks for playing`));
    p.append(this.button('Main menu', o.onBack, 'primary'));
    this.open(p);
  }

  /** context prompt over the HUD (e.g. swapping weapons); null hides it */
  setPrompt(text: string | null) { this.toastPrompt.classList.toggle('hidden', !text); if (text && this.toastPrompt.textContent !== text) this.toastPrompt.textContent = text; }
  toastPrompt = el('div', { id: 'itemprompt', class: 'hidden' });
  /** held weapon and flares, bottom right; null hides it */
  setWeapon(text: string | null) { this.weaponEl.classList.toggle('hidden', text == null); if (text != null && this.weaponEl.textContent !== text) this.weaponEl.textContent = text; }
  private bankT = 0; private lastBanked = 0;
  /** flow combo: current move, chain points x multiplier, total score; null hides it */
  setCombo(c: { label: string; labelT: number; chain: number; pending: number; mult: number; score: number; banked: number } | null) {
    this.comboEl.classList.toggle('hidden', !c);
    if (!c) return;
    const q = (s: string) => this.comboEl.querySelector(s) as HTMLElement;
    if (c.banked && c.banked !== this.lastBanked) { this.bankT = 1.6; this.lastBanked = c.banked; }
    this.bankT -= 1 / 60;
    q('.move').textContent = c.labelT > 0 && c.chain ? c.label : '';
    q('.chain').innerHTML = c.chain ? `${c.pending} <b>×${c.mult}</b>` : this.bankT > 0 ? `+${this.lastBanked}` : '';
    q('.chain').classList.toggle('banked', !c.chain && this.bankT > 0);
    q('.score').textContent = c.score ? `SCORE ${c.score}` : '';
  }
  /** Night Run health bar; null hides it */
  setHealth(v: number | null) {
    this.health.classList.toggle('hidden', v == null);
    if (v != null) { const i = this.health.querySelector('i') as HTMLElement; i.style.width = `${Math.max(0, v)}%`; i.classList.toggle('low', v < 35); }
  }
  /** red edge flash when something hits you; fades by itself */
  flashHurt() { this.hurt.style.transition = 'none'; this.hurt.style.opacity = '1'; void this.hurt.offsetWidth; this.hurt.style.transition = 'opacity .9s'; this.hurt.style.opacity = '0'; }
  setCheckpoints(i: number, n: number, label = '') { this.cp.innerHTML = n ? `${label}<br>${i} / ${n}` : label; }
  setShards(n: number, total: number) { this.shards.innerHTML = `<i></i> ${n} / ${total}`; }
  setSpeed(v: number, flow: number) {
    (this.speed.querySelector('.v') as HTMLElement).textContent = v.toFixed(1);
    const bar = this.speed.querySelector('.bar i') as HTMLElement;
    bar.style.width = `${Math.min(100, v / 10 * 100)}%`;
    bar.classList.toggle('flow', flow > 0.95);
  }
  setMarker(x: number, y: number, visible: boolean, offscreen: boolean, dist: number) {
    this.marker.style.opacity = visible ? '1' : '0';
    this.marker.style.transform = `translate(${x}px, ${y}px)`;
    this.marker.classList.toggle('off', offscreen);
    (this.marker.querySelector('.m') as HTMLElement).textContent = `${Math.round(dist)} m`;
  }
  toast(text: string, sub = '', red = false, dur = 1.8) {
    this.toastEl.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.toastEl.classList.toggle('red', red);
    this.toastEl.style.opacity = '1';
    this.toastT = dur;
  }
  countdown(text: string) {
    this.countdownEl.textContent = text;
    this.countdownEl.style.opacity = text ? '1' : '0';
  }
  tick(dt: number) {
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.toastEl.style.opacity = '0'; }
  }
  setFade(a: number, red = false) { this.fade.style.opacity = String(a); this.fade.classList.toggle('red', red); }

  // ---------------- menus ----------------
  private open(html: HTMLElement) {
    this.menu.innerHTML = '';
    this.menu.append(html);
    this.menu.classList.remove('hidden');
    const first = html.querySelector('.btn') as HTMLElement | null;
    first?.focus({ preventScroll: true });
  }
  closeMenu() { this.menu.classList.add('hidden'); this.menu.innerHTML = ''; }
  get menuOpen() { return !this.menu.classList.contains('hidden'); }

  private button(label: string, onClick: () => void, cls = '', right = '') {
    const b = el('button', { class: `btn ${cls}` }, `<span>${label}</span>${right ? `<small>${right}</small>` : ''}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  mainMenu(o: { onFree: () => void; onStory: () => void; onNight: () => void; onChallenges: () => void; onTrials: () => void; onSettings: () => void; onControls: () => void; shards: string }) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'SKYLINE<br><b>RUNNER</b>'), el('h2', {}, 'First-person freerunning'));
    p.append(this.button('Story', o.onStory, 'primary', 'last signal'));
    p.append(this.button('Free Run', o.onFree, '', 'explore the district'));
    p.append(this.button('Night Run', o.onNight, '', 'survive the infected'));
    p.append(this.button('Time Trials', o.onTrials, '', 'races & ghosts'));
    p.append(this.button('Challenges', o.onChallenges, '', 'shard rush · floor is lava'));
    p.append(this.button('Settings', o.onSettings));
    p.append(this.button('Controls', o.onControls));
    p.append(el('div', { class: 'foot' }, `Data shards found: ${o.shards}<br>Mouse + keyboard or gamepad. Click to capture the mouse; Esc pauses.`));
    this.open(p);
  }

  trialsMenu(trials: TrialDef[], save: Save, o: { onRun: (t: TrialDef, ghost: boolean) => void; onReplay: (t: TrialDef) => void; onShare: (t: TrialDef) => void; onRaceCode: () => void; onBack: () => void }) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, '<b>TIME</b> TRIALS'), el('h2', {}, 'Beat the clock. Race your best ghost.'));
    for (const t of trials) {
      const r = save.trial(t.id);
      const m = medalOf(t, r.best);
      const card = el('div', { class: 'trial' });
      card.append(el('div', { class: 't' }, `<strong>${t.name}</strong><span>${fmt(r.best)}</span>`));
      card.append(el('p', {}, t.desc));
      card.append(el('div', { class: 'medals' }, `<span class="medal ${m}"><i></i>${m === 'none' ? 'no medal' : m}</span>
        <span class="medal gold"><i></i>${fmt(t.medals[0])}</span><span class="medal silver"><i></i>${fmt(t.medals[1])}</span><span class="medal bronze"><i></i>${fmt(t.medals[2])}</span>`));
      const row = el('div', { class: 'row' });
      row.append(this.button('Run', () => o.onRun(t, true), 'primary'));
      if (r.ghost) row.append(this.button('Watch PB', () => o.onReplay(t)), this.button('Share', () => o.onShare(t), '', 'code'));
      card.append(row);
      p.append(card);
    }
    p.append(this.button("Race a friend's ghost", o.onRaceCode, '', 'paste a code'));
    p.append(this.button('Back', o.onBack));
    this.open(p);
  }

  challengesMenu(best: Record<string, number>, o: { onRush: () => void; onLava: () => void; onBack: () => void }) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, '<b>CHALLENGES</b>'), el('h2', {}, 'One run. Beat your best.'));
    const card = (name: string, desc: string, bestText: string, run: () => void) => {
      const c = el('div', { class: 'trial' });
      c.append(el('div', { class: 't' }, `<strong>${name}</strong><span>${bestText}</span>`), el('p', {}, desc));
      const row = el('div', { class: 'row' }); row.append(this.button('Play', run, 'primary')); c.append(row);
      p.append(c);
    };
    card('Shard Rush', 'Three minutes. Every data shard is back in the city: grab as many as you can.', best.rush ? `best ${best.rush}` : '—', o.onRush);
    card('Floor is Lava', 'One life. Touch street level and it is over. Chain moves for flow points; your score is everything you bank.', best.lava ? `best ${best.lava}` : '—', o.onLava);
    p.append(this.button('Back', o.onBack));
    this.open(p);
  }

  challengeResult(o: { title: string; score: string; best: string; isBest: boolean; onRetry: () => void; onBack: () => void }) {
    const p = el('div', { class: 'panel results' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, o.title), el('div', { class: 'big' }, o.score));
    if (o.isBest) p.append(el('div', { class: 'pb' }, 'NEW BEST'));
    p.append(el('div', { class: 'splits' }, `Best: ${o.best}`));
    const row = el('div', { class: 'row' }); row.append(this.button('Retry', o.onRetry, 'primary'), this.button('Menu', o.onBack)); p.append(row);
    this.open(p);
  }

  pauseMenu(o: { inTrial: boolean; onResume: () => void; onRestart: () => void; onRespawn: () => void; onSettings: () => void; onControls: () => void; onQuit: () => void }) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'PAUSED'), el('h2', {}, o.inTrial ? 'Time trial' : 'Free run'));
    p.append(this.button('Resume', o.onResume, 'primary'));
    if (o.inTrial) p.append(this.button('Restart trial', o.onRestart, '', 'R'));
    p.append(this.button(o.inTrial ? 'Last checkpoint' : 'Respawn', o.onRespawn));
    p.append(this.button('Settings', o.onSettings));
    p.append(this.button('Controls', o.onControls));
    p.append(this.button('Main menu', o.onQuit));
    this.open(p);
  }

  results(o: { trial: TrialDef; time: number; best: number | null; isPB: boolean; splits: number[]; onRetry: () => void; onReplay: () => void; onBack: () => void }) {
    const p = el('div', { class: 'panel results' });
    const m = medalOf(o.trial, o.time);
    p.append(el('div', { class: 'tag' }), el('h2', {}, o.trial.name));
    if (o.isPB) p.append(el('div', { class: 'pb' }, 'NEW PERSONAL BEST'));
    p.append(el('div', { class: 'big' }, fmt(o.time)));
    p.append(el('div', { class: 'medals' }, `<span class="medal ${m}"><i></i> ${m === 'none' ? 'no medal' : m.toUpperCase()}</span> &nbsp; best ${fmt(o.best)}`));
    p.append(el('div', { class: 'splits' }, o.splits.map((s, i) => `CP${String(i + 1).padStart(2, '0')}  ${fmt(s)}`).join('<br>')));
    p.append(this.button('Retry', o.onRetry, 'primary', 'R'));
    p.append(this.button('Watch replay', o.onReplay));
    p.append(this.button('Back to trials', o.onBack));
    this.open(p);
  }

  settingsMenu(s: Settings, onChange: (s: Settings) => void, onBack: () => void) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'SETTINGS'), el('h2', {}, 'Graphics · Camera · Audio'));
    const add = (label: string, input: HTMLElement) => { const r = el('div', { class: 'setting' }); r.append(el('span', {}, label), input); p.append(r); };
    const sel = el('select');
    for (const q of ['low', 'medium', 'high', 'ultra']) { const op = el('option', { value: q }, q.toUpperCase()); if (q === s.quality) op.setAttribute('selected', ''); sel.append(op); }
    sel.addEventListener('change', () => { s.quality = sel.value as Settings['quality']; s.autoQuality = false; onChange(s); });
    add('Graphics quality', sel);
    const range = (label: string, key: keyof Settings, min: number, max: number, step: number) => {
      const i = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]) });
      i.addEventListener('input', () => { (s as any)[key] = Number(i.value); onChange(s); });
      add(label, i);
    };
    const check = (label: string, key: keyof Settings) => {
      const i = el('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = !!s[key];
      i.addEventListener('change', () => { (s as any)[key] = i.checked; onChange(s); });
      add(label, i);
    };
    range('Field of view', 'fov', 70, 110, 1);
    range('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05);
    check('Invert Y', 'invertY');
    range('Camera motion (bob, tilt, shake)', 'comfort', 0, 1, 0.05);
    check('Wall-jump view assist', 'autoTurn');
    range('Master volume', 'volume', 0, 1, 0.01);
    range('Music volume', 'music', 0, 1, 0.01);
    check('Speed readout', 'showSpeed');
    check('Centre dot', 'reticle');
    check('Runner vision (route marker)', 'runnerVision');
    check('Night (free run & trials)', 'night');
    check('Rain', 'rain');
    check('Slow motion on big jumps', 'slowMo');
    p.append(this.button('Back', onBack));
    this.open(p);
  }

  controlsMenu(onBack: () => void) {
    const p = el('div', { class: 'panel' });
    p.append(el('div', { class: 'tag' }), el('h1', {}, 'CONTROLS'), el('h2', {}, 'Up · Down · Momentum'));
    p.append(el('div', { class: 'keys' }, `
      <span>Move</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / left stick</span>
      <span>Sprint</span><span><kbd>Shift</kbd> / L3 · builds momentum</span>
      <span>Walk</span><span><kbd>X</kbd> / <kbd>Alt</kbd></span>
      <span>Up</span><span><kbd>Space</kbd> / <kbd>LMB</kbd> / A · jump, wall-run, wall-climb, climb, vault, pull up</span>
      <span>Down</span><span><kbd>Ctrl</kbd> / <kbd>C</kbd> / <kbd>RMB</kbd> / B · crouch, slide, roll (press just before landing), drop</span>
      <span>Quick turn</span><span><kbd>Q</kbd> / X · also: jump during a wall-climb to spin off</span>
      <span>Grapple</span><span><kbd>E</kbd> / <kbd>MMB</kbd> / R3 · aim at a red ring on a tall roof edge (it lights up in range) to reel yourself up; jump to let go early</span>
      <span>Inventory</span><span>two slots: <kbd>1</kbd> / <kbd>2</kbd> (D-pad left/right) · <kbd>F</kbd> / Y uses what's in hand: swing, or throw a flare · walk over items to pick them up, <kbd>R</kbd> / D-pad down swaps when full</span>
      <span>Flare</span><span><kbd>G</kbd> / D-pad up · quick throw: it burns red and lures nearby infected away from you</span>
      <span>Kick</span><span><kbd>V</kbd>, or <kbd>F</kbd> with an empty hand</span>
      <span>Kick</span><span><kbd>F</kbd> / Y · knocks the infected back; running, sliding or in the air it's a dropkick that floors them</span>
      <span>Restart trial</span><span><kbd>R</kbd> / Back</span>
      <span>Pause</span><span><kbd>Esc</kbd> / Start</span>
      <span>Debug overlay</span><span><kbd>F3</kbd></span>`));
    p.append(el('div', { class: 'foot' }, `Tips — Run straight to build flow before long gaps. Hit walls at a shallow angle to wall-run; head-on and press Up to wall-climb, then Up again at the top to spin off. Press Down just before a big landing to roll and keep your speed. Ledges are grabbed automatically while you hold forward.`));
    p.append(this.button('Back', onBack));
    this.open(p);
  }
}
