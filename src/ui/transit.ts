/**
 * The Public transport layer of Your Place · Data: trams, buses, trains and ferries moving
 * through the square as a timetable (GTFS) has them. The user loads their city's timetable file
 * (or tries Freiburg's, which we host); it is read in the browser, in a worker, and never
 * uploaded. The panel is the Traffic layer's: a bar chart of the day (trips into the square per
 * hour), a clock, a replay, and the lines as chips; tap a vehicle or a chip to see one line.
 *
 * The file stays in memory while the page is open, so moving to another square reads it again
 * for that one; reloading the page forgets it.
 */

import { compact, locale, num, t } from '../i18n';
import type { LngLat } from '../geo/projection';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import { readTimetable, TimetableProblem, type Timetable } from '../data/sources/timetable';
import { downloadFeed, feedSize, feedsFor, licenceName, loadCatalog, CATALOG_SITE, type CatalogFeed } from '../data/sources/feedCatalog';
import { MAX_GTFS_BYTES } from '../data/sources/gtfs';
import type { TransitMode } from '../data/sources/gtfs';
import { DAY_S, dayRuns, dayWithin, runsPerHour, type TransitDay, type TransitLine } from '../data/match/transit';
import { MODE_COLOURS, modesOn, TransitDisplay } from '../data/display/transit';
import { barShares, chartTicks } from '../data/display/trafficChart';
import { Playback } from '../data/time/playback';

export interface TransitHost {
  viewer: Viewer;
  model(): CityModel | null;
  /** open a place with this layer on */
  open(center: LngLat, size: number, label: string): void;
  /** the share link and the description should follow */
  changed(): void;
  /** turn this layer on (a file was picked on the start page, or on another layer) */
  select(): void;
  /** where the hosted demo timetable is */
  demoUrl: string;
  say(message: string, ms?: number): void;
}

/** Freiburg's centre, for the demo: Bertoldsbrunnen, where all the tram lines meet. */
export const TRANSIT_DEMO = { center: { lat: 47.99555, lon: 7.85065 }, size: 2000 } as const;
/** A square opened for a timetable that was loaded before a place. */
const OPEN_SIZE = 2000;
/** Replay speeds: timetable seconds per second. */
const SPEEDS = [60, 600, 3600] as const;
/** A tap this close to a vehicle (px) picks its line. */
const TAP_PX = 22;
/** Replays this fast (timetable seconds a second) or faster leave trails behind the vehicles… */
const TRAIL_FROM_SPEED = 600;
/** …as long as this many seconds of the replay, up to… */
const TRAIL_REPLAY_S = 0.5;
/** …this long (s of timetable). */
const TRAIL_MAX_S = 20 * 60;
/** At most this many labels when paused. */
const MAX_LABELS = 10;

type Status = 'empty' | 'reading' | 'ready' | 'outside' | 'error';

/** A timetable shown: a file the user picked, one from the Mobility Database, or Freiburg's demo. */
interface Source {
  blob: Blob;
  demo: boolean;
  feed: CatalogFeed | null;
  /** the file's name, for a file the user picked */
  name: string;
}

/** Freiburg's timetable, as we host it */
const DEMO_FEED = { provider: 'Freiburger Verkehrs AG (VAG)', licence: 'https://www.govdata.de/dl-de/by-2-0' };



const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pad = (v: number) => String(v).padStart(2, '0');
const clock = (s: number) => `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}`;
const DAY_MS = 86_400_000;

/** Today's date where the timetable runs, as days since 1 Jan 1970, and the time there (s). */
function nowIn(timeZone: string): { day: number; time: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { day: Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS, time: get('hour') * 3600 + get('minute') * 60 };
}

/** Whether a vehicle is in the square at `time` on the day. */
function busyAt(d: TransitDay, time: number): boolean {
  for (let i = 0; i < d.run.length; i++) {
    const r = d.run[i];
    const t = time - d.shift[i];
    if (t >= d.runs.tIn[r] && t <= d.runs.tOut[r]) return true;
  }
  return false;
}

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export class TransitController {
  on = false;
  private status: Status = 'empty';
  private problem = '';
  private sources: Source[] = [];
  /** goes up whenever the timetables shown change */
  private version = 0;
  /** what the panel says while a timetable downloads, instead of the reading progress */
  private downloading = '';
  /** the Mobility Database's timetables for the square, once looked for */
  private found: { center: LngLat; feeds: CatalogFeed[]; sizes: Map<string, number | null> } | null = null;
  private finding: 'idle' | 'busy' | 'failed' = 'idle';
  /** a file was just loaded: if the square has none of its lines, go where it runs */
  private fresh = false;
  /** a place was asked for (where the timetable runs): wait for it rather than look again */
  private opening = false;
  private last: { model: CityModel; center: LngLat } | null = null;
  private timetable: Timetable | null = null;
  private key = '';
  private abort: AbortController | null = null;
  private progress = 0;
  private dayNo = NaN;
  private dayData: TransitDay | null = null;
  /** seconds after midnight of the day shown */
  private time = 8 * 3600;
  private picked: string | null = null;
  private hover: number | null = null;
  private speed: number = SPEEDS[0];
  private display: { model: CityModel; overlay: TransitDisplay } | null = null;
  private readonly playback: Playback;
  private readonly dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  private readonly longDay = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  constructor(private readonly host: TransitHost) {
    this.playback = new Playback(DAY_S * 1000 / this.speed, (pos, playing) => this.onPlayback(pos, playing));
    host.viewer.onFrame((dt) => {
      if (this.playback.advance(dt)) host.viewer.requestRender();
    });
    this.bind();
    this.renderSpeeds();
    this.syncPanel();
  }

  /** Show or hide the layer. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) {
      this.playback.pause();
      this.detach();
      this.syncPanel();
      this.host.viewer.requestRender();
      return;
    }
    this.refresh();
  }

  /** A newly built model (a new place or size): the timetable for its square. */
  attach(model: CityModel, center: LngLat): void {
    this.last = { model, center };
    this.opening = false;
    // the timetables found were for the square before
    if (this.found && (this.found.center.lat !== center.lat || this.found.center.lon !== center.lon)) this.found = null;
    else if (this.found) this.found.center = center;
    this.finding = 'idle';
    this.renderFeeds();
    this.playback.pause();
    if (this.on) this.refresh();
  }

  /** The model's terrain changed: stand the vehicles on it again. */
  placeAgain(): void {
    const d = this.shownDisplay();
    if (!d) return;
    d.overlay.place(d.model);
    this.host.viewer.requestRender();
  }

  /** Whether the lines are on the model now. */
  get shown(): boolean {
    return !!this.shownDisplay();
  }

  /** Open the file picker. */
  pickFile(): void {
    $<HTMLInputElement>('transit-file').click();
  }

  /** Who to credit on the poster, or null when no lines are shown. */
  credit(): string | null {
    if (!this.shown || !this.timetable) return null;
    const list = this.sources.map((src, k) => {
      const { name, licence } = this.creditOf(src, k);
      const short = licence ? licenceName(licence) : null;
      return short ? `${name} (${short})` : name;
    });
    return list.length ? `Timetable: ${list.join('; ')}` : null;
  }

  /** Who made a timetable shown, and the link to its licence ('' when not known). */
  private creditOf(src: Source, k: number): { name: string; licence: string } {
    if (src.demo) return { name: DEMO_FEED.provider, licence: DEMO_FEED.licence };
    if (src.feed) return { name: src.feed.provider, licence: src.feed.licence };
    const agencies = this.timetable?.parts[k]?.agencies ?? [];
    return { name: agencies.join(', ') || src.name, licence: '' };
  }

  /**
   * A timetable file the user picked, one from the Mobility Database or the demo: read it for the
   * square shown (with the others when `add`), or find where it runs.
   */
  loadFile(file: Blob, opts: { demo?: boolean; feed?: CatalogFeed | null; name?: string; add?: boolean; go?: boolean } = {}): void {
    const src: Source = { blob: file, demo: !!opts.demo, feed: opts.feed ?? null, name: opts.name ?? (file instanceof File ? file.name : '') };
    const add = !!opts.add && this.sources.length > 0;
    this.sources = add ? [...this.sources, src] : [src];
    this.version++;
    // a file of one's own, with nothing else shown, may be for somewhere else: go where it runs
    this.fresh = !add && !src.demo && !src.feed;
    this.timetable = null;
    this.key = '';
    this.picked = null;
    if (!add) this.dayNo = NaN;
    this.downloading = '';
    this.playback.pause();
    this.detach();
    this.renderFeeds();
    if (opts.go === false) return;
    // turning the layer on reads it; if it's on already, read it now
    if (!this.on) this.host.select();
    else this.refresh();
  }

  /** Freiburg's timetable, which we host: open its centre with it. */
  async loadDemo(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    this.status = 'reading';
    this.progress = 0;
    this.problem = '';
    this.syncPanel(t.transitDemoLoading);
    try {
      const res = await fetch(this.host.demoUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // in Freiburg already: read it for this square; elsewhere, go to its centre first
      const c = this.last?.center;
      const model = this.host.model();
      const there = !!c && !!model && this.last?.model === model && Math.abs(c.lat - TRANSIT_DEMO.center.lat) < 0.03 && Math.abs(c.lon - TRANSIT_DEMO.center.lon) < 0.05;
      this.loadFile(blob, { demo: true, go: there });
      if (!there) this.go(TRANSIT_DEMO.center, TRANSIT_DEMO.size, t.transitFreiburg);
    } catch (err) {
      console.warn('Demo timetable could not be loaded', err);
      this.fail('demo');
    }
  }

  /** Open a place (where the timetable runs); the model it gets is read when it comes. */
  private go(center: LngLat, size: number, label: string): void {
    this.opening = true;
    this.host.open(center, size, label);
  }

  /** Look up the Mobility Database's timetables for the square shown. */
  async find(): Promise<void> {
    const center = this.last?.center;
    if (!center || this.finding === 'busy') return;
    this.finding = 'busy';
    this.renderFeeds();
    let feeds: CatalogFeed[];
    try {
      feeds = feedsFor(await loadCatalog(), center);
    } catch (err) {
      console.warn('The timetable list could not be loaded', err);
      if (this.last?.center === center) this.finding = 'failed';
      this.renderFeeds();
      return;
    }
    if (this.last?.center !== center) return;
    const found = { center, feeds, sizes: new Map<string, number | null>() };
    this.found = found;
    this.finding = 'idle';
    this.renderFeeds();
    // how big each is, to say so and to leave out what's too big for a browser
    await Promise.all(
      feeds.map(async (f) => {
        found.sizes.set(f.url, await feedSize(f.url));
        if (this.found === found) this.renderFeeds();
      }),
    );
  }

  /** Download a timetable from the Mobility Database and show it, with any shown already. */
  async loadFeed(feed: CatalogFeed): Promise<void> {
    if (this.sources.some((s) => s.feed?.url === feed.url)) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.status = 'reading';
    this.progress = 0;
    this.problem = '';
    this.downloading = feed.provider;
    this.syncPanel();
    let shown = -1;
    try {
      const blob = await downloadFeed(
        feed.url,
        (share) => {
          if (this.abort !== ac) return;
          this.progress = Number.isNaN(share) ? 0 : share;
          if (Math.floor(this.progress * 100) !== shown) {
            shown = Math.floor(this.progress * 100);
            this.syncPanel();
          }
        },
        ac.signal,
      );
      if (this.abort !== ac) return;
      this.abort = null;
      this.loadFile(blob, { feed, add: true });
    } catch (err) {
      if (ac.signal.aborted || this.abort !== ac) return;
      this.abort = null;
      console.warn('The timetable could not be downloaded', err);
      this.downloading = '';
      if (this.sources.length) {
        // what was shown stays
        this.host.say(t.transitDownloadFailed, 5000);
        this.key = '';
        this.refresh();
      } else this.fail('download');
    }
  }

  /** Take one timetable away; the rest stay. */
  removeSource(k: number): void {
    if (this.sources.length <= 1) return this.remove();
    this.sources = this.sources.filter((_, i) => i !== k);
    this.version++;
    this.timetable = null;
    this.key = '';
    this.picked = null;
    this.detach();
    this.renderFeeds();
    this.refresh();
  }

  /** Take the timetables away. */
  remove(): void {
    this.abort?.abort();
    this.abort = null;
    this.sources = [];
    this.version++;
    this.downloading = '';
    this.timetable = null;
    this.dayData = null;
    this.key = '';
    this.picked = null;
    this.playback.pause();
    this.detach();
    this.status = 'empty';
    this.renderFeeds();
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  /** A tap on the model: true if it picked a vehicle's line. */
  tap(clientX: number, clientY: number): boolean {
    const d = this.shownDisplay();
    if (!d) return false;
    const v = this.host.viewer;
    let best: string | null = null;
    let bestD = TAP_PX;
    for (const x of d.overlay.vehicles) {
      const a = v.screenPoint(x.top[0], -x.top[2], x.top[1] - d.overlay.width * 0.4);
      const dist = Math.hypot(clientX - a.x, clientY - a.y);
      if (dist < bestD) {
        bestD = dist;
        best = this.lineOf(x.route)?.key ?? null;
      }
    }
    if (best == null) return false;
    this.pickLine(best === this.picked ? null : best);
    return true;
  }

  /** One moment, without labels and with trails `trailS` long, for rendering a video frame by frame. */
  frameAt(s: number, trailS = 0): void {
    this.playback.pause();
    this.time = Math.max(0, Math.min(DAY_S - 1, s));
    const d = this.shownDisplay();
    if (d) {
      d.overlay.setLabels([]);
      d.overlay.setTrail(trailS);
      d.overlay.setTime(this.time);
    }
    this.renderChart();
    this.host.viewer.requestRender();
  }

  /** A sentence for the model's description, or null. */
  describe(): string | null {
    const d = this.dayData;
    if (!this.on || this.status !== 'ready' || !d || !d.run.length) return null;
    const per = runsPerHour(d);
    const top = per.indexOf(Math.max(...per));
    return t.transitSummary(num(d.run.length), this.dayFormat.format(d.day * DAY_MS), num(per[top]), `${pad(top)}:00–${pad(top + 1)}:00`);
  }

  /** For tests (window.__yourPlace.transit()). */
  debugInfo(): unknown {
    const d = this.shownDisplay();
    const day = this.dayData;
    return {
      on: this.on,
      status: this.status,
      problem: this.problem,
      shown: !!d,
      demo: this.sources.some((s) => s.demo),
      sources: this.sources.map((s) => (s.demo ? 'demo' : s.feed ? s.feed.id : 'file')),
      finding: this.finding,
      found: this.found?.feeds.map((f) => f.id) ?? null,
      day: Number.isFinite(this.dayNo) ? isoDay(this.dayNo) : null,
      time: this.time,
      runs: this.timetable?.runs.tIn.length ?? 0,
      dayRuns: day?.run.length ?? 0,
      lines: day?.lines.map((l) => `${l.mode}:${l.name}`) ?? [],
      perHour: day ? runsPerHour(day, this.pickedRoutes()) : [],
      vehicles: d?.overlay.vehicles.length ?? 0,
      labels: d?.overlay.labelCount ?? 0,
      trails: d?.overlay.trailing ?? false,
      picked: this.picked,
      playing: this.playback.playing,
      speed: this.speed,
      // where a vehicle is on screen, for the end-to-end test
      vehicleAt: (i: number) => {
        const x = d?.overlay.vehicles[i];
        if (!d || !x) return null;
        return this.host.viewer.screenPoint(x.top[0], -x.top[2], x.top[1] - d.overlay.width * 0.4);
      },
    };
  }

  // ------------------------------------------------------------------ reading

  private refresh(): void {
    if (!this.on) return;
    if (!this.sources.length) {
      if (this.status !== 'error') this.status = 'empty';
      this.detach();
      this.syncPanel();
      return;
    }
    // a place is on its way: read the timetable for it when it comes
    if (this.opening) return;
    const model = this.host.model();
    const last = this.last;
    if (!model || !last || last.model !== model) {
      // no place yet (the file was picked on the start page): find where it runs, then go there
      if (!model && !this.opening) this.read(null);
      return;
    }
    const key = `${this.version}|${last.center.lat.toFixed(5)}|${last.center.lon.toFixed(5)}|${model.sizeM}`;
    if (this.timetable && this.key === key) {
      if (this.display?.model !== model) this.show(model);
      return;
    }
    this.read({ model, center: last.center, key });
  }

  private read(square: { model: CityModel; center: LngLat; key: string } | null): void {
    const files = this.sources.map((s) => s.blob);
    if (!files.length) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.detach();
    this.status = 'reading';
    this.progress = 0;
    this.problem = '';
    this.syncPanel();
    const center = square?.center ?? { lat: 0, lon: 0 };
    let shown = 0;
    readTimetable(
      { files, center, sizeM: square ? square.model.sizeM : 0 },
      (share) => {
        if (this.abort !== ac) return;
        this.progress = share;
        // the panel's text once a percent
        if (Math.floor(share * 100) !== shown) {
          shown = Math.floor(share * 100);
          this.syncPanel();
        }
      },
      ac.signal,
    ).then(
      (tt) => {
        if (this.abort !== ac) return;
        this.abort = null;
        if (!square) {
          // where it runs: open that square (attach reads it again for the square)
          this.fresh = false;
          if (!tt.busiest) return this.fail('empty');
          this.status = 'reading';
          this.go({ lat: tt.busiest.lat, lon: tt.busiest.lon }, OPEN_SIZE, tt.busiest.name);
          return;
        }
        if (this.host.model() !== square.model) return;
        this.timetable = tt;
        this.key = square.key;
        if (!tt.runs.tIn.length) {
          // a file just loaded with none of its lines here: go where it runs
          if (this.fresh && tt.busiest) {
            this.fresh = false;
            this.status = 'reading';
            this.syncPanel();
            this.go({ lat: tt.busiest.lat, lon: tt.busiest.lon }, OPEN_SIZE, tt.busiest.name);
            return;
          }
          this.status = 'outside';
          this.dayData = null;
          this.syncPanel();
          this.host.changed();
          return;
        }
        this.fresh = false;
        this.status = 'ready';
        this.setDay(Number.isFinite(this.dayNo) ? this.dayNo : NaN, true);
      },
      (err) => {
        if (ac.signal.aborted || this.abort !== ac) return;
        this.abort = null;
        const kind = err instanceof TimetableProblem ? err.kind : 'unreadable';
        const k = err instanceof TimetableProblem ? err.file : 0;
        if (this.sources.length > 1) {
          // one of several can't be read: it goes, the others are shown
          this.host.say(t.transitProblems[kind] ?? t.transitProblems.unreadable, 6000);
          this.removeSource(k);
        } else this.fail(kind);
      },
    );
  }

  private fail(kind: string): void {
    // a file that can't be read is let go: a new place won't try it again
    this.sources = [];
    this.version++;
    this.downloading = '';
    this.timetable = null;
    this.status = 'error';
    this.problem = kind;
    this.detach();
    this.syncPanel();
    this.host.changed();
  }

  /** Show a day (NaN: today where the timetable runs, or the nearest day it has). */
  private setDay(want: number, fresh = false): void {
    const tt = this.timetable;
    const model = this.host.model();
    if (!tt || !model) return;
    const now = nowIn(tt.timeZone);
    const day = dayWithin(Number.isFinite(want) ? want : now.day, tt.firstDay, tt.lastDay);
    if (day === this.dayNo && !fresh && this.dayData) return;
    const first = !Number.isFinite(this.dayNo);
    this.dayNo = day;
    this.dayData = dayRuns(tt.runs, day);
    // now, if it's today and something runs now; else the morning
    if (first) this.time = day === now.day && busyAt(this.dayData, now.time) ? now.time : 8 * 3600;
    // a line picked that doesn't run on this day: all of them
    if (this.picked && !this.dayData.lines.some((l) => l.key === this.picked)) this.picked = null;
    this.show(model);
  }

  private show(model: CityModel): void {
    const day = this.dayData;
    this.detach(false);
    if (!day) {
      model.repaint();
      return;
    }
    const overlay = new TransitDisplay(day, model.sizeM);
    overlay.pick(this.pickedRoutes());
    overlay.setTime(this.time);
    model.addOverlay(overlay);
    this.display = { model, overlay };
    this.renderLines();
    this.renderChart(true);
    this.updateLabels();
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  private detach(repaint = true): void {
    const d = this.display;
    if (!d) return;
    if (d.model === this.host.model()) d.model.removeOverlay(d.overlay, repaint);
    this.display = null;
  }

  private shownDisplay(): { model: CityModel; overlay: TransitDisplay } | null {
    const d = this.display;
    return d && d.model === this.host.model() ? d : null;
  }

  // ------------------------------------------------------------------ picking

  private lineOf(route: number): TransitLine | undefined {
    return this.dayData?.lines.find((l) => l.routes.includes(route));
  }

  private pickedRoutes(): ReadonlySet<number> | null {
    const line = this.picked ? this.dayData?.lines.find((l) => l.key === this.picked) : undefined;
    return line ? new Set(line.routes) : null;
  }

  private pickLine(key: string | null): void {
    this.picked = key;
    const d = this.shownDisplay();
    if (d) {
      d.overlay.pick(this.pickedRoutes());
      d.model.repaint();
    }
    this.renderLines();
    this.renderChart(true);
    this.updateLabels();
    this.host.viewer.requestRender();
  }

  private setTime(s: number, fromPlayback = false): void {
    const time = Math.max(0, Math.min(DAY_S - 60, s));
    if (!fromPlayback) this.playback.pause();
    const minuteChanged = Math.floor(time / 60) !== Math.floor(this.time / 60);
    this.time = time;
    this.shownDisplay()?.overlay.setTime(time);
    if (minuteChanged || !fromPlayback) this.renderChart();
    if (!fromPlayback) this.updateLabels();
    this.host.viewer.requestRender();
  }

  /** Line names over the vehicles, a few, not on top of each other; none while replaying. */
  private updateLabels(): void {
    const d = this.shownDisplay();
    if (!d) return;
    if (this.playback.playing) {
      d.overlay.setLabels([]);
      return;
    }
    const picked = this.pickedRoutes();
    const minM = d.model.sizeM * 0.08;
    const kept: Array<{ run: number; e: number; n: number; text: string }> = [];
    const list = [...d.overlay.vehicles].sort((a, b) => Number(!!picked && !picked.has(a.route)) - Number(!!picked && !picked.has(b.route)));
    for (const v of list) {
      if (kept.length >= MAX_LABELS) break;
      if (picked && !picked.has(v.route)) continue;
      if (kept.some((k) => Math.hypot(k.e - v.e, k.n - v.n) < minM)) continue;
      const line = this.lineOf(v.route);
      kept.push({ run: v.run, e: v.e, n: v.n, text: line?.name ?? '' });
    }
    d.overlay.setLabels(kept.map(({ run, text }) => ({ run, text })));
  }

  private onPlayback(pos: number, playing: boolean): void {
    const btn = $('transit-play');
    btn.textContent = playing ? t.routePause : t.routePlay;
    btn.setAttribute('aria-pressed', String(playing));
    const d = this.shownDisplay();
    // fast replays leave trails, so the vehicles read as flowing rather than jumping
    d?.overlay.setTrail(playing && this.speed >= TRAIL_FROM_SPEED ? Math.min(TRAIL_MAX_S, this.speed * TRAIL_REPLAY_S) : 0);
    if (playing) {
      this.setTime(pos * DAY_S, true);
      if (d && d.overlay.labelCount) d.overlay.setLabels([]);
    } else {
      this.updateLabels();
      this.renderChart();
    }
  }

  // ------------------------------------------------------------------ the panel

  private renderSpeeds(): void {
    const group = $('transit-speed');
    group.replaceChildren(
      ...SPEEDS.map((v, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = String(v);
        b.textContent = t.transitSpeeds[i];
        b.setAttribute('aria-checked', String(v === this.speed));
        b.tabIndex = v === this.speed ? 0 : -1;
        b.addEventListener('click', () => this.setSpeed(v));
        return b;
      }),
    );
  }

  private setSpeed(v: number): void {
    this.speed = v;
    this.playback.durationMs = (DAY_S * 1000) / v;
    for (const b of $('transit-speed').querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
      const on = Number(b.dataset.value) === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  private renderLines(): void {
    const day = this.dayData;
    const host = $('transit-lines');
    if (!day) {
      host.replaceChildren();
      return;
    }
    host.replaceChildren(
      ...day.lines.map((l) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip line-chip';
        b.setAttribute('aria-pressed', String(this.picked === l.key));
        b.title = t.transitLineTitle(`${t.transitModes[l.mode]} ${l.name}`, t.transitTrips(l.runs, num(l.runs)));
        const sw = document.createElement('i');
        sw.className = `swatch line-swatch mode-${l.mode}`;
        sw.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.textContent = l.name;
        b.append(sw, name);
        b.addEventListener('click', () => this.pickLine(this.picked === l.key ? null : l.key));
        return b;
      }),
    );
    host.classList.toggle('picking', !!this.picked);
    const modes = modesOn(day);
    $('transit-modes').replaceChildren(
      ...modes.map((m: TransitMode) => {
        const li = document.createElement('li');
        const sw = document.createElement('i');
        sw.className = `swatch line-swatch mode-${m}`;
        sw.setAttribute('aria-hidden', 'true');
        li.append(sw, document.createTextNode(t.transitModes[m]));
        return li;
      }),
    );
  }

  /** The bar chart of the day; `rebuild` when the data or the line changed, not only the time. */
  private renderChart(rebuild = false): void {
    const day = this.dayData;
    if (!day) return;
    const values = runsPerHour(day, this.pickedRoutes());
    const bars = $('transit-bars');
    const line = this.picked ? day.lines.find((l) => l.key === this.picked) : undefined;
    if (rebuild || bars.children.length !== 24) {
      const { top, ticks } = chartTicks(Math.max(0, ...values));
      bars.replaceChildren(
        ...barShares(values, top).map((s) => {
          const bar = document.createElement('i');
          bar.className = 'tbar';
          bar.style.height = `${(s * 100).toFixed(2)}%`;
          return bar;
        }),
      );
      $('transit-grid').replaceChildren(
        ...ticks.map((v) => {
          const g = document.createElement('span');
          g.className = 'tgrid';
          g.style.bottom = `${((v / top) * 100).toFixed(2)}%`;
          g.dataset.label = compact(v);
          return g;
        }),
      );
      $('transit-x').replaceChildren(
        ...[0, 6, 12, 18].map((h) => {
          const label = document.createElement('span');
          label.style.left = `${(((h + 0.5) / 24) * 100).toFixed(2)}%`;
          label.textContent = `${pad(h)}:00`;
          return label;
        }),
      );
      const fig = $('transit-figure');
      if (line) {
        fig.style.setProperty('--bar', `color-mix(in srgb, ${MODE_COLOURS[line.mode]} 45%, #f1ede5)`);
        fig.style.setProperty('--bar-on', MODE_COLOURS[line.mode]);
      } else {
        fig.style.removeProperty('--bar');
        fig.style.removeProperty('--bar-on');
      }
      $('transit-sub').textContent = line ? t.transitOneLine(line.name) : t.transitAllLines;
      $('transit-all').hidden = !line;
      this.renderTable(values);
    }
    const hour = Math.floor(this.time / 3600);
    [...bars.children].forEach((bar, i) => {
      bar.classList.toggle('on', i === hour);
      bar.classList.toggle('hover', i === this.hover && i !== hour);
    });
    $('transit-now').style.left = `${((this.time / DAY_S) * 100).toFixed(3)}%`;
    const when = `${this.dayFormat.format(day.day * DAY_MS)} ${clock(this.time)}`;
    const count = this.shownDisplay()?.overlay.vehicles.length ?? 0;
    const shown = this.hover != null ? `${pad(this.hover)}:00–${pad(this.hover + 1)}:00: ${t.transitTrips(values[this.hover], num(values[this.hover]))}` : `${when} · ${t.transitVehicles(count, num(count))}`;
    $('transit-readout').textContent = shown;
    // the quick play button in the panel's bar shows the time too
    $('transit-play').dataset.clock = clock(this.time);
    const chart = $('transit-chart');
    const minute = Math.floor(this.time / 60);
    chart.setAttribute('aria-valuenow', String(minute));
    chart.setAttribute('aria-valuetext', `${when}, ${t.transitVehicles(count, num(count))}, ${t.transitTrips(values[hour], num(values[hour]))} ${pad(hour)}:00–${pad(hour + 1)}:00`);
    chart.setAttribute('aria-label', `${t.transitPerHour}, ${$('transit-sub').textContent}`);
  }

  private renderTable(values: number[]): void {
    const head = document.createElement('tr');
    for (const text of [t.trafficTableHour, t.transitPerHour]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      head.append(th);
    }
    const rows = values.map((v, i) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = `${pad(i)}:00–${pad(i + 1)}:00`;
      const td = document.createElement('td');
      td.textContent = num(v);
      tr.append(th, td);
      return tr;
    });
    $('transit-table').replaceChildren(head, ...rows);
  }

  private syncPanel(override?: string): void {
    const s = this.status;
    const tt = this.timetable;
    const ready = this.on && s === 'ready' && !!tt && !!this.dayData;
    const loaded = this.sources.length > 0;
    // the way to load one: until one is read, and again when it couldn't be
    $('transit-empty').hidden = s === 'reading' || (loaded && s !== 'error');
    const pct = `${num(Math.round(this.progress * 100))} %`;
    const text =
      override ??
      (s === 'reading'
        ? this.downloading
          ? t.transitDownloading(this.downloading, pct)
          : t.transitReading(pct)
        : s === 'error'
          ? (t.transitProblems[this.problem] ?? t.transitProblems.unreadable)
          : s === 'outside'
            ? t.transitOutside
            : ready && !this.dayData!.run.length
              ? t.transitNoTrips
              : '');
    $('transit-status').textContent = text;
    $('transit-status').hidden = !text;
    const bar = $<HTMLProgressElement>('transit-progress');
    bar.hidden = s !== 'reading' || override != null;
    bar.value = this.progress;
    const go = $('transit-go');
    go.hidden = !(s === 'outside' && tt?.busiest);
    if (tt?.busiest) go.textContent = t.transitGoTo(tt.busiest.name);
    $('transit-loaded').hidden = !(loaded && (s === 'ready' || s === 'outside'));
    $('transit-figure').hidden = !ready;
    $('transit-day-row').hidden = !ready;
    $('transit-control').classList.toggle('has-timetable', loaded && (s === 'ready' || s === 'outside'));
    $('transit-remove').textContent = this.sources.length > 1 ? t.transitRemoveAll : t.transitRemove;
    this.renderSources();
    this.renderFeeds();
    if (tt) {
      $('transit-shapes').hidden = tt.parts.every((p) => p.hasShapes);
      const input = $<HTMLInputElement>('transit-date');
      if (Number.isFinite(tt.firstDay)) {
        input.min = isoDay(tt.firstDay);
        input.max = isoDay(tt.lastDay);
        $('transit-covers').textContent = t.transitCovers(this.longDay.format(tt.firstDay * DAY_MS), this.longDay.format(tt.lastDay * DAY_MS));
      }
      if (Number.isFinite(this.dayNo)) input.value = isoDay(this.dayNo);
    }
  }

  /** The timetables shown, each with a way to take it away, and who to credit for them. */
  private renderSources(): void {
    const tt = this.timetable;
    $('transit-sources').replaceChildren(
      ...this.sources.map((src, k) => {
        const { name } = this.creditOf(src, k);
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'feed-text';
        const strong = document.createElement('strong');
        strong.textContent = name || '–';
        const small = document.createElement('small');
        small.textContent = src.demo ? t.transitFreiburg : src.feed ? src.feed.place || src.feed.name : t.transitYourFile;
        text.append(strong, small);
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'icon-btn feed-remove';
        x.setAttribute('aria-label', t.transitRemoveOne(name));
        x.title = t.transitRemoveOne(name);
        x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>';
        x.addEventListener('click', () => this.removeSource(k));
        li.append(text, x);
        return li;
      }),
    );
    const credit = $('transit-credit');
    if (!tt) {
      credit.replaceChildren();
      return;
    }
    const parts: Array<string | Node> = [`${t.transitCreditsLabel} `];
    this.sources.forEach((src, k) => {
      const { name, licence } = this.creditOf(src, k);
      if (k) parts.push('; ');
      parts.push(name || '–');
      if (licence) {
        const a = document.createElement('a');
        a.href = licence;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = licenceName(licence) ?? t.transitLicence;
        parts.push(' (', a, ')');
      } else if (!src.demo && !src.feed) parts.push(` (${t.transitYourFile})`);
    });
    if (this.sources.some((src) => src.feed)) {
      const a = document.createElement('a');
      a.href = CATALOG_SITE;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t.transitViaCatalog;
      parts.push(', ', a);
    }
    parts.push('.');
    credit.replaceChildren(...parts);
  }

  /** The finder: a button, then the Mobility Database's timetables for the square, each to load or add. */
  private renderFeeds(): void {
    const model = this.host.model();
    const here = !!model && this.last?.model === model;
    $('transit-find').hidden = !this.on || !here || (this.status === 'reading' && !this.found);
    const found = this.found && this.last && this.found.center === this.last.center ? this.found : null;
    const btn = $<HTMLButtonElement>('transit-find-btn');
    btn.hidden = !!found;
    btn.disabled = this.finding === 'busy';
    const status = this.finding === 'busy' ? t.transitFinding : this.finding === 'failed' ? t.transitFindFailed : found && !found.feeds.length ? t.transitFindNone : '';
    $('transit-find-status').textContent = status;
    $('transit-find-status').hidden = !status;
    const list = $('transit-feeds');
    list.hidden = !found?.feeds.length;
    if (!found) {
      list.replaceChildren();
      return;
    }
    const busy = this.status === 'reading';
    list.replaceChildren(
      ...found.feeds.map((f) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'feed-text';
        const strong = document.createElement('strong');
        strong.textContent = f.provider;
        const size = found.sizes.get(f.url);
        const small = document.createElement('small');
        small.textContent = [f.name, f.place, size ? t.transitFeedSize(num(Math.max(0.1, size / 1048576), size < 10 * 1048576 ? 1 : 0)) : ''].filter(Boolean).join(' · ');
        text.append(strong, small);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-small';
        const shown = this.sources.some((s) => s.feed?.url === f.url);
        const big = !!size && size > MAX_GTFS_BYTES;
        b.textContent = shown ? t.transitFeedShown : big ? t.transitFeedTooBig : this.sources.length ? t.transitFeedAdd : t.transitFeedLoad;
        b.disabled = shown || big || busy;
        b.addEventListener('click', () => void this.loadFeed(f));
        li.append(text, b);
        return li;
      }),
    );
  }

  private bind(): void {
    const input = $<HTMLInputElement>('transit-file');
    // a file to add to those shown, or the first one
    let adding = false;
    const pick = (add: boolean) => {
      adding = add;
      this.pickFile();
    };
    $('transit-load-btn').addEventListener('click', () => pick(false));
    $('transit-another').addEventListener('click', () => pick(true));
    $('transit-landing-btn').addEventListener('click', () => pick(false));
    $('transit-find-btn').addEventListener('click', () => void this.find());
    $('transit-remove').addEventListener('click', () => this.remove());
    $('transit-demo').addEventListener('click', () => void this.loadDemo());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) this.loadFile(file, { add: adding });
    });
    // a ZIP dropped on the page is a timetable (a route is a GPX or TCX)
    window.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files[0];
      if (!file || !/\.zip$/i.test(file.name)) return;
      e.preventDefault();
      this.loadFile(file, { add: true });
    });
    $('transit-go').addEventListener('click', () => {
      const b = this.timetable?.busiest;
      if (b) this.go({ lat: b.lat, lon: b.lon }, OPEN_SIZE, b.name);
    });
    $('transit-all').addEventListener('click', () => this.pickLine(null));
    $<HTMLInputElement>('transit-date').addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value;
      if (!v) return;
      const [y, m, d] = v.split('-').map(Number);
      this.setDay(Date.UTC(y, m - 1, d) / DAY_MS);
    });
    $('transit-play').addEventListener('click', () => {
      if (!this.playback.playing) this.playback.seek(this.time >= DAY_S - 120 ? 0 : this.time / DAY_S);
      this.playback.toggle();
    });

    const chart = $('transit-chart');
    const timeAt = (clientX: number) => {
      const r = $('transit-bars').getBoundingClientRect();
      const u = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return Math.round((u * DAY_S) / 60) * 60;
    };
    chart.addEventListener('pointermove', (e) => {
      const s = timeAt(e.clientX);
      if (e.buttons & 1) {
        this.hover = null;
        this.setTime(s);
      } else {
        const h = Math.min(23, Math.floor(s / 3600));
        if (h !== this.hover) {
          this.hover = h;
          this.renderChart();
        }
      }
    });
    chart.addEventListener('pointerleave', () => {
      this.hover = null;
      this.renderChart();
    });
    chart.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.hover = null;
      this.setTime(timeAt(e.clientX));
    });
    chart.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 3600 : 900;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.setTime(this.time + step);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.setTime(this.time - step);
      else if (e.key === 'PageUp') this.setTime(this.time + 3600);
      else if (e.key === 'PageDown') this.setTime(this.time - 3600);
      else if (e.key === 'Home') this.setTime(0);
      else if (e.key === 'End') this.setTime(DAY_S - 60);
      else return;
      e.preventDefault();
    });
  }
}
