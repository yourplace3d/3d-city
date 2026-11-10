import './styles.css';
import { resolveToSettlement, reverse, type Place } from './geo/geocode';
import { buildingsQuery, featuresQuery, overpass, parseBuildings, parseFeatures, parseSettlements, pickSettlement, settlementsQuery, type FeatureSet, type Settlement, type SettlementKind } from './geo/osm';
import { DATA_ZOOM, fetchTiles, parseTiles, settlementsFromTiles, tilesForSquare } from './geo/tiles';
import { formatLatLon, makeProjector, squareBBox, type LngLat } from './geo/projection';
import { loadHeightGrid } from './geo/terrain';
import { CityModel } from './scene/cityModel';
import { BUILDING_COLOURS, HEIGHT_RAMP } from './scene/buildingsMesh';
import { isWebGL2Available, Viewer } from './scene/viewer';
import { clampSize, decodeState, encodeState, samePlace, type AreaSize, type BuildingStyle, type DataLayerId, type Layers, type TrafficKind, type ViewState } from './state';
import { makePoster, posterFileName } from './ui/poster';
import { setupSearch } from './ui/search';
import { NoticeView } from './ui/notice';
import { StatusView } from './ui/status';
import { RouteController } from './ui/route';
import { SteepController } from './ui/steepness';
import { TrafficController, TRAFFIC_PRESETS } from './ui/traffic';
import { TRAFFIC_ATTRIBUTION } from './data/sources/hamburgTraffic';
import { TransitController } from './ui/transit';
import { AreaController } from './ui/areas';
import type { AreaLayer } from './data/sources/areaProviders';
import { area, direction, distance, num, t, translatePage } from './i18n';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Hilly places for the steepness card. */
const STEEP_PRESETS: Array<{ name: string; center: LngLat; size: AreaSize; ex: number }> = [
  { name: 'Lisbon', center: { lat: 38.7139, lon: -9.1365 }, size: 2000, ex: 1.5 },
  { name: 'San Francisco', center: { lat: 37.7935, lon: -122.4075 }, size: 2000, ex: 1.5 },
  { name: 'Stuttgart', center: { lat: 48.7765, lon: 9.1772 }, size: 3000, ex: 1.5 },
];

// ------------------------------------------------------------------ state

// the page's texts in the visitor's language, before anything reads them
translatePage();
const app = $('app');
/** the landing page's title; a loaded place puts its name in the tab instead */
const HOME_TITLE = document.title;
let state: ViewState = decodeState(location.hash);
/** Set once this browser has opened a place of its own; until then a shared model ends with an invitation. */
const OWN_KEY = 'yp:own';
let inviteOwn = !!state.center && !readFlag(OWN_KEY);
let model: CityModel | null = null;
let placeLabel = '';
/** set when a shared link to open country is named after the nearest village */
let placeNear = '';
let loadToken = 0;
let abort: AbortController | null = null;
/** the square was built around a route's stretch (no searched point: the pin stays hidden until placed) */
let routeSquare = false;
const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c8431a';

const status = new StatusView($('status'));
const notice = new NoticeView($('notice'), $('notice-text'), $('notice-actions'), $('notice-close'));
const debug = {
  state: () => state,
  stage: 'idle' as 'idle' | 'loading' | 'terrain' | 'ready' | 'error',
  timings: {} as Record<string, number>,
  stats: () => model?.stats() ?? null,
  /** used by tools/inspect to diagnose odd-looking models */
  inspect: () => model?.inspect() ?? null,
  camera: () => (model ? viewer.getCameraState() : null),
  /** whether the camera is still gliding (damping after a drag, or an animation) */
  moving: () => viewer.moving,
  notice: () => (notice.visible ? $('notice-text').textContent : null),
  source: '' as '' | 'tiles' | 'overpass',
  pin: () => model?.pinInfo() ?? null,
  pick: (x: number, y: number) => viewer.pick(x, y),
  /** used by tools/video to drive the camera frame by frame */
  setCamera: (c: Parameters<Viewer['setCameraState']>[0]) => viewer.setCameraState(c),
  route: () => route?.debugInfo() ?? null,
  steep: () => steep?.debugInfo() ?? null,
  traffic: () => traffic?.debugInfo() ?? null,
  transit: () => transit?.debugInfo() ?? null,
  /** show the timetable at a moment (s after midnight), with trails that long (s), for tools/video */
  transitAt: (s: number, trail = 0) => transit?.frameAt(s, trail),
  /** the route's replay at a point (0–1), for tools/video */
  routeAt: (position: number) => route?.frameAt(position),
  /** the traffic at a moment of the day (hours from its first, fractions too), for tools/video */
  trafficAt: (hour: number) => traffic?.frameAt(hour),
  /** the model's streets and paths (metres E, N of the centre), for tools/video to lay a run along them */
  streets: () => model?.featureSet?.lines.filter((l) => !['rail', 'river', 'canal', 'stream'].includes(l.kind)).map((l) => ({ kind: l.kind, pts: l.pts })) ?? null,
  /** the Homes and Income layers */
  areas: (layer: AreaLayer) => (layer === 'homes' ? homes : income)?.debugInfo() ?? null,
};
(window as unknown as { __yourPlace: typeof debug }).__yourPlace = debug;

// ------------------------------------------------------------------ boot

if (!isWebGL2Available()) {
  $('unsupported').hidden = false;
  throw new Error('WebGL 2 is not available');
}

const viewer = new Viewer($<HTMLCanvasElement>('scene'));
viewer.onCameraChange(() => {
  updateCompass();
  scheduleHashWrite();
});
viewer.onTap(movePinTo);
// the data layers
const steep = new SteepController({ viewer, model: () => model });
const route = new RouteController({
  viewer,
  accent,
  model: () => model,
  // the route takes the steepness colours on the steepness layer
  steep: () => state.data === 'steep',
  // over traffic streets, the route rides on top of them
  lift: () => (state.data === 'traffic' ? (traffic?.lift() ?? null) : null),
  // a route of your own shows over any layer; steepness then colours only the route
  showRoute: () => syncSteep(),
  open: (center, size, label, detail) => {
    markOwnPlace();
    routeSquare = true;
    state.size = clampSize(size);
    state.pin = null;
    syncControls();
    notice.hide();
    void loadPlace(center, { label, detail });
  },
  changed: () => {
    syncSteep();
    writeHash();
    describe();
    const url = $<HTMLInputElement>('share-url');
    if ($<HTMLDialogElement>('share-dialog').open) url.value = location.href;
    if (model) applyPin(model);
    viewer.requestRender();
  },
  say: (message, ms) => toast(message, ms),
});
route.setShown(true);
const traffic: TrafficController = new TrafficController({
  viewer,
  model: () => model,
  open: (center, size, label) => {
    $<HTMLInputElement>('search-input').value = label;
    void openPlace({ label, detail: t.dataLayers.traffic, center }, { size });
  },
  moved: () => route?.liftChanged(),
  changed: () => {
    state.traffic = traffic?.kind ?? 'cars';
    state.spread = traffic?.spreadM ?? state.spread;
    writeHash();
    describe();
  },
});

const transit: TransitController = new TransitController({
  viewer,
  model: () => model,
  open: (center, size, label) => {
    $<HTMLInputElement>('search-input').value = label;
    if (state.data !== 'transit') setDataLayer('transit');
    void openPlace({ label, detail: t.dataLayers.transit, center }, { size });
  },
  select: () => setDataLayer('transit'),
  changed: () => {
    describe();
    if (model) applyPin(model);
  },
  demoUrl: './timetables/freiburg-2026.zip',
  say: (message, ms) => toast(message, ms),
});

/** Homes and Income: buildings coloured by values per area, from open data the user loads. */
const makeAreas = (layer: AreaLayer): AreaController =>
  new AreaController(layer, {
    viewer,
    model: () => model,
    open: (center, size, label) => {
      $<HTMLInputElement>('search-input').value = label;
      if (state.data !== layer) setDataLayer(layer);
      void openPlace({ label, detail: t.dataLayers[layer], center }, { size });
    },
    select: () => setDataLayer(layer),
    changed: () => {
      describe();
      if (model) applyPin(model);
    },
    root: './',
    accent,
    pin: () => {
      const p = model?.pinInfo();
      return p ? [p.e, p.n] : null;
    },
    say: (message, ms) => toast(message, ms),
  });
const homes = makeAreas('homes');
const income = makeAreas('income');

renderDataPresets();
renderLegend();
syncControls();
bindControls();
setupSearch({
  form: $<HTMLFormElement>('search-form'),
  input: $<HTMLInputElement>('search-input'),
  list: $<HTMLUListElement>('suggestions'),
  locate: $<HTMLButtonElement>('locate-btn'),
  bias: () => state.center,
  onPick: (p) => openPlace(p),
  onLocate: locate,
  onError: (m) => status.say(m),
  onNote: (m) => toast(m, 6000),
});

const wide = window.matchMedia('(min-width: 880px)');
const coarse = window.matchMedia('(pointer: coarse)');
bindDoubleClick();
bindMouseHint();
$('gesture-hint').textContent = gestureHint();
coarse.addEventListener('change', () => ($('gesture-hint').textContent = gestureHint()));
if (wide.matches) setSheetOpen(true);
const updateInsets = () => {
  const sheet = $('sheet');
  const visible = wide.matches && app.dataset.mode === 'model';
  viewer.setInsetLeft(visible ? sheet.getBoundingClientRect().right + 8 : 0);
};
new ResizeObserver(updateInsets).observe($('sheet'));
wide.addEventListener('change', updateInsets);

// a shared route shows over the layer the link names (or steepness)
if (state.route && !route.openLink(state.route)) state.route = null;
routeSquare = !!state.route;
traffic.setKind(state.traffic);
traffic.setSpread(state.spread);
setDataLayer(state.data ?? 'steep');
if (state.center) {
  void loadPlace(state.center, { camera: state.camera });
} else {
  setMode('landing');
}

window.addEventListener('hashchange', () => {
  const next = decodeState(location.hash, state);
  if (!next.center) return;
  // a pasted link with a route: show that one (the link without one keeps what's loaded)
  const newRoute = !!next.route && next.route !== state.route && route.openLink(next.route);
  if (newRoute) routeSquare = true;
  traffic.setKind(next.traffic);
  traffic.setSpread(next.spread);
  setDataLayer(next.data ?? state.data ?? 'steep');
  if (!samePlace(next.center, state.center) || next.size !== state.size) {
    state = next;
    syncControls();
    void loadPlace(next.center, { camera: next.camera });
  } else {
    if (newRoute && model && state.center) route?.attach(model, state.center);
    if (!samePlace(next.pin, state.pin)) state.pin = next.pin;
    if (model) applyPin(model);
    describe();
    viewer.requestRender();
  }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

// ------------------------------------------------------------------ loading pipeline

function overlayPixels(size: number): number {
  const gl = viewer.renderer.getContext();
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const want = viewer.small || size <= 1000 ? 2048 : 4096;
  return Math.min(want, max);
}

function gridResolution(size: number): number {
  return size > 2500 && !viewer.small ? 385 : 257;
}

/** Overpass is only the fallback; don't let a struggling mirror hold the model for minutes. */
const OVERPASS_TIMEOUT_MS = 30_000;
/** Villages within this radius are offered when a square has (almost) no buildings. */
const RESCUE_RADIUS_M = 8000;
const FEW_BUILDINGS = 10;
/** The longest a search may spend finding a postcode's village before the model loads anyway. */
const RESOLVE_BUDGET_MS = 8000;
let pickToken = 0;

/** Zoom of the tiles used to look up villages and towns: one ~12 km tile carries all of them. */
const SETTLEMENT_ZOOM = 11;

/** Villages and towns around a point: from map tiles, else (quick) Overpass. */
async function settlementsNear(center: LngLat, radiusM: number): Promise<Settlement[]> {
  try {
    return await settlementsFromTiles(center, radiusM, SETTLEMENT_ZOOM);
  } catch (err) {
    console.warn('Place lookup from map tiles failed, trying Overpass', err);
    return parseSettlements(await overpass(settlementsQuery(center, radiusM), undefined, 10_000), center);
  }
}

const SIZE_ORDER: SettlementKind[] = ['city', 'town', 'village', 'suburb', 'hamlet'];

/** Resolve with `fallback` if `p` fails or takes longer than `ms`. */
function withinBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Postcode and area results point at the middle of their area — for rural
 * postcodes that is fields between villages. Build the model around the
 * settlement instead: the one the geocoder names, else the nearest one.
 */
async function resolvePick(p: Place): Promise<Place> {
  if (p.kind !== 'postcode' && p.kind !== 'area') return p;
  const list = await settlementsNear(p.center, 15000).catch(() => null);
  if (!list) return (await resolveToSettlement(p).catch(() => null)) ?? p;
  const wanted = p.settlement?.toLowerCase();
  let chosen = wanted ? list.filter((s) => s.name.toLowerCase() === wanted).sort((a, b) => a.distanceM - b.distanceM)[0] : undefined;
  if (!chosen && p.kind === 'postcode') chosen = pickSettlement(list.filter((s) => s.distanceM < 6000)) ?? undefined;
  if (!chosen && p.kind === 'area') {
    // a county or region: its biggest place nearby
    const biggest = SIZE_ORDER.find((k) => list.some((s) => s.kind === k));
    chosen = list.filter((s) => s.kind === biggest).sort((a, b) => a.distanceM - b.distanceM)[0];
  }
  if (!chosen) return p;
  const context = p.kind === 'postcode' ? t.postcodeOf(p.label) : p.label;
  return { label: chosen.name, detail: `${context} · ${t.kind[chosen.kind]}`, center: chosen.center, kind: chosen.kind };
}

async function openPlace(p: Place, opts: { size?: AreaSize; ex?: number } = {}): Promise<void> {
  markOwnPlace();
  routeSquare = false;
  if (opts.size) state.size = opts.size;
  if (opts.ex) state.exaggeration = opts.ex;
  state.pin = null;
  syncControls();
  notice.hide();
  const token = ++pickToken;
  // Never leave the user waiting silently: a visible spinner, and a hard time limit after
  // which the model loads at the original point (the empty-square offer still helps there).
  if (p.kind === 'postcode' || p.kind === 'area') status.busy(t.findingVillage(p.label));
  const target = await withinBudget(resolvePick(p), RESOLVE_BUDGET_MS, p);
  if (token !== pickToken) return;
  await loadPlace(target.center, { label: target.label, detail: target.detail });
}

/** When a square comes back (nearly) empty, offer the nearest village or town instead of a bare plain. */
async function offerNearby(center: LngLat, size: AreaSize, count: number, stale: () => boolean): Promise<void> {
  let list: Settlement[];
  try {
    list = await settlementsNear(center, RESCUE_RADIUS_M);
  } catch {
    return;
  }
  if (stale()) return;
  const here = count === 0 ? t.noBuildingsHere : t.fewBuildingsHere(num(count), count);
  // places inside the square are what is empty: suggest the best one outside it
  const best = pickSettlement(list, size * 0.6);
  if (!best) {
    const inside = pickSettlement(list);
    notice.show(
      inside ? t.fewAround(here, inside.name) : t.noVillageWithin(here, num(RESCUE_RADIUS_M / 1000)),
      size < 4000 ? [{ label: t.show4km, onClick: () => setSize(4000) }] : [],
    );
    return;
  }
  notice.show(t.nearest(here, best.name, t.kindInSentence[best.kind], distance(best.distanceM), direction(best.bearingDeg)), [
    { label: t.goTo(best.name), primary: true, onClick: () => void openPlace({ label: best.name, detail: t.kind[best.kind], center: best.center, kind: best.kind }) },
  ]);
}

function setSize(want: AreaSize): void {
  const size = clampSize(want);
  if (size === state.size) return;
  state.size = size;
  syncControls();
  if (state.center) void loadPlace(state.center, { label: placeLabel || undefined, detail: placeMetaDetail });
}

async function loadPlace(center: LngLat, opts: { label?: string; detail?: string; camera?: ViewState['camera'] } = {}): Promise<void> {
  const token = ++loadToken;
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const stale = () => token !== loadToken;
  const size = state.size;

  state.center = center;
  state.camera = opts.camera ?? null;
  setMode('model');
  placeLabel = opts.label ?? '';
  placeNear = '';
  setPlaceTitle(opts.label || formatLatLon(center), opts.detail ?? '');
  if (!opts.label) {
    reverse(center, signal).then((p) => {
      if (!stale() && p) {
        placeLabel = p.label;
        setPlaceTitle(p.label, p.detail);
        describe();
      }
    });
  }
  notice.hide();
  status.reset();
  debug.stage = 'loading';
  const t0 = performance.now();
  debug.timings = {};

  const bbox = squareBBox(center, size);
  const terrainP = loadHeightGrid(center, size, gridResolution(size), signal);
  // Map data: vector tiles from a CDN (fast, cached). Overpass only if the tiles fail.
  const tilesP = fetchTiles(tilesForSquare(center, size, DATA_ZOOM), signal).then((t) => parseTiles(t, center, size));
  const fallback = (err: unknown) => {
    if (signal.aborted) throw err;
    if (debug.source !== 'overpass') console.warn('Map tiles failed, falling back to Overpass', err);
    debug.source = 'overpass';
  };
  const buildingsP: Promise<(m: CityModel) => void> = tilesP.then(
    (d) => {
      debug.source = 'tiles';
      return (m: CityModel) => m.setBuildingSpecs(d.buildings.map((b) => ({ ...b, estimated: false })));
    },
    (err) => {
      fallback(err);
      return overpass(buildingsQuery(bbox), signal, OVERPASS_TIMEOUT_MS).then((res) => (m: CityModel) => m.setBuildings(parseBuildings(res, center, size)));
    },
  );
  const featuresP: Promise<FeatureSet> = tilesP.then(
    (d) => d.features,
    (err) => {
      fallback(err);
      return overpass(featuresQuery(bbox), signal, OVERPASS_TIMEOUT_MS).then((res) => parseFeatures(res, center));
    },
  );
  const nearbyP: Promise<Settlement[]> = tilesP.then((d) => d.settlements, () => []);
  // avoid unhandled-rejection noise; errors are handled below
  buildingsP.catch(() => undefined);
  featuresP.catch(() => undefined);

  let grid;
  try {
    grid = await terrainP;
  } catch (err) {
    if (stale()) return;
    console.error(err);
    status.set('terrain', 'error', () => loadPlace(center, opts));
    debug.stage = 'error';
    return;
  }
  if (stale()) return;

  const next = new CityModel(grid, overlayPixels(size), accent);
  next.setExaggeration(state.exaggeration);
  next.setContours(state.contours);
  next.setStyle(state.style);
  next.setLayers(state.layers);
  route?.attach(next, center);
  applyPin(next);
  const old = model;
  model = next;
  viewer.setModel(next);
  old?.dispose();
  viewer.setCameraState(state.camera ?? viewer.defaultCamera());
  // after the camera: the traffic layer writes the link when its counts start loading
  traffic?.attach(next, center);
  transit?.attach(next, center);
  homes?.attach(next, center);
  income?.attach(next, center);
  updateContourNote();
  status.set('terrain', 'done');
  debug.stage = 'terrain';
  debug.timings.terrain = performance.now() - t0;
  describe();
  writeHash();

  const buildingsTask = buildingsP.then(
    (apply) => {
      if (stale()) return;
      apply(next);
      // the buildings can take roofs out of the terrain: measure steepness again
      dataLayersChanged();
      viewer.requestRender();
      status.set('buildings', 'done');
      debug.timings.buildings = performance.now() - t0;
      describe();
      const count = next.stats().buildings;
      if (count < FEW_BUILDINGS) void offerNearby(center, size, count, stale);
    },
    (err) => {
      if (stale()) return;
      console.error(err);
      status.set('buildings', 'error', () => loadPlace(center, { ...opts, label: placeLabel || opts.label, camera: viewer.getCameraState() }));
    },
  );
  void nearbyP.then((list) => {
    // a shared link to open country: name it after the nearest village rather than the county
    if (stale() || placeLabel) return;
    const near = pickSettlement(list.filter((s) => s.distanceM < 4000));
    if (!near) return;
    placeLabel = t.near(near.name);
    placeNear = near.name;
    setPlaceTitle(placeLabel, placeMetaDetail);
    describe();
  });
  const featuresTask = featuresP.then(
    (features) => {
      if (stale()) return;
      next.setFeatures(features);
      // roads for steepness, bridges for the route
      dataLayersChanged();
      updateContourNote();
      describe();
      viewer.retarget();
      status.set('layers', 'done');
      debug.timings.layers = performance.now() - t0;
    },
    (err) => {
      if (stale()) return;
      console.error(err);
      status.set('layers', 'error', () => loadPlace(center, { ...opts, label: placeLabel || opts.label, camera: viewer.getCameraState() }));
    },
  );
  await Promise.all([buildingsTask, featuresTask]);
  if (stale()) return;
  debug.timings.total = performance.now() - t0;
  debug.stage = status.get('buildings') === 'error' || status.get('layers') === 'error' ? 'error' : 'ready';
  if (debug.stage === 'ready') {
    showGestureTip();
    offerOwnPlace();
  }
}

/** The model's roads or terrain changed: steepness and the route measure again. */
function dataLayersChanged(): void {
  steep?.refresh();
  if (route?.visible) route.refresh();
  traffic?.placeAgain();
  transit?.placeAgain();
}

/** Show one data layer, with its panel. A route of your own stays on over any of them. */
function setDataLayer(layer: DataLayerId): void {
  const switched = layer !== state.data;
  state.data = layer;
  for (const b of $('data-layer-group').querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const on = b.dataset.value === layer;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('steep-legend').hidden = layer !== 'steep';
  $('traffic-control').hidden = layer !== 'traffic';
  traffic.set(layer === 'traffic');
  $('transit-control').hidden = layer !== 'transit';
  transit.set(layer === 'transit');
  homes?.set(layer === 'homes');
  income?.set(layer === 'income');
  syncSteep();
  // the route wears the steepness colours only on the steepness layer
  if (switched && route.visible) route.refresh();
  if (model) applyPin(model);
  describe();
  writeHash();
  viewer.requestRender();
}

/** Steepness colours the roads, or only the route when one is loaded. */
function syncSteep(): void {
  steep?.set(state.data === 'steep' && !route?.active);
}

// ------------------------------------------------------------------ shared links: "see your own city"

function readFlag(key: string): boolean {
  try {
    return !!localStorage.getItem(key);
  } catch {
    return false;
  }
}

function markOwnPlace(): void {
  inviteOwn = false;
  try {
    localStorage.setItem(OWN_KEY, '1');
  } catch {
    /* private browsing: the invitation may show again next time */
  }
}

/** Someone who opened a shared view sees it first, then an invitation to look at their own city. */
function offerOwnPlace(): void {
  if (!inviteOwn) return;
  inviteOwn = false;
  const token = loadToken;
  window.setTimeout(() => {
    if (token !== loadToken || notice.visible) return;
    notice.show(t.dataSharedInvite, [
      {
        label: t.dataSearchPlace,
        primary: true,
        onClick: () => {
          notice.hide();
          markOwnPlace();
          const input = $<HTMLInputElement>('search-input');
          input.value = '';
          input.focus();
        },
      },
    ]);
  }, 2500);
}

// ------------------------------------------------------------------ the pin: "this one is ours"

/** Put the pin where the state says (e.g. from a shared link), or back on the searched point. */
function applyPin(m: CityModel): void {
  placePin(m);
  // the Homes and Income panels say what the pin stands in
  homes?.pinMoved();
  income?.pinMoved();
}

function placePin(m: CityModel): void {
  if (state.pin && state.center) {
    const [e, n] = makeProjector(state.center).toLocal(state.pin.lon, state.pin.lat);
    const h = state.size / 2;
    if (Math.abs(e) <= h && Math.abs(n) <= h) {
      m.showPin(true);
      return m.setPin(e, n, true);
    }
    state.pin = null; // outside a smaller square
  }
  m.setPin(0, 0, false);
  // a route's square has no searched point at its centre
  m.showPin(!(routeSquare && route?.active));
}

/** A click or tap on the model moves the pin there; share links carry it. */
function movePinTo(x: number, y: number): void {
  if (!model || !state.center) return;
  // a tap on a traffic column picks it
  if (traffic?.tap(x, y)) return;
  // a tap on a vehicle picks its line
  if (transit?.tap(x, y)) return;
  const hit = viewer.pick(x, y);
  if (!hit) return;
  model.setPin(hit.e, hit.n, true);
  model.showPin(true);
  state.pin = makeProjector(state.center).toLngLat(hit.e, hit.n);
  homes?.pinMoved();
  income?.pinMoved();
  viewer.requestRender();
  writeHash();
  notice.show(hit.building ? t.pinOnBuilding : t.pinOnSpot, [
    { label: t.centreHere, primary: true, onClick: centreOnPin },
    { label: t.resetPin, onClick: resetPin },
  ]);
}

/** Build a new square around the pin, e.g. when the house is near the edge. */
function centreOnPin(): void {
  if (!state.pin) return;
  const cam = viewer.getCameraState();
  void loadPlace(state.pin, { camera: { ...cam, targetE: 0, targetN: 0 } });
}

function resetPin(): void {
  state.pin = null;
  if (model) applyPin(model);
  viewer.requestRender();
  writeHash();
}

/** Once per browser: say how to pin a house and slide the model. */
function showGestureTip(): void {
  // the mouse hint says the same, and stays
  if (!$('mouse-hint').hidden && wide.matches) return;
  try {
    if (localStorage.getItem('yp:tip-pin')) return;
    localStorage.setItem('yp:tip-pin', '1');
  } catch {
    return;
  }
  toast(gestureHint(), 6000);
}

function gestureHint(): string {
  return coarse.matches
    ? t.gestureTouch
    : t.gestureMouse;
}

/** Double-click (or double-tap) a spot: pin it and build a new square around it. */
function bindDoubleClick(): void {
  viewer.onDoubleTap((x, y) => {
    if (!model || !state.center || debug.stage === 'loading') return;
    if (!viewer.pick(x, y)) return;
    movePinTo(x, y);
    notice.hide();
    toast(t.loadingHere);
    centreOnPin();
  });
}

/** On computers with a mouse, a small hint until it's dismissed: the controls aren't obvious. */
function bindMouseHint(): void {
  const hint = $('mouse-hint');
  let dismissed = false;
  try {
    dismissed = !!localStorage.getItem('yp:hint-mouse');
  } catch {
    /* no storage: show it */
  }
  const update = () => (hint.hidden = dismissed || coarse.matches);
  $('mouse-hint-close').addEventListener('click', () => {
    dismissed = true;
    update();
    try {
      localStorage.setItem('yp:hint-mouse', '1');
    } catch {
      /* no storage: hidden for this visit */
    }
  });
  coarse.addEventListener('change', update);
  update();
}

function locate(): void {
  if (!('geolocation' in navigator)) return status.say(t.noGeolocation);
  status.say(t.findingLocation);
  navigator.geolocation.getCurrentPosition(
    (pos) => void openPlace({ label: t.yourLocation, detail: '', center: { lat: pos.coords.latitude, lon: pos.coords.longitude } }),
    (err) => status.say(err.code === err.PERMISSION_DENIED ? t.locationDenied : t.locationFailed),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

// ------------------------------------------------------------------ UI: controls

function setMode(mode: 'landing' | 'model'): void {
  app.dataset.mode = mode;
  if (mode === 'landing') document.title = HOME_TITLE;
  updateInsets();
}

function setPlaceTitle(title: string, detail: string): void {
  $('place-title').textContent = title;
  // tabs, history and bookmarks name the place
  document.title = t.dataDocTitle(title);
  placeMetaDetail = detail;
  updateMeta();
}

let placeMetaDetail = '';
function updateMeta(): void {
  const parts = [placeMetaDetail, area(state.size), t.terrainTimes(num(state.exaggeration, 1))].filter(Boolean);
  $('place-meta').textContent = parts.join(' · ');
}

function setSheetOpen(open: boolean): void {
  $('sheet').dataset.open = String(open);
  $('sheet-toggle').setAttribute('aria-expanded', String(open));
}

function bindControls(): void {
  $('sheet-toggle').addEventListener('click', () => setSheetOpen($('sheet').dataset.open !== 'true'));

  const ex = $<HTMLInputElement>('ex-range');
  let exFrame = 0;
  ex.addEventListener('input', () => {
    state.exaggeration = Number(ex.value);
    $('ex-out').textContent = `×${num(state.exaggeration, 1)}`;
    updateMeta();
    cancelAnimationFrame(exFrame);
    exFrame = requestAnimationFrame(() => {
      model?.setExaggeration(state.exaggeration);
      viewer.retarget();
      viewer.requestRender();
      scheduleHashWrite();
    });
  });

  const sw = $('contour-switch');
  sw.addEventListener('click', () => {
    state.contours = !state.contours;
    sw.setAttribute('aria-checked', String(state.contours));
    model?.setContours(state.contours);
    viewer.requestRender();
    scheduleHashWrite();
  });

  radioGroup('style-group', (v) => {
    state.style = v as BuildingStyle;
    $('legend').hidden = state.style !== 'ramp';
    model?.setStyle(state.style);
    viewer.requestRender();
    scheduleHashWrite();
  });

  // the area: the readout follows the slider, the model loads when it's let go (a pause for keys)
  const sizeRange = $<HTMLInputElement>('size-range');
  let sizeTimer = 0;
  sizeRange.addEventListener('input', () => ($('size-out').textContent = area(clampSize(Number(sizeRange.value)))));
  sizeRange.addEventListener('change', () => {
    window.clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(() => setSize(Number(sizeRange.value)), 350);
  });

  for (const chip of $('layers-group').querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    chip.addEventListener('click', () => {
      const key = chip.dataset.layer as keyof Layers;
      state.layers = { ...state.layers, [key]: !state.layers[key] };
      chip.setAttribute('aria-pressed', String(state.layers[key]));
      model?.setLayers(state.layers);
      viewer.requestRender();
      scheduleHashWrite();
    });
  }

  radioGroup('data-layer-group', (v) => setDataLayer(v as DataLayerId));
  radioGroup('traffic-kind-group', (v) => traffic.setKind(v as TrafficKind));

  $('compass-btn').addEventListener('click', () => viewer.resetNorth());
  $('reset-btn').addEventListener('click', () => viewer.resetView());
  bindShare();
}

function radioGroup(id: string, onChange: (value: string) => void): void {
  const group = $(id);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const select = (b: HTMLButtonElement, focus = false) => {
    for (const x of buttons) {
      x.setAttribute('aria-checked', String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    }
    if (focus) b.focus();
    onChange(b.dataset.value!);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(b));
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      select(buttons[(i + dir + buttons.length) % buttons.length], true);
    });
  });
}

function syncControls(): void {
  const ex = $<HTMLInputElement>('ex-range');
  ex.value = String(state.exaggeration);
  $('ex-out').textContent = `×${num(state.exaggeration, 1)}`;
  $('contour-switch').setAttribute('aria-checked', String(state.contours));
  $<HTMLInputElement>('size-range').value = String(state.size);
  $('size-out').textContent = area(state.size);
  for (const [id, value] of [['style-group', state.style]] as const) {
    for (const b of $(id).querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  $('legend').hidden = state.style !== 'ramp';
  for (const chip of $('layers-group').querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    chip.setAttribute('aria-pressed', String(state.layers[chip.dataset.layer as keyof Layers]));
  }
  updateMeta();
}

function updateContourNote(): void {
  if (model) $('contour-note').textContent = t.contourEvery(num(model.stats().contourInterval));
}

function updateCompass(): void {
  const az = viewer.getCameraState().azimuth;
  $('compass-needle').style.transform = `rotate(${az}deg)`;
}

/** The layer cards: places that open with that layer on. */
function renderDataPresets(): void {
  const add = (hostId: string, layer: DataLayerId, name: string, center: LngLat, size: number, ex?: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.addEventListener('click', () => {
      $<HTMLInputElement>('search-input').value = name;
      setDataLayer(layer);
      void openPlace({ label: name, detail: t.dataLayers[layer], center }, { size, ex });
    });
    $(hostId).append(b);
  };
  for (const p of STEEP_PRESETS) add('steep-presets', 'steep', p.name, p.center, p.size, p.ex);
  for (const p of TRAFFIC_PRESETS) add('traffic-presets', 'traffic', p.name(), p.center, p.size);
  // the timetable's demo: Freiburg's, which we host
  const demo = document.createElement('button');
  demo.type = 'button';
  demo.className = 'chip';
  demo.textContent = t.transitFreiburg;
  demo.addEventListener('click', () => {
    setDataLayer('transit');
    void transit?.loadDemo();
  });
  $('transit-presets').append(demo);
  // the examples for Homes and Income, which we host
  for (const [layer, ctl] of [['homes', homes], ['income', income]] as const) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = t.areaDemoPlace[layer];
    chip.addEventListener('click', () => {
      setDataLayer(layer);
      void ctl?.loadDemo();
    });
    $(`${layer}-presets`).append(chip);
  }
}

function renderLegend(): void {
  const max = HEIGHT_RAMP[HEIGHT_RAMP.length - 1][0];
  const pos = (h: number) => (Math.sqrt(h) / Math.sqrt(max)) * 100;
  const ramp = (dir: string) => `linear-gradient(${dir}, ${HEIGHT_RAMP.map(([h, c]) => `${c} ${pos(h).toFixed(1)}%`).join(', ')})`;
  $('legend-bar').style.background = ramp('to right');
  // the building colour swatches, from the same colours the buildings get
  for (const b of $('style-group').querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const v = b.dataset.value as keyof typeof BUILDING_COLOURS | 'ramp';
    b.querySelector<HTMLElement>('.style-swatch')!.style.background = v === 'ramp' ? ramp('135deg') : BUILDING_COLOURS[v];
  }
  const labels = $('legend-labels');
  for (const [h] of HEIGHT_RAMP) {
    const s = document.createElement('span');
    s.style.left = `${pos(h)}%`;
    s.textContent = h === max ? t.legendTop(num(h)) : num(h);
    labels.append(s);
  }
}

/** Plain-language summary of the area (spec: accessibility). */
function describe(): void {
  if (!model) return;
  const s = model.stats();
  const relief = Math.round(s.maxElev - s.minElev);
  const lines = [
    placeNear ? t.nearPlace(area(state.size), placeNear) : t.aroundPlace(area(state.size), placeLabel || t.thisPoint),
    t.ground(num(Math.round(s.minElev)), num(Math.round(s.maxElev)), num(relief)),
  ];
  if (model.hasBuildings) {
    lines.push(s.buildings ? t.buildingCount(num(s.buildings), num(Math.round(s.tallest))) : t.noBuildingsSquare);
  }
  const steepLine = steep?.describe();
  if (steepLine) lines.push(steepLine);
  const trafficLine = traffic?.describe();
  if (trafficLine) lines.push(trafficLine);
  const transitLine = transit?.describe();
  if (transitLine) lines.push(transitLine);
  for (const a of [homes, income]) {
    const line = a?.describe();
    if (line) lines.push(line);
  }
  const routeLine = route?.describe();
  if (routeLine) lines.push(routeLine);
  $('describe').textContent = lines.join(' ');
  const note = $('estimate-note');
  if (model.hasBuildings && s.estimatedShare >= 0.05) {
    note.hidden = false;
    note.textContent = t.estimated(num(Math.round(s.estimatedShare * 100)));
  } else {
    note.hidden = true;
  }
  $<HTMLCanvasElement>('scene').setAttribute(
    'aria-label',
    t.sceneDescription(lines.join(' ')),
  );
}

// ------------------------------------------------------------------ URL + share

let hashTimer = 0;
function scheduleHashWrite(): void {
  window.clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 350);
}

function writeHash(): void {
  if (!state.center || !model) return;
  state.camera = viewer.getCameraState();
  // the route goes into the link only when the user turned that on
  state.route = route?.linkCode() ?? null;
  const h = encodeState(state);
  if (`#${h}` !== location.hash) history.replaceState(null, '', `#${h}`);
}

let toastTimer = 0;
function toast(message: string, ms = 2200): void {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

/** Hand a generated file to the browser as a download. */
function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function bindShare(): void {
  const dialog = $<HTMLDialogElement>('share-dialog');
  const url = $<HTMLInputElement>('share-url');
  const msg = $('share-msg');
  const nativeBtn = $<HTMLButtonElement>('native-share-btn');
  nativeBtn.hidden = typeof navigator.share !== 'function';

  // the title on the image: the place's name until the user writes their own
  const titleInput = $<HTMLInputElement>('image-title');
  const subtitleInput = $<HTMLInputElement>('image-subtitle');
  let autoTitle = '';
  const title = () => titleInput.value.trim() || autoTitle;
  const subtitle = () => subtitleInput.value.trim();

  $('share-btn').addEventListener('click', () => {
    writeHash();
    url.value = location.href;
    msg.textContent = '';
    const place = placeLabel || (state.center ? formatLatLon(state.center) : '');
    if (!titleInput.value.trim() || titleInput.value === autoTitle) titleInput.value = place;
    autoTitle = place;
    titleInput.placeholder = place;
    dialog.showModal();
  });

  $('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      msg.textContent = t.linkCopied;
    } catch {
      url.select();
      msg.textContent = t.selectLink;
    }
  });

  nativeBtn.addEventListener('click', async () => {
    try {
      await navigator.share({ title: placeLabel ? t.dataDocTitle(placeLabel) : 'Your Place · Data', text: t.dataShareText(placeLabel || t.thisPlace), url: url.value });
    } catch {
      /* dismissed */
    }
  });

  const posterBtn = $<HTMLButtonElement>('poster-btn');
  posterBtn.addEventListener('click', async () => {
    if (!model || !state.center) return;
    posterBtn.disabled = true;
    msg.textContent = t.dataRenderingImage;
    try {
      // third-party data on the model is credited on the poster too
      const credit = traffic?.describe() ? TRAFFIC_ATTRIBUTION.text : (transit?.credit() ?? homes?.credit() ?? income?.credit() ?? undefined);
      const blob = await makePoster(viewer, { title: title(), subtitle: subtitle(), center: state.center, sizeM: state.size, exaggeration: state.exaggeration, credit });
      saveBlob(blob, posterFileName(title(), state.size));
      msg.textContent = '';
      dialog.close();
      toast(t.dataImageSaved);
    } catch (err) {
      console.error(err);
      msg.textContent = t.dataImageFailed;
    } finally {
      posterBtn.disabled = false;
    }
  });

}

