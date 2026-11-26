import { describe, expect, it } from 'vitest';
import { Story, type StoryHooks, type Vec } from '../src/game/Story';

describe('story: Last Signal', () => {
  const places = { stash: { x: 10, y: 20, z: 0 }, shards: [{ x: 20, y: 20, z: 0 }, { x: 30, y: 22, z: 0 }, { x: 40, y: 18, z: 5 }], supplies: { x: 50, y: 25, z: 0 }, spireTop: { x: 60, y: 78, z: 0 } };
  const log = () => {
    const l = { said: 0, items: [] as string[], night: [] as boolean[], climbers: 0, ended: false, obj: '' };
    const h: StoryHooks = { say: (x) => { l.said += x.length; }, objective: (t) => { l.obj = t; }, give: (i) => l.items.push(i), night: (n) => l.night.push(n), spawnClimber: () => l.climbers++, end: () => { l.ended = true; } };
    return { l, h };
  };
  const at = (s: Story, v: Vec, secs = 0.1, alive = true) => { for (let t = 0; t < secs; t += 1 / 30) s.update(1 / 30, v, alive); };

  it('plays through all four chapters in order', () => {
    const { l, h } = log();
    const s = new Story(places, h);
    s.start(0);
    expect(l.obj).toBe('Reach your stash');
    at(s, { x: 0, y: 20, z: 0 }); expect(s.chapter).toBe(0);           // not there yet
    at(s, places.stash); expect(l.items).toEqual(['katana']); expect(s.chapter).toBe(1);
    at(s, places.shards[1]); expect(s.step).toBe(0);                    // shards go in order
    for (const sh of places.shards) at(s, sh);
    expect(s.chapter).toBe(2); expect(l.night.at(-1)).toBe(true);
    at(s, places.spireTop); expect(s.chapter).toBe(2);                  // the cache comes first
    at(s, places.supplies); expect(l.items).toEqual(['katana', 'pipe', 'flares']);
    at(s, places.spireTop); expect(s.chapter).toBe(3);
    at(s, places.spireTop, 30); expect(s.done).toBe(false);
    at(s, places.spireTop, 10, false); expect(s.done).toBe(false);      // dead: the hold timer pauses
    at(s, places.spireTop, 31); expect(s.done).toBe(true);
    expect(l.ended).toBe(true);
    expect(l.climbers).toBeGreaterThan(8);
    expect(l.said).toBeGreaterThan(10);
  });

  it('can resume at any chapter', () => {
    const { l, h } = log();
    const s = new Story(places, h);
    s.start(2);
    expect(l.night).toEqual([true]);
    expect(l.obj).toBe('Grab the supply cache');
  });
});
