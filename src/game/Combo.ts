/**
 * Flow combos: parkour moves chained without stopping score points. Each new move raises the
 * multiplier (repeating the same move gives less); the chain banks into the score when the
 * runner stops, falls, or goes 2.5 s without a move.
 */
import type { PEvent } from '../player/PlayerController';

const MOVES: Record<string, [string, number]> = {
  speedvault: ['Speed vault', 100], kongvault: ['Kong vault', 150], mantle: ['Mantle', 60], pullup: ['Pull-up', 60],
  wallrunStart: ['Wall run', 150], walljump: ['Wall jump', 120], wallclimbStart: ['Wall climb', 80],
  roll: ['Roll', 100], slideStart: ['Slide', 60], zipStart: ['Zipline', 120], mantleJump: ['Mantle jump', 200],
  pipeGrab: ['Pipe', 60], grab: ['Ledge grab', 60], kick: ['Kick', 80], dropkick: ['Dropkick', 200], takedown: ['Takedown', 300], runnerDown: ['Runner down', 400], mutantDown: ['Mutant down', 1000], grappleStart: ['Grapple', 120], slash: ['Slash', 100], smash: ['Smash', 120],
};

export class Combo {
  score = 0; best = 0;
  chain = 0; mult = 1; pending = 0;
  label = ''; labelT = 0;
  private sinceMove = 99; private slowT = 0;
  private last: string[] = [];
  /** set when a chain banks; the UI shows it briefly */
  banked = 0;

  add(key: string) {
    const m = MOVES[key];
    if (!m) return;
    const repeats = this.last.filter((k) => k === key).length;
    const value = Math.round(m[1] * Math.pow(0.5, repeats));
    if (!repeats) this.mult = Math.min(10, this.mult + (this.chain ? 1 : 0));
    this.chain++;
    this.pending += value;
    this.last.push(key); if (this.last.length > 4) this.last.shift();
    this.label = m[0]; this.labelT = 1.4;
    this.sinceMove = 0;
  }

  feed(events: PEvent[]) {
    for (const e of events) {
      if (e.type === 'traverse') this.add(e.kind);
      else if (e.type === 'death') this.drop();
      else this.add(e.type);
    }
  }

  update(dt: number, speed: number) {
    this.sinceMove += dt; this.labelT -= dt;
    this.slowT = speed < 1.5 ? this.slowT + dt : 0;
    if (this.chain && (this.sinceMove > 2.5 || this.slowT > 1.0)) this.bank();
  }

  /** chain ends well: points x multiplier go into the score */
  bank() {
    if (!this.chain) return;
    this.banked = this.pending * this.mult;
    this.score += this.banked;
    this.best = Math.max(this.best, this.banked);
    this.reset();
  }
  /** chain ends badly (death): nothing banked */
  drop() { this.banked = 0; this.reset(); }
  private reset() { this.chain = 0; this.mult = 1; this.pending = 0; this.last = []; }
}
