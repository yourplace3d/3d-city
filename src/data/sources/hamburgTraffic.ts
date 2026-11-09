/**
 * Source: traffic counts from the City of Hamburg's open SensorThings API (iot.hamburg.de).
 * Infrared detectors count cars and bikes at several hundred points across the city; every
 * hour each counting point publishes how many passed. The API is open to browsers (CORS),
 * needs no key, and answers one square's last day in one request of about 100 KB.
 *
 * Fetching (`fetchTrafficCounts`, takes an AbortSignal) is kept apart from parsing
 * (`parseTrafficCounts`, a pure function on the JSON) so tests can run the parser in Node.
 */

import type { BBox } from '../../geo/projection';
import type { Attribution } from '../types';

export type TrafficMode = 'cars' | 'bikes';

export const TRAFFIC_API = 'https://iot.hamburg.de/v1.1';

/** The hourly counts per counting point, by what is counted. */
const LAYERS: Record<TrafficMode, string> = {
  cars: 'Anzahl_Kfz_Zaehlstelle_1-Stunde',
  bikes: 'Anzahl_Fahrraeder_Zaehlstelle_1-Stunde',
};

export const TRAFFIC_ATTRIBUTION: Attribution = {
  text: 'Traffic counts: Freie und Hansestadt Hamburg, Behörde für Verkehr und Mobilitätswende',
  licence: 'dl-de/by-2-0',
  url: 'https://iot.hamburg.de/',
};

/** Hamburg (with a little of its edge): where the layer has data. */
export const TRAFFIC_AREA: BBox = { south: 53.39, west: 9.72, north: 53.75, east: 10.33 };

/** The clock the counts are shown in. */
export const TRAFFIC_TIME_ZONE = 'Europe/Berlin';

/** How far back to ask: a day and a bit, so the last full 24 hours are in. */
const LOOK_BACK_H = 26;
/** At most this many pages of 1000 counting points (a 4 km square in the centre has under 100). */
const MAX_PAGES = 4;

/** Does the square touch the area with counts? */
export function trafficCovers(b: BBox): boolean {
  const a = TRAFFIC_AREA;
  return b.west < a.east && b.east > a.west && b.south < a.north && b.north > a.south;
}

/** One counting point: where it is, and its counts by the hour's start (ms since 1970, UTC). */
export interface CountingPoint {
  id: string;
  lon: number;
  lat: number;
  counts: Map<number, number>;
}

export class TrafficProblem extends Error {
  constructor(readonly reason: 'network' | 'format') {
    super(`traffic counts: ${reason}`);
  }
}

/** The request for one square's counts since `since` (ms). */
export function trafficUrl(mode: TrafficMode, b: BBox, since: number): string {
  const ring = [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ]
    .map(([x, y]) => `${x.toFixed(5)} ${y.toFixed(5)}`)
    .join(', ');
  const from = new Date(Math.floor(since / 3_600_000) * 3_600_000).toISOString().replace('.000Z', 'Z');
  const q = new URLSearchParams({
    // counting points the city has retired are marked "veraltet" (outdated) and have no new counts
    $filter: `properties/layerName eq '${LAYERS[mode]}' and not substringof('veraltet', name) and st_within(observedArea, geography'POLYGON((${ring}))')`,
    $select: '@iot.id,name,observedArea',
    $expand: `Observations($select=phenomenonTime,result;$filter=phenomenonTime ge ${from};$orderby=phenomenonTime asc;$top=100)`,
    $top: '1000',
  });
  return `${TRAFFIC_API}/Datastreams?${q.toString()}`;
}

/** The counting points of one page of the API's answer. Skips anything without a place or counts. */
export function parseTrafficCounts(json: unknown): { points: CountingPoint[]; next: string | null } {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { value?: unknown }).value)) throw new TrafficProblem('format');
  const page = json as { value: unknown[]; '@iot.nextLink'?: unknown };
  const points: CountingPoint[] = [];
  for (const raw of page.value) {
    if (!raw || typeof raw !== 'object') continue;
    const ds = raw as { '@iot.id'?: unknown; name?: unknown; observedArea?: { type?: unknown; coordinates?: unknown }; Observations?: unknown };
    const c = ds.observedArea?.type === 'Point' && Array.isArray(ds.observedArea.coordinates) ? ds.observedArea.coordinates : null;
    const lon = Number(c?.[0]);
    const lat = Number(c?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const counts = new Map<number, number>();
    for (const o of Array.isArray(ds.Observations) ? ds.Observations : []) {
      const time = typeof o?.phenomenonTime === 'string' ? Date.parse(o.phenomenonTime.split('/')[0]) : NaN;
      const v = Number(o?.result);
      if (Number.isFinite(time) && Number.isFinite(v) && v >= 0) counts.set(Math.floor(time / 3_600_000) * 3_600_000, v);
    }
    if (!counts.size) continue;
    points.push({ id: String(ds['@iot.id'] ?? `${lon},${lat}`), lon, lat, counts });
  }
  const next = typeof page['@iot.nextLink'] === 'string' && page['@iot.nextLink'].startsWith(TRAFFIC_API) ? page['@iot.nextLink'] : null;
  return { points, next };
}

/** The last day and a bit of counts in a square. */
export async function fetchTrafficCounts(mode: TrafficMode, b: BBox, signal: AbortSignal, now = Date.now()): Promise<CountingPoint[]> {
  let url: string | null = trafficUrl(mode, b, now - LOOK_BACK_H * 3_600_000);
  const points: CountingPoint[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let json: unknown;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new TrafficProblem('network');
      json = await res.json();
    } catch (err) {
      if (signal.aborted) throw err;
      throw err instanceof TrafficProblem ? err : new TrafficProblem('network');
    }
    const parsed = parseTrafficCounts(json);
    points.push(...parsed.points);
    url = parsed.next;
  }
  return points;
}
