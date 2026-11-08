/**
 * Matching for routes: distance along the route, the stretch the user picks, the square that
 * fits it, trimming the ends for privacy, and where a runner is at a moment of the replay.
 *
 * Distances are "route metres": metres from the route's real start. A stretch shared by link
 * starts part-way, so its first point carries that offset and km markers keep their numbers.
 */

import { makeProjector, type LngLat } from '../../geo/projection';
import { AREA_MAX, AREA_MIN, AREA_STEP } from '../../state';
import type { Pt, Track, TrackPoint } from '../types';

export interface Route {
  name: string;
  points: TrackPoint[];
  /** route metres at each point */
  dist: Float64Array;
  /** every point has a time (a recorded activity, not a planned course) */
  hasTime: boolean;
  /** time of the real start, for the race clock in the replay */
  t0: number;
  /** whether the route's real start / finish are among the points (not trimmed or left out of a link) */
  hasStart: boolean;
  hasFinish: boolean;
}

/**
 * Metres between two points, from the WGS84 ellipsoid's metres per degree at their mean latitude
 * (the projection's series). A sphere would make east–west distances 0.3 % short in Europe:
 * 120 m over a marathon, enough to put the km markers visibly off.
 */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const phi = ((a.lat + b.lat) / 2) * RAD;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return Math.hypot((b.lat - a.lat) * mLat, (b.lon - a.lon) * mLon);
}

const RAD = Math.PI / 180;

/** A route from a track; `offset` is the route metres of its first point (a stretch from a link). */
export function makeRoute(track: Track, opts: { offset?: number; hasStart?: boolean; hasFinish?: boolean } = {}): Route {
  const points = track.points;
  const dist = new Float64Array(points.length);
  dist[0] = opts.offset ?? 0;
  for (let i = 1; i < points.length; i++) dist[i] = dist[i - 1] + distanceM(points[i - 1], points[i]);
  const hasTime = points.length > 0 && points.every((p) => Number.isFinite(p.time));
  if (hasTime) {
    // clocks jump back now and then (GPS resync): keep time running forwards
    for (let i = 1; i < points.length; i++) if (points[i].time! < points[i - 1].time!) points[i] = { ...points[i], time: points[i - 1].time };
  }
  return {
    name: track.name,
    points,
    dist,
    hasTime,
    t0: hasTime ? points[0].time! : 0,
    hasStart: opts.hasStart ?? true,
    hasFinish: opts.hasFinish ?? true,
  };
}

export const startOf = (r: Route): number => r.dist[0];
export const endOf = (r: Route): number => r.dist[r.dist.length - 1];

/** Index i with dist[i] <= m < dist[i + 1] (clamped to the route). */
function segmentAt(dist: Float64Array, m: number): number {
  let lo = 0;
  let hi = dist.length - 1;
  if (m <= dist[0]) return 0;
  if (m >= dist[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= m) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The point at route metres `m`, between the recorded points. */
export function pointAt(r: Route, m: number): TrackPoint {
  const i = segmentAt(r.dist, m);
  const a = r.points[i];
  const b = r.points[i + 1] ?? a;
  const len = r.dist[i + 1] - r.dist[i];
  const k = len > 0 ? Math.min(1, Math.max(0, (m - r.dist[i]) / len)) : 0;
  const p: TrackPoint = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
  if (r.hasTime) p.time = a.time! + (b.time! - a.time!) * k;
  return p;
}

/** The points from `fromM` to `toM`, with exact end points. */
export function stretchOf(r: Route, fromM: number, toM: number): TrackPoint[] {
  const out: TrackPoint[] = [pointAt(r, fromM)];
  for (let i = 0; i < r.points.length; i++) if (r.dist[i] > fromM && r.dist[i] < toM) out.push(r.points[i]);
  out.push(pointAt(r, toM));
  return out;
}

/** The route without its first and last `m` metres, where a run from home starts and ends. */
export function trimEnds(r: Route, m: number): Route {
  if (!r.hasStart && !r.hasFinish) return r;
  const from = r.hasStart ? startOf(r) + m : startOf(r);
  const to = r.hasFinish ? endOf(r) - m : endOf(r);
  if (to - from < 50) return r; // too short to trim; keep it rather than leave nothing
  const points = stretchOf(r, from, to);
  const trimmed = makeRoute({ name: r.name, points }, { offset: from, hasStart: false, hasFinish: false });
  return { ...trimmed, t0: r.t0, hasTime: trimmed.hasTime && r.hasTime };
}

/** Edge room around a stretch, so it doesn't run along the model's walls. */
export function marginFor(extentM: number): number {
  return Math.max(60, extentM * 0.08);
}

/** The square side (m) that holds a stretch `extentM` across; may exceed AREA_MAX (then it doesn't fit). */
export function sizeFor(extentM: number): number {
  const need = extentM + 2 * marginFor(extentM);
  return Math.max(AREA_MIN, Math.ceil(need / AREA_STEP) * AREA_STEP);
}

function boxOf(points: TrackPoint[]) {
  const p = makeProjector(points[0]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of points) {
    const [x, y] = p.toLocal(q.lon, q.lat);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { p, x0, y0, x1, y1, extent: Math.max(x1 - x0, y1 - y0) };
}

/** The square for a stretch: centred on its box, a side in 100 m steps from 300 m up to the largest. */
export function squareFor(points: TrackPoint[]): { center: LngLat; size: number } {
  const b = boxOf(points);
  const c = b.p.toLngLat((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  return { center: { lat: c.lat, lon: c.lon }, size: Math.min(AREA_MAX, sizeFor(b.extent)) };
}

/** The shortest stretch the picker allows (m), unless the whole route is shorter. */
export const MIN_STRETCH_M = 100;

/**
 * The stretch, shortened so it fits the largest model. `keep` is the end the user is moving:
 * moving the start pulls the end in, moving the end pushes the start along. Returns route metres.
 */
export function fitStretch(r: Route, fromM: number, toM: number, keep: 'from' | 'to', maxSizeM = AREA_MAX): { fromM: number; toM: number } {
  const lo = startOf(r);
  const hi = endOf(r);
  const min = Math.min(MIN_STRETCH_M, hi - lo);
  let from = Math.min(Math.max(fromM, lo), hi);
  let to = Math.min(Math.max(toM, lo), hi);
  // never shorter than the minimum: the moving end pushes the other one along
  if (to - from < min) {
    if (keep === 'from') {
      to = Math.min(hi, from + min);
      from = to - min;
    } else {
      from = Math.max(lo, to - min);
      to = from + min;
    }
  }
  const fits = (a: number, b: number) => sizeFor(boxOf(stretchOf(r, a, b)).extent) <= maxSizeM;
  if (fits(from, to)) return { fromM: from, toM: to };
  // binary search on the far end's position (the box only grows as the stretch gets longer)
  let ok = keep === 'from' ? from : to;
  let bad = keep === 'from' ? to : from;
  for (let k = 0; k < 40 && Math.abs(bad - ok) > 1; k++) {
    const mid = (ok + bad) / 2;
    if (keep === 'from' ? fits(from, mid) : fits(mid, to)) ok = mid;
    else bad = mid;
  }
  return keep === 'from' ? { fromM: from, toM: ok } : { fromM: ok, toM: to };
}

/** The stretch shown first: the whole route if it fits, else the finish, the moment of a race. */
export function defaultStretch(r: Route, maxSizeM = AREA_MAX): { fromM: number; toM: number } {
  return fitStretch(r, startOf(r), endOf(r), 'to', maxSizeM);
}

/** Whole kilometres after `fromM` up to `toM`, for the markers. */
export function kmMarks(fromM: number, toM: number): number[] {
  const out: number[] = [];
  for (let km = Math.floor(fromM / 1000) + 1; km * 1000 <= toM; km++) out.push(km);
  return out;
}

/** Points in the model's local metres. */
export function toLocal(points: TrackPoint[], center: LngLat): Pt[] {
  const p = makeProjector(center);
  return points.map((q) => p.toLocal(q.lon, q.lat));
}

/** Fewer points, none further than `tol` metres from the line (Douglas–Peucker); keeps the ends. */
export function simplify(pts: Pt[], tol: number): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax;
      const py = pts[i][1] - ay;
      const k = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const ex = px - k * dx;
      const ey = py - k * dy;
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((v, i) => v && out.push(i));
  return out;
}

/**
 * Where the runner is at `k` (0 → 1) of the replay of a stretch: at the recorded pace when the
 * route has times, else at an even pace. `m` is route metres; `elapsed` is ms since the real start.
 */
export function replayAt(r: Route, fromM: number, toM: number, k: number): { point: TrackPoint; m: number; elapsed: number | null } {
  const kk = Math.min(1, Math.max(0, k));
  if (r.hasTime) {
    const t0 = pointAt(r, fromM).time!;
    const t1 = pointAt(r, toM).time!;
    if (t1 > t0) {
      const m = distanceAtTime(r, t0 + (t1 - t0) * kk, fromM, toM);
      const point = pointAt(r, m);
      return { point, m, elapsed: point.time! - r.t0 };
    }
  }
  const m = fromM + (toM - fromM) * kk;
  const point = pointAt(r, m);
  return { point, m, elapsed: r.hasTime ? point.time! - r.t0 : null };
}

/** Route metres where the clock showed `time` (within the stretch). */
function distanceAtTime(r: Route, time: number, fromM: number, toM: number): number {
  const pts = r.points;
  let lo = 0;
  let hi = pts.length - 1;
  if (time <= pts[0].time!) return fromM;
  if (time >= pts[hi].time!) return toM;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time! <= time) lo = mid;
    else hi = mid;
  }
  const span = pts[hi].time! - pts[lo].time!;
  const k = span > 0 ? (time - pts[lo].time!) / span : 0;
  const m = r.dist[lo] + (r.dist[hi] - r.dist[lo]) * k;
  return Math.min(toM, Math.max(fromM, m));
}

/** "1:23:45", "23:45" */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (v: number) => String(v).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
