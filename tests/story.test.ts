import { describe, expect, it } from 'vitest';
import { Story, VOICE_LOGS, type StoryHooks, type Vec } from '../src/game/Story';

describe('story: Last Signal', () => {
  const places = { stash: { x: 10, y: 20, z: 0 }, shards: [{ x: 20, y: 20, z: 0 }, { x: 30, y: 22, z: 0 }, { x: 40, y: 18, z: 5 }], supplies: { x: 50, y: 25, z: 0 }, spireTop: { x: 60, y: 78, z: 0 }, raceFinish: { x: 90, y: 20, z: 0 } };
  const log = () => {
    const l = { said: [] as string[], items: [] as string[], night: [] as boolean[], rival: [] as (string | null)[], climbers: 0, failed: [] as string[], chose: '', ended: '' as string, obj: '' };
    const h: StoryHooks = {
      say: (x) => l.said.push(...x.map((y) => y.who)), objective: (t) => { l.obj = t; }, give: (i) => l.items.push(i), night: (n) => l.night.push(n),
      rival: (m) => l.rival.push(m), spawnClimber: () => l.climbers++, fail: (w) => l.failed.push(w), choose: (p) => { l.chose = p; }, end: (e) => { l.ended = e; },
    };
    return { l, h };
  };
  const at = (s: Story, v: Vec, secs = 0.1, alive = true, rival: (Vec & { finished: boolean }) | null = null) => { for (let t = 0; t < secs; t += 1 / 30) s.update(1 / 30, v, alive, rival); };

  it('plays through all six chapters to an ending, with the twists in order', () => {
    const { l, h } = log();
    const s = new Story(places, h);
    s.start(0);
    at(s, places.stash); expect(l.items).toEqual(['katana']); expect(s.chapter).toBe(1);
    expect(l.rival.at(-1)).toBe('chase');
    at(s, { x: 0, y: 20, z: 0 }, 0.1, true, { x: 30, y: 20, z: 0, finished: false }); expect(s.chapter).toBe(1); // not caught yet
    at(s, { x: 0, y: 20, z: 0 }, 0.1, true, { x: 2, y: 20, z: 0, finished: false }); expect(s.chapter).toBe(2); // caught
    expect(l.said).toContain('HALE');                                     // the antagonist shows up
    at(s, places.shards[1]); expect(s.step).toBe(0);                      // drops go in order
    for (const sh of places.shards) at(s, sh);
    expect(l.said).toContain('THEO');                                     // the first twist: Theo's voice
    expect(s.chapter).toBe(3); expect(l.rival.at(-1)).toBe('race');
    at(s, places.raceFinish); expect(s.chapter).toBe(4);
    expect(l.night.at(-1)).toBe(true);
    at(s, places.spireTop); expect(s.chapter).toBe(4);                    // cache first
    at(s, places.supplies); expect(l.items).toEqual(['katana', 'pipe', 'flares']);
    at(s, places.spireTop); expect(s.chapter).toBe(5);
    at(s, places.spireTop, 30); at(s, places.spireTop, 10, false);        // dead: the hold pauses
    expect(l.chose).toBe('');
    at(s, places.spireTop, 31);
    expect(l.chose).not.toBe('');                                         // the final choice
    expect(l.climbers).toBeGreaterThan(8);
    s.choose(0);
    expect(l.ended).toBe('broadcast');
    expect(s.done).toBe(true);
  });

  it('the other ending: trading the shards for Theo', () => {
    const { l, h } = log();
    const s = new Story(places, h);
    s.start(5); at(s, places.spireTop, 61); s.choose(1);
    expect(l.ended).toBe('deal');
  });

  it('missions can be failed: the escape timer, losing Vesper, losing the race', () => {
    { const { l, h } = log(); const s = new Story(places, h); s.start(0); at(s, { x: -50, y: 20, z: 0 }, 91); expect(l.failed.length).toBeGreaterThan(0); }
    { const { l, h } = log(); const s = new Story(places, h); s.start(1); at(s, { x: 0, y: 20, z: 0 }, 0.1, true, { x: 120, y: 20, z: 0, finished: false }); expect(l.failed[0]).toMatch(/got away/); }
    { const { l, h } = log(); const s = new Story(places, h); s.start(3); at(s, { x: 0, y: 20, z: 0 }, 0.1, true, { x: 90, y: 20, z: 0, finished: true }); expect(l.failed[0]).toMatch(/first/); }
  });

  it('can resume at any chapter, and there are voice logs to find', () => {
    const { l, h } = log();
    const s = new Story(places, h);
    s.start(4);
    expect(l.night).toEqual([true]);
    expect(l.obj).toBe('Grab the supply cache');
    expect(VOICE_LOGS.length).toBeGreaterThanOrEqual(10);
  });
});
