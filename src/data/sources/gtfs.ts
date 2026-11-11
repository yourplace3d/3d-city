/**
 * Source: a city's timetable in GTFS, the format transit operators publish their schedules in
 * (a ZIP of CSV files: stops, lines, trips, the times at each stop, the lines' shapes, the days
 * they run). The user picks the file; it is read here, in the browser, and never uploaded.
 *
 * A city's file unpacks to a few hundred MB (Hamburg: stop times 148 MB, shapes 122 MB), so it is
 * read in one pass per file, in pieces, keeping only what passes through the model's square:
 * the shapes that come near it, and the trips that stop in it or run along such a shape, for all
 * the days the timetable covers (picking a day afterwards needs no second read). Runs in a worker
 * (`gtfs.worker.ts`); everything here is plain code, so Node tests can run it too.
 */

import { makeProjector, type LngLat } from '../../geo/projection';
import { findItem, listZip, openItem, type ZipItem } from './zipFile';

/**
 * What a line is, from its GTFS route type: the colour and the vehicle on the model. 'rail' is
 * the regional and long-distance trains, 'suburban' the S-Bahn and other suburban trains.
 */
export type TransitMode = 'rail' | 'suburban' | 'subway' | 'tram' | 'bus' | 'ferry' | 'other';
export const TRANSIT_MODES: readonly TransitMode[] = ['rail', 'suburban', 'subway', 'tram', 'bus', 'ferry', 'other'];

/**
 * A GTFS route type (basic or extended) as one of our modes. Suburban trains are route type 109
 * (Hamburg's and Berlin's S-Bahn), or a train named like an S-Bahn line ("S1", "S 41") where a
 * timetable gives all its trains one type.
 */
export function modeOf(type: number, name = ''): TransitMode {
  if (type === 0 || type === 5 || (type >= 900 && type < 1000)) return 'tram';
  // 400–404, the urban railways: Berlin's U-Bahn is 400 (as other GTFS tools read it, e.g. OpenTripPlanner)
  if (type === 1 || (type >= 400 && type <= 404)) return 'subway';
  if (type === 109) return 'suburban';
  if (type === 2 || (type >= 100 && type < 200) || type === 12 || type === 405) return /^S ?\d/.test(name.trim()) ? 'suburban' : 'rail';
  if (type === 3 || type === 11 || (type >= 200 && type < 300) || (type >= 700 && type < 900)) return 'bus';
  if (type === 4 || (type >= 1000 && type < 1100) || (type >= 1200 && type < 1300)) return 'ferry';
  return 'other';
}

export type GtfsProblemKind = 'notGtfs' | 'empty' | 'tooBig';

export class GtfsProblem extends Error {
  constructor(readonly kind: GtfsProblemKind, message = kind) {
    super(message);
    this.name = 'GtfsProblem';
  }
}

/** A whole country's timetable is too much for a browser; a city's or a region's is fine. */
export const MAX_GTFS_BYTES = 400 * 1024 * 1024;
/** Shapes and stops this far outside the square still count: a line along its edge. */
export const CUT_MARGIN_M = 100;

export interface GtfsRoute {
  short: string;
  long: string;
  type: number;
  mode: TransitMode;
  /** "#rrggbb" from the file, or null */
  colour: string | null;
}

/** Which days a service runs: weekdays between two days, plus and minus single days. Days are days since 1 Jan 1970. */
export interface GtfsService {
  /** bit 0 Monday … bit 6 Sunday */
  week: number;
  start: number;
  end: number;
  add: number[];
  remove: number[];
}

/** The timetable cut to a square: only what passes through it, in metres from its centre. */
export interface GtfsCut {
  agencies: string[];
  timeZone: string;
  /** the first and last day the timetable has services on */
  firstDay: number;
  lastDay: number;
  routes: GtfsRoute[];
  services: GtfsService[];
  stopNames: string[];
  /** E, N of each stop kept */
  stopAt: Float32Array;
  /** each shape kept, E, N pairs in order */
  shapes: Float32Array[];
  tripRoute: Int32Array;
  tripService: Int32Array;
  /** the trip's shape, or -1 */
  tripShape: Int32Array;
  tripHeadsign: string[];
  /** where each trip's stops start in the arrays below; one more entry than trips */
  tripFirst: Int32Array;
  stStop: Int32Array;
  /** seconds after midnight of the service day (past 24 h after midnight), -1 when not given */
  stArr: Int32Array;
  stDep: Int32Array;
  /** trips run every so often instead of at set times: trip, start, end, headway (s) */
  frequencies: Int32Array;
  /** whether the file has shapes for its lines (without them they run straight from stop to stop) */
  hasShapes: boolean;
  /** where the timetable is busiest (a 2 km square's centre, and its busiest stop): where to look when the square has nothing */
  busiest: { lon: number; lat: number; name: string } | null;
  /** how many trips the whole file has */
  tripsInFile: number;
}

export interface CutArea {
  center: LngLat;
  /** 0 to only find where the timetable is busiest and which days it has (no square yet) */
  sizeM: number;
}

// ------------------------------------------------------------------ small parsers

/** "HH:MM:SS" (hours past 24 allowed, "7:05:00" too) → seconds, NaN when empty or bad. */
export function parseTime(s: string): number {
  const a = s.indexOf(':');
  if (a < 0) return NaN;
  const b = s.indexOf(':', a + 1);
  const h = Number(s.slice(0, a));
  const m = Number(b < 0 ? s.slice(a + 1) : s.slice(a + 1, b));
  const sec = b < 0 ? 0 : Number(s.slice(b + 1));
  if (!(h >= 0 && m >= 0 && m < 60 && sec >= 0 && sec < 61) || !s.slice(0, a).trim()) return NaN;
  return h * 3600 + m * 60 + sec;
}

const DAY_MS = 86_400_000;

/** "YYYYMMDD" → days since 1 Jan 1970, NaN when bad. */
export function parseDay(s: string): number {
  const v = s.trim();
  if (!/^\d{8}$/.test(v)) return NaN;
  return Date.UTC(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8))) / DAY_MS;
}

/** 0 Monday … 6 Sunday (1 Jan 1970 was a Thursday). */
export function weekday(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/** Whether a service runs on a day. */
export function runsOn(s: GtfsService, day: number): boolean {
  if (s.remove.includes(day)) return false;
  if (s.add.includes(day)) return true;
  return day >= s.start && day <= s.end && ((s.week >> weekday(day)) & 1) === 1;
}

/** One CSV line into fields (quotes, doubled quotes); returns how many. `out` is reused. `sep` is the separator (`,` or `;` or a tab). */
export function splitCsv(line: string, out: string[], sep = ','): number {
  let n = 0;
  let i = 0;
  const len = line.length;
  while (i <= len) {
    if (line.charCodeAt(i) === 34) {
      let j = i + 1;
      let s = '';
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) {
          s += line.slice(j);
          i = len + 1;
          break;
        }
        if (line.charCodeAt(q + 1) === 34) {
          s += line.slice(j, q + 1);
          j = q + 2;
          continue;
        }
        s += line.slice(j, q);
        const c = line.indexOf(sep, q + 1);
        i = c < 0 ? len + 1 : c + 1;
        break;
      }
      out[n++] = s;
    } else {
      const c = line.indexOf(sep, i);
      if (c < 0) {
        out[n++] = line.slice(i);
        break;
      }
      out[n++] = line.slice(i, c);
      i = c + 1;
    }
  }
  return n;
}

function quotesOpen(s: string): boolean {
  let open = false;
  for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) open = !open;
  return open;
}

/**
 * Reads one CSV file of the archive row by row, giving the `want`ed columns (by header name) in
 * that order; a missing column gives ''. The array passed to `onRow` is reused.
 */
export async function readTable(
  blob: Blob,
  item: ZipItem,
  want: readonly string[],
  onRow: (v: string[]) => void,
  onChars: (n: number) => void = () => undefined,
): Promise<void> {
  const reader = (await openItem(blob, item)).pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  const fields: string[] = [];
  const vals: string[] = want.map(() => '');
  let idx: number[] | null = null;
  let pending = '';
  const handle = (raw: string, last = false) => {
    let s = pending ? `${pending}\n${raw}` : raw;
    pending = '';
    // a quoted field may hold a line break
    if (!last && s.indexOf('"') >= 0 && quotesOpen(s)) {
      pending = s;
      return;
    }
    if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    if (!s.trim()) return;
    const n = splitCsv(s, fields);
    if (!idx) {
      const names = fields.slice(0, n).map((f) => f.replace(/^﻿/, '').trim().toLowerCase());
      idx = want.map((w) => names.indexOf(w));
      return;
    }
    for (let k = 0; k < want.length; k++) {
      const i = idx[k];
      vals[k] = i >= 0 && i < n ? fields[i] : '';
    }
    onRow(vals);
  };
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChars(value.length);
    const chunk = rest + value;
    let start = 0;
    for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
      handle(chunk.slice(start, nl));
      start = nl + 1;
    }
    rest = chunk.slice(start);
  }
  if (rest) handle(rest);
  if (pending) handle('', true);
}

// ------------------------------------------------------------------ geometry

/** Whether the segment a → b touches the square |x|, |y| <= h (Liang–Barsky). */
export function crossesBox(ax: number, ay: number, bx: number, by: number, h: number): boolean {
  if (Math.max(ax, bx) < -h || Math.min(ax, bx) > h || Math.max(ay, by) < -h || Math.min(ay, by) > h) return false;
  if (Math.abs(ax) <= h && Math.abs(ay) <= h) return true;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax + h, h - ax, ay + h, h - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return false;
      continue;
    }
    const r = q[k] / p[k];
    if (p[k] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1;
}

// ------------------------------------------------------------------ the cut

class Grow {
  a: Int32Array;
  n = 0;
  constructor(size = 1024) {
    this.a = new Int32Array(size);
  }
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Int32Array {
    return this.a.slice(0, this.n);
  }
}

/**
 * Reads a GTFS file and keeps what passes through the square. `onProgress` gets the share read
 * (0 … 1). Throws a `GtfsProblem` (or a `ZipProblem`) the panel can explain.
 */
export async function cutGtfs(blob: Blob, area: CutArea, onProgress: (share: number) => void = () => undefined): Promise<GtfsCut> {
  if (blob.size > MAX_GTFS_BYTES) throw new GtfsProblem('tooBig');
  const items = await listZip(blob);
  const item = (name: string) => findItem(items, name);
  const need = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].map(item);
  if (need.some((x) => !x) || (!item('calendar.txt') && !item('calendar_dates.txt'))) throw new GtfsProblem('notGtfs');
  const [stopsItem, routesItem, tripsItem, timesItem] = need as ZipItem[];
  const shapesItem = item('shapes.txt');

  // progress by unpacked characters, over the files read
  const scan = area.sizeM <= 0;
  const read = [stopsItem, routesItem, tripsItem, timesItem, scan ? null : shapesItem, item('calendar.txt'), item('calendar_dates.txt')];
  const total = read.reduce((s, x) => s + (x?.size ?? 0), 0) || 1;
  let done = 0;
  let lastShare = -1;
  const tick = (n: number) => {
    done += n;
    const share = Math.min(1, done / total);
    if (share - lastShare >= 0.01) {
      lastShare = share;
      onProgress(share);
    }
  };

  const proj = makeProjector(area.center);
  const h = area.sizeM / 2 + CUT_MARGIN_M;

  // agencies: names and the time zone
  const agencies: string[] = [];
  let timeZone = '';
  const agencyItem = item('agency.txt');
  if (agencyItem) {
    await readTable(blob, agencyItem, ['agency_name', 'agency_timezone'], ([name, tz]) => {
      if (name.trim() && !agencies.includes(name.trim())) agencies.push(name.trim());
      if (!timeZone && tz.trim()) timeZone = tz.trim();
    });
  }

  // lines
  const routeIndex = new Map<string, number>();
  const routes: GtfsRoute[] = [];
  await readTable(
    blob,
    routesItem,
    ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'],
    ([id, short, long, type, colour]) => {
      const tp = Number(type);
      const c = colour.trim().replace(/^#/, '');
      routeIndex.set(id, routes.length);
      routes.push({ short: short.trim(), long: long.trim(), type: tp, mode: modeOf(tp, short), colour: /^[0-9a-f]{6}$/i.test(c) ? `#${c.toLowerCase()}` : null });
    },
    tick,
  );

  // stops: where, and whether in the square
  const stopIndex = new Map<string, number>();
  const stopE: number[] = [];
  const stopN: number[] = [];
  const stopLon: number[] = [];
  const stopLat: number[] = [];
  const stopName: string[] = [];
  await readTable(
    blob,
    stopsItem,
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
    ([id, name, lat, lon]) => {
      const la = Number(lat);
      const lo = Number(lon);
      if (!lat.trim() || !lon.trim() || !Number.isFinite(la) || !Number.isFinite(lo)) return;
      const [e, n] = proj.toLocal(lo, la);
      stopIndex.set(id, stopE.length);
      stopE.push(e);
      stopN.push(n);
      stopLon.push(lo);
      stopLat.push(la);
      stopName.push(name.trim());
    },
    tick,
  );
  const stopIn = new Uint8Array(stopE.length);
  for (let i = 0; i < stopE.length; i++) stopIn[i] = Math.abs(stopE[i]) <= h && Math.abs(stopN[i]) <= h ? 1 : 0;

  // the days
  const serviceIndex = new Map<string, number>();
  const services: GtfsService[] = [];
  const service = (id: string) => {
    let i = serviceIndex.get(id);
    if (i == null) {
      i = services.length;
      serviceIndex.set(id, i);
      services.push({ week: 0, start: Infinity, end: -Infinity, add: [], remove: [] });
    }
    return services[i];
  };
  let firstDay = Infinity;
  let lastDay = -Infinity;
  const calItem = item('calendar.txt');
  if (calItem) {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    await readTable(
      blob,
      calItem,
      ['service_id', ...days, 'start_date', 'end_date'],
      (v) => {
        const s = service(v[0]);
        for (let d = 0; d < 7; d++) if (v[1 + d].trim() === '1') s.week |= 1 << d;
        s.start = parseDay(v[8]);
        s.end = parseDay(v[9]);
        if (s.week && s.start <= s.end) {
          firstDay = Math.min(firstDay, s.start);
          lastDay = Math.max(lastDay, s.end);
        }
      },
      tick,
    );
  }
  const datesItem = item('calendar_dates.txt');
  if (datesItem) {
    await readTable(
      blob,
      datesItem,
      ['service_id', 'date', 'exception_type'],
      ([id, date, type]) => {
        const d = parseDay(date);
        if (!Number.isFinite(d)) return;
        const s = service(id);
        if (type.trim() === '1') {
          s.add.push(d);
          firstDay = Math.min(firstDay, d);
          lastDay = Math.max(lastDay, d);
        } else if (type.trim() === '2') s.remove.push(d);
      },
      tick,
    );
  }
  for (const s of services) {
    if (!Number.isFinite(s.start)) s.start = 1;
    if (!Number.isFinite(s.end)) s.end = 0;
  }

  // trips: line, days, shape
  const tripIndex = new Map<string, number>();
  const tRoute = new Grow();
  const tService = new Grow();
  const tShapeId: string[] = [];
  const tHeadsign: string[] = [];
  await readTable(
    blob,
    tripsItem,
    ['trip_id', 'route_id', 'service_id', 'shape_id', 'trip_headsign'],
    ([id, route, svc, shape, headsign]) => {
      const r = routeIndex.get(route);
      if (r == null) return;
      tripIndex.set(id, tRoute.n);
      tRoute.push(r);
      tService.push(serviceIndex.get(svc) ?? -1);
      tShapeId.push(shape);
      tHeadsign.push(headsign.trim());
    },
    tick,
  );
  const tripCount = tRoute.n;
  if (!tripCount) throw new GtfsProblem('empty');

  // shapes that come near the square: one pass, points kept only for those
  const shapeNear = new Set<string>();
  const shapePts = new Map<string, Float32Array>();
  let hasShapes = !!shapesItem;
  if (shapesItem && !scan) {
    const usedShapes = new Set(tShapeId.filter(Boolean));
    let cur = '';
    let buf: number[] = [];
    const finished = new Set<string>();
    const again = new Set<string>();
    const finish = () => {
      if (!cur) return;
      if (finished.has(cur)) again.add(cur);
      finished.add(cur);
      const pts = sortShape(buf);
      if (touches(pts, h)) {
        shapeNear.add(cur);
        if (!again.has(cur)) shapePts.set(cur, pts);
      }
      buf = [];
    };
    const onRow = ([id, lat, lon, seq]: string[]) => {
      if (!usedShapes.has(id)) return;
      if (id !== cur) {
        finish();
        cur = id;
      }
      const la = Number(lat);
      const lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || !lat.trim()) return;
      const [e, n] = proj.toLocal(lo, la);
      buf.push(Number(seq), e, n);
    };
    await readTable(blob, shapesItem, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], onRow, tick);
    finish();
    hasShapes = finished.size > 0;
    // a file whose shapes' points aren't kept together: read those shapes once more, whole
    if (again.size) {
      const whole = new Map<string, number[]>();
      await readTable(blob, shapesItem, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], ([id, lat, lon, seq]) => {
        if (!again.has(id)) return;
        const [e, n] = proj.toLocal(Number(lon), Number(lat));
        let b = whole.get(id);
        if (!b) whole.set(id, (b = []));
        b.push(Number(seq), e, n);
      });
      for (const [id, b] of whole) {
        const pts = sortShape(b);
        if (touches(pts, h)) {
          shapeNear.add(id);
          shapePts.set(id, pts);
        } else {
          shapeNear.delete(id);
          shapePts.delete(id);
        }
      }
    }
  }

  // stop times: the trips through the square, whole
  const keepStop = new Grow(1 << 16);
  const keepArr = new Grow(1 << 16);
  const keepDep = new Grow(1 << 16);
  const keepTrip = new Grow();
  const keepFirst = new Grow();
  const kept = new Map<number, number>();
  const stopUse = new Int32Array(stopE.length);
  let curTrip = '';
  // seq, stop, arrival, departure (as written: times are only read for the trips kept)
  let rows: Array<number | string> = [];
  const finishedTrips = new Set<number>();
  const scattered = new Set<number>();
  const relevant = (trip: number, r: Array<number | string>): boolean => {
    const sid = tShapeId[trip];
    if (sid && shapeNear.has(sid)) return true;
    for (let k = 0; k < r.length; k += 4) if (stopIn[r[k + 1] as number]) return true;
    // no shape: does a straight line from stop to stop cross the square?
    if (!sid || !shapePts.has(sid)) {
      for (let k = 4; k < r.length; k += 4) {
        const a = r[k - 3] as number;
        const b = r[k + 1] as number;
        if (crossesBox(stopE[a], stopN[a], stopE[b], stopN[b], h)) return true;
      }
    }
    return false;
  };
  const valid: boolean[] = [];
  const keep = (trip: number, r: Array<number | string>) => {
    kept.set(trip, keepTrip.n);
    valid.push(true);
    keepTrip.push(trip);
    keepFirst.push(keepStop.n);
    for (let k = 0; k < r.length; k += 4) {
      keepStop.push(r[k + 1] as number);
      const a = parseTime(r[k + 2] as string);
      const d = parseTime(r[k + 3] as string);
      keepArr.push(Number.isNaN(a) ? (Number.isNaN(d) ? -1 : d) : a);
      keepDep.push(Number.isNaN(d) ? (Number.isNaN(a) ? -1 : a) : d);
    }
  };
  const finishTrip = () => {
    const trip = tripIndex.get(curTrip);
    if (trip == null || !rows.length) {
      rows = [];
      return;
    }
    if (finishedTrips.has(trip)) scattered.add(trip);
    finishedTrips.add(trip);
    if (!scattered.has(trip)) {
      const r = sortRows(rows);
      if (relevant(trip, r)) keep(trip, r);
    }
    rows = [];
  };
  await readTable(
    blob,
    timesItem,
    ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'],
    ([trip, stop, seq, arr, dep]) => {
      if (trip !== curTrip) {
        finishTrip();
        curTrip = trip;
      }
      const s = stopIndex.get(stop);
      if (s == null) return;
      stopUse[s]++;
      if (!scan) rows.push(Number(seq), s, arr, dep);
    },
    tick,
  );
  finishTrip();
  if (scattered.size) {
    // a file whose trips' rows aren't kept together: read those trips once more, whole
    const whole = new Map<number, Array<number | string>>();
    await readTable(blob, timesItem, ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'], ([trip, stop, seq, arr, dep]) => {
      const t = tripIndex.get(trip);
      const s = stopIndex.get(stop);
      if (t == null || s == null || !scattered.has(t)) return;
      let b = whole.get(t);
      if (!b) whole.set(t, (b = []));
      b.push(Number(seq), s, arr, dep);
    });
    for (const t of scattered) {
      // the part kept on the first read goes
      const before = kept.get(t);
      if (before != null) valid[before] = false;
      kept.delete(t);
      const b = whole.get(t);
      if (!b) continue;
      const r = sortRows(b);
      if (relevant(t, r)) keep(t, r);
    }
  }
  keepFirst.push(keepStop.n);

  // trips that run every few minutes
  const freq = new Grow();
  const freqItem = item('frequencies.txt');
  if (freqItem && kept.size) {
    await readTable(blob, freqItem, ['trip_id', 'start_time', 'end_time', 'headway_secs'], ([trip, start, end, headway]) => {
      const t = tripIndex.get(trip);
      const k = t == null ? undefined : kept.get(t);
      const a = parseTime(start);
      const b = parseTime(end);
      const hw = Number(headway);
      if (k == null || !(b > a) || !(hw >= 30)) return;
      freq.push(k);
      freq.push(a);
      freq.push(b);
      freq.push(hw);
    });
  }

  // where the timetable is busiest: the 2 × 2 km with the most stops served (its centre and
  // its busiest stop's name), to go to when the square has nothing
  const busiest = busiestArea(stopUse, stopLon, stopLat, stopName);

  // only what the kept trips use, numbered afresh
  const allTrips = keepTrip.done();
  const allFirst = keepFirst.done();
  const allStop = keepStop.done();
  const allArr = keepArr.done();
  const allDep = keepDep.done();
  const order: number[] = [];
  const renumber = new Int32Array(allTrips.length).fill(-1);
  for (let k = 0; k < allTrips.length; k++) {
    if (!valid[k]) continue;
    renumber[k] = order.length;
    order.push(k);
  }
  const trips = Int32Array.from(order, (k) => allTrips[k]);
  const first = new Int32Array(order.length + 1);
  let rowsKept = 0;
  for (let i = 0; i < order.length; i++) {
    first[i] = rowsKept;
    rowsKept += allFirst[order[i] + 1] - allFirst[order[i]];
  }
  first[order.length] = rowsKept;
  const stStop = new Int32Array(rowsKept);
  const stArr = new Int32Array(rowsKept);
  const stDep = new Int32Array(rowsKept);
  const stopMap = new Map<number, number>();
  const names: string[] = [];
  const at: number[] = [];
  order.forEach((k, i) => {
    for (let a = allFirst[k], b = first[i]; a < allFirst[k + 1]; a++, b++) {
      const s = allStop[a];
      let j = stopMap.get(s);
      if (j == null) {
        j = names.length;
        stopMap.set(s, j);
        names.push(stopName[s]);
        at.push(stopE[s], stopN[s]);
      }
      stStop[b] = j;
      stArr[b] = allArr[a];
      stDep[b] = allDep[a];
    }
  });
  // frequencies name trips by their place among those kept
  const freqAll = freq.done();
  const freqKept: number[] = [];
  for (let f = 0; f < freqAll.length; f += 4) {
    const k = renumber[freqAll[f]];
    if (k >= 0) freqKept.push(k, freqAll[f + 1], freqAll[f + 2], freqAll[f + 3]);
  }
  const shapeMap = new Map<string, number>();
  const shapes: Float32Array[] = [];
  const tripShape = new Int32Array(trips.length);
  const tripRoute = new Int32Array(trips.length);
  const tripService = new Int32Array(trips.length);
  const tripHeadsign: string[] = [];
  trips.forEach((t, k) => {
    tripRoute[k] = tRoute.a[t];
    tripService[k] = tService.a[t];
    tripHeadsign.push(tHeadsign[t]);
    const sid = tShapeId[t];
    const pts = sid ? shapePts.get(sid) : undefined;
    if (!pts || pts.length < 4) {
      tripShape[k] = -1;
      return;
    }
    let i = shapeMap.get(sid);
    if (i == null) {
      i = shapes.length;
      shapeMap.set(sid, i);
      shapes.push(pts);
    }
    tripShape[k] = i;
  });

  onProgress(1);
  return {
    agencies,
    timeZone,
    firstDay: Number.isFinite(firstDay) ? firstDay : NaN,
    lastDay: Number.isFinite(lastDay) ? lastDay : NaN,
    routes,
    services,
    stopNames: names,
    stopAt: Float32Array.from(at),
    shapes,
    tripRoute,
    tripService,
    tripShape,
    tripHeadsign,
    tripFirst: first,
    stStop,
    stArr,
    stDep,
    frequencies: Int32Array.from(freqKept),
    hasShapes,
    busiest,
    tripsInFile: tripCount,
  };
}

/** seq, e, n triples → E, N pairs in sequence order */
function sortShape(buf: number[]): Float32Array {
  const n = buf.length / 3;
  let sorted = true;
  for (let i = 1; i < n; i++) if (buf[i * 3] < buf[(i - 1) * 3]) sorted = false;
  const order = Array.from({ length: n }, (_, i) => i);
  if (!sorted) order.sort((a, b) => buf[a * 3] - buf[b * 3]);
  const out = new Float32Array(n * 2);
  order.forEach((i, k) => {
    out[k * 2] = buf[i * 3 + 1];
    out[k * 2 + 1] = buf[i * 3 + 2];
  });
  return out;
}

/** seq, stop, arr, dep rows in sequence order */
function sortRows(r: Array<number | string>): Array<number | string> {
  const n = r.length / 4;
  const seq = (i: number) => r[i * 4] as number;
  let sorted = true;
  for (let i = 1; i < n; i++) if (seq(i) < seq(i - 1)) sorted = false;
  if (sorted) return r;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => seq(a) - seq(b));
  return order.flatMap((i) => [r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]]);
}

function touches(pts: Float32Array, h: number): boolean {
  const n = pts.length / 2;
  if (n === 1) return Math.abs(pts[0]) <= h && Math.abs(pts[1]) <= h;
  for (let i = 1; i < n; i++) if (crossesBox(pts[i * 2 - 2], pts[i * 2 - 1], pts[i * 2], pts[i * 2 + 1], h)) return true;
  return false;
}

/** The centre of the 2 × 2 km with the most stops served, weighted, and the name of its busiest stop. */
export function busiestArea(use: ArrayLike<number>, lon: number[], lat: number[], name: string[]): { lon: number; lat: number; name: string } | null {
  let lat0 = NaN;
  for (let i = 0; i < use.length && Number.isNaN(lat0); i++) if (use[i] > 0) lat0 = lat[i];
  if (Number.isNaN(lat0)) return null;
  // 1 km cells; the best block of 2 × 2 of them
  const dLat = 1000 / 111_132;
  const dLon = dLat / Math.max(0.1, Math.cos((lat0 * Math.PI) / 180));
  const cells = new Map<string, number>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (let i = 0; i < use.length; i++) {
    if (!use[i]) continue;
    const k = key(Math.floor(lon[i] / dLon), Math.floor(lat[i] / dLat));
    cells.set(k, (cells.get(k) ?? 0) + use[i]);
  }
  let best = '';
  let most = -1;
  for (const k of cells.keys()) {
    const [x, y] = k.split(',').map(Number);
    let sum = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) sum += cells.get(key(x + dx, y + dy)) ?? 0;
    if (sum > most) {
      most = sum;
      best = k;
    }
  }
  const [bx, by] = best.split(',').map(Number);
  let w = 0;
  let sx = 0;
  let sy = 0;
  let top = -1;
  let topName = '';
  for (let i = 0; i < use.length; i++) {
    if (!use[i]) continue;
    const x = Math.floor(lon[i] / dLon) - bx;
    const y = Math.floor(lat[i] / dLat) - by;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    w += use[i];
    sx += use[i] * lon[i];
    sy += use[i] * lat[i];
    if (use[i] > top) {
      top = use[i];
      topName = name[i];
    }
  }
  return { lon: sx / w, lat: sy / w, name: topName };
}
