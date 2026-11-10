/**
 * Match: values per area on the model. Each building gets the value of the area it stands in
 * (a neighbourhood, a block group, a census square). Single points, such as sales, are never
 * shown one by one: they become the median of each 100 m square that has at least five, so no
 * single home's price shows.
 *
 * The colours come in five classes, split where the areas in the square split into fifths, so a
 * place's own differences show whatever its price level; the legend gives the numbers.
 */

import type { AreaCut, AreaGeometry } from '../sources/areaFile';

export interface AreaShape {
  /** rings as flat E, N pairs (metres from the centre) */
  rings: Float32Array[];
  e0: number;
  n0: number;
  e1: number;
  n1: number;
  /** the area (m²), so the smallest wins where areas overlap */
  size: number;
  value: number;
  name: string;
  uncertain: boolean;
  /** for medians of points: how many there were */
  count: number;
}

export interface Areas {
  geometry: AreaGeometry;
  /** the side of a grid square (m), for cells and points */
  cellM: number;
  /** the areas with a value */
  shapes: AreaShape[];
}

/** Points become squares of this side … */
export const POINT_CELL_M = 100;
/** … with at least this many points in them. */
export const MIN_POINTS = 5;

function ringArea(r: ArrayLike<number>): number {
  let a = 0;
  for (let k = 0, j = r.length - 2; k < r.length; j = k, k += 2) a += (r[j] + r[k]) * (r[k + 1] - r[j + 1]);
  return Math.abs(a / 2);
}

function inRing(r: ArrayLike<number>, e: number, n: number): boolean {
  let inside = false;
  for (let k = 0, j = r.length - 2; k < r.length; j = k, k += 2) {
    const yi = r[k + 1];
    const yj = r[j + 1];
    if (yi > n !== yj > n && e < ((r[j] - r[k]) * (n - yi)) / (yj - yi) + r[k]) inside = !inside;
  }
  return inside;
}

function shapeOf(rings: number[][], value: number, name: string, uncertain: boolean, count = 1): AreaShape {
  let e0 = Infinity;
  let n0 = Infinity;
  let e1 = -Infinity;
  let n1 = -Infinity;
  for (const r of rings) {
    for (let k = 0; k < r.length; k += 2) {
      e0 = Math.min(e0, r[k]);
      e1 = Math.max(e1, r[k]);
      n0 = Math.min(n0, r[k + 1]);
      n1 = Math.max(n1, r[k + 1]);
    }
  }
  // a ring inside an odd number of others is a hole: whichever way the file winds its rings
  const areas = rings.map(ringArea);
  let size = 0;
  rings.forEach((r, k) => {
    let depth = 0;
    rings.forEach((o, j) => {
      if (j !== k && areas[j] > areas[k] && inRing(o, r[0], r[1])) depth++;
    });
    size += depth % 2 ? -areas[k] : areas[k];
  });
  return { rings: rings.map((r) => Float32Array.from(r)), e0, n0, e1, n1, size: Math.max(0, size), value, name, uncertain, count };
}

export function median(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (!n) return NaN;
  return n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** The areas of a file with a value in `column` (an index into `cut.columns`). */
export function areasFor(cut: AreaCut, column: number): Areas {
  const values = cut.values[column];
  if (cut.geometry !== 'points') {
    const shapes: AreaShape[] = [];
    cut.features.forEach((f, i) => {
      const v = values?.[i];
      if (Number.isFinite(v)) shapes.push(shapeOf(f.rings, v, f.name, f.uncertain));
    });
    return { geometry: cut.geometry, cellM: cut.cellM, shapes };
  }
  // points: the median of each square
  const bins = new Map<string, number[]>();
  cut.features.forEach((f, i) => {
    const v = values?.[i];
    if (!Number.isFinite(v)) return;
    const [e, n] = f.rings[0];
    const key = `${Math.floor(e / POINT_CELL_M)},${Math.floor(n / POINT_CELL_M)}`;
    let bin = bins.get(key);
    if (!bin) bins.set(key, (bin = []));
    bin.push(v);
  });
  const shapes: AreaShape[] = [];
  for (const [key, bin] of bins) {
    if (bin.length < MIN_POINTS) continue;
    const [i, j] = key.split(',').map(Number);
    const e = i * POINT_CELL_M;
    const n = j * POINT_CELL_M;
    const s = POINT_CELL_M;
    bin.sort((a, b) => a - b);
    shapes.push(shapeOf([[e, n, e + s, n, e + s, n + s, e, n + s]], median(bin), '', false, bin.length));
  }
  return { geometry: 'points', cellM: POINT_CELL_M, shapes };
}

/** Whether a point is inside a shape (even–odd over all its rings, so holes and several parts work). */
export function insideShape(s: AreaShape, e: number, n: number): boolean {
  if (e < s.e0 || e > s.e1 || n < s.n0 || n > s.n1) return false;
  let inside = false;
  for (const r of s.rings) if (inRing(r, e, n)) inside = !inside;
  return inside;
}

/** Finds the area a point is in, fast: shapes are filed in buckets of the square by their bounds. */
export class AreaIndex {
  private readonly buckets: number[][];
  private readonly cols: number;
  private readonly h: number;

  constructor(
    readonly shapes: AreaShape[],
    sizeM: number,
    private readonly bucketM = 100,
  ) {
    this.h = sizeM / 2;
    this.cols = Math.max(1, Math.ceil(sizeM / bucketM));
    this.buckets = Array.from({ length: this.cols * this.cols }, () => []);
    shapes.forEach((s, i) => {
      const [c0, r0] = this.cell(s.e0, s.n0);
      const [c1, r1] = this.cell(s.e1, s.n1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c].push(i);
    });
  }

  private cell(e: number, n: number): [number, number] {
    const clamp = (v: number) => Math.max(0, Math.min(this.cols - 1, Math.floor((v + this.h) / this.bucketM)));
    return [clamp(e), clamp(n)];
  }

  /** the smallest area holding the point, or -1 */
  at(e: number, n: number): number {
    if (Math.abs(e) > this.h || Math.abs(n) > this.h) return -1;
    const [c, r] = this.cell(e, n);
    let best = -1;
    for (const i of this.buckets[r * this.cols + c]) {
      const s = this.shapes[i];
      if ((best < 0 || s.size < this.shapes[best].size) && insideShape(s, e, n)) best = i;
    }
    return best;
  }
}

/** A number rounded to two significant digits: 8.37 → 8.4, 602 → 600, 111364 → 110000. */
export function roundNicely(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / p) * p;
}

/**
 * Where the classes split: the values at each fifth of the areas, rounded nicely; fewer when
 * the values don't differ enough. A value v is in class k when breaks[k-1] <= v < breaks[k].
 */
export function classBreaks(values: readonly number[], classes = 5): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const out: number[] = [];
  for (let k = 1; k < classes; k++) {
    const b = roundNicely(sorted[Math.min(sorted.length - 1, Math.round((k * sorted.length) / classes))]);
    if (b > sorted[0] && b <= sorted[sorted.length - 1] && (!out.length || b > out[out.length - 1])) out.push(b);
  }
  return out;
}

/** The class of a value (0 = lowest), given the breaks. */
export function classOf(v: number, breaks: readonly number[]): number {
  let k = 0;
  while (k < breaks.length && v >= breaks[k]) k++;
  return k;
}

/** The share of areas with a lower value than v (0 … 1). */
export function shareBelow(v: number, values: readonly number[]): number {
  if (!values.length) return NaN;
  let below = 0;
  for (const x of values) if (x < v) below++;
  return below / values.length;
}

/** The areas a building's middle falls in, per building (index into the shapes, or -1). */
export function buildingAreas(index: AreaIndex, centres: ArrayLike<number>): Int32Array {
  const out = new Int32Array(centres.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = index.at(centres[i * 2], centres[i * 2 + 1]);
  return out;
}
