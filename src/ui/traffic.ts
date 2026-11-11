/**
 * The Traffic layer of Your Place · Data: how many cars or bikes the City of Hamburg's counting
 * points counted in each of the last 24 hours, as red streets that rise with the traffic on the
 * model and as a bar chart of the day in the panel. Each count spreads along the streets around
 * its point (the slider sets how far); pick an hour in the chart (or replay the day) and the
 * streets follow; tap a counting point to see its day. Only Hamburg has counts so far; elsewhere
 * the panel says so and offers Hamburg.
 */

import { compact, locale, num, t } from '../i18n';
import { squareBBox, type LngLat } from '../geo/projection';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import type { TrafficKind } from '../state';
import { fetchTrafficCounts, trafficCovers, TRAFFIC_TIME_ZONE, type CountingPoint } from '../data/sources/hamburgTraffic';
import { busiestHour, HOURS, lastDay, topColumns, type TrafficDay } from '../data/match/traffic';
import { SPREAD, spreadStreets, StreetNetwork } from '../data/match/trafficStreets';
import { TrafficDisplay } from '../data/display/traffic';
import type { FeatureSet } from '../geo/osm';
import type { ClipSource } from './clipSource';
import { barShares, chartTicks } from '../data/display/trafficChart';
import { Playback } from '../data/time/playback';

export interface TrafficHost {
  viewer: Viewer;
  model(): CityModel | null;
  /** open a place in Hamburg with this layer on */
  open(center: LngLat, size: number, label: string): void;
  /** the share link and the description should follow */
  changed(): void;
  /** the streets rose or fell, came or went (a route rides on them) */
  moved(): void;
}

/** Places with many counting points, for the start page and "Show Hamburg". */
export const TRAFFIC_PRESETS: ReadonlyArray<{ name: () => string; center: LngLat; size: number }> = [
  { name: () => t.trafficCentre, center: { lat: 53.5511, lon: 9.9937 }, size: 3000 },
  { name: () => 'Eimsbüttel', center: { lat: 53.575, lon: 9.953 }, size: 3000 },
  { name: () => 'Barmbek', center: { lat: 53.5873, lon: 10.0446 }, size: 3000 },
];

/** A replay of the day takes this long. */
const PLAY_MS = 12_000;
/** Counts fetched less than this long ago are used again (a new hour comes in every hour). */
const CACHE_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** A tap this close to a counting point (px) picks it. */
const TAP_PX = 18;

type Status = 'idle' | 'loading' | 'error' | 'outside' | 'none' | 'ready';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class TrafficController {
  on = false;
  kind: TrafficKind = 'cars';
  /** how far each count spreads along the streets (m) */
  spreadM: number = SPREAD.initial;
  private status: Status = 'idle';
  private last: { model: CityModel; center: LngLat } | null = null;
  private day: TrafficDay | null = null;
  private dayKey = '';
  private display: { model: CityModel; overlay: TrafficDisplay } | null = null;
  /** the street network of the model's roads, for the mode it was built for */
  private network: { features: FeatureSet; kind: TrafficKind; net: StreetNetwork } | null = null;
  private spreadFrame = 0;
  /** the hour picked (index into the day) */
  private hour = HOURS - 1;
  /** the column picked, or null for all of them */
  private column: number | null = null;
  private hover: number | null = null;
  private abort: AbortController | null = null;
  private readonly cache = new Map<string, { at: number; points: CountingPoint[] }>();
  private readonly playback: Playback;
  private readonly hourFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: TRAFFIC_TIME_ZONE });
  private readonly dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: TRAFFIC_TIME_ZONE });
  private readonly clockHour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TRAFFIC_TIME_ZONE });

  constructor(private readonly host: TrafficHost) {
    this.playback = new Playback(PLAY_MS, (pos, playing) => this.onPlayback(pos, playing));
    host.viewer.onFrame((dt) => {
      if (this.playback.advance(dt)) host.viewer.requestRender();
    });
    this.bind();
    this.syncPanel();
  }

  /** Show or hide the layer. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) {
      this.abort?.abort();
      this.abort = null;
      this.playback.reset();
      this.detach();
      this.syncPanel();
      this.host.viewer.requestRender();
      return;
    }
    this.refresh();
  }

  /** Cars or bikes. */
  setKind(kind: TrafficKind): void {
    for (const b of $('traffic-kind-group').querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
      const on = b.dataset.value === kind;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (kind === this.kind) return;
    this.kind = kind;
    this.column = null;
    this.playback.reset();
    if (this.on) this.refresh();
    this.host.changed();
  }

  /** A newly built model (a new place or size): the counts for its square. */
  attach(model: CityModel, center: LngLat): void {
    this.last = { model, center };
    this.playback.reset();
    this.column = null;
    if (this.on) this.refresh();
  }

  /** How far each count spreads along the streets (m). */
  setSpread(m: number): void {
    const spread = Math.max(SPREAD.min, Math.min(SPREAD.max, Math.round(m / SPREAD.step) * SPREAD.step || SPREAD.initial));
    const range = $<HTMLInputElement>('traffic-spread');
    range.value = String(spread);
    $('traffic-spread-out').textContent = `${num(spread)} m`;
    if (spread === this.spreadM) return;
    this.spreadM = spread;
    // while the slider moves, once a frame at most
    if (!this.spreadFrame) {
      this.spreadFrame = requestAnimationFrame(() => {
        this.spreadFrame = 0;
        const d = this.shownDisplay();
        if (d) this.show(d.model);
      });
    }
    this.host.changed();
  }

  /**
   * The model's roads arrived (the streets can be drawn), or its terrain changed (buildings took
   * roofs out of it): stand the streets on it again.
   */
  placeAgain(): void {
    const d = this.shownDisplay();
    if (d) {
      d.overlay.place(d.model);
      this.host.moved();
      this.host.viewer.requestRender();
      return;
    }
    const model = this.host.model();
    if (this.on && this.status === 'ready' && this.day && model?.featureSet && this.last?.model === model) this.show(model);
  }

  /** How high the traffic streets stand at a point now (m above the ground), or null when they're not shown. */
  lift(): ((e: number, n: number) => number) | null {
    const d = this.shownDisplay();
    return d ? (e, n) => d.overlay.liftAt(e, n) : null;
  }

  /** Whether the traffic streets are on the model now. */
  get shown(): boolean {
    return !!this.shownDisplay();
  }

  /** A tap on the model: true if it picked a counting point. */
  tap(clientX: number, clientY: number): boolean {
    const d = this.shownDisplay();
    if (!d) return false;
    // the point under the finger, or one close to it on screen (they're small on a phone)
    const i = d.overlay.hit(this.host.viewer.rayAt(clientX, clientY)) ?? this.nearOnScreen(d.overlay, clientX, clientY, TAP_PX);
    if (i == null) return false;
    this.pickColumn(i === this.column ? null : i);
    return true;
  }

  /** The counting point closest to a point on screen, within `px`. */
  private nearOnScreen(overlay: TrafficDisplay, x: number, y: number, px: number): number | null {
    const v = this.host.viewer;
    let best: number | null = null;
    let bestD = px;
    overlay.day.columns.forEach((_, i) => {
      const [fx, fy, fz] = overlay.topOf(i);
      const a = v.screenPoint(fx, -fz, fy);
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** A sentence for the model's description, or null when the layer is off or has nothing to show. */
  describe(): string | null {
    const day = this.day;
    if (!this.on || this.status !== 'ready' || !day) return null;
    const i = busiestHour(day.totals);
    return t.trafficSummary(t.trafficCount[this.kind](num(day.totals[i])), day.counted[i], this.when(i));
  }

  /** One moment of the day (hours from its first, fractions too), without labels, for rendering a video frame by frame. */
  /** A clip of the traffic: its whole day, hour by hour; null with none shown. */
  clip(): ClipSource | null {
    const day = this.day;
    if (!day || !this.shownDisplay()) return null;
    const was = this.hour;
    const first = day.hours[0];
    const dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: TRAFFIC_TIME_ZONE });
    return {
      span: t.clipSpanTraffic,
      at: (k) => {
        const h = k * (HOURS - 1);
        this.frameAt(h);
        const ms = first + Math.round(h * 4) * (HOUR_MS / 4);
        return { clock: this.hourFormat.format(ms), note: dayFormat.format(ms) };
      },
      done: () => {
        this.frameAt(was);
        this.updateLabels();
        this.renderChart();
      },
    };
  }

  frameAt(at: number): void {
    this.playback.pause();
    const d = this.shownDisplay();
    if (!d) return;
    const h = Math.max(0, Math.min(HOURS - 1, at));
    d.overlay.setTime(h);
    d.overlay.setLabels([]);
    this.host.moved();
    const hour = Math.round(h);
    if (hour !== this.hour) {
      this.hour = hour;
      this.renderChart();
    }
    this.host.viewer.requestRender();
  }

  /** For tests (window.__yourPlace.traffic()). */
  debugInfo(): unknown {
    const d = this.shownDisplay();
    const day = this.day;
    return {
      on: this.on,
      kind: this.kind,
      status: this.status,
      shown: !!d,
      columns: day?.columns.length ?? 0,
      points: day?.columns.reduce((n, c) => n + c.ids.length, 0) ?? 0,
      hour: this.hour,
      column: this.column,
      totals: day?.totals ?? [],
      labels: d?.overlay.labelCount ?? 0,
      playing: this.playback.playing,
      spread: this.spreadM,
      streets: d ? d.overlay.stats() : null,
      onStreet: d ? d.overlay.data.onStreet.filter(Boolean).length : 0,
      // where to tap a counting point, for the end-to-end test
      columnPoint: (i: number) => {
        if (!d) return null;
        const [x, y, z] = d.overlay.midOf(i);
        return this.host.viewer.screenPoint(x, -z, y);
      },
      busiest: day ? topColumns(day, this.hour, 1)[0] ?? null : null,
      // where a counting point sits (m E, N), for tests
      columnAt: (i: number) => (d ? [d.overlay.data.at[2 * (d.overlay.data.streetSamples + i)], d.overlay.data.at[2 * (d.overlay.data.streetSamples + i) + 1]] : null),
    };
  }

  // ------------------------------------------------------------------ loading

  private refresh(): void {
    const last = this.last;
    const model = this.host.model();
    if (!this.on || !last || last.model !== model) {
      this.detach();
      this.syncPanel();
      return;
    }
    const size = model.sizeM;
    const box = squareBBox(last.center, size);
    if (!trafficCovers(box)) {
      this.day = null;
      this.dayKey = '';
      this.detach();
      this.setStatus('outside');
      return;
    }
    const key = `${this.kind}|${last.center.lat.toFixed(5)}|${last.center.lon.toFixed(5)}|${size}`;
    if (this.day && this.dayKey === key) {
      if (this.display?.model !== model) this.show(model);
      return;
    }
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      this.apply(cached.points, key, last.center, model);
      return;
    }
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.detach();
    this.day = null;
    this.setStatus('loading');
    fetchTrafficCounts(this.kind, box, ac.signal).then(
      (points) => {
        if (this.abort !== ac) return;
        this.abort = null;
        this.cache.set(key, { at: Date.now(), points });
        if (this.on && this.last?.model === this.host.model()) this.apply(points, key, last.center, this.host.model()!);
      },
      (err) => {
        if (ac.signal.aborted || this.abort !== ac) return;
        this.abort = null;
        console.warn('Traffic counts could not be loaded', err);
        this.setStatus('error');
      },
    );
  }

  private apply(points: CountingPoint[], key: string, center: LngLat, model: CityModel): void {
    const day = lastDay(points, center, model.sizeM);
    this.dayKey = key;
    if (!day || !day.columns.length) {
      this.day = null;
      this.detach();
      this.setStatus('none');
      return;
    }
    this.day = day;
    this.column = null;
    // open on the busiest hour of the day
    this.hour = busiestHour(day.totals);
    this.status = 'ready';
    this.show(model);
  }

  private show(model: CityModel): void {
    const day = this.day;
    this.detach();
    if (!day) return;
    // the chart can show before the roads are in; the streets come with them (placeAgain)
    const features = model.featureSet;
    if (features) {
      const streets = spreadStreets(this.networkFor(features), day, this.spreadM);
      const overlay = new TrafficDisplay(day, streets, model.sizeM);
      model.addOverlay(overlay);
      overlay.pick(this.column);
      overlay.setTime(this.playback.playing ? this.playback.position * (HOURS - 1) : this.hour);
      this.display = { model, overlay };
      this.host.moved();
    }
    this.renderChart(true);
    this.updateLabels();
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  /** The street network for the roads and the mode, built once. */
  private networkFor(features: FeatureSet): StreetNetwork {
    const n = this.network;
    if (n && n.features === features && n.kind === this.kind) return n.net;
    const net = new StreetNetwork(features.lines, this.kind);
    this.network = { features, kind: this.kind, net };
    return net;
  }

  private detach(repaint = true): void {
    const d = this.display;
    if (!d) return;
    // on a model that has been replaced, the overlay went with that model
    if (d.model === this.host.model()) d.model.removeOverlay(d.overlay, repaint);
    this.display = null;
    this.host.moved();
  }

  private shownDisplay(): { model: CityModel; overlay: TrafficDisplay } | null {
    const d = this.display;
    return d && d.model === this.host.model() ? d : null;
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  // ------------------------------------------------------------------ picking

  private setHour(i: number): void {
    const hour = Math.max(0, Math.min(HOURS - 1, Math.round(i)));
    this.playback.pause();
    if (hour === this.hour) return;
    this.hour = hour;
    this.shownDisplay()?.overlay.setTime(hour);
    this.host.moved();
    this.updateLabels();
    this.renderChart();
    this.host.viewer.requestRender();
  }

  private pickColumn(i: number | null): void {
    this.column = i;
    this.shownDisplay()?.overlay.pick(i);
    this.updateLabels();
    this.renderChart(true);
    this.host.viewer.requestRender();
  }

  /** Counts on the busiest columns at the hour picked, and on the column picked; none while replaying. */
  private updateLabels(): void {
    const d = this.shownDisplay();
    const day = this.day;
    if (!d || !day) return;
    if (this.playback.playing) {
      d.overlay.setLabels([]);
      return;
    }
    const want = topColumns(day, this.hour, 3);
    if (this.column != null) want.unshift(this.column);
    // labels keep their size on screen: leave out one that would sit on another
    const minM = day.columns.length > 1 ? d.model.sizeM * 0.1 : 0;
    const kept: number[] = [];
    for (const i of want) {
      if (kept.includes(i)) continue;
      const at = day.columns[i].at;
      if (kept.every((k) => Math.hypot(day.columns[k].at[0] - at[0], day.columns[k].at[1] - at[1]) >= minM)) kept.push(i);
    }
    d.overlay.setLabels(
      kept.filter((i) => !Number.isNaN(day.columns[i].values[this.hour])).map((i) => ({ column: i, text: num(day.columns[i].values[this.hour]) })),
    );
  }

  private onPlayback(pos: number, playing: boolean): void {
    const btn = $('traffic-play');
    btn.textContent = playing ? t.routePause : t.routePlay;
    btn.setAttribute('aria-pressed', String(playing));
    const d = this.shownDisplay();
    if (!d) return;
    if (playing) {
      const at = pos * (HOURS - 1);
      d.overlay.setTime(at);
      this.host.moved();
      const hour = Math.round(at);
      if (hour !== this.hour) {
        this.hour = hour;
        this.renderChart();
      }
      d.overlay.setLabels([]);
    } else {
      d.overlay.setTime(this.hour);
      this.host.moved();
      this.updateLabels();
      this.renderChart();
    }
  }

  // ------------------------------------------------------------------ the panel

  /** "Sun 14:00–15:00" in Hamburg time */
  private when(i: number): string {
    const h = this.day?.hours[i];
    if (h == null) return '';
    return t.trafficHour(this.dayFormat.format(h), this.hourFormat.format(h), this.hourFormat.format(h + HOUR_MS));
  }

  /** the values the chart shows: the column picked, or all of them added up (NaN for an hour without counts) */
  private chartValues(): number[] {
    const day = this.day;
    if (!day) return [];
    if (this.column != null) return Array.from(day.columns[this.column].values);
    return day.totals.map((v, i) => (day.counted[i] ? v : NaN));
  }

  private countText(v: number): string {
    return Number.isNaN(v) ? '–' : t.trafficCount[this.kind](num(v));
  }

  /** The bar chart of the day; `rebuild` when the data or the column changed, not only the hour. */
  private renderChart(rebuild = false): void {
    const day = this.day;
    if (!day) return;
    const values = this.chartValues();
    const bars = $('traffic-bars');
    if (rebuild || bars.children.length !== HOURS) {
      const max = Math.max(0, ...values.filter((v) => !Number.isNaN(v)));
      const { top, ticks } = chartTicks(max);
      const shares = barShares(values, top);
      bars.replaceChildren(
        ...shares.map((s) => {
          const bar = document.createElement('i');
          bar.className = 'tbar';
          bar.style.height = `${(s * 100).toFixed(2)}%`;
          return bar;
        }),
      );
      $('traffic-grid').replaceChildren(
        ...ticks.map((v) => {
          const line = document.createElement('span');
          line.className = 'tgrid';
          line.style.bottom = `${((v / top) * 100).toFixed(2)}%`;
          line.dataset.label = compact(v);
          return line;
        }),
      );
      // hour labels where Hamburg's clock shows 0, 6, 12 or 18 o'clock
      $('traffic-x').replaceChildren(
        ...day.hours.flatMap((h, i) => {
          if (Number(this.clockHour.format(h)) % 6 !== 0) return [];
          const label = document.createElement('span');
          label.style.left = `${(((i + 0.5) / HOURS) * 100).toFixed(2)}%`;
          label.textContent = this.hourFormat.format(h);
          return [label];
        }),
      );
      this.renderTable(values);
      $('traffic-title').textContent = t.trafficPerHour[this.kind];
      $('traffic-sub').textContent = this.column != null ? t.trafficOnePoint : t.trafficAllPoints(day.columns.length);
      $('traffic-all').hidden = this.column == null;
    }
    [...bars.children].forEach((bar, i) => {
      bar.classList.toggle('on', i === this.hour);
      bar.classList.toggle('hover', i === this.hover && i !== this.hour);
    });
    const shown = this.hover ?? this.hour;
    const readout = `${this.when(shown)}: ${this.countText(values[shown])}`;
    $('traffic-readout').textContent = readout;
    // the quick play button in the panel's bar shows the hour too
    const at = this.day?.hours[this.hour];
    $('traffic-play').dataset.clock = at == null ? '' : this.hourFormat.format(at);
    const chart = $('traffic-chart');
    chart.setAttribute('aria-valuenow', String(this.hour));
    chart.setAttribute('aria-valuetext', `${this.when(this.hour)}: ${this.countText(values[this.hour])}`);
    chart.setAttribute('aria-label', `${$('traffic-title').textContent}, ${$('traffic-sub').textContent}`);
  }

  private renderTable(values: number[]): void {
    const table = $('traffic-table');
    const head = document.createElement('tr');
    for (const text of [t.trafficTableHour, t.trafficPerHour[this.kind]]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      head.append(th);
    }
    const rows = values.map((v, i) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = this.when(i);
      const td = document.createElement('td');
      td.textContent = Number.isNaN(v) ? '–' : num(v);
      tr.append(th, td);
      return tr;
    });
    table.replaceChildren(head, ...rows);
  }

  private syncPanel(): void {
    const s = this.status;
    const ready = this.on && s === 'ready' && !!this.day;
    const text = !this.on ? '' : s === 'loading' ? t.trafficLoading : s === 'error' ? t.trafficFailed : s === 'outside' ? t.trafficOutside : s === 'none' ? t.trafficNone : '';
    $('traffic-status').textContent = text;
    $('traffic-status').hidden = !text;
    $('traffic-retry').hidden = !(this.on && s === 'error');
    $('traffic-hamburg').hidden = !(this.on && s === 'outside');
    $('traffic-figure').hidden = !ready;
    $('traffic-key').hidden = !ready;
  }

  private bind(): void {
    $('traffic-retry').addEventListener('click', () => {
      this.dayKey = '';
      this.refresh();
    });
    $('traffic-hamburg').addEventListener('click', () => {
      const p = TRAFFIC_PRESETS[0];
      this.host.open(p.center, p.size, p.name());
    });
    $('traffic-all').addEventListener('click', () => this.pickColumn(null));
    $('traffic-spread').addEventListener('input', (e) => this.setSpread(Number((e.target as HTMLInputElement).value)));
    $('traffic-play').addEventListener('click', () => {
      // replay from the hour picked (from the start once it's at the end)
      if (!this.playback.playing) this.playback.seek(this.hour >= HOURS - 1 ? 0 : this.hour / (HOURS - 1));
      this.playback.toggle();
    });

    const chart = $('traffic-chart');
    // the bars, not the chart: its left edge holds the value labels
    const indexAt = (clientX: number) => {
      const r = $('traffic-bars').getBoundingClientRect();
      return Math.max(0, Math.min(HOURS - 1, Math.floor(((clientX - r.left) / r.width) * HOURS)));
    };
    chart.addEventListener('pointermove', (e) => {
      const i = indexAt(e.clientX);
      if (e.buttons & 1) {
        this.hover = null;
        this.setHour(i);
      } else if (i !== this.hover) {
        this.hover = i;
        this.renderChart();
      }
    });
    chart.addEventListener('pointerleave', () => {
      this.hover = null;
      this.renderChart();
    });
    chart.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.hover = null;
      this.setHour(indexAt(e.clientX));
      // a hover on a touch screen is the tap itself
      this.renderChart();
    });
    chart.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (step) this.setHour(this.hour + step);
      else if (e.key === 'Home') this.setHour(0);
      else if (e.key === 'End') this.setHour(HOURS - 1);
      else return;
      e.preventDefault();
    });
  }
}
