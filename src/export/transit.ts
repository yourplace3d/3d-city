/**
 * Public transport in the 3D print: the lines that run on the day shown as raised strips, higher
 * where more trips pass, from 0.4 mm (two layers) on the quietest to 1.2 mm on the busiest, and
 * at least 0.8 mm wide. Where lines share a street or a track their trips add up, so a trunk
 * where five tram lines meet stands highest. Built like the raised roads (roads.ts); a route
 * printed with them stands 0.4 mm above them (routeOverTraffic).
 */

import { DAY_S, type TransitDay } from '../data/match/transit';
import type { Pt } from '../data/types';
import type { PrintRoad } from './roads';
import { thin } from './traffic';

/** The lines' heights (mm) on the quietest and the busiest, and their least width. */
export const TRANSIT_PRINT_MM = { low: 0.4, high: 1.2, width: 0.8 } as const;
/** Lines are sampled this often (m)… */
const SAMPLE_M = 8;
/** …and their trips added up in cells this big (m); lines a cell or so apart count as one. */
const CELL_M = 6;
/** Points closer to a straight line than this are left out (mm on the print), as are changes in height below… */
const KEEP_MM = 0.1;
/** …this (mm). */
const KEEP_RAISE_MM = 0.03;

const cellKey = (e: number, n: number) => (Math.round(e / CELL_M) + 4096) * 8192 + (Math.round(n / CELL_M) + 4096);

/** Points every `step` metres along a line (E, N pairs), its ends included. */
export function resample(pts: ArrayLike<number>, step: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length / 2;
  if (n < 2) return out;
  out.push([pts[0], pts[1]]);
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = pts[i * 2 - 2];
    const ay = pts[i * 2 - 1];
    const dx = pts[i * 2] - ax;
    const dy = pts[i * 2 + 1] - ay;
    const len = Math.hypot(dx, dy);
    let d = step - carry;
    while (d < len) {
      out.push([ax + (dx * d) / len, ay + (dy * d) / len]);
      d += step;
    }
    carry = len - (d - step);
  }
  const last: Pt = [pts[n * 2 - 2], pts[n * 2 - 1]];
  const end = out[out.length - 1];
  if (Math.hypot(end[0] - last[0], end[1] - last[1]) > step * 0.2) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** The trips on the day per cell along the lines: each line's runs, once per cell it passes. */
export function tripsByCell(day: TransitDay, picked: ReadonlySet<number> | null): { lines: Array<{ pts: Pt[]; keys: number[] }>; cells: Map<number, number> } {
  const runs = day.runs;
  const trips = new Map<number, number>();
  for (let i = 0; i < day.run.length; i++) {
    const r = day.run[i];
    if (picked && !picked.has(runs.runRoute[r])) continue;
    const t = runs.tIn[r] + day.shift[i];
    if (t < 0 || t >= DAY_S) continue;
    trips.set(runs.runPath[r], (trips.get(runs.runPath[r]) ?? 0) + 1);
  }
  const h = runs.sizeM / 2 + SAMPLE_M;
  const cells = new Map<number, number>();
  const lines: Array<{ pts: Pt[]; keys: number[] }> = [];
  for (const [path, n] of trips) {
    const all = resample(runs.paths[path].pts, SAMPLE_M);
    // only the part in the square, as runs of samples
    let cur: Pt[] = [];
    const flush = () => {
      if (cur.length >= 2) {
        const keys = cur.map(([e, nn]) => cellKey(e, nn));
        for (const k of new Set(keys)) cells.set(k, (cells.get(k) ?? 0) + n);
        lines.push({ pts: cur, keys });
      }
      cur = [];
    };
    for (const p of all) {
      if (Math.abs(p[0]) <= h && Math.abs(p[1]) <= h) cur.push(p);
      else flush();
    }
    flush();
  }
  return { lines, cells };
}

/** The lines for print at `mmPerM`, each point as high as the trips through it and the cells around it. */
export function transitForPrint(day: TransitDay, picked: ReadonlySet<number> | null, mmPerM: number): PrintRoad[] {
  const { lines, cells } = tripsByCell(day, picked);
  // a point's trips: the most in its cell and the eight around it
  const around = (k: number) => {
    let v = 0;
    for (const dx of [-8192, 0, 8192]) for (const dy of [-1, 0, 1]) v = Math.max(v, cells.get(k + dx + dy) ?? 0);
    return v;
  };
  const values = lines.map((l) => l.keys.map(around));
  const most = Math.max(1, ...values.flat());
  const { low, high, width } = TRANSIT_PRINT_MM;
  const widthM = width / mmPerM;
  return lines.map((l, i) => {
    const raises = values[i].map((v) => low + (high - low) * Math.sqrt(v / most));
    const keep = thin(l.pts, raises, KEEP_MM / mmPerM, KEEP_RAISE_MM);
    return { pts: keep.map((k) => l.pts[k]), raises: keep.map((k) => raises[k]), widthM, bridge: false };
  });
}
