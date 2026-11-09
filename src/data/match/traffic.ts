/**
 * Match: counting points in the model's local metres, and their last 24 hours on fixed steps.
 * Points a few metres apart (the two directions of one road, counted from one mast) become one
 * column whose count is their sum: the traffic on that stretch of road.
 */

import { makeProjector, type LngLat } from '../../geo/projection';
import type { CountingPoint } from '../sources/hamburgTraffic';
import type { Pt } from '../types';

export const HOURS = 24;
const HOUR_MS = 3_600_000;
/** Counting points closer than this become one column (m). */
export const MERGE_M = 12;

export interface TrafficColumn {
  /** the counting points in it */
  ids: string[];
  at: Pt;
  /** count per hour of the day shown, oldest first; NaN where none came in */
  values: Float32Array;
}

export interface TrafficDay {
  /** the start of each of the 24 hours (ms since 1970, UTC), oldest first */
  hours: number[];
  columns: TrafficColumn[];
  /** all columns' counts added up, per hour */
  totals: number[];
  /** how many columns had a count, per hour */
  counted: number[];
  /** the highest count of any column in any hour: the top of the scale */
  max: number;
}

/**
 * The last 24 hours of counts that have come in, for the points inside the square, as columns.
 * Null when there are no counts at all.
 */
export function lastDay(points: CountingPoint[], center: LngLat, sizeM: number): TrafficDay | null {
  let end = -Infinity;
  for (const p of points) for (const h of p.counts.keys()) end = Math.max(end, h);
  if (!Number.isFinite(end)) return null;
  const hours = Array.from({ length: HOURS }, (_, i) => end - (HOURS - 1 - i) * HOUR_MS);
  const proj = makeProjector(center);
  const half = sizeM / 2;
  const columns: TrafficColumn[] = [];
  for (const p of points) {
    const at = proj.toLocal(p.lon, p.lat);
    if (Math.abs(at[0]) > half || Math.abs(at[1]) > half) continue;
    const values = new Float32Array(HOURS).fill(NaN);
    let any = false;
    hours.forEach((h, i) => {
      const v = p.counts.get(h);
      if (v != null) {
        values[i] = v;
        any = true;
      }
    });
    if (!any) continue;
    const near = columns.find((c) => Math.hypot(c.at[0] - at[0], c.at[1] - at[1]) < MERGE_M);
    if (!near) {
      columns.push({ ids: [p.id], at, values });
      continue;
    }
    // one more direction of the same road: add it up, and stand the column between them
    const k = near.ids.length;
    near.at = [(near.at[0] * k + at[0]) / (k + 1), (near.at[1] * k + at[1]) / (k + 1)];
    near.ids.push(p.id);
    for (let i = 0; i < HOURS; i++) {
      if (Number.isNaN(values[i])) continue;
      near.values[i] = Number.isNaN(near.values[i]) ? values[i] : near.values[i] + values[i];
    }
  }
  const totals = new Array<number>(HOURS).fill(0);
  const counted = new Array<number>(HOURS).fill(0);
  let max = 0;
  for (const c of columns) {
    for (let i = 0; i < HOURS; i++) {
      const v = c.values[i];
      if (Number.isNaN(v)) continue;
      totals[i] += v;
      counted[i]++;
      max = Math.max(max, v);
    }
  }
  return { hours, columns, totals, counted, max };
}

/** A column's count at a moment between hours (`pos` 0 … 23, fractional while replaying); none counts as 0. */
export function valueAt(values: ArrayLike<number>, pos: number): number {
  const i = Math.max(0, Math.min(values.length - 1, Math.floor(pos)));
  const j = Math.min(values.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, pos - i));
  const a = Number.isNaN(values[i]) ? 0 : values[i];
  const b = Number.isNaN(values[j]) ? 0 : values[j];
  return a + (b - a) * f;
}

/** The hour with the most counted, as an index (the latest one on a tie). */
export function busiestHour(totals: number[]): number {
  let best = totals.length - 1;
  totals.forEach((v, i) => {
    if (v > totals[best]) best = i;
  });
  return best;
}

/** The columns with the highest counts at an hour, highest first. */
export function topColumns(day: TrafficDay, hour: number, n: number): number[] {
  return day.columns
    .map((c, i) => ({ i, v: c.values[hour] }))
    .filter((x) => !Number.isNaN(x.v) && x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((x) => x.i);
}
