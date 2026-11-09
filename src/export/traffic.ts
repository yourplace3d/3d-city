/**
 * Traffic streets in the 3D print: the streets near counting points as raised strips whose
 * height follows the traffic in the hour shown, from 0.5 mm where a count has faded out to 2 mm
 * at the most in the day, and at least 0.8 mm wide. A gentle relief with no spikes: sturdy to
 * print and easy to paint. Built like the raised roads (roads.ts), whose pieces follow the
 * terrain; a route printed with them stands 0.4 mm above them, so it isn't buried.
 */

import { printRaiseMm, TRAFFIC_PRINT_MM } from '../data/display/traffic';
import type { TrafficStreets } from '../data/match/trafficStreets';
import type { Pt } from '../data/types';
import type { PrintRoad } from './roads';

/** How far a route stands above a traffic street it runs along (mm). */
export const ROUTE_OVER_TRAFFIC_MM = 0.4;
/** Points closer to a straight line than this are left out (mm on the print), as are changes in height below… */
const KEEP_MM = 0.1;
/** …this (mm). */
const KEEP_RAISE_MM = 0.03;
/** The route is checked against the traffic streets every this many metres. */
const ROUTE_STEP_M = 10;

/** The traffic streets for print at `mmPerM`, from each sample's share of the top (0 … 1). */
export function trafficForPrint(s: TrafficStreets, shares: ArrayLike<number>, mmPerM: number): PrintRoad[] {
  const minWidth = TRAFFIC_PRINT_MM.width / mmPerM;
  const out: PrintRoad[] = [];
  for (const run of s.runs) {
    const pts: Pt[] = [];
    const raises: number[] = [];
    let width = 0;
    for (let k = run.start; k < run.start + run.count; k++) {
      pts.push([s.at[2 * k], s.at[2 * k + 1]]);
      raises.push(printRaiseMm(shares[k]));
      width = Math.max(width, s.width[k]);
    }
    const keep = thin(pts, raises, KEEP_MM / mmPerM, KEEP_RAISE_MM);
    out.push({ pts: keep.map((i) => pts[i]), raises: keep.map((i) => raises[i]), widthM: Math.max(width, minWidth), bridge: run.bridge });
  }
  return out;
}

/**
 * The points to keep: every one where leaving it out would move the line more than `tolM` or
 * its height more than `tolMm` (a straight, evenly rising stretch needs only its ends).
 */
function thin(pts: Pt[], raises: number[], tolM: number, tolMm: number): number[] {
  const keep = [0];
  let a = 0;
  while (a < pts.length - 1) {
    let b = a + 1;
    // run on while every point between a and b+1 stays close to the straight line between them
    while (b + 1 < pts.length && fits(pts, raises, a, b + 1, tolM, tolMm)) b++;
    keep.push(b);
    a = b;
  }
  return keep;
}

function fits(pts: Pt[], raises: number[], a: number, b: number, tolM: number, tolMm: number): boolean {
  const [ax, ay] = pts[a];
  const dx = pts[b][0] - ax;
  const dy = pts[b][1] - ay;
  const len2 = dx * dx + dy * dy;
  for (let i = a + 1; i < b; i++) {
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2)) : 0;
    if (Math.hypot(ax + dx * f - pts[i][0], ay + dy * f - pts[i][1]) > tolM) return false;
    if (Math.abs(raises[a] + (raises[b] - raises[a]) * f - raises[i]) > tolMm) return false;
  }
  return true;
}

/** The top of the traffic streets at a point (mm above the ground), 0 where there's none; `reachM` widens them. */
export function trafficTop(pieces: PrintRoad[]): (p: Pt, reachM: number) => number {
  const CELL = 50;
  const segs: Array<[number, number, number, number, number, number, number]> = [];
  const cells = new Map<string, number[]>();
  for (const r of pieces) {
    const raises = r.raises ?? r.pts.map(() => r.raiseMm ?? 0);
    for (let k = 1; k < r.pts.length; k++) {
      const [x0, y0] = r.pts[k - 1];
      const [x1, y1] = r.pts[k];
      const i = segs.length;
      segs.push([x0, y0, x1, y1, raises[k - 1], raises[k], r.widthM / 2]);
      const pad = r.widthM / 2 + CELL;
      for (let cx = Math.floor((Math.min(x0, x1) - pad) / CELL); cx <= Math.floor((Math.max(x0, x1) + pad) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(y0, y1) - pad) / CELL); cy <= Math.floor((Math.max(y0, y1) + pad) / CELL); cy++) {
          const key = `${cx},${cy}`;
          const list = cells.get(key);
          if (list) list.push(i);
          else cells.set(key, [i]);
        }
      }
    }
  }
  return (p, reachM) => {
    let top = 0;
    for (const i of cells.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? []) {
      const [x0, y0, x1, y1, r0, r1, hw] = segs[i];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const f = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / len2)) : 0;
      if (Math.hypot(x0 + dx * f - p[0], y0 + dy * f - p[1]) <= hw + reachM) top = Math.max(top, r0 + (r1 - r0) * f);
    }
    return top;
  };
}

/**
 * A route's print pieces lifted over the traffic streets: where it runs on or across one, it
 * stands ROUTE_OVER_TRAFFIC_MM above it rather than inside it. Bridges keep their level decks.
 */
export function routeOverTraffic(route: PrintRoad[], traffic: PrintRoad[]): PrintRoad[] {
  if (!traffic.length) return route;
  const top = trafficTop(traffic);
  return route.map((r) => {
    if (r.bridge || r.pts.length < 2) return r;
    const base = r.raiseMm ?? 0;
    const pts: Pt[] = [r.pts[0]];
    for (let k = 1; k < r.pts.length; k++) {
      const [x0, y0] = r.pts[k - 1];
      const [x1, y1] = r.pts[k];
      const parts = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / ROUTE_STEP_M));
      for (let j = 1; j <= parts; j++) pts.push([x0 + ((x1 - x0) * j) / parts, y0 + ((y1 - y0) * j) / parts]);
    }
    const raises = pts.map((p) => {
      const t = top(p, r.widthM / 2);
      return t > 0 ? Math.max(base, t + ROUTE_OVER_TRAFFIC_MM) : base;
    });
    return raises.some((x) => x !== base) ? { ...r, pts, raises } : r;
  });
}
