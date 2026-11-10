/**
 * Source: values per area, such as what homes cost or what people earn, from a file the user picked or
 * a provider's download. Statistics offices publish them in a few shapes, and all of them are read
 * here, in the browser:
 *
 *   - grid cells: a CSV with one row per square of the European grid (ETRS89-LAEA, EPSG:3035),
 *     named the INSPIRE way, e.g. "CRS3035RES100mN2691700E4341100" (Germany's 2022 census,
 *     France's INSEE, Eurostat)
 *   - areas: GeoJSON polygons, such as neighbourhoods or US block groups, with numbers among their
 *     properties (in longitude/latitude, or a projection `geo/crs` knows)
 *   - points: GeoJSON points, or a CSV with latitude and longitude columns, such as single sales;
 *     `match/areas` turns them into medians per square, so no single one shows
 *
 * A ZIP holding such a file works too (the census ships 100 m, 1 km and 10 km grids in one; the
 * finest is read). Only what lies in the model's square is kept. A whole country's grid is a few
 * hundred MB unpacked, so CSV files are read in pieces as a stream; GeoJSON is read whole. Runs in a
 * worker (`area.worker.ts`); everything here is plain code, so Node tests can run it too.
 */

import { makeProjector, type LngLat } from '../../geo/projection';
import { epsgOf, laeaForward, laeaInverse, toLonLatFor, type ToLonLat } from '../../geo/crs';
import { splitCsv } from './gtfs';
import { listZip, openItem, ZipProblem, type ZipItem } from './zipFile';

export type AreaGeometry = 'cells' | 'shapes' | 'points';

export interface AreaFeature {
  /** cells and shapes: rings as flat E, N pairs (metres from the centre). Points: one ring of one pair. */
  rings: number[][];
  /** what the area is called in the file, or '' */
  name: string;
  /** the provider marks the value as statistically uncertain */
  uncertain: boolean;
}

/** A file's values, cut to the model's square. */
export interface AreaCut {
  geometry: AreaGeometry;
  /** the side of a grid cell (m), for cells; 0 otherwise */
  cellM: number;
  features: AreaFeature[];
  /** the columns with numbers, in the file's order */
  columns: string[];
  /** what a column holds, where the file says (Census Reporter's metadata), by column */
  titles: Record<string, string>;
  /** values[c][f]; NaN where an area has none */
  values: Float64Array[];
  /** how many areas, cells or points the whole file has */
  inFile: number;
  /** the file read (inside a ZIP: its name there) */
  part: string;
  /** where the whole file has data (degrees), or null */
  extent: Extent | null;
}

export interface Extent {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Grows a box of longitudes and latitudes. */
class Bounds {
  s = Infinity;
  w = Infinity;
  n = -Infinity;
  e = -Infinity;
  add(lon: number, lat: number): void {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lat < this.s) this.s = lat;
    if (lat > this.n) this.n = lat;
    if (lon < this.w) this.w = lon;
    if (lon > this.e) this.e = lon;
  }
  get extent(): Extent | null {
    return Number.isFinite(this.s) ? { south: this.s, west: this.w, north: this.n, east: this.e } : null;
  }
}

export interface AreaArea {
  center: LngLat;
  sizeM: number;
}

export type AreaProblemKind = 'unreadable' | 'noPlace' | 'noValues' | 'projection' | 'tooBig' | 'sevenZip';

export class AreaProblem extends Error {
  constructor(
    readonly kind: AreaProblemKind,
    readonly detail = '',
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'AreaProblem';
  }
}

/** A CSV is read as a stream, so a country's grid is fine; GeoJSON is read whole, so it has to fit in memory. */
export const MAX_CSV_BYTES = 1500 * 1024 * 1024;
export const MAX_JSON_BYTES = 400 * 1024 * 1024;
/** Areas this far outside the square still count: a building on its edge belongs to one. */
export const AREA_MARGIN_M = 60;

// ------------------------------------------------------------------ values

/** Placeholder numbers statistics offices use for "secret" or "not available" (CBS −99997, US Census −666666666). */
const SENTINEL = -99990;

/**
 * A number from a file: German and French files write 6,26 for 6.26 (`comma`); a string from
 * GeoJSON may be "6,26" or "1,234". Placeholders for missing values, and text, are NaN.
 */
export function parseValue(raw: unknown, comma = false): number {
  let v: number;
  if (typeof raw === 'number') v = raw;
  else if (typeof raw === 'string') {
    let s = raw.trim().replace(/[\s  ']/g, '').replace(/−/g, '-');
    if (!s) return NaN;
    if (comma) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    v = Number(s);
  } else return NaN;
  return Number.isFinite(v) && v > SENTINEL ? v : NaN;
}

/** Columns that hold places, codes or years, not values worth colouring by. */
const NOT_VALUES =
  /^(x|y|z|lat|lon|lng|long|latitude|longitude|fid|ogc_fid|objectid|gml_id|id|oid|shape_area|shape_length|shape_leng|shape__area|shape__length|area|perimeter)$|^[xy]_mp_|(^|_)(id|code|nr|nummer)$|gitter_id|geoid|jahrgang|postcode|postal|^zip|^plz$|^year$|jaar|statcode|,\s*error$|_moe$|margin/i;

/** What an area's name is called in the files we know, best first. */
const NAME_KEYS = ['name', 'buurtnaam', 'wijknaam', 'stadtteil', 'ortsteil', 'nom', 'naam', 'bezeichnung', 'label', 'gemeentenaam', 'gen'];

/** Germany's census marks values from very few homes with KLAMMERN ("in brackets"). */
const FLAG_KEY = 'werterlaeuternde_zeichen';

/** Gathers values column by column as areas come in. */
class Table {
  readonly columns: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly cols: number[][] = [];
  private readonly filled: number[] = [];
  private readonly numeric: number[] = [];
  readonly names: string[] = [];
  count = 0;

  column(key: string): number {
    let c = this.index.get(key);
    if (c === undefined) {
      c = this.columns.length;
      this.index.set(key, c);
      this.columns.push(key);
      this.cols.push([]);
      this.filled.push(0);
      this.numeric.push(0);
    }
    return c;
  }

  /** a new area; then `set` its values */
  add(name: string): number {
    this.names.push(name);
    return this.count++;
  }

  set(c: number, raw: unknown, comma: boolean): void {
    if (raw === null || raw === undefined || raw === '') return;
    this.filled[c]++;
    const v = parseValue(raw, comma);
    // a placeholder for "secret" still counts as a number
    if (Number.isFinite(v) || (typeof raw === 'number' && Number.isFinite(raw)) || (typeof raw === 'string' && /^-\d+([.,]\d+)?$/.test(raw.trim()))) this.numeric[c]++;
    const col = this.cols[c];
    while (col.length < this.count - 1) col.push(NaN);
    col[this.count - 1] = v;
  }

  /** the columns worth colouring by: mostly numbers, at least one value, not a place or a code */
  done(): { columns: string[]; values: Float64Array[] } {
    const columns: string[] = [];
    const values: Float64Array[] = [];
    this.columns.forEach((key, c) => {
      if (NOT_VALUES.test(key) || this.numeric[c] === 0 || this.numeric[c] < this.filled[c] * 0.5) return;
      const a = new Float64Array(this.count).fill(NaN);
      const col = this.cols[c];
      for (let i = 0; i < col.length; i++) a[i] = col[i] ?? NaN;
      if (!a.some(Number.isFinite)) return;
      columns.push(key);
      values.push(a);
    });
    return { columns, values };
  }
}

// ------------------------------------------------------------------ the square

interface Square {
  toLocal: (lon: number, lat: number) => [number, number];
  /** half the side, plus the margin */
  h: number;
  center: LngLat;
}

function squareOf(area: AreaArea): Square {
  const p = makeProjector(area.center);
  return { toLocal: (lon, lat) => p.toLocal(lon, lat), h: area.sizeM / 2 + AREA_MARGIN_M, center: area.center };
}

function boxMeets(xs: number[], h: number): boolean {
  let e0 = Infinity;
  let e1 = -Infinity;
  let n0 = Infinity;
  let n1 = -Infinity;
  for (let k = 0; k < xs.length; k += 2) {
    if (xs[k] < e0) e0 = xs[k];
    if (xs[k] > e1) e1 = xs[k];
    if (xs[k + 1] < n0) n0 = xs[k + 1];
    if (xs[k + 1] > n1) n1 = xs[k + 1];
  }
  return e1 >= -h && e0 <= h && n1 >= -h && n0 <= h;
}

// ------------------------------------------------------------------ grid cells (CSV)

const INSPIRE_ID = /^CRS(\d+)RES(\d+)(m|km)N(\d+)E(\d+)$/i;
const SHORT_ID = /^(\d+)(m|km)N(\d+)E(\d+)$/i;

/** A grid cell's code as its lower-left corner and side (metres, ETRS89-LAEA), or null. */
export function parseCellId(id: string): { crs: number; size: number; n: number; e: number } | null {
  let m = INSPIRE_ID.exec(id);
  if (m) {
    const size = Number(m[2]) * (m[3].toLowerCase() === 'km' ? 1000 : 1);
    return { crs: Number(m[1]), size, n: Number(m[4]), e: Number(m[5]) };
  }
  // Eurostat's older codes count in cells: 1kmN2689E4337
  m = SHORT_ID.exec(id);
  if (m) {
    const size = Number(m[1]) * (m[2].toLowerCase() === 'km' ? 1000 : 1);
    return { crs: 3035, size, n: Number(m[3]) * size, e: Number(m[4]) * size };
  }
  return null;
}

/** The square's extent in ETRS89-LAEA metres (its corners projected; the grid is turned a little). */
function laeaBox(sq: Square): { x0: number; x1: number; y0: number; y1: number; toLonLat: (e: number, n: number) => [number, number] } {
  const p = makeProjector(sq.center);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [e, n] of [[-sq.h, -sq.h], [sq.h, -sq.h], [sq.h, sq.h], [-sq.h, sq.h]]) {
    const ll = p.toLngLat(e, n);
    const [x, y] = laeaForward(ll.lon, ll.lat);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1, toLonLat: (e, n) => [p.toLngLat(e, n).lon, p.toLngLat(e, n).lat] };
}

// ------------------------------------------------------------------ reading text

/** Text of a file, in pieces; UTF-8, or Windows-1252 for older files that aren't. */
async function textStream(src: Blob | (() => Promise<ReadableStream<Uint8Array>>)): Promise<ReadableStreamDefaultReader<string>> {
  const open = typeof src === 'function' ? src : async () => src.stream() as ReadableStream<Uint8Array>;
  // sniff the start: German offices still write Windows-1252 now and then
  const sniff = (await open()).getReader();
  const head = await sniff.read();
  void sniff.cancel();
  let label = 'utf-8';
  try {
    if (head.value) new TextDecoder('utf-8', { fatal: true }).decode(head.value.subarray(0, Math.min(head.value.length, 65536 - 4)), { stream: true });
  } catch {
    label = 'windows-1252';
  }
  return (await open()).pipeThrough(new TextDecoderStream(label) as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
}

/** Calls `onLine` for each line of a text stream (without its line end). */
async function eachLine(reader: ReadableStreamDefaultReader<string>, onLine: (line: string) => boolean | void, onChars: (n: number) => void): Promise<void> {
  let rest = '';
  let pending = '';
  const handle = (raw: string): boolean => {
    let s = pending ? `${pending}\n${raw}` : raw;
    pending = '';
    // a quoted field may hold a line break
    if (s.indexOf('"') >= 0 && quotesOpen(s)) {
      pending = s;
      return false;
    }
    if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    return onLine(s) === true;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChars(value.length);
    const chunk = rest + value;
    let start = 0;
    for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
      if (handle(chunk.slice(start, nl))) {
        await reader.cancel();
        return;
      }
      start = nl + 1;
    }
    rest = chunk.slice(start);
  }
  if (rest || pending) handle(rest);
}

function quotesOpen(s: string): boolean {
  let open = false;
  for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) open = !open;
  return open;
}

/** The separator a CSV's header line uses. */
export function separatorOf(header: string): string {
  const count = (c: string) => header.split(c).length - 1;
  const best = [';', '\t', ',', '|'].map((c) => [c, count(c)] as const).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

const LAT_KEYS = /^(lat|latitude|breite|breitengrad|y_wgs84|lat_wgs84|wgs84_lat|latitud)$/i;
const LON_KEYS = /^(lon|lng|long|longitude|laenge|länge|laengengrad|x_wgs84|lon_wgs84|wgs84_lon|longitud)$/i;

/** Reads a CSV: grid cells (by their codes or centre columns) or points (latitude and longitude). */
async function readCsv(src: Blob | (() => Promise<ReadableStream<Uint8Array>>), size: number, part: string, sq: Square, onProgress: (share: number) => void): Promise<AreaCut> {
  const reader = await textStream(src);
  const table = new Table();
  const features: AreaFeature[] = [];
  const fields: string[] = [];
  let sep = ',';
  let comma = false;
  let header: string[] | null = null;
  let colOf: number[] = [];
  let mode: 'cells' | 'centres' | 'points' | null = null;
  let idCol = -1;
  let xCol = -1;
  let yCol = -1;
  let centreSize = 0;
  let nameCol = -1;
  let flagCol = -1;
  let inFile = 0;
  let geometry: AreaGeometry = 'cells';
  let cellM = 0;
  let box: ReturnType<typeof laeaBox> | null = null;
  let chars = 0;
  let problem: AreaProblem | null = null;
  const bounds = new Bounds();
  // the grid's extent, in its own metres
  let gx0 = Infinity;
  let gx1 = -Infinity;
  let gy0 = Infinity;
  let gy1 = -Infinity;

  const cellRings = (x: number, y: number, s: number): number[] => {
    const out: number[] = [];
    for (const [cx, cy] of [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]) {
      const [lon, lat] = laeaInverse(cx, cy);
      out.push(...sq.toLocal(lon, lat));
    }
    return out;
  };

  const keep = (rings: number[][], row: number): void => {
    const name = nameCol >= 0 ? fields[nameCol] ?? '' : '';
    table.add(name);
    features.push({ rings, name, uncertain: flagCol >= 0 && /klammer/i.test(fields[flagCol] ?? '') });
    for (let k = 0; k < colOf.length && k < row; k++) table.set(colOf[k], fields[k], comma);
  };

  await eachLine(
    reader,
    (line) => {
      if (!line.trim()) return;
      if (!header) {
        const clean = line.replace(/^﻿/, '');
        sep = separatorOf(clean);
        comma = sep === ';';
        const n = splitCsv(clean, fields, sep);
        header = fields.slice(0, n).map((f) => f.trim());
        const lower = header.map((h) => h.toLowerCase());
        colOf = header.map((h) => table.column(h));
        nameCol = NAME_KEYS.map((k) => lower.indexOf(k)).find((i) => i >= 0) ?? -1;
        flagCol = lower.indexOf(FLAG_KEY);
        const lat = lower.findIndex((h) => LAT_KEYS.test(h));
        const lon = lower.findIndex((h) => LON_KEYS.test(h));
        xCol = lower.findIndex((h) => /^x_mp_\d+k?m$/.test(h));
        yCol = lower.findIndex((h) => /^y_mp_\d+k?m$/.test(h));
        if (lat >= 0 && lon >= 0) {
          mode = 'points';
          xCol = lon;
          yCol = lat;
        } else if (xCol >= 0 && yCol >= 0) {
          const m = /_(\d+)(k?m)$/i.exec(lower[xCol])!;
          centreSize = Number(m[1]) * (m[2] === 'km' ? 1000 : 1);
          mode = 'centres';
        }
        return;
      }
      const n = splitCsv(line, fields, sep);
      if (!inFile && mode !== 'points') {
        // the grid code column, found by its first value; it wins over centre columns
        for (let k = 0; k < n && idCol < 0; k++) if (parseCellId(fields[k].trim())) idCol = k;
        if (idCol >= 0) mode = 'cells';
        if (!mode) {
          problem = new AreaProblem('noPlace');
          return true;
        }
      }
      inFile++;
      if (mode === 'points') {
        geometry = 'points';
        const lon = parseValue(fields[xCol]);
        const lat = parseValue(fields[yCol]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        bounds.add(lon, lat);
        const [e, nn] = sq.toLocal(lon, lat);
        if (Math.abs(e) > sq.h || Math.abs(nn) > sq.h) return;
        keep([[e, nn]], n);
        return;
      }
      box ??= laeaBox(sq);
      let x: number;
      let y: number;
      let s: number;
      if (mode === 'cells') {
        const c = parseCellId(fields[idCol].trim());
        if (!c) return;
        if (c.crs !== 3035) {
          problem = new AreaProblem('projection', `EPSG:${c.crs}`);
          return true;
        }
        ({ e: x, n: y, size: s } = c);
      } else {
        s = centreSize;
        x = parseValue(fields[xCol]) - s / 2;
        y = parseValue(fields[yCol]) - s / 2;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      }
      cellM = s;
      if (x < gx0) gx0 = x;
      if (x + s > gx1) gx1 = x + s;
      if (y < gy0) gy0 = y;
      if (y + s > gy1) gy1 = y + s;
      if (x + s < box.x0 || x > box.x1 || y + s < box.y0 || y > box.y1) return;
      const ring = cellRings(x, y, s);
      if (!boxMeets(ring, sq.h)) return;
      keep([ring], n);
    },
    (c) => {
      chars += c;
      // characters ≈ bytes for these files
      onProgress(Math.min(1, chars / Math.max(1, size)));
    },
  );
  if (problem) throw problem;
  if (!header) throw new AreaProblem('unreadable');
  if (!inFile) throw new AreaProblem(mode ? 'noValues' : 'noPlace');
  const { columns, values } = table.done();
  if (Number.isFinite(gx0)) for (const [x, y] of [[gx0, gy0], [gx1, gy0], [gx1, gy1], [gx0, gy1]]) bounds.add(...laeaInverse(x, y));
  const cut: AreaCut = { geometry, cellM: geometry === 'cells' ? cellM : 0, features, columns, titles: {}, values, inFile, part, extent: bounds.extent };
  // nothing in the square: the page says so (and where the file has data)
  if (!features.length) return cut;
  if (!columns.length) throw new AreaProblem('noValues');
  return cut;
}

// ------------------------------------------------------------------ GeoJSON

interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

interface GeoJsonFeature {
  type?: string;
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

/** The projections to try when a file doesn't say which one it uses, by how close they put it to the square. */
function guessProjection(sample: [number, number], sq: Square): ToLonLat | null {
  const [x, y] = sample;
  const zone = Math.floor((sq.center.lon + 180) / 6) + 1;
  const codes = [3035, 25832, 25833, 25831, 4647, 5650, 3857, (sq.center.lat >= 0 ? 32600 : 32700) + zone, 4326];
  let best: ToLonLat | null = null;
  let bestD = 150_000;
  for (const code of codes) {
    const f = toLonLatFor(code)!;
    // lon/lat given the other way round, too
    for (const g of code === 4326 ? [f, (a: number, b: number) => [b, a] as [number, number]] : [f]) {
      const [lon, lat] = g(x, y);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) continue;
      const [e, n] = sq.toLocal(lon, lat);
      const d = Math.hypot(e, n);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
  }
  return best;
}

function firstPosition(c: unknown): [number, number] | null {
  let v = c;
  while (Array.isArray(v) && Array.isArray(v[0])) v = v[0];
  return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null;
}

/** Reads GeoJSON (a FeatureCollection, or a single Feature): polygons, or points. */
export function readGeoJson(text: string, part: string, area: AreaArea): AreaCut {
  let doc: { type?: string; features?: GeoJsonFeature[]; crs?: { properties?: { name?: string } } } & GeoJsonFeature;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new AreaProblem('unreadable');
  }
  const list: GeoJsonFeature[] = doc?.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features : doc?.type === 'Feature' ? [doc] : [];
  if (!list.length) throw new AreaProblem(doc?.type === 'FeatureCollection' ? 'noValues' : 'unreadable');
  const sq = squareOf(area);

  // the projection: as the file says, else whichever puts it near the square
  const named = doc.crs?.properties?.name;
  let toLonLat: ToLonLat | null = null;
  if (named) {
    const code = epsgOf(named);
    toLonLat = code ? toLonLatFor(code) : null;
    if (!toLonLat) throw new AreaProblem('projection', named);
  }
  if (!toLonLat) {
    const sample = list.map((f) => firstPosition(f.geometry?.coordinates)).find(Boolean) ?? null;
    if (!sample) throw new AreaProblem('noPlace');
    const plain = Math.abs(sample[0]) <= 180 && Math.abs(sample[1]) <= 90;
    toLonLat = plain ? (x, y) => [x, y] : guessProjection(sample, sq);
    if (!toLonLat) throw new AreaProblem('projection');
  }
  const bounds = new Bounds();
  const local = (pos: unknown): [number, number] | null => {
    if (!Array.isArray(pos) || typeof pos[0] !== 'number' || typeof pos[1] !== 'number') return null;
    const [lon, lat] = toLonLat!(pos[0], pos[1]);
    bounds.add(lon, lat);
    return sq.toLocal(lon, lat);
  };
  const ringOf = (ring: unknown): number[] => {
    const out: number[] = [];
    if (!Array.isArray(ring)) return out;
    for (const p of ring) {
      const q = local(p);
      if (q) out.push(q[0], q[1]);
    }
    return out;
  };
  const shapesOf = (g: GeoJsonGeometry | null | undefined, rings: number[][], points: number[][]): void => {
    if (!g) return;
    const c = g.coordinates as unknown[];
    if (g.type === 'Polygon' && Array.isArray(c)) for (const r of c) rings.push(ringOf(r));
    else if (g.type === 'MultiPolygon' && Array.isArray(c)) for (const poly of c) for (const r of poly as unknown[]) rings.push(ringOf(r));
    else if (g.type === 'Point') {
      const q = local(c);
      if (q) points.push(q);
    } else if (g.type === 'MultiPoint' && Array.isArray(c) && c.length) {
      const q = local(c[0]);
      if (q) points.push(q);
    } else if (g.type === 'GeometryCollection') for (const part of g.geometries ?? []) shapesOf(part, rings, points);
  };

  const table = new Table();
  const features: AreaFeature[] = [];
  let polygons = 0;
  let points = 0;
  const kept: { rings: number[][]; points: number[][]; props: Record<string, unknown> }[] = [];
  for (const f of list) {
    const rings: number[][] = [];
    const pts: number[][] = [];
    shapesOf(f.geometry, rings, pts);
    const good = rings.filter((r) => r.length >= 6);
    if (good.length) polygons++;
    else if (pts.length) points++;
    else continue;
    const inside = good.length ? good.some((r) => boxMeets(r, sq.h)) : Math.abs(pts[0][0]) <= sq.h && Math.abs(pts[0][1]) <= sq.h;
    if (inside) kept.push({ rings: good, points: pts, props: f.properties ?? {} });
  }
  if (!polygons && !points) throw new AreaProblem('noPlace');
  const geometry: AreaGeometry = polygons >= points ? 'shapes' : 'points';
  for (const k of kept) {
    if (geometry === 'shapes' && !k.rings.length) continue;
    if (geometry === 'points' && k.rings.length) continue;
    const props = k.props;
    const keys = Object.keys(props);
    const nameKey = NAME_KEYS.map((n) => keys.find((key) => key.toLowerCase() === n)).find((key) => key && typeof props[key] === 'string');
    const name = nameKey ? String(props[nameKey]) : '';
    const flagKey = keys.find((key) => key.toLowerCase() === FLAG_KEY);
    table.add(name);
    features.push({ rings: geometry === 'shapes' ? k.rings : [k.points[0]], name, uncertain: !!flagKey && /klammer/i.test(String(props[flagKey])) });
    for (const key of keys) {
      const v = props[key];
      if (typeof v === 'number' || typeof v === 'string') table.set(table.column(key), v, false);
      else table.column(key);
    }
  }
  const { columns, values } = table.done();
  const cut: AreaCut = { geometry, cellM: 0, features, columns, titles: {}, values, inFile: polygons + points, part, extent: bounds.extent };
  if (!features.length) return cut;
  if (!columns.length) throw new AreaProblem('noValues');
  return cut;
}

// ------------------------------------------------------------------ files and archives

const READABLE = /\.(csv|txt|tsv|geojson|json)$/i;

/** The cell size a file's name says (100m, 1km, 200m), in metres, or Infinity. */
function sizeInName(name: string): number {
  const m = /(\d+)\s*(km|m)(?![a-z])/i.exec(name.replace(/^.*\//, ''));
  return m ? Number(m[1]) * (m[2].toLowerCase() === 'km' ? 1000 : 1) : Infinity;
}

/** Which file of an archive to read: GeoJSON before CSV; of grids, the finest; else the biggest. */
export function pickPart(items: ZipItem[]): ZipItem | null {
  const files = items.filter((i) => READABLE.test(i.name) && !/(^|\/)(__MACOSX|\.)/.test(i.name) && !/metadata\.json$/i.test(i.name) && i.size > 0);
  if (!files.length) return null;
  const geo = files.filter((i) => /\.geojson$/i.test(i.name));
  const pool = geo.length ? geo : files.filter((i) => !/\.json$/i.test(i.name)).length ? files.filter((i) => !/\.json$/i.test(i.name)) : files;
  return [...pool].sort((a, b) => sizeInName(a.name) - sizeInName(b.name) || b.size - a.size)[0];
}

async function itemText(blob: Blob, item: ZipItem): Promise<string> {
  return new Response(await openItem(blob, item)).text();
}

/** Column titles from Census Reporter's metadata.json, by column. */
export function titlesFromMetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const meta = JSON.parse(text) as { tables?: Record<string, { title?: string; columns?: Record<string, { name?: string }> }> };
    for (const table of Object.values(meta.tables ?? {})) for (const [id, c] of Object.entries(table.columns ?? {})) if (c.name) out[id] = c.name;
  } catch {
    /* no titles then */
  }
  return out;
}

const isZip = async (blob: Blob) => {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
};

const is7z = async (blob: Blob) => {
  const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  return head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf;
};

/** Reads a file of values (CSV, GeoJSON, or a ZIP of one) for the square. */
export async function cutAreas(blob: Blob, name: string, area: AreaArea, onProgress: (share: number) => void = () => undefined): Promise<AreaCut> {
  if (await is7z(blob)) throw new AreaProblem('sevenZip');
  const sq = squareOf(area);
  if (await isZip(blob)) {
    let items: ZipItem[];
    try {
      items = await listZip(blob);
    } catch (err) {
      if (err instanceof ZipProblem) throw new AreaProblem('unreadable');
      throw err;
    }
    if (items.some((i) => /\.7z$/i.test(i.name)) && !items.some((i) => READABLE.test(i.name))) throw new AreaProblem('sevenZip');
    const item = pickPart(items);
    if (!item) throw new AreaProblem('unreadable');
    const meta = items.find((i) => /metadata\.json$/i.test(i.name));
    const titles = meta ? titlesFromMetadata(await itemText(blob, meta)) : {};
    let cut: AreaCut;
    if (/\.(geojson|json)$/i.test(item.name)) {
      if (item.size > MAX_JSON_BYTES) throw new AreaProblem('tooBig');
      cut = readGeoJson(await itemText(blob, item), item.name, area);
    } else {
      if (item.size > MAX_CSV_BYTES) throw new AreaProblem('tooBig');
      cut = await readCsv(() => openItem(blob, item), item.size, item.name, sq, onProgress);
    }
    cut.titles = titles;
    return cut;
  }
  const head = (await blob.slice(0, 2048).text()).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    if (blob.size > MAX_JSON_BYTES) throw new AreaProblem('tooBig');
    return readGeoJson(await blob.text(), name, area);
  }
  if (blob.size > MAX_CSV_BYTES) throw new AreaProblem('tooBig');
  return readCsv(blob, blob.size, name, sq, onProgress);
}
