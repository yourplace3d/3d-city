/**
 * Match: a timetable's trips through the square as runs, one per vehicle passing through. Each
 * run follows a path (the line's shape, or straight from stop to stop when the file has none)
 * from the last stop before the square to the first one after it, with the times it is at each
 * of those stops; in between, a vehicle moves evenly, as timetables are planned. Trips that share
 * a line and stops share a path.
 *
 * A day's runs are the trips whose service runs that day, plus the ones from the evening before
 * still running after midnight (GTFS writes those as 24:30 and so on).
 */

import { runsOn, weekday, type GtfsCut, type GtfsRoute, type GtfsService, type TransitMode } from '../sources/gtfs';

export const DAY_S = 86_400;

/** A line on the model: points (E, N pairs, m) and the distance to each from the start (m). */
export interface TransitPath {
  pts: Float32Array;
  cum: Float32Array;
  /** the line it was first made for (for its colour) */
  route: number;
}

export interface TransitRuns {
  sizeM: number;
  routes: GtfsRoute[];
  services: GtfsService[];
  paths: TransitPath[];
  runPath: Int32Array;
  runRoute: Int32Array;
  runService: Int32Array;
  runHeadsign: string[];
  /** where each run's stops start in `at`, `arr`, `dep`; one more entry than runs */
  runFirst: Int32Array;
  /** along the run's path (m) */
  at: Float32Array;
  /** seconds after midnight of the service day */
  arr: Int32Array;
  dep: Int32Array;
  /** when the run comes into the square and leaves it (s of the service day) */
  tIn: Int32Array;
  tOut: Int32Array;
}

/** A stop this close to the line (m) is on it: the first stretch that close after the last stop wins… */
const ON_LINE_M = 60;
/** …unless the line comes back much closer within this far along it (a loop, or the way back on a parallel street). */
const LOOK_AHEAD_M = 300;

/** The closest point on a line to each stop, in order along it (m from its start). */
export function projectStops(pts: ArrayLike<number>, cum: ArrayLike<number>, stops: ArrayLike<number>): Float64Array {
  const nSeg = pts.length / 2 - 1;
  const nStop = stops.length / 2;
  const out = new Float64Array(nStop);
  let seg = 0;
  let floor = 0;
  for (let s = 0; s < nStop; s++) {
    const px = stops[s * 2];
    const py = stops[s * 2 + 1];
    let best = Infinity;
    let bestD = floor;
    let bestSeg = seg;
    let inRun = false;
    let limit = Infinity;
    for (let i = seg; i < nSeg; i++) {
      if (cum[i] > limit) break;
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const dx = pts[i * 2 + 2] - ax;
      const dy = pts[i * 2 + 3] - ay;
      const len2 = dx * dx + dy * dy;
      let u = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(ax + u * dx - px, ay + u * dy - py);
      const along = cum[i] + u * (cum[i + 1] - cum[i]);
      if (along < floor) continue;
      // past the first stretch close to the stop, a later pass wins only if it's much closer
      const better = limit === Infinity ? d < best : d < best * 0.5;
      if (better) {
        best = d;
        bestD = along;
        bestSeg = i;
      }
      if (d <= ON_LINE_M) inRun = true;
      else if (inRun && limit === Infinity) limit = bestD + LOOK_AHEAD_M;
    }
    out[s] = bestD;
    floor = bestD;
    seg = bestSeg;
  }
  return out;
}

/** Distances from the start to each point of a line. */
export function cumulative(pts: ArrayLike<number>): Float32Array {
  const n = pts.length / 2;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return cum;
}

/** Where a line is in the square |e|, |n| <= h: from the first distance in it to the last, or null. */
export function spanInside(pts: ArrayLike<number>, cum: ArrayLike<number>, h: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = pts.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - ax;
    const dy = pts[i * 2 + 3] - ay;
    // the part of this stretch in the square (Liang–Barsky)
    let t0 = 0;
    let t1 = 1;
    let out = false;
    const p = [-dx, dx, -dy, dy];
    const q = [ax + h, h - ax, ay + h, h - ay];
    for (let k = 0; k < 4 && !out; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) out = true;
        continue;
      }
      const r = q[k] / p[k];
      if (p[k] < 0) {
        if (r > t1) out = true;
        else if (r > t0) t0 = r;
      } else if (r < t0) out = true;
      else if (r < t1) t1 = r;
    }
    if (out || t0 > t1) continue;
    const len = cum[i + 1] - cum[i];
    lo = Math.min(lo, cum[i] + t0 * len);
    hi = Math.max(hi, cum[i] + t1 * len);
  }
  if (n === 1 && Math.abs(pts[0]) <= h && Math.abs(pts[1]) <= h) return [0, 0];
  return lo <= hi ? [lo, hi] : null;
}

/** The stretch of a line between two distances along it, as a line of its own. */
export function stretch(pts: ArrayLike<number>, cum: ArrayLike<number>, from: number, to: number): Float32Array {
  const out: number[] = [];
  const n = pts.length / 2;
  const at = (m: number) => {
    let i = 0;
    while (i < n - 2 && cum[i + 1] < m) i++;
    const len = cum[i + 1] - cum[i];
    const u = len > 0 ? Math.max(0, Math.min(1, (m - cum[i]) / len)) : 0;
    return [pts[i * 2] + u * (pts[i * 2 + 2] - pts[i * 2]), pts[i * 2 + 1] + u * (pts[i * 2 + 3] - pts[i * 2 + 1])];
  };
  if (n < 2) return Float32Array.from(pts);
  out.push(...at(from));
  for (let i = 0; i < n; i++) if (cum[i] > from && cum[i] < to) out.push(pts[i * 2], pts[i * 2 + 1]);
  out.push(...at(to));
  return Float32Array.from(out);
}

interface Pattern {
  path: number;
  /** each kept stop's distance along the path */
  d: Float64Array;
  /** the stops kept: from k0 to k1 of the trip's */
  k0: number;
  k1: number;
  /** where the square starts and ends along the path */
  lo: number;
  hi: number;
}

/** The trips of a cut timetable as runs through a square of `sizeM`. */
export function makeRuns(cut: GtfsCut, sizeM: number): TransitRuns {
  const h = sizeM / 2;
  const paths: TransitPath[] = [];
  const patterns = new Map<string, Pattern | null>();
  const runPath: number[] = [];
  const runRoute: number[] = [];
  const runService: number[] = [];
  const runHeadsign: string[] = [];
  const runFirst: number[] = [];
  const at: number[] = [];
  const arr: number[] = [];
  const dep: number[] = [];
  const tIn: number[] = [];
  const tOut: number[] = [];

  // trips that run every few minutes: their start times
  const every = new Map<number, number[]>();
  for (let f = 0; f < cut.frequencies.length; f += 4) {
    const [trip, start, end, headway] = [cut.frequencies[f], cut.frequencies[f + 1], cut.frequencies[f + 2], cut.frequencies[f + 3]];
    let list = every.get(trip);
    if (!list) every.set(trip, (list = []));
    for (let t = start; t < end; t += headway) list.push(t);
  }

  const nTrips = cut.tripRoute.length;
  for (let k = 0; k < nTrips; k++) {
    const a = cut.tripFirst[k];
    const b = cut.tripFirst[k + 1];
    if (b - a < 2) continue;
    const shape = cut.tripShape[k];
    let key = `${shape}|`;
    for (let i = a; i < b; i++) key += `${cut.stStop[i]},`;
    let pat = patterns.get(key);
    if (pat === undefined) {
      pat = makePattern(cut, k, h, paths);
      patterns.set(key, pat);
    }
    if (!pat) continue;
    const times = tripTimes(cut, k, pat);
    if (!times) continue;
    // a trip run every few minutes: its times count from its first stop's departure
    const first = cut.tripFirst[k];
    const zero = cut.stDep[first] >= 0 ? cut.stDep[first] : cut.stArr[first];
    const starts = every.get(k) ?? [null];
    for (const start of starts) {
      const shift = start == null ? 0 : start - zero;
      runPath.push(pat.path);
      runRoute.push(cut.tripRoute[k]);
      runService.push(cut.tripService[k]);
      runHeadsign.push(cut.tripHeadsign[k]);
      runFirst.push(at.length);
      const base = pat.d[0];
      for (let i = 0; i < pat.d.length; i++) {
        at.push(pat.d[i] - base);
        arr.push(times.arr[i] + shift);
        dep.push(times.dep[i] + shift);
      }
      tIn.push(Math.round(timeAt(pat.d, times.arr, times.dep, pat.lo) + shift));
      tOut.push(Math.round(timeAt(pat.d, times.arr, times.dep, pat.hi) + shift));
    }
  }
  runFirst.push(at.length);
  return {
    sizeM,
    routes: cut.routes,
    services: cut.services,
    paths,
    runPath: Int32Array.from(runPath),
    runRoute: Int32Array.from(runRoute),
    runService: Int32Array.from(runService),
    runHeadsign,
    runFirst: Int32Array.from(runFirst),
    at: Float32Array.from(at),
    arr: Int32Array.from(arr),
    dep: Int32Array.from(dep),
    tIn: Int32Array.from(tIn),
    tOut: Int32Array.from(tOut),
  };
}

function makePattern(cut: GtfsCut, k: number, h: number, paths: TransitPath[]): Pattern | null {
  const a = cut.tripFirst[k];
  const b = cut.tripFirst[k + 1];
  const stops = new Float64Array((b - a) * 2);
  for (let i = a; i < b; i++) {
    stops[(i - a) * 2] = cut.stopAt[cut.stStop[i] * 2];
    stops[(i - a) * 2 + 1] = cut.stopAt[cut.stStop[i] * 2 + 1];
  }
  const shape = cut.tripShape[k];
  const pts = shape >= 0 ? cut.shapes[shape] : Float32Array.from(stops);
  const cum = cumulative(pts);
  const d = shape >= 0 ? projectStops(pts, cum, stops) : Float64Array.from(cum);
  const span = spanInside(pts, cum, h);
  if (!span) return null;
  const [lo, hi] = span;
  let k0 = 0;
  for (let i = 0; i < d.length; i++) if (d[i] <= lo) k0 = i;
  let k1 = d.length - 1;
  for (let i = d.length - 1; i >= 0; i--) if (d[i] >= hi) k1 = i;
  if (k1 <= k0) {
    // the square lies before the first stop or after the last: the stretch to the nearest two
    if (k0 >= d.length - 1) k0 = d.length - 2;
    k1 = k0 + 1;
  }
  const from = d[k0];
  const to = d[k1];
  const part = stretch(pts, cum, from, to);
  paths.push({ pts: part, cum: cumulative(part), route: cut.tripRoute[k] });
  return { path: paths.length - 1, d: d.slice(k0, k1 + 1), k0, k1, lo: Math.max(lo, from), hi: Math.min(hi, to) };
}

/** A trip's times at the stops kept, gaps filled in by distance; null when the ends have none. */
function tripTimes(cut: GtfsCut, k: number, pat: Pattern): { arr: Float64Array; dep: Float64Array } | null {
  const a = cut.tripFirst[k] + pat.k0;
  const n = pat.d.length;
  const arr = new Float64Array(n);
  const dep = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = cut.stArr[a + i];
    dep[i] = cut.stDep[a + i];
  }
  // stops without times (not every stop is a timing point): evenly by distance between those with
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (arr[i] < 0) continue;
    if (last >= 0 && i - last > 1) {
      const span = pat.d[i] - pat.d[last];
      for (let j = last + 1; j < i; j++) {
        const u = span > 0 ? (pat.d[j] - pat.d[last]) / span : (j - last) / (i - last);
        arr[j] = dep[j] = dep[last] + u * (arr[i] - dep[last]);
      }
    }
    last = i;
  }
  if (arr[0] < 0 || arr[n - 1] < 0 || dep[0] < 0) return null;
  for (let i = 0; i < n; i++) {
    if (i > 0 && arr[i] < dep[i - 1]) arr[i] = dep[i - 1];
    if (dep[i] < arr[i]) dep[i] = arr[i];
  }
  return { arr, dep };
}

/** The time (s) a run is at a distance along its path. */
function timeAt(d: ArrayLike<number>, arr: ArrayLike<number>, dep: ArrayLike<number>, m: number): number {
  const n = d.length;
  if (m <= d[0]) return dep[0];
  for (let i = 0; i + 1 < n; i++) {
    if (m <= d[i + 1]) {
      const len = d[i + 1] - d[i];
      const u = len > 0 ? (m - d[i]) / len : 0;
      return dep[i] + u * (arr[i + 1] - dep[i]);
    }
  }
  return arr[n - 1];
}

// ------------------------------------------------------------------ one day

/** A line as people know it: one name and mode (a file may split it into several routes). */
export interface TransitLine {
  key: string;
  name: string;
  mode: TransitMode;
  routes: number[];
  /** runs through the square on the day */
  runs: number;
}

export interface TransitDay {
  runs: TransitRuns;
  /** days since 1 Jan 1970 */
  day: number;
  /** the runs on this day, and what to add to their times for seconds after this day's midnight */
  run: Int32Array;
  shift: Int32Array;
  /** the lines with runs on this day, by mode, then by name */
  lines: TransitLine[];
  /** the most vehicles in the square at once */
  most: number;
}

export const MODE_ORDER: readonly TransitMode[] = ['rail', 'subway', 'tram', 'bus', 'ferry', 'other'];

/** The runs on a day: its services, and the evening before's after midnight. */
export function dayRuns(runs: TransitRuns, day: number): TransitDay {
  const run: number[] = [];
  const shift: number[] = [];
  const today = runs.services.map((s) => runsOn(s, day));
  const before = runs.services.map((s) => runsOn(s, day - 1));
  const n = runs.tIn.length;
  for (let r = 0; r < n; r++) {
    const s = runs.runService[r];
    if (s < 0) continue;
    if (today[s] && runs.tIn[r] < DAY_S) {
      run.push(r);
      shift.push(0);
    }
    if (before[s] && runs.tOut[r] > DAY_S) {
      run.push(r);
      shift.push(-DAY_S);
    }
  }
  const byKey = new Map<string, TransitLine>();
  for (const r of run) {
    const route = runs.routes[runs.runRoute[r]];
    const name = lineName(route);
    const key = `${route.mode}|${name}`;
    let line = byKey.get(key);
    if (!line) byKey.set(key, (line = { key, name, mode: route.mode, routes: [], runs: 0 }));
    if (!line.routes.includes(runs.runRoute[r])) line.routes.push(runs.runRoute[r]);
    line.runs++;
  }
  const lines = [...byKey.values()].sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  // the most at once: in at tIn, out after tOut
  const events: number[] = [];
  for (let i = 0; i < run.length; i++) {
    events.push((runs.tIn[run[i]] + shift[i]) * 2 + 1, (runs.tOut[run[i]] + shift[i]) * 2 + 2);
  }
  events.sort((a, b) => a - b);
  let now = 0;
  let most = 0;
  for (const e of events) {
    now += (e & 1) === 1 ? 1 : -1;
    most = Math.max(most, now);
  }
  return { runs, day, run: Int32Array.from(run), shift: Int32Array.from(shift), lines, most };
}

/** The day to show: `want` if the timetable has it, else the nearest one on the same weekday. */
export function dayWithin(want: number, first: number, last: number): number {
  if (!Number.isFinite(first) || !Number.isFinite(last) || (want >= first && want <= last)) return want;
  if (want > last) return last - ((weekday(last) - weekday(want) + 7) % 7);
  return first + ((weekday(want) - weekday(first) + 7) % 7);
}

/** A line's name on a chip: its short name, or its long one. */
export function lineName(r: GtfsRoute): string {
  return r.short || r.long || '?';
}

/** How many runs come into the square in each hour of the day (of some lines' routes, or all). */
export function runsPerHour(d: TransitDay, routes: ReadonlySet<number> | null = null): number[] {
  const out = new Array<number>(24).fill(0);
  for (let i = 0; i < d.run.length; i++) {
    const r = d.run[i];
    if (routes && !routes.has(d.runs.runRoute[r])) continue;
    const t = d.runs.tIn[r] + d.shift[i];
    if (t >= 0 && t < DAY_S) out[Math.floor(t / 3600)]++;
  }
  return out;
}

/** Where a vehicle is (E, N) and which way it heads (unit vector). */
export interface VehicleAt {
  e: number;
  n: number;
  dx: number;
  dy: number;
}

/**
 * Where run `r` is at `t` (s of its service day), into `out`; false when it isn't running then or
 * is outside the square.
 */
export function runAt(runs: TransitRuns, r: number, t: number, out: VehicleAt): boolean {
  const a = runs.runFirst[r];
  const b = runs.runFirst[r + 1] - 1;
  if (t < runs.arr[a] && t < runs.dep[a]) return false;
  if (t > runs.dep[b]) return false;
  // the last stop reached
  let lo = a;
  let hi = b;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs.arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  let m: number;
  if (t <= runs.dep[lo] || lo === b) m = runs.at[lo];
  else {
    const span = runs.arr[lo + 1] - runs.dep[lo];
    const u = span > 0 ? (t - runs.dep[lo]) / span : 1;
    m = runs.at[lo] + u * (runs.at[lo + 1] - runs.at[lo]);
  }
  pointOn(runs.paths[runs.runPath[r]], m, out);
  const h = runs.sizeM / 2;
  return Math.abs(out.e) <= h && Math.abs(out.n) <= h;
}

/** How far along its path run `r` is at `t` (m), held at its first and last stop before and after. */
export function distanceAt(runs: TransitRuns, r: number, t: number): number {
  const a = runs.runFirst[r];
  const b = runs.runFirst[r + 1] - 1;
  if (t <= runs.dep[a]) return runs.at[a];
  if (t >= runs.arr[b]) return runs.at[b];
  let lo = a;
  let hi = b;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs.arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  if (t <= runs.dep[lo] || lo === b) return runs.at[lo];
  const span = runs.arr[lo + 1] - runs.dep[lo];
  const u = span > 0 ? (t - runs.dep[lo]) / span : 1;
  return runs.at[lo] + u * (runs.at[lo + 1] - runs.at[lo]);
}

/** The stretch of a path from `m0` to `m1` (m along it) as E, N pairs into `out`: its ends and the bends between. */
export function stretchOn(p: TransitPath, m0: number, m1: number, out: number[]): number[] {
  out.length = 0;
  if (!(m1 > m0)) return out;
  const v: VehicleAt = { e: 0, n: 0, dx: 0, dy: 0 };
  pointOn(p, m0, v);
  out.push(v.e, v.n);
  const { pts, cum } = p;
  for (let i = 0; i < cum.length; i++) if (cum[i] > m0 && cum[i] < m1) out.push(pts[i * 2], pts[i * 2 + 1]);
  pointOn(p, m1, v);
  out.push(v.e, v.n);
  return out;
}

/** The point at `m` along a path, and its heading. */
export function pointOn(p: TransitPath, m: number, out: VehicleAt): VehicleAt {
  const { pts, cum } = p;
  const n = cum.length;
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= m) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.max(0, lo);
  const len = cum[i + 1] - cum[i];
  const u = len > 0 ? Math.max(0, Math.min(1, (m - cum[i]) / len)) : 0;
  const dx = pts[i * 2 + 2] - pts[i * 2];
  const dy = pts[i * 2 + 3] - pts[i * 2 + 1];
  out.e = pts[i * 2] + u * dx;
  out.n = pts[i * 2 + 1] + u * dy;
  const l = Math.hypot(dx, dy) || 1;
  out.dx = dx / l;
  out.dy = dy / l;
  return out;
}

/** Several timetables' runs through the same square as one (a city's buses and its trains, say). */
export function mergeRuns(list: TransitRuns[]): TransitRuns {
  if (list.length === 1) return list[0];
  const cat = <T extends Int32Array | Float32Array>(make: (n: number) => T, parts: T[], add: (k: number) => number = () => 0, keepNegative = false): T => {
    const out = make(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    parts.forEach((p, k) => {
      const d = add(k);
      for (let i = 0; i < p.length; i++) out[at + i] = keepNegative && p[i] < 0 ? p[i] : p[i] + d;
      at += p.length;
    });
    return out;
  };
  const offsets = (count: (r: TransitRuns) => number) => {
    const o: number[] = [];
    let s = 0;
    for (const r of list) {
      o.push(s);
      s += count(r);
    }
    return o;
  };
  const routeOff = offsets((r) => r.routes.length);
  const serviceOff = offsets((r) => r.services.length);
  const pathOff = offsets((r) => r.paths.length);
  const stopOff = offsets((r) => r.at.length);
  const i32 = (n: number) => new Int32Array(n);
  const f32 = (n: number) => new Float32Array(n);
  const firsts = list.map((r) => r.runFirst.slice(0, r.runFirst.length - 1));
  const runFirst = cat(i32, firsts, (k) => stopOff[k]);
  const all = new Int32Array(runFirst.length + 1);
  all.set(runFirst);
  all[runFirst.length] = stopOff[list.length - 1] + list[list.length - 1].at.length;
  return {
    sizeM: list[0].sizeM,
    routes: list.flatMap((r) => r.routes),
    services: list.flatMap((r) => r.services),
    paths: list.flatMap((r, k) => r.paths.map((p) => ({ ...p, route: p.route + routeOff[k] }))),
    runPath: cat(i32, list.map((r) => r.runPath), (k) => pathOff[k]),
    runRoute: cat(i32, list.map((r) => r.runRoute), (k) => routeOff[k]),
    runService: cat(i32, list.map((r) => r.runService), (k) => serviceOff[k], true),
    runHeadsign: list.flatMap((r) => r.runHeadsign),
    runFirst: all,
    at: cat(f32, list.map((r) => r.at)),
    arr: cat(i32, list.map((r) => r.arr)),
    dep: cat(i32, list.map((r) => r.dep)),
    tIn: cat(i32, list.map((r) => r.tIn)),
    tOut: cat(i32, list.map((r) => r.tOut)),
  };
}
