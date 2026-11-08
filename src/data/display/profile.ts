/**
 * Display: a route's height profile, as SVG markup (no DOM, so it's testable in Node).
 * Distance across, height up; the line takes the steepness colours, flat parts a quiet ink.
 * The chart stretches to its box (preserveAspectRatio none) with lines that keep their width;
 * labels, the crosshair and dots are HTML around it, so text and circles never get squashed.
 */

import { sampleClasses, type LineSample, type SteepClass } from '../match/slope';
import { STEEP_COLOURS } from './steepness';

export const PROFILE_W = 300;
export const PROFILE_H = 84;
/** the flat parts of the line: a muted ink, like the app's secondary text */
const FLAT_INK = '#8a8378';

export interface ProfileScale {
  /** heights at the bottom and top of the chart (m) */
  y0: number;
  y1: number;
  /** distance at the right edge (m along the stretch) */
  dMax: number;
}

/** Heights shown: the stretch's range with a little room, at least 20 m so a flat route looks flat. */
export function profileScale(s: LineSample[]): ProfileScale {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of s) {
    lo = Math.min(lo, x.h);
    hi = Math.max(hi, x.h);
  }
  const mid = (lo + hi) / 2;
  const range = Math.max(hi - lo, 20) * 1.15;
  return { y0: mid - range / 2, y1: mid + range / 2, dMax: s.length ? s[s.length - 1].d : 1 };
}

/** Chart coordinates (viewBox units) of a sample. */
export function profilePoint(x: LineSample, sc: ProfileScale): [number, number] {
  return [(x.d / (sc.dMax || 1)) * PROFILE_W, PROFILE_H - ((x.h - sc.y0) / (sc.y1 - sc.y0)) * PROFILE_H];
}

/** The sample nearest to a fraction (0 → 1) of the way across. */
export function sampleAtFraction(s: LineSample[], f: number): LineSample {
  const d = Math.min(1, Math.max(0, f)) * (s[s.length - 1]?.d ?? 0);
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].d <= d) lo = mid;
    else hi = mid;
  }
  return Math.abs(s[hi].d - d) < Math.abs(s[lo].d - d) ? s[hi] : s[lo];
}

const f1 = (v: number) => v.toFixed(1);

export function profileSvg(s: LineSample[], sc = profileScale(s), classes: SteepClass[] = sampleClasses(s)): string {
  if (s.length < 2) return '';
  const pts = s.map((x) => profilePoint(x, sc));
  const line = (a: number, b: number) => pts.slice(a, b + 1).map(([x, y], i) => `${i ? 'L' : 'M'}${f1(x)} ${f1(y)}`).join('');
  const area = `${line(0, pts.length - 1)}L${f1(pts[pts.length - 1][0])} ${PROFILE_H}L${f1(pts[0][0])} ${PROFILE_H}Z`;
  // one path per run of a class, sharing end points so the line is unbroken
  const runs: string[] = [];
  let a = 0;
  for (let i = 1; i <= s.length; i++) {
    const c = classes[a];
    if (i < s.length && classes[i] === c) continue;
    const end = Math.min(i, s.length - 1);
    const colour = c ? STEEP_COLOURS[c - 1] : FLAT_INK;
    runs.push(`<path d="${line(a, end)}" stroke="${colour}" vector-effect="non-scaling-stroke" />`);
    a = end;
    if (end === s.length - 1) break;
  }
  return (
    `<svg viewBox="0 0 ${PROFILE_W} ${PROFILE_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<path class="profile-area" d="${area}" vector-effect="non-scaling-stroke" />` +
    `<g class="profile-line" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${runs.join('')}</g>` +
    '</svg>'
  );
}
