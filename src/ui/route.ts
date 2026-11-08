/**
 * The route panel: load a GPX or TCX file (or a route from a share link), pick the stretch the
 * model shows, replay it, hide its ends, remove it.
 *
 * Privacy: the file is read in this browser and never uploaded or stored; reloading the page
 * forgets it. A share link carries the stretch only when the user turns that on, and never
 * times or the name. Loading a route doesn't look up the place's name either: the square is
 * named after the route, so no search service learns where it runs.
 */

import { num, t } from '../i18n';
import type { LngLat } from '../geo/projection';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import { declutter, RouteDisplay, type RouteMark } from '../data/display/route';
import {
  endOf,
  fitStretch,
  defaultStretch,
  formatClock,
  kmMarks,
  makeRoute,
  pointAt,
  replayAt,
  simplify,
  squareFor,
  startOf,
  stretchOf,
  toLocal,
  trimEnds,
  type Route,
} from '../data/match/route';
import { decodeRouteLink, encodeRouteLink, MAX_LINK_POINTS } from '../data/sources/routeLink';
import { readTrackFile, TrackFileProblem } from '../data/sources/trackFile';
import { Playback } from '../data/time/playback';

/** How much of each end "hide the ends" removes (m). */
export const TRIM_M = 500;
/** A replay takes this long, whatever the stretch's length. */
const REPLAY_MS = 10_000;

export interface RouteHost {
  viewer: Viewer;
  accent: string;
  model(): CityModel | null;
  /** build the model around a stretch */
  open(center: LngLat, size: number, label: string, detail: string): void;
  /** the share link or the description should follow */
  changed(): void;
  say(message: string, ms?: number): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class RouteController {
  /** the route as loaded */
  private base: Route | null = null;
  /** as shown: without its ends when the user hides them */
  private route: Route | null = null;
  private fromM = 0;
  private toM = 0;
  /** from a share link: only the shared stretch exists */
  private shared = false;
  private trim = false;
  private share = false;
  private display: { model: CityModel; center: LngLat; overlay: RouteDisplay } | null = null;
  private readonly playback: Playback;
  private linkCache: { key: string; code: string } | null = null;

  constructor(private readonly host: RouteHost) {
    this.playback = new Playback(REPLAY_MS, (pos, playing) => this.onPlayback(pos, playing));
    host.viewer.onFrame((dt) => {
      if (this.playback.advance(dt)) host.viewer.requestRender();
    });
    this.bind();
    this.syncPanel();
  }

  get active(): boolean {
    return !!this.route;
  }

  get name(): string {
    return this.base?.name || (this.shared ? t.routeShared : t.routeUnnamed);
  }

  /** Read a picked or dropped file and build the model around its default stretch. */
  async loadFile(file: File): Promise<void> {
    this.host.say(t.routeReading, 2000);
    let route: Route;
    try {
      const track = await readTrackFile(file);
      route = makeRoute(track);
      if (endOf(route) < 20) throw new TrackFileProblem('empty');
    } catch (err) {
      const reason = err instanceof TrackFileProblem ? err.reason : null;
      if (!reason) console.warn('Route file could not be read', err);
      this.host.say(
        reason === 'fit' ? t.routeFit : reason === 'unsupported' ? t.routeUnsupported : reason === 'empty' ? t.routeEmpty : reason === 'tooBig' ? t.routeTooBig : t.routeFailed,
        7000,
      );
      return;
    }
    this.playback.reset();
    this.base = route;
    this.shared = false;
    this.share = false;
    this.trim = false;
    this.route = route;
    ({ fromM: this.fromM, toM: this.toM } = defaultStretch(route));
    this.syncPanel();
    this.host.say(t.routeLoaded(this.name, num(endOf(route) / 1000, 1)), 6000);
    this.openStretch();
  }

  /** A route from a share link; false if the link's route is unreadable. The place comes from the link. */
  openLink(code: string): boolean {
    const linked = decodeRouteLink(code);
    if (!linked) return false;
    this.playback.reset();
    this.base = makeRoute({ name: '', points: linked.points }, { offset: linked.startM, hasStart: linked.hasStart, hasFinish: linked.hasFinish });
    this.route = this.base;
    this.shared = true;
    // it came in a link: passing the link on keeps it
    this.share = true;
    this.trim = false;
    this.fromM = startOf(this.route);
    this.toM = endOf(this.route);
    this.linkCache = { key: this.linkKey(), code };
    this.syncPanel();
    return true;
  }

  /** Put the route on a newly built model. */
  attach(model: CityModel, center: LngLat): void {
    // the ground is painted again when the new display is added (an old model is about to go anyway)
    this.detach(false);
    this.playback.reset();
    if (!this.route) return;
    const overlay = new RouteDisplay(this.view(center, model.sizeM), this.host.accent, model.sizeM);
    model.addOverlay(overlay);
    this.display = { model, center, overlay };
  }

  remove(): void {
    this.detach();
    this.playback.reset();
    this.base = null;
    this.route = null;
    this.shared = false;
    this.share = false;
    this.syncPanel();
    this.host.viewer.requestRender();
    this.host.changed();
  }

  /** The link code for the stretch shown, or null unless the user turned sharing on. */
  linkCode(): string | null {
    const r = this.route;
    if (!r || !this.share) return null;
    const key = this.linkKey();
    if (this.linkCache?.key === key) return this.linkCache.code;
    const points = stretchOf(r, this.fromM, this.toM);
    const local = toLocal(points, points[0]);
    // about a metre in the link anyway; fewer points keep it short
    let keep = simplify(local, 1.5);
    for (let tol = 3; keep.length > MAX_LINK_POINTS; tol *= 2) keep = simplify(local, tol);
    const code = encodeRouteLink({
      points: keep.map((i) => points[i]),
      startM: this.fromM,
      hasStart: r.hasStart && this.fromM <= startOf(r) + 0.5,
      hasFinish: r.hasFinish && this.toM >= endOf(r) - 0.5,
    });
    this.linkCache = { key, code };
    return code;
  }

  /** A sentence for the model's description, or null without a route. */
  describe(): string | null {
    if (!this.route) return null;
    return t.routeDescribe(this.name, num((this.toM - this.fromM) / 1000, 1), num(this.fromM / 1000, 1), num(this.toM / 1000, 1));
  }

  /** For tests (window.__yourPlace.route()). */
  debugInfo(): unknown {
    const r = this.route;
    if (!r) return null;
    const d = this.display;
    return {
      name: this.name,
      shared: this.shared,
      share: this.share,
      trim: this.trim,
      startM: startOf(r),
      endM: endOf(r),
      fromM: this.fromM,
      toM: this.toM,
      hasTime: r.hasTime,
      hasStart: r.hasStart,
      hasFinish: r.hasFinish,
      shown: !!d && d.model === this.host.model(),
      marks: d?.overlay.view.marks.map((m) => m.label) ?? [],
      stretchPoints: d?.overlay.view.stretch.length ?? 0,
      playing: this.playback.playing,
      position: this.playback.position,
      runner: d?.overlay.runnerVisible ?? false,
    };
  }

  // ------------------------------------------------------------------ internals

  private linkKey(): string {
    return `${this.fromM}|${this.toM}|${this.trim}|${this.shared}`;
  }

  private detach(repaint = true): void {
    if (this.display) {
      this.display.model.removeOverlay(this.display.overlay, repaint);
      this.display = null;
    }
  }

  /** Draw the route again on the same model (the ends hidden or shown, a stretch within the square). */
  private redraw(): void {
    const d = this.display;
    if (d && d.model === this.host.model()) this.attach(d.model, d.center);
    this.host.viewer.requestRender();
  }

  /** The route in the model's local metres: the stretch, the rest of it faint, and its markers. */
  private view(center: LngLat, sizeM: number) {
    const r = this.route!;
    const local = (p: { lat: number; lon: number }) => toLocal([p], center)[0];
    const h = sizeM / 2;
    const inside = (at: [number, number]) => Math.abs(at[0]) <= h && Math.abs(at[1]) <= h;
    const marks: RouteMark[] = [];
    const startShown = r.hasStart && this.fromM <= startOf(r) + 0.5;
    const finishShown = r.hasFinish && this.toM >= endOf(r) - 0.5;
    if (startShown) marks.push({ at: local(r.points[0]), label: t.routeStart, kind: 'start' });
    if (finishShown) marks.push({ at: local(r.points[r.points.length - 1]), label: t.routeFinish, kind: 'finish' });
    for (const km of kmMarks(this.fromM, this.toM)) marks.push({ at: local(pointAt(r, km * 1000)), label: `${num(km)} km`, kind: 'km' });
    return {
      rest: toLocal(r.points, center),
      stretch: toLocal(stretchOf(r, this.fromM, this.toM), center),
      marks: declutter(marks.filter((m) => inside(m.at)), sizeM),
    };
  }

  /** Build the model around the chosen stretch. */
  private openStretch(): void {
    const r = this.route;
    if (!r) return;
    const sq = squareFor(stretchOf(r, this.fromM, this.toM));
    this.host.open(sq.center, sq.size, this.name, t.routeLength(num(endOf(r) / 1000, 1)));
  }

  private onPlayback(position: number, playing: boolean): void {
    const btn = $('route-play');
    btn.textContent = playing ? t.routePause : t.routePlay;
    btn.setAttribute('aria-pressed', String(playing));
    const r = this.route;
    const d = this.display;
    if (!r || !d) {
      $('route-clock').textContent = '';
      return;
    }
    if (!playing && position === 0) {
      d.overlay.setRunner(null);
      $('route-clock').textContent = '';
      return;
    }
    const at = replayAt(r, this.fromM, this.toM, position);
    d.overlay.setRunner(toLocal([at.point], d.center)[0]);
    $('route-clock').textContent = `${num(at.m / 1000, 1)} km${at.elapsed != null ? ` · ${formatClock(at.elapsed)}` : ''}`;
  }

  private syncPanel(): void {
    const r = this.route;
    $('route-empty').hidden = !!r;
    $('route-loaded').hidden = !r;
    $<HTMLInputElement>('share-route').checked = this.share;
    $('share-route-row').hidden = !r;
    if (!r) {
      $('route-summary').textContent = t.routeHint;
      return;
    }
    $('route-name').textContent = this.name;
    $('route-stretch').hidden = this.shared;
    $('route-trim-row').hidden = this.shared;
    $<HTMLInputElement>('route-trim').checked = this.trim;
    for (const id of ['route-from', 'route-to']) {
      const el = $<HTMLInputElement>(id);
      el.min = String(Math.floor(startOf(r)));
      el.max = String(Math.ceil(endOf(r)));
    }
    this.syncStretch();
  }

  private syncStretch(): void {
    const r = this.route;
    if (!r) return;
    $<HTMLInputElement>('route-from').value = String(Math.round(this.fromM));
    $<HTMLInputElement>('route-to').value = String(Math.round(this.toM));
    $('route-from-out').textContent = num(this.fromM / 1000, 1);
    $('route-to-out').textContent = num(this.toM / 1000, 1);
    $('route-summary').textContent = t.routeShown(num((this.toM - this.fromM) / 1000, 1), num((endOf(r) - startOf(r)) / 1000, 1));
  }

  private bind(): void {
    const input = $<HTMLInputElement>('route-file');
    const pick = () => input.click();
    $('route-load-btn').addEventListener('click', pick);
    $('route-landing-btn').addEventListener('click', pick);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      // the same file can be picked again later
      input.value = '';
      if (file) void this.loadFile(file);
    });

    // drop a file anywhere on the page
    const hasFile = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragover', (e) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      const file = e.dataTransfer!.files[0];
      if (file) void this.loadFile(file);
    });

    // the stretch: the readouts follow the sliders; the model is built when one is let go
    let timer = 0;
    const slide = (keep: 'from' | 'to') => {
      const r = this.route;
      if (!r) return;
      const from = Number($<HTMLInputElement>('route-from').value);
      const to = Number($<HTMLInputElement>('route-to').value);
      ({ fromM: this.fromM, toM: this.toM } = fitStretch(r, from, to, keep));
      this.syncStretch();
    };
    for (const [id, keep] of [
      ['route-from', 'from'],
      ['route-to', 'to'],
    ] as const) {
      const el = $<HTMLInputElement>(id);
      el.addEventListener('input', () => slide(keep));
      el.addEventListener('change', () => {
        slide(keep);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          this.playback.reset();
          this.openStretch();
        }, 350);
      });
    }

    $('route-play').addEventListener('click', () => this.playback.toggle());

    $<HTMLInputElement>('route-trim').addEventListener('change', (e) => {
      if (!this.base || this.shared) return;
      this.trim = (e.target as HTMLInputElement).checked;
      this.route = this.trim ? trimEnds(this.base, TRIM_M) : this.base;
      ({ fromM: this.fromM, toM: this.toM } = fitStretch(this.route, this.fromM, this.toM, 'to'));
      this.playback.reset();
      this.syncPanel();
      this.redraw();
      this.host.changed();
    });

    $('route-remove').addEventListener('click', () => this.remove());

    $<HTMLInputElement>('share-route').addEventListener('change', (e) => {
      this.share = (e.target as HTMLInputElement).checked;
      this.host.changed();
    });
  }
}
