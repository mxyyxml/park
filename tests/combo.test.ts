import { describe, expect, it } from 'vitest';
import { Combo } from '../src/game/Combo';

describe('combo', () => {
  it('different moves raise the multiplier and bank when the runner stops', () => {
    const c = new Combo();
    c.add('wallrunStart'); c.add('walljump'); c.add('roll');
    expect(c.mult).toBe(3);
    expect(c.pending).toBe(150 + 120 + 100);
    c.update(1.2, 0); // standing still > 1 s
    expect(c.score).toBe(370 * 3);
    expect(c.chain).toBe(0);
  });
  it('repeating a move is worth less and does not raise the multiplier', () => {
    const c = new Combo();
    c.add('slideStart'); c.add('slideStart'); c.add('slideStart');
    expect(c.mult).toBe(1);
    expect(c.pending).toBe(60 + 30 + 15);
  });
  it('dying drops the chain', () => {
    const c = new Combo();
    c.add('kongvault'); c.feed([{ type: 'death', cause: 'fall' }]);
    expect(c.score).toBe(0);
    expect(c.chain).toBe(0);
  });
  it('the chain survives while moving fast between moves, up to 2.5 s', () => {
    const c = new Combo();
    c.add('zipStart');
    c.update(2.0, 8); expect(c.chain).toBe(1);
    c.update(0.6, 8); expect(c.chain).toBe(0);
  });
});
