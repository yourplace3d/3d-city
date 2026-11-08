/**
 * Matching for steepness: how steep a road, path or route is, from the model's terrain.
 *
 * The terrain data has points 10–30 m apart, so the grade at a point is taken over a window
 * (60 m) rather than between neighbouring samples, and very short runs of one class are merged
 * into their neighbours. Steepness always comes from the real heights, whatever the
 * exaggeration on screen. Bridges span valleys the terrain dips into, so their heights are
 * bridged straight across (routes) or they're left out (roads).
 */

import type { Pt } from '../types';

/** Lower bounds of the classes gentle, moderate, steep and very steep (grade, 0.03 = 3 %). */
export const STEEP_BOUNDS = [0.03, 0.06, 0.1, 0.15] as const;
/** 0 flat, 1 gentle, 2 moderate, 3 steep, 4 very steep */
export type SteepClass = 0 | 1 | 2 | 3 | 4;

export const SAMPLE_STEP_M = 10;
export const GRADE_WINDOW_M = 60;
/** Runs of one class shorter than this take their neighbour's class (no speckle). */
export const MIN_RUN_M = 25;

export function steepClass(grade: number): SteepClass {
  const g = Math.abs(grade);
  let c = 0;
  while (c < STEEP_BOUNDS.length && g >= STEEP_BOUNDS[c]) c++;
  return c as SteepClass;
}

export interface LineSample {
  /** metres along the line from its first point */
  d: number;
  e: number;
  n: number;
  /** ground height (m above sea level) */
  h: number;
  /** grade over the window, signed in the line's direction (0.08 = 8 % up) */
  g: number;
}

/**
 * Samples every ~10 m along a line, with heights and grades. `onBridge(i, samples)` marks
 * samples whose heights should run straight between the ground on either side.
 */
export function sampleLine(
  pts: Pt[],
  heightAt: (e: number, n: number) => number,
  opts: { step?: number; window?: number; onBridge?: (s: LineSample, i: number, all: LineSample[]) => boolean } = {},
): LineSample[] {
  const step = opts.step ?? SAMPLE_STEP_M;
  const out: LineSample[] = [];
  let d = 0;
  const push = (e: number, n: number) => out.push({ d, e, n, h: heightAt(e, n), g: 0 });
  if (!pts.length) return out;
  push(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const parts = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= parts; i++) {
      d += len / parts;
      push(ax + ((bx - ax) * i) / parts, ay + ((by - ay) * i) / parts);
    }
  }
  const onBridge = opts.onBridge;
  if (onBridge) bridgeAcross(out, out.map((x, i, all) => onBridge(x, i, all)));
  grades(out, opts.window ?? GRADE_WINDOW_M);
  return out;
}

/** Heights on bridges: a straight line between the ground at either end. */
function bridgeAcross(s: LineSample[], on: boolean[]): void {
  let i = 0;
  while (i < s.length) {
    if (!on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && on[j]) j++;
    const a = i > 0 ? s[i - 1] : null;
    const b = j < s.length ? s[j] : null;
    for (let k = i; k < j; k++) {
      if (a && b) s[k].h = a.h + ((b.h - a.h) * (s[k].d - a.d)) / (b.d - a.d);
      else if (a || b) s[k].h = (a ?? b)!.h;
    }
    i = j;
  }
}

/**
 * Each sample's grade over `window` metres around it. Near the ends the window slides inwards
 * rather than shrinking, so the first and last metres of a road aren't noisier than the rest;
 * a line shorter than the window gets its overall grade.
 */
function grades(s: LineSample[], window: number): void {
  if (s.length < 2) return;
  const total = s[s.length - 1].d;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.max(0, Math.min(s[i].d - window / 2, total - window));
    const b = Math.min(total, a + window);
    while (lo < s.length - 1 && s[lo + 1].d <= a + 1e-9) lo++;
    while (hi < s.length - 1 && s[hi].d < b - 1e-9) hi++;
    const p = s[lo];
    const q = s[hi];
    s[i].g = q.d > p.d ? (q.h - p.h) / (q.d - p.d) : 0;
  }
}

interface Run {
  c: SteepClass;
  /** samples [a, b) */
  a: number;
  b: number;
}

/** Runs of one class along the samples; runs shorter than `minRun` metres join the longer neighbour. */
function mergedRuns(s: LineSample[], minRun: number): Run[] {
  let runs: Run[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = steepClass(s[i].g);
    const last = runs[runs.length - 1];
    if (last && last.c === c) last.b = i + 1;
    else runs.push({ c, a: i, b: i + 1 });
  }
  const len = (r: Run) => s[Math.min(r.b, s.length - 1)].d - s[r.a].d;
  // fold the shortest short run into its longer neighbour until none is left
  for (let guard = 0; runs.length > 1 && guard < 100000; guard++) {
    let k = -1;
    for (let i = 0; i < runs.length; i++) if (len(runs[i]) < minRun && (k < 0 || len(runs[i]) < len(runs[k]))) k = i;
    if (k < 0) break;
    const prev = runs[k - 1];
    const next = runs[k + 1];
    const into = !prev ? next : !next ? prev : len(prev) >= len(next) ? prev : next;
    into.a = Math.min(into.a, runs[k].a);
    into.b = Math.max(into.b, runs[k].b);
    runs.splice(k, 1);
    // neighbours of the same class become one run
    runs = runs.reduce<Run[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && last.c === r.c) last.b = r.b;
      else acc.push(r);
      return acc;
    }, []);
  }
  return runs;
}

/** A stretch of one class, as points (it shares its end point with the next one). */
export interface ClassPiece {
  cls: SteepClass;
  pts: Pt[];
  lengthM: number;
}

/** The line cut into runs of one steepness class; runs shorter than MIN_RUN_M join a neighbour. */
export function classRuns(s: LineSample[], minRun = MIN_RUN_M): ClassPiece[] {
  if (s.length < 2) return [];
  return mergedRuns(s, minRun).map((r) => {
    const end = Math.min(r.b, s.length - 1);
    const pts: Pt[] = [];
    for (let i = r.a; i <= end; i++) pts.push([s[i].e, s[i].n]);
    return { cls: r.c, pts, lengthM: s[end].d - s[r.a].d };
  });
}

/** The class of each sample after merging short runs (what the model shows), for the profile. */
export function sampleClasses(s: LineSample[], minRun = MIN_RUN_M): SteepClass[] {
  const out: SteepClass[] = new Array(s.length).fill(0);
  if (s.length < 2) return out;
  for (const r of mergedRuns(s, minRun)) for (let i = r.a; i < r.b; i++) out[i] = r.c;
  return out;
}

/** Height gained and lost along the samples, ignoring wobbles under `hysteresis` metres. */
export function climbTotals(s: LineSample[], hysteresis = 2): { up: number; down: number; low: number; high: number } {
  let up = 0;
  let down = 0;
  let low = Infinity;
  let high = -Infinity;
  let ref = s[0]?.h ?? 0;
  for (const x of s) {
    low = Math.min(low, x.h);
    high = Math.max(high, x.h);
    if (x.h - ref >= hysteresis) {
      up += x.h - ref;
      ref = x.h;
    } else if (ref - x.h >= hysteresis) {
      down += ref - x.h;
      ref = x.h;
    }
  }
  return { up, down, low: s.length ? low : 0, high: s.length ? high : 0 };
}

export interface SteepSection {
  /** metres along the line */
  from: number;
  to: number;
  /** average grade over the section, signed (+ climbs) */
  grade: number;
  /** its middle, for a label */
  at: Pt;
}

/**
 * The steepest sustained sections: runs at least `minGrade` steep in one direction and at
 * least `minLength` long, steepest first.
 */
export function steepSections(s: LineSample[], minGrade = STEEP_BOUNDS[1], minLength = 100): SteepSection[] {
  const out: SteepSection[] = [];
  let i = 0;
  while (i < s.length) {
    const sign = Math.sign(s[i].g);
    if (Math.abs(s[i].g) < minGrade || sign === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < s.length && Math.sign(s[j + 1].g) === sign && Math.abs(s[j + 1].g) >= minGrade) j++;
    const len = s[j].d - s[i].d;
    if (len >= minLength) {
      const mid = s[(i + j) >> 1];
      out.push({ from: s[i].d, to: s[j].d, grade: (s[j].h - s[i].h) / len, at: [mid.e, mid.n] });
    }
    i = j + 1;
  }
  return out.filter((x) => Math.abs(x.grade) >= minGrade * 0.8).sort((a, b) => Math.abs(b.grade) - Math.abs(a.grade));
}

/**
 * Whether a sample of a line runs along a bridge: within `maxDist` of a bridge and heading the
 * same way (a road passing under a bridge crosses it, so it isn't on it).
 */
export function bridgeTester(bridges: Pt[][], maxDist = 12, maxAngleDeg = 30): (s: LineSample, i: number, all: LineSample[]) => boolean {
  const segs: Array<[number, number, number, number]> = [];
  for (const b of bridges) for (let k = 1; k < b.length; k++) segs.push([b[k - 1][0], b[k - 1][1], b[k][0], b[k][1]]);
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  const r2 = maxDist * maxDist;
  return (s, i, all) => {
    if (!segs.length) return false;
    const p = all[Math.max(0, i - 1)];
    const q = all[Math.min(all.length - 1, i + 1)];
    const dx = q.e - p.e;
    const dy = q.n - p.n;
    const dl = Math.hypot(dx, dy);
    if (!dl) return false;
    for (const [ax, ay, bx, by] of segs) {
      if (s.e < Math.min(ax, bx) - maxDist || s.e > Math.max(ax, bx) + maxDist || s.n < Math.min(ay, by) - maxDist || s.n > Math.max(ay, by) + maxDist) continue;
      const sx = bx - ax;
      const sy = by - ay;
      const sl2 = sx * sx + sy * sy;
      if (!sl2) continue;
      const k = Math.min(1, Math.max(0, ((s.e - ax) * sx + (s.n - ay) * sy) / sl2));
      const ex = ax + k * sx - s.e;
      const ey = ay + k * sy - s.n;
      if (ex * ex + ey * ey > r2) continue;
      if (Math.abs(dx * sx + dy * sy) / (dl * Math.sqrt(sl2)) >= cosMax) return true;
    }
    return false;
  };
}

/** A line of the map, as far as steepness needs it. */
export interface MapLine {
  kind: string;
  pts: Pt[];
  widthM: number;
  bridge: boolean;
}

/** Line kinds people walk, run or ride on. */
const WAYS = new Set(['motorway', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path']);

/**
 * Roads and paths cut into pieces by steepness, with the length of each class (m, index by
 * class). Bridges are left out: the terrain under them is the valley, not the deck.
 */
export function steepRoads(lines: MapLine[], heightAt: (e: number, n: number) => number): { pieces: Array<ClassPiece & { widthM: number }>; lengths: number[] } {
  const pieces: Array<ClassPiece & { widthM: number }> = [];
  const lengths = [0, 0, 0, 0, 0];
  for (const l of lines) {
    if (!WAYS.has(l.kind) || l.bridge || l.pts.length < 2) continue;
    for (const r of classRuns(sampleLine(l.pts, heightAt))) {
      lengths[r.cls] += r.lengthM;
      if (r.cls > 0) pieces.push({ ...r, widthM: l.widthM });
    }
  }
  return { pieces, lengths };
}
