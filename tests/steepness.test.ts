import { describe, expect, it } from 'vitest';
import {
  bridgeTester,
  classRuns,
  climbTotals,
  sampleClasses,
  sampleLine,
  steepClass,
  steepRoads,
  steepSections,
  type LineSample,
} from '../src/data/match/slope';
import { profileScale, profileSvg, sampleAtFraction } from '../src/data/display/profile';
import { STEEP_COLOURS } from '../src/data/display/steepness';
import type { Pt } from '../src/data/types';

/** Ground rising 8 % to the east. */
const ramp = (e: number) => e * 0.08;

describe('steepness classes', () => {
  it('sorts grades into flat, gentle, moderate, steep and very steep, either way', () => {
    expect([0, 0.029, 0.03, 0.059, 0.06, 0.099, 0.1, 0.149, 0.15, 0.4].map(steepClass)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(steepClass(-0.12)).toBe(3);
  });
});

describe('sampling a line on the terrain', () => {
  it('measures the grade along the line, signed in its direction', () => {
    const up = sampleLine([[0, 0], [500, 0]], (e) => ramp(e));
    expect(up[up.length - 1].d).toBeCloseTo(500, 6);
    expect(up.length).toBeGreaterThanOrEqual(51);
    for (const s of up) expect(s.g).toBeCloseTo(0.08, 6);
    const down = sampleLine([[500, 0], [0, 0]], (e) => ramp(e));
    for (const s of down) expect(s.g).toBeCloseTo(-0.08, 6);
    const runs = classRuns(up);
    expect(runs).toHaveLength(1);
    expect(runs[0].cls).toBe(2);
    expect(runs[0].lengthM).toBeCloseTo(500, 6);
  });

  it('takes the grade over a window, so terrain noise doesn’t make every metre steep', () => {
    // flat ground with ±0.5 m noise every 10 m: neighbours alone would read as 10 % slopes
    const noisy = sampleLine([[0, 0], [400, 0]], (e) => (Math.round(e / 10) % 2 ? 0.5 : -0.5));
    expect(Math.max(...noisy.map((s) => Math.abs(s.g)))).toBeLessThan(0.03);
    expect(classRuns(noisy).every((r) => r.cls === 0)).toBe(true);
  });

  it('merges runs too short to show into their neighbours', () => {
    // flat, a 20 m kink, flat
    const h = (e: number) => (e < 200 ? 0 : e < 220 ? (e - 200) * 0.2 : 4);
    const runs = classRuns(sampleLine([[0, 0], [600, 0]], h));
    for (const r of runs.slice(1, -1)) expect(r.lengthM).toBeGreaterThanOrEqual(25);
    const classes = sampleClasses(sampleLine([[0, 0], [600, 0]], h));
    expect(classes).toHaveLength(61);
  });

  it('runs straight across bridges instead of down into the valley', () => {
    // flat at 100 m, a 30 m deep valley between 200 and 300 m
    const valley = (e: number) => (e > 200 && e < 300 ? 70 : 100);
    const line: Pt[] = [[0, 0], [500, 0]];
    const plain = sampleLine(line, valley);
    expect(classRuns(plain).some((r) => r.cls === 4)).toBe(true);
    const onBridge = bridgeTester([[[190, 2], [310, 2]]]);
    const bridged = sampleLine(line, valley, { onBridge });
    expect(Math.min(...bridged.map((s) => s.h))).toBe(100);
    expect(classRuns(bridged).every((r) => r.cls === 0)).toBe(true);
    // a road passing under the bridge crosses it: not on it
    const under = sampleLine([[250, -200], [250, 200]], () => 70, { onBridge });
    expect(under.every((s) => s.h === 70)).toBe(true);
  });

  it('adds up the height gained and lost, ignoring wobbles', () => {
    const hill = (e: number) => (e < 500 ? e * 0.1 : (1000 - e) * 0.1) + (Math.round(e / 10) % 2 ? 0.4 : 0);
    const t = climbTotals(sampleLine([[0, 0], [1000, 0]], hill));
    expect(t.up).toBeGreaterThan(48);
    expect(t.up).toBeLessThan(53);
    expect(t.down).toBeGreaterThan(48);
    expect(t.down).toBeLessThan(53);
    expect(t.high).toBeCloseTo(50, 0);
  });

  it('finds the steepest sustained sections', () => {
    // flat, a 300 m climb at 12 %, flat, a 200 m descent at 7 %
    const h = (e: number) => {
      if (e < 200) return 0;
      if (e < 500) return (e - 200) * 0.12;
      if (e < 800) return 36;
      if (e < 1000) return 36 - (e - 800) * 0.07;
      return 22;
    };
    const s = steepSections(sampleLine([[0, 0], [1200, 0]], h));
    expect(s).toHaveLength(2);
    expect(s[0].grade).toBeGreaterThan(0.1);
    expect(s[0].to - s[0].from).toBeGreaterThan(220);
    expect(s[0].at[0]).toBeGreaterThan(300);
    expect(s[0].at[0]).toBeLessThan(400);
    expect(s[1].grade).toBeLessThan(-0.05);
  });
});

describe('steep roads', () => {
  it('colours roads and paths, never bridges, railways or rivers', () => {
    const lines = [
      { kind: 'minor', pts: [[0, 0], [400, 0]] as Pt[], widthM: 6, bridge: false },
      { kind: 'path', pts: [[0, 50], [0, 450]] as Pt[], widthM: 2, bridge: false },
      { kind: 'primary', pts: [[0, 100], [400, 100]] as Pt[], widthM: 12, bridge: true },
      { kind: 'rail', pts: [[0, 200], [400, 200]] as Pt[], widthM: 4, bridge: false },
      { kind: 'river', pts: [[0, 300], [400, 300]] as Pt[], widthM: 20, bridge: false },
    ];
    const { pieces, lengths } = steepRoads(lines, (e) => ramp(e));
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ cls: 2, widthM: 6 });
    // the north-going path is flat: counted, not coloured
    expect(lengths[0]).toBeCloseTo(400, 3);
    expect(lengths[2]).toBeCloseTo(400, 3);
  });
});

describe('height profile', () => {
  const s = sampleLine([[0, 0], [1000, 0]], (e) => (e < 500 ? 200 : 200 + (e - 500) * 0.12));

  it('scales to the heights, at least 20 m so flat stays flat', () => {
    const sc = profileScale(s);
    expect(sc.y0).toBeLessThan(200);
    expect(sc.y1).toBeGreaterThan(260);
    expect(sc.dMax).toBeCloseTo(1000, 6);
    const flat = profileScale(sampleLine([[0, 0], [300, 0]], () => 50));
    expect(flat.y1 - flat.y0).toBeCloseTo(23, 6);
  });

  it('draws the line in the steepness colours, flat parts in ink', () => {
    const svg = profileSvg(s);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('stroke="#8a8378"');
    expect(svg).toContain(`stroke="${STEEP_COLOURS[2]}"`);
    expect(svg.match(/<path d=/g)?.length).toBe(2);
    expect(profileSvg([] as LineSample[])).toBe('');
  });

  it('finds the sample under the pointer', () => {
    expect(sampleAtFraction(s, 0).d).toBe(0);
    expect(sampleAtFraction(s, 0.5).d).toBeCloseTo(500, 6);
    expect(sampleAtFraction(s, 2).d).toBeCloseTo(1000, 6);
  });
});
