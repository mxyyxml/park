import { describe, expect, it } from 'vitest';
import { terrainHeight, TERRAIN_INNER, SEA_LEVEL } from '../src/world/Terrain';

describe('landscape', () => {
  it('stays flat under the whole city, including its outer corners', () => {
    for (const [x, z] of [[0, 0], [736, 643], [-736, -643], [736, -643], [-736, 643]]) expect(terrainHeight(x, z)).toBeLessThan(0);
    expect(Math.hypot(736, 643)).toBeLessThan(TERRAIN_INNER);
  });
  it('rises into a mountain range to the north-west and falls into the sea to the south-east', () => {
    let peak = 0, deep = 0;
    for (let r = 1500; r <= 6000; r += 250) for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const h = terrainHeight(Math.cos(a) * r, Math.sin(a) * r);
      if (Math.cos(a - Math.PI * 1.25) > 0.7) peak = Math.max(peak, h);
      if (Math.cos(a - Math.PI * 0.3) > 0.8) deep = Math.min(deep, h);
    }
    expect(peak).toBeGreaterThan(400);
    expect(deep).toBeLessThan(SEA_LEVEL - 10);
  });
});
