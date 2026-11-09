/**
 * A route in the 3D print: a raised line on the terrain, made of the same closed pieces as the
 * raised roads (roads.ts), but wider and higher so it stands out from them and is easy to paint:
 * 1.2 mm wide and 0.8 mm up (four layers at 0.2 mm), twice the roads' 0.4 mm. On bridges it
 * keeps a level deck between their ends instead of dipping into the valley the terrain shows.
 */

import { sampleLine, type LineSample } from '../data/match/slope';
import { simplify } from '../data/match/route';
import type { Pt } from '../data/types';
import type { PrintRoad } from './roads';

export const ROUTE_RAISE_MM = 0.8;
export const ROUTE_WIDTH_MM = 1.2;
/** Detail finer than this on the print (mm) is smoothed out: GPS wobble would only make tiny corners. */
const ROUTE_TOLERANCE_MM = 0.15;
/** Shorter "bridges" (m) are taken for noise and printed on the ground. */
const MIN_BRIDGE_M = 15;

/**
 * The route's centreline (m from the centre) as print pieces at `mmPerM`: runs on the ground,
 * simplified to the print's detail, and straight runs across bridges (`onBridge` marks them).
 */
export function routeForPrint(pts: Pt[], mmPerM: number, onBridge?: (s: LineSample, i: number, all: LineSample[]) => boolean): PrintRoad[] {
  if (pts.length < 2) return [];
  const samples = sampleLine(pts, () => 0);
  const flags = onBridge ? samples.map((x, i, all) => onBridge(x, i, all)) : samples.map(() => false);
  // runs of samples on and off bridges
  const runs: Array<{ bridge: boolean; a: number; b: number }> = [];
  for (let i = 0; i < samples.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.bridge === flags[i]) last.b = i;
    else runs.push({ bridge: flags[i], a: i, b: i });
  }
  // a bridge too short to be one goes back on the ground
  for (const r of runs) if (r.bridge && samples[r.b].d - samples[r.a].d < MIN_BRIDGE_M) r.bridge = false;
  const merged = runs.reduce<typeof runs>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && last.bridge === r.bridge) last.b = r.b;
    else acc.push({ ...r });
    return acc;
  }, []);
  const widthM = ROUTE_WIDTH_MM / mmPerM;
  const tol = Math.max(1, ROUTE_TOLERANCE_MM / mmPerM);
  const out: PrintRoad[] = [];
  merged.forEach((r, k) => {
    // runs share their end sample with the next one, so the line has no gaps
    const end = k < merged.length - 1 ? merged[k + 1].a : r.b;
    const run: Pt[] = samples.slice(r.a, end + 1).map((x) => [x.e, x.n]);
    if (run.length < 2) return;
    const line = r.bridge ? [run[0], run[run.length - 1]] : simplify(run, tol).map((i) => run[i]);
    out.push({ pts: line, widthM, bridge: r.bridge, raiseMm: ROUTE_RAISE_MM });
  });
  return out;
}
