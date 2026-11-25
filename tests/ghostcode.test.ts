import { describe, expect, it } from 'vitest';
import { encodeGhost, ghostCode, parseGhostCode } from '../src/game/Ghost';

const frames = (n: number) => { const f = new Float32Array(n * 34); for (let i = 0; i < n; i++) { f[i * 34] = i; f[i * 34 + 5] = 1; } return f; };

describe('ghost codes', () => {
  it('round-trips a run', () => {
    const f = frames(40);
    const r = parseGhostCode(ghostCode('crosstown', encodeGhost(f)), ['crosstown']);
    expect('data' in r && r.trialId === 'crosstown' && r.data.length === f.length && r.data[34 * 39] === 39).toBe(true);
  });
  it('tolerates line breaks and spaces from chat apps', () => {
    const code = ghostCode('crosstown', encodeGhost(frames(5)));
    expect('data' in parseGhostCode(code.slice(0, 20) + '\n ' + code.slice(20), ['crosstown'])).toBe(true);
  });
  it('rejects junk, unknown trials, damaged and hostile data', () => {
    const ok = encodeGhost(frames(5));
    expect('error' in parseGhostCode('hello', ['a'])).toBe(true);
    expect('error' in parseGhostCode(ghostCode('nope', ok), ['crosstown'])).toBe(true);
    expect('error' in parseGhostCode(ghostCode('crosstown', ok.slice(0, -9)), ['crosstown'])).toBe(true);
    expect('error' in parseGhostCode(ghostCode('crosstown', '<script>alert(1)</script>'), ['crosstown'])).toBe(true);
    const bad = frames(5); bad[3] = NaN;
    expect('error' in parseGhostCode(ghostCode('crosstown', encodeGhost(bad)), ['crosstown'])).toBe(true);
    const badState = frames(5); badState[5] = 99;
    expect('error' in parseGhostCode(ghostCode('crosstown', encodeGhost(badState)), ['crosstown'])).toBe(true);
  });
});
