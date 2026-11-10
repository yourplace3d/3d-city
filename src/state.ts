/**
 * View state and its URL form. Shared links carry coordinates and view
 * settings only — never the address the user typed (spec: privacy).
 */

import { round, type LngLat } from './geo/projection';

/** Building colours: one colour for all, or coloured by height ('ramp'). */
export const BUILDING_STYLES = ['white', 'grey', 'sand', 'dark', 'ramp'] as const;
export type BuildingStyle = (typeof BUILDING_STYLES)[number];
/** The side of the square (m): 300 m to 4 km in 100 m steps. */
export type AreaSize = number;
export const AREA_MIN = 300;
export const AREA_MAX = 4000;
export const AREA_STEP = 100;
export const clampSize = (m: number): AreaSize => Math.min(AREA_MAX, Math.max(AREA_MIN, Math.round(m / AREA_STEP) * AREA_STEP));
/** "500 m", "1.5 km", "2 km" */
export const formatSize = (m: number): string => (m < 1000 ? `${m} m` : `${Number((m / 1000).toFixed(1))} km`);
/** "500 × 500 m", "2 × 2 km" */
export const formatArea = (m: number): string => (m < 1000 ? `${m} × ${m} m` : `${Number((m / 1000).toFixed(1))} × ${formatSize(m)}`);

export interface Layers {
  roads: boolean;
  water: boolean;
  green: boolean;
}

/** The data layers of Your Place · Data; one is shown at a time (a route of your own shows over any). */
export const DATA_LAYERS = ['steep', 'traffic', 'transit', 'homes', 'income'] as const;
export type DataLayerId = (typeof DATA_LAYERS)[number];
/** What the traffic layer counts. */
export const TRAFFIC_KINDS = ['cars', 'bikes'] as const;
export type TrafficKind = (typeof TRAFFIC_KINDS)[number];

/** Orbit camera: angles in degrees, distance in metres, target offset in metres (E, N). */
export interface CameraState {
  azimuth: number;
  tilt: number;
  distance: number;
  targetE: number;
  targetN: number;
}

export interface ViewState {
  center: LngLat | null;
  size: AreaSize;
  exaggeration: number;
  contours: boolean;
  style: BuildingStyle;
  layers: Layers;
  camera: CameraState | null;
  /** where the user put the pin ("this one is ours"); null = at the centre */
  pin: LngLat | null;
  /**
   * A route's stretch as a link code (src/data/sources/routeLink.ts). Only set when the user
   * turned on "include the route in the link": a route can show where someone lives.
   */
  route: string | null;
  /** Your Place · Data: the data layer shown (null in Your Place) */
  data: DataLayerId | null;
  /** the traffic layer: cars or bikes */
  traffic: TrafficKind;
  /** the traffic layer: how far each count spreads along the streets (m) */
  spread: number;
}

export const DEFAULT_STATE: ViewState = {
  center: null,
  size: 2000,
  exaggeration: 1.5,
  contours: false,
  style: 'white',
  layers: { roads: true, water: true, green: true },
  camera: null,
  pin: null,
  route: null,
  data: null,
  traffic: 'cars',
  spread: 300,
};

/** The traffic layer's spread (m): its range and steps. */
export const SPREAD_RANGE = { min: 100, max: 500, step: 50 } as const;

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 5;

export function encodeState(s: ViewState): string {
  if (!s.center) return '';
  const p = new URLSearchParams();
  p.set('lat', round(s.center.lat, 5).toFixed(5));
  p.set('lon', round(s.center.lon, 5).toFixed(5));
  p.set('km', String(Number((s.size / 1000).toFixed(1))));
  p.set('ex', round(s.exaggeration, 1).toString());
  if (s.contours) p.set('ct', '1');
  if (s.style !== 'white') p.set('st', s.style);
  const ly = `${s.layers.roads ? 'r' : ''}${s.layers.water ? 'w' : ''}${s.layers.green ? 'g' : ''}`;
  if (ly !== 'rwg') p.set('ly', ly || '-');
  if (s.camera) {
    const c = s.camera;
    p.set('cam', [round(c.azimuth, 1), round(c.tilt, 1), Math.round(c.distance), Math.round(c.targetE), Math.round(c.targetN)].join(','));
  }
  if (s.pin) p.set('pin', `${round(s.pin.lat, 5).toFixed(5)},${round(s.pin.lon, 5).toFixed(5)}`);
  if (s.data) p.set('dl', s.data);
  if (s.data === 'traffic' && s.traffic !== 'cars') p.set('tk', s.traffic);
  if (s.data === 'traffic' && s.spread !== DEFAULT_STATE.spread) p.set('sp', String(s.spread));
  if (s.route) p.set('rt', s.route);
  // commas are fine in a fragment and keep links readable
  return p.toString().replace(/%2C/g, ',');
}

export function decodeState(raw: string, base: ViewState = DEFAULT_STATE): ViewState {
  const p = new URLSearchParams(raw.replace(/^[#?]/, ''));
  const s: ViewState = { ...base, layers: { ...base.layers }, camera: null, pin: null, route: null, data: null };
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  if (p.has('lat') && p.has('lon') && validLatLon(lat, lon)) {
    s.center = { lat, lon };
  } else {
    return { ...base, center: null, pin: null, route: null, data: null };
  }
  const km = Number(p.get('km'));
  if (p.has('km') && Number.isFinite(km) && km > 0) s.size = clampSize(km * 1000);
  const ex = Number(p.get('ex'));
  if (p.has('ex') && Number.isFinite(ex)) s.exaggeration = Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, ex));
  s.contours = p.get('ct') === '1';
  const st = p.get('st');
  s.style = BUILDING_STYLES.find((x) => x === st) ?? 'white';
  const ly = p.get('ly');
  if (ly != null) s.layers = { roads: ly.includes('r'), water: ly.includes('w'), green: ly.includes('g') };
  const cam = p.get('cam')?.split(',').map(Number);
  if (cam && cam.length === 5 && cam.every(Number.isFinite)) {
    s.camera = { azimuth: cam[0], tilt: cam[1], distance: cam[2], targetE: cam[3], targetN: cam[4] };
  }
  const pin = p.get('pin')?.split(',').map(Number);
  if (pin && pin.length === 2 && validLatLon(pin[0], pin[1])) s.pin = { lat: pin[0], lon: pin[1] };
  const rt = p.get('rt');
  if (rt && /^[A-Za-z0-9_-]{6,12000}$/.test(rt)) s.route = rt;
  s.data = DATA_LAYERS.find((d) => d === p.get('dl')) ?? null;
  s.traffic = TRAFFIC_KINDS.find((k) => k === p.get('tk')) ?? 'cars';
  const sp = Number(p.get('sp'));
  s.spread = p.has('sp') && Number.isFinite(sp) ? Math.max(SPREAD_RANGE.min, Math.min(SPREAD_RANGE.max, Math.round(sp / SPREAD_RANGE.step) * SPREAD_RANGE.step)) : DEFAULT_STATE.spread;
  return s;
}

function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
}

export function samePlace(a: LngLat | null, b: LngLat | null): boolean {
  return a === b || (!!a && !!b && a.lat === b.lat && a.lon === b.lon);
}
