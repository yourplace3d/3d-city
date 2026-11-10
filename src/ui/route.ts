/**
 * The route layer of Your Place · Data: load a GPX or TCX file (or a route from a share link),
 * pick the stretch the model shows, replay it, see its height profile, hide its ends, remove it.
 * Shown while it is the chosen data layer; the route stays loaded when another one is picked.
 *
 * Privacy: the file is read in this browser and never uploaded or stored; reloading the page
 * forgets it. A share link carries the stretch only when the user turns that on, and never
 * times or the name. Loading a route doesn't look up the place's name either: the square is
 * named after the route, so no search service learns where it runs.
 */

import { distance, num, t } from '../i18n';
import type { LngLat } from '../geo/projection';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import { declutter, RouteDisplay, type Lift, type RouteMark } from '../data/display/route';
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
import { bridgeTester, classRuns, climbTotals, sampleClasses, sampleLine, steepClass, steepSections, type LineSample } from '../data/match/slope';
import { steepColour } from '../data/display/steepness';
import { profileScale, profileSvg, sampleAtFraction, type ProfileScale } from '../data/display/profile';

/** How much of each end "hide the ends" removes (m). */
export const TRIM_M = 500;
/** A replay takes this long, whatever the stretch's length. */
const REPLAY_MS = 10_000;

export interface RouteHost {
  viewer: Viewer;
  accent: string;
  model(): CityModel | null;
  /** whether the route shows its steepness colours and climbs */
  steep(): boolean;
  /** what the route rides on where a data layer stands up from the model (traffic streets), if any */
  lift(): Lift | null;
  /** a route was loaded from a file: make it the data layer shown */
  showRoute(): void;
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
  /** the route is the data layer shown */
  private shown = false;
  /** the model it was last given, to show the route on when it's picked again */
  private last: { model: CityModel; center: LngLat } | null = null;
  /** the stretch's heights and grades on the current model, for the profile */
  private profile: { samples: LineSample[]; scale: ProfileScale; climbs: string[] } | null = null;
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
    this.host.showRoute();
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

  /** Show or hide the route (it is or isn't the data layer picked); it stays loaded either way. */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    const last = this.last;
    if (shown && last && last.model === this.host.model()) this.attach(last.model, last.center);
    else if (!shown) {
      this.detach();
      this.playback.reset();
      this.profile = null;
      this.renderProfile();
    }
    this.syncPanel();
    this.host.viewer.requestRender();
  }

  get visible(): boolean {
    return this.shown && !!this.route;
  }

  /** Put the route on a newly built model (if it's the layer shown). */
  attach(model: CityModel, center: LngLat): void {
    // the ground is painted again when the new display is added (an old model is about to go anyway)
    this.detach(false);
    this.playback.reset();
    this.last = { model, center };
    if (!this.route || !this.shown) {
      this.profile = null;
      this.renderProfile();
      return;
    }
    const overlay = new RouteDisplay(this.view(model, center), this.host.accent, model.sizeM);
    model.addOverlay(overlay);
    overlay.setLift(this.host.lift());
    this.display = { model, center, overlay };
    this.renderProfile();
  }

  /** What's under the route changed (traffic streets rose or fell, came or went): ride on it again. */
  liftChanged(): void {
    const d = this.display;
    if (!d || d.model !== this.host.model()) return;
    d.overlay.setLift(this.host.lift());
    this.host.viewer.requestRender();
  }

  /** Draw the route again: its model's roads arrived (bridges), its terrain changed, or steepness was switched. */
  refresh(): void {
    this.redraw();
    this.host.changed();
  }

  remove(): void {
    this.detach();
    this.playback.reset();
    this.base = null;
    this.route = null;
    this.profile = null;
    this.renderProfile();
    this.shared = false;
    this.share = false;
    this.syncPanel();
    this.host.viewer.requestRender();
    this.host.changed();
  }

  /** The link code for the stretch shown, or null unless the user turned sharing on. */
  linkCode(): string | null {
    const r = this.route;
    if (!r || !this.share || !this.shown) return null;
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
    if (!this.route || !this.shown) return null;
    const line = t.routeDescribe(this.name, num((this.toM - this.fromM) / 1000, 1), num(this.fromM / 1000, 1), num(this.toM / 1000, 1));
    const summary = this.profileSummary();
    return summary ? `${line} ${t.profileLabel(summary)}` : line;
  }

  /** The replay at one point (0–1), paused, for rendering a video frame by frame. */
  frameAt(position: number): void {
    this.playback.pause();
    this.playback.seek(position);
    this.host.viewer.requestRender();
  }

  /** For tests (window.__yourPlace.route()). */
  debugInfo(): unknown {
    const r = this.route;
    if (!r) return null;
    const d = this.display;
    return {
      name: this.name,
      layerShown: this.shown,
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
      steep: !!d?.overlay.view.steep,
      lifted: d?.overlay.lifted ?? false,
      climbs: this.profile?.climbs ?? [],
      profile: this.profileSummary(),
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

  /**
   * The route in the model's local metres: the stretch, the rest of it faint, and its markers;
   * with steepness on, the stretch in its steepness colours and its steepest sections labelled.
   * Also measures the stretch's heights for the profile.
   */
  private view(model: CityModel, center: LngLat) {
    const r = this.route!;
    const sizeM = model.sizeM;
    const local = (p: { lat: number; lon: number }) => toLocal([p], center)[0];
    const h = sizeM / 2;
    const inside = (at: [number, number]) => Math.abs(at[0]) <= h && Math.abs(at[1]) <= h;
    const stretch = toLocal(stretchOf(r, this.fromM, this.toM), center);
    // heights from the model's terrain (not the file's GPS heights), straight across bridges
    const bridges = (model.featureSet?.lines ?? []).filter((l) => l.bridge).map((l) => l.pts);
    const all = sampleLine(stretch, (e, n) => model.elevationAt(e, n), { onBridge: bridgeTester(bridges) });
    // only where the model has terrain: a smaller square can cut the stretch
    const samples = all.filter((x) => inside([x.e, x.n]));

    const marks: RouteMark[] = [];
    const startShown = r.hasStart && this.fromM <= startOf(r) + 0.5;
    const finishShown = r.hasFinish && this.toM >= endOf(r) - 0.5;
    if (startShown) marks.push({ at: local(r.points[0]), label: t.routeStart, kind: 'start' });
    if (finishShown) marks.push({ at: local(r.points[r.points.length - 1]), label: t.routeFinish, kind: 'finish' });
    const steep = this.host.steep();
    const climbs: string[] = [];
    if (steep) {
      for (const c of steepSections(samples).slice(0, 3)) {
        const label = t.climbLabel(signedPct(c.grade), distance(c.to - c.from));
        climbs.push(label);
        marks.push({ at: c.at, label, kind: 'climb', colour: steepColour(steepClass(c.grade)) ?? undefined });
      }
    }
    for (const km of kmMarks(this.fromM, this.toM)) marks.push({ at: local(pointAt(r, km * 1000)), label: `${num(km)} km`, kind: 'km' });
    this.profile = samples.length >= 2 ? { samples, scale: profileScale(samples), climbs } : null;
    return {
      rest: toLocal(r.points, center),
      stretch,
      steep: steep ? classRuns(all) : undefined,
      marks: declutter(marks.filter((m) => inside(m.at)), sizeM),
    };
  }

  /** "85 m up, 120 m down · steepest +9 % at km 7.2" */
  private profileSummary(): string | null {
    const p = this.profile;
    if (!p) return null;
    const { up, down } = climbTotals(p.samples);
    let top = p.samples[0];
    for (const x of p.samples) if (Math.abs(x.g) > Math.abs(top.g)) top = x;
    const parts = [t.profileSummary(num(Math.round(up)), num(Math.round(down)))];
    if (Math.abs(top.g) >= 0.03) parts.push(t.steepest(signedPct(top.g), num((this.fromM + top.d) / 1000, 1)));
    return parts.join(' · ');
  }

  /** The height profile in the panel, with its labels; hidden without a route. */
  private renderProfile(): void {
    const p = this.profile;
    $('route-profile').hidden = !p;
    $('profile-cross').hidden = true;
    $('profile-hover-dot').hidden = true;
    $('profile-runner').hidden = true;
    $('profile-readout').textContent = '';
    if (!p) {
      $('profile-plot').innerHTML = '';
      return;
    }
    const s = p.samples;
    $('profile-plot').innerHTML = profileSvg(s, p.scale, sampleClasses(s));
    let low = s[0];
    let high = s[0];
    for (const x of s) {
      if (x.h < low.h) low = x;
      if (x.h > high.h) high = x;
    }
    const top = (hm: number) => `${((1 - (hm - p.scale.y0) / (p.scale.y1 - p.scale.y0)) * 100).toFixed(1)}%`;
    const y1 = $('profile-y1');
    y1.textContent = `${num(Math.round(high.h))} m`;
    y1.style.top = top(high.h);
    const y0 = $('profile-y0');
    y0.textContent = `${num(Math.round(low.h))} m`;
    y0.style.top = top(low.h);
    // the same labels when the highest and lowest points are close: keep the top one only
    y0.hidden = Math.round(high.h) === Math.round(low.h);
    $('profile-x0').textContent = `${num((this.fromM + s[0].d) / 1000, 1)} km`;
    $('profile-x1').textContent = `${num((this.fromM + s[s.length - 1].d) / 1000, 1)} km`;
    const summary = this.profileSummary() ?? '';
    $('profile-summary').textContent = summary;
    $('profile-chart').setAttribute('aria-label', t.profileLabel(summary));
  }

  /** Put a profile marker (crosshair, hover dot or runner) at a sample; the crosshair only moves across. */
  private placeOnProfile(el: HTMLElement, x: LineSample, across = false): void {
    const p = this.profile!;
    el.hidden = false;
    el.style.left = `${((x.d / (p.scale.dMax || 1)) * 100).toFixed(2)}%`;
    if (!across) el.style.top = `${((1 - (x.h - p.scale.y0) / (p.scale.y1 - p.scale.y0)) * 100).toFixed(2)}%`;
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
      $('profile-runner').hidden = true;
      return;
    }
    const at = replayAt(r, this.fromM, this.toM, position);
    d.overlay.setRunner(toLocal([at.point], d.center)[0]);
    const p = this.profile;
    if (p) this.placeOnProfile($('profile-runner'), sampleAtFraction(p.samples, (at.m - this.fromM) / (p.scale.dMax || 1)));
    $('route-clock').textContent = `${num(at.m / 1000, 1)} km${at.elapsed != null ? ` · ${formatClock(at.elapsed)}` : ''}`;
  }

  private syncPanel(): void {
    const r = this.route;
    $('route-empty').hidden = !!r;
    $('route-loaded').hidden = !r;
    $<HTMLInputElement>('share-route').checked = this.share;
    $('share-route-row').hidden = !r || !this.shown;
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
      // a ZIP is a timetable, for the public transport layer
      if (file && !/\.zip$/i.test(file.name)) void this.loadFile(file);
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

    // the profile: what's under the pointer, as the crosshair moves along it
    const chart = $('profile-chart');
    const hover = (e: PointerEvent) => {
      const p = this.profile;
      if (!p) return;
      const box = chart.getBoundingClientRect();
      const x = sampleAtFraction(p.samples, (e.clientX - box.left) / box.width);
      this.placeOnProfile($('profile-cross'), x, true);
      this.placeOnProfile($('profile-hover-dot'), x);
      $('profile-readout').textContent = t.profileAt(num((this.fromM + x.d) / 1000, 1), num(Math.round(x.h)), signedPct(x.g));
    };
    chart.addEventListener('pointermove', hover);
    chart.addEventListener('pointerdown', hover);
    chart.addEventListener('pointerleave', () => {
      $('profile-cross').hidden = true;
      $('profile-hover-dot').hidden = true;
      $('profile-readout').textContent = '';
    });

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

/** "+9", "−12" (a real minus sign), "0" */
function signedPct(grade: number): string {
  const v = Math.round(grade * 100);
  return v > 0 ? `+${num(v)}` : v < 0 ? `−${num(-v)}` : num(0);
}
