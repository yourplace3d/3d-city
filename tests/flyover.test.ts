import { describe, expect, it } from 'vitest';
import { flyoverFileName, flyoverPose, type FlightSpace } from '../src/ui/flyover';

const space: FlightSpace = { sizeM: 2000, groundY: 30, topY: 180 };
const steps = Array.from({ length: 21 }, (_, i) => i / 20);

describe('flyover path', () => {
  it('stays over the square, camera and aim', () => {
    for (const dir of ['ne', 'nw'] as const) {
      for (const k of steps) {
        const { pos, look } = flyoverPose(k, dir, space);
        for (const v of [pos[0], pos[1], look[0], look[1]]) expect(Math.abs(v)).toBeLessThanOrEqual(space.sizeM / 2);
      }
    }
  });

  it('flies above the tallest building and looks ahead and down', () => {
    for (const k of steps) {
      const { pos, look } = flyoverPose(k, 'ne', space);
      expect(pos[2]).toBeGreaterThan(space.topY);
      expect(look[2]).toBeLessThan(pos[2]);
      expect(look[0]).toBeGreaterThan(pos[0]);
      expect(look[1]).toBeGreaterThan(pos[1]);
    }
  });

  it('keeps clear of tall towers and hills', () => {
    const tall = { ...space, topY: 900 };
    const { pos, look } = flyoverPose(0.5, 'ne', tall);
    expect(pos[2]).toBeGreaterThan(900);
    expect(Math.abs(look[0])).toBeLessThanOrEqual(tall.sizeM / 2);
  });

  it('goes the chosen way along the diagonal, without turning back', () => {
    const ne = steps.map((k) => flyoverPose(k, 'ne', space).pos);
    const nw = steps.map((k) => flyoverPose(k, 'nw', space).pos);
    for (let i = 1; i < steps.length; i++) {
      expect(ne[i][0]).toBeGreaterThan(ne[i - 1][0]);
      expect(ne[i][1]).toBeGreaterThan(ne[i - 1][1]);
      expect(nw[i][0]).toBeLessThan(nw[i - 1][0]);
      expect(nw[i][1]).toBeGreaterThan(nw[i - 1][1]);
    }
    // it starts in the south-west (or south-east) and passes the centre
    expect(ne[0][0]).toBeLessThan(0);
    expect(nw[0][0]).toBeGreaterThan(0);
    expect(ne[20][1]).toBeGreaterThan(0);
  });

  it('names the file after the place', () => {
    expect(flyoverFileName('Kleinfelde', 2000)).toBe('your-place-kleinfelde-2km-flyover.mp4');
    expect(flyoverFileName('São Paulo', 500)).toBe('your-place-sao-paulo-500m-flyover.mp4');
  });
});
