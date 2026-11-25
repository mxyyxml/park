import { emptyInput, InputFrame } from '../player/PlayerController';

export interface Bindings {
  forward: string[]; back: string[]; left: string[]; right: string[];
  jump: string[]; crouch: string[]; sprint: string[]; walk: string[]; quickTurn: string[]; kick: string[]; grapple: string[];
  restart: string[]; pause: string[];
}

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['ControlLeft', 'KeyC', 'ControlRight'], sprint: ['ShiftLeft', 'ShiftRight'], walk: ['AltLeft', 'KeyX'],
  quickTurn: ['KeyQ'], kick: ['KeyF'], grapple: ['KeyE'], restart: ['KeyR'], pause: ['Escape', 'KeyP'],
};

/**
 * Collects keyboard / mouse / gamepad into per-physics-tick InputFrames.
 * Edge-triggered presses are latched until consumed by a fixed tick so they are never lost
 * when the render rate exceeds the physics rate (or vice versa).
 */
export class Input {
  keys = new Set<string>();
  private pressedLatch = new Set<string>();
  private lookDX = 0; private lookDY = 0;
  sensitivity = 0.0022;
  invertY = false;
  gamepadSens = 3.2;
  locked = false;
  /** touch, or pointer lock refused even on repeated clicks (e.g. a sandboxed frame): look follows the free mouse */
  fallbackLook = false;
  private lockFails = 0;
  private lockFromClick = false;
  get active() { return this.locked || this.fallbackLook; }
  mouseButtons = 0;
  private gpPrev: boolean[] = [];
  autoSprint = false;
  onPausePressed: (() => void) | null = null;
  onRestartPressed: (() => void) | null = null;
  enabled = true;

  constructor(private el: HTMLElement, public bind: Bindings = DEFAULT_BINDINGS) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code.startsWith('Alt') || (e.code === 'Space' && this.locked) || e.code.startsWith('Control')) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressedLatch.add(e.code);
      this.keys.add(e.code);
      if (this.bind.pause.includes(e.code) && !e.repeat) this.onPausePressed?.();
      if (this.bind.restart.includes(e.code) && !e.repeat) this.onRestartPressed?.();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === this.el; if (this.locked) this.lockFails = 0; });
    // a refusal is usually temporary (re-lock within ~1 s of Esc, or a request not made by a click):
    // the "Click to resume" prompt stays up. Only clicks that keep failing mean lock is unavailable.
    document.addEventListener('pointerlockerror', () => { if (this.lockFromClick && ++this.lockFails >= 2) this.fallbackLook = true; });
    document.addEventListener('mousemove', (e) => {
      if (!this.active || !this.enabled) return;
      this.lookDX += e.movementX; this.lookDY += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      if (e.button === 0) this.pressedLatch.add('Mouse0');
      if (e.button === 2) this.pressedLatch.add('Mouse2');
      if (e.button === 1) { this.pressedLatch.add('Mouse1'); e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- touch: left stick, right-half look, UP / DOWN buttons
  touch = { active: false, mx: 0, my: 0, lookDX: 0, lookDY: 0, up: false, down: false, upPressed: false, downPressed: false };
  private stickId: number | null = null; private lookId: number | null = null;
  private stickOrigin = { x: 0, y: 0 }; private lookLast = { x: 0, y: 0 };
  touchSensitivity = 0.006;
  onTouchStick: ((x: number, y: number, ox: number, oy: number, on: boolean) => void) | null = null;

  enableTouch(root: HTMLElement, up: HTMLElement, down: HTMLElement) {
    this.touch.active = true;
    const btn = (el: HTMLElement, key: 'up' | 'down') => {
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); this.touch[key] = true; this.touch[key === 'up' ? 'upPressed' : 'downPressed'] = true; }, { passive: false });
      const end = (e: Event) => { e.preventDefault(); this.touch[key] = false; };
      el.addEventListener('touchend', end, { passive: false }); el.addEventListener('touchcancel', end, { passive: false });
    };
    btn(up, 'up'); btn(down, 'down');
    root.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth * 0.45 && this.stickId === null) {
          this.stickId = t.identifier; this.stickOrigin = { x: t.clientX, y: t.clientY };
          this.onTouchStick?.(t.clientX, t.clientY, t.clientX, t.clientY, true);
        } else if (this.lookId === null) { this.lookId = t.identifier; this.lookLast = { x: t.clientX, y: t.clientY }; }
      }
      e.preventDefault();
    }, { passive: false });
    root.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          const R = 60;
          let dx = (t.clientX - this.stickOrigin.x) / R, dy = (t.clientY - this.stickOrigin.y) / R;
          const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
          this.touch.mx = dx; this.touch.my = -dy;
          this.onTouchStick?.(this.stickOrigin.x + dx * R, this.stickOrigin.y + dy * R, this.stickOrigin.x, this.stickOrigin.y, true);
        } else if (t.identifier === this.lookId) {
          this.touch.lookDX += t.clientX - this.lookLast.x; this.touch.lookDY += t.clientY - this.lookLast.y;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) { this.stickId = null; this.touch.mx = this.touch.my = 0; this.onTouchStick?.(0, 0, 0, 0, false); }
        if (t.identifier === this.lookId) this.lookId = null;
      }
    };
    root.addEventListener('touchend', end); root.addEventListener('touchcancel', end);
  }

  lock(fromClick = false) {
    if (this.locked || this.fallbackLook) return;
    if (!this.el.requestPointerLock) { this.fallbackLook = true; return; }
    this.lockFromClick = fromClick;
    try {
      const r = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {}); // handled by the pointerlockerror listener
    } catch { /* same */ }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  private any(codes: string[]) { return codes.some((c) => this.keys.has(c)); }
  private anyPressed(codes: string[]) { return codes.some((c) => this.pressedLatch.has(c)); }

  private gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }

  /** Build one frame of input. dt is the elapsed render time (for analog look). */
  sample(dt: number): InputFrame {
    const f = emptyInput();
    if (!this.enabled) { this.lookDX = this.lookDY = 0; this.pressedLatch.clear(); return f; }
    f.moveY = (this.any(this.bind.forward) ? 1 : 0) - (this.any(this.bind.back) ? 1 : 0);
    f.moveX = (this.any(this.bind.right) ? 1 : 0) - (this.any(this.bind.left) ? 1 : 0);
    f.jump = this.any(this.bind.jump) || !!(this.mouseButtons & 1);
    f.jumpPressed = this.anyPressed(this.bind.jump) || this.pressedLatch.has('Mouse0');
    f.crouch = this.any(this.bind.crouch) || !!(this.mouseButtons & 4);
    f.crouchPressed = this.anyPressed(this.bind.crouch) || this.pressedLatch.has('Mouse2');
    f.sprint = this.any(this.bind.sprint) || this.autoSprint;
    f.walk = this.any(this.bind.walk);
    f.quickTurn = this.anyPressed(this.bind.quickTurn);
    f.kickPressed = this.anyPressed(this.bind.kick);
    f.grapplePressed = this.anyPressed(this.bind.grapple) || this.pressedLatch.has('Mouse1');
    f.lookX = this.lookDX * this.sensitivity;
    f.lookY = -this.lookDY * this.sensitivity * (this.invertY ? -1 : 1);
    this.lookDX = 0; this.lookDY = 0;
    if (this.touch.active) {
      const tc = this.touch;
      if (Math.abs(tc.mx) + Math.abs(tc.my) > 0.05) { f.moveX = tc.mx; f.moveY = tc.my; f.sprint ||= Math.hypot(tc.mx, tc.my) > 0.85 && tc.my > 0.5; }
      f.lookX += tc.lookDX * this.touchSensitivity; f.lookY += -tc.lookDY * this.touchSensitivity * (this.invertY ? -1 : 1);
      tc.lookDX = tc.lookDY = 0;
      f.jump ||= tc.up; f.jumpPressed ||= tc.upPressed; f.crouch ||= tc.down; f.crouchPressed ||= tc.downPressed;
      tc.upPressed = tc.downPressed = false;
    }
    const gp = this.gamepad();
    if (gp) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      const lx = dz(gp.axes[0]), ly = dz(gp.axes[1]), rx = dz(gp.axes[2]), ry = dz(gp.axes[3]);
      if (Math.abs(lx) + Math.abs(ly) > 0) { f.moveX = lx; f.moveY = -ly; }
      const curve = (v: number) => Math.sign(v) * v * v;
      f.lookX += curve(rx) * this.gamepadSens * dt;
      f.lookY += -curve(ry) * this.gamepadSens * 0.75 * dt * (this.invertY ? -1 : 1);
      const btn = (i: number) => !!gp.buttons[i]?.pressed;
      const pressed = (i: number) => btn(i) && !this.gpPrev[i];
      // A / LB = jump (up), B / LT / RB = down, L3 = sprint, X = quick turn, Y = kick, R3 = grapple, Start = pause, Back = restart
      f.jump ||= btn(0) || btn(4);
      f.jumpPressed ||= pressed(0) || pressed(4);
      f.crouch ||= btn(1) || btn(6) || btn(5);
      f.crouchPressed ||= pressed(1) || pressed(6) || pressed(5);
      f.sprint ||= btn(10) || btn(7) || Math.hypot(lx, ly) > 0.92;
      f.quickTurn ||= pressed(2);
      f.kickPressed ||= pressed(3);
      f.grapplePressed ||= pressed(11);
      if (pressed(9)) this.onPausePressed?.();
      if (pressed(8)) this.onRestartPressed?.();
      this.gpPrev = gp.buttons.map((b) => b.pressed);
    }
    this.pressedLatch.clear();
    return f;
  }
}
