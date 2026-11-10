/**
 * The Homes and Income layers of Your Place · Data: the buildings coloured by what homes cost, or
 * what people earn, in the area they stand in. People bring the data themselves, as with
 * timetables: the panel lists the open sources we know for the place (some load in one tap, the
 * others link to their download), and any GeoJSON or CSV with values per area works too. The file
 * is read in the browser, in a worker, and never uploaded; share links don't carry it.
 *
 * One controller per layer; each keeps its own file while the page is open, so moving to another
 * square reads it again for that one (a one-tap source is downloaded again, for the new square).
 */

import { locale, num, t } from '../i18n';
import { squareBBox, type LngLat } from '../geo/projection';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import type { AreaCut } from '../data/sources/areaFile';
import { AreaReadProblem, readAreaValues } from '../data/sources/areaValues';
import { pickColumn, profileOf, providersFor, type AreaLayer, type AreaProfile, type AreaProvider } from '../data/sources/areaProviders';
import { AreaIndex, areasFor, classBreaks, shareBelow, type Areas } from '../data/match/areas';
import { AREA_NONE, AreaDisplay } from '../data/display/areas';

export interface AreaHost {
  viewer: Viewer;
  model(): CityModel | null;
  /** open a place with this layer on */
  open(center: LngLat, size: number, label: string): void;
  /** the share link and the description should follow */
  changed(): void;
  /** turn this layer on */
  select(): void;
  /** where the hosted examples are (the app's root) */
  root: string;
  accent: string;
  /** the pin, metres E, N from the centre */
  pin(): [number, number] | null;
  say(message: string, ms?: number): void;
}

/** The examples we host: Freiburg's rents (2022 census) and central Amsterdam's incomes (CBS). */
export const AREA_DEMOS: Record<AreaLayer, { center: LngLat; size: number; file: string }> = {
  homes: { center: { lat: 47.99555, lon: 7.85065 }, size: 2000, file: 'areas/freiburg-rent-2022.csv' },
  income: { center: { lat: 52.3702, lon: 4.8952 }, size: 2000, file: 'areas/amsterdam-income-cbs.geojson' },
};

/** A file whose areas all lie within this (km, corner to corner) is a city's: offer to go there. */
const GO_THERE_KM = 80;

type Status = 'empty' | 'reading' | 'ready' | 'outside' | 'error';

/** The values shown: a file the user picked, a provider's download, or an example. */
interface Source {
  blob: Blob;
  name: string;
  demo: boolean;
  provider: AreaProvider | null;
  /** a provider's download is for one square: which ("lat|lon|size") */
  square: string;
}

const squareKey = (c: LngLat, size: number) => `${c.lat.toFixed(5)}|${c.lon.toFixed(5)}|${size}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(e, rest);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...kids);
  return e;
}

export class AreaController {
  on = false;
  private status: Status = 'empty';
  private problem = '';
  private problemDetail = '';
  private source: Source | null = null;
  private last: { model: CityModel; center: LngLat } | null = null;
  /** a place was asked for (the example's): wait for it */
  private opening = false;
  private cut: AreaCut | null = null;
  private key = '';
  private abort: AbortController | null = null;
  private progress = 0;
  private downloading = false;
  /** the column picked, by name, kept for the next square */
  private columnName: string | null = null;
  private column = 0;
  private areas: Areas | null = null;
  private values: number[] = [];
  private breaks: number[] = [];
  private display: { model: CityModel; overlay: AreaDisplay } | null = null;
  private readonly root: HTMLElement;
  private readonly ui: {
    empty: HTMLElement;
    providers: HTMLUListElement;
    none: HTMLElement;
    status: HTMLElement;
    progress: HTMLProgressElement;
    go: HTMLButtonElement;
    loaded: HTMLElement;
    columnRow: HTMLElement;
    select: HTMLSelectElement;
    measure: HTMLElement;
    legend: HTMLUListElement;
    pin: HTMLElement;
    note: HTMLElement;
    credit: HTMLElement;
    input: HTMLInputElement;
  };

  constructor(
    readonly layer: AreaLayer,
    private readonly host: AreaHost,
  ) {
    this.root = document.getElementById(`${layer}-control`)!;
    this.ui = this.build();
    this.syncPanel();
  }

  /** Show or hide the layer. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.root.hidden = !on;
    if (!on) {
      this.abort?.abort();
      this.abort = null;
      if (this.status === 'reading') this.status = this.source ? 'empty' : this.status;
      this.key = '';
      this.detach();
      this.host.viewer.requestRender();
      return;
    }
    this.refresh();
  }

  /** A new model (a new place or size). */
  attach(model: CityModel, center: LngLat): void {
    this.last = { model, center };
    this.opening = false;
    this.renderProviders();
    if (this.on) this.refresh();
  }

  /** Whether values colour the model now. */
  get shown(): boolean {
    return this.on && this.status === 'ready' && !!this.display;
  }

  /** Who to credit for the values shown, for posters; null for none, or the user's own file. */
  credit(): string | null {
    if (!this.shown) return null;
    const p = this.profile();
    if (p) return p.credit.licence ? `${p.credit.text} (${p.credit.licence})` : p.credit.text;
    return null;
  }

  pickFile(): void {
    this.ui.input.click();
  }

  /** Show a file of values (the user's, a provider's download or an example). */
  loadFile(file: Blob, opts: { name?: string; demo?: boolean; provider?: AreaProvider | null; square?: string } = {}): void {
    this.source = { blob: file, name: opts.name ?? (file instanceof File ? file.name : ''), demo: !!opts.demo, provider: opts.provider ?? null, square: opts.square ?? '' };
    this.cut = null;
    this.key = '';
    this.columnName = null;
    this.detach();
    if (!this.on) this.host.select();
    else this.refresh();
  }

  /** The example for this layer: open its place with it. */
  async loadDemo(): Promise<void> {
    const demo = AREA_DEMOS[this.layer];
    this.abort?.abort();
    this.abort = null;
    this.status = 'reading';
    this.downloading = true;
    this.problem = '';
    this.syncPanel();
    try {
      const res = await fetch(this.host.root + demo.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      this.downloading = false;
      const c = this.last?.center;
      const model = this.host.model();
      const there = !!c && !!model && this.last?.model === model && Math.abs(c.lat - demo.center.lat) < 0.02 && Math.abs(c.lon - demo.center.lon) < 0.03;
      if (!there) this.opening = true;
      this.loadFile(blob, { demo: true, name: demo.file.replace(/^.*\//, '') });
      if (!there) this.host.open(demo.center, demo.size, t.areaDemoPlace[this.layer]);
    } catch (err) {
      console.warn('Example values could not be loaded', err);
      this.downloading = false;
      this.fail('demo');
    }
  }

  /** A provider's values for the square shown, downloaded straight into the browser. */
  async loadProvider(p: AreaProvider): Promise<void> {
    const last = this.last;
    if (!p.load || !last) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.status = 'reading';
    this.downloading = true;
    this.problem = '';
    this.detach();
    this.syncPanel();
    try {
      const res = await fetch(p.load(squareBBox(last.center, last.model.sizeM, 100)), { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (this.abort !== ac) return;
      this.abort = null;
      this.downloading = false;
      this.loadFile(blob, { name: p.name, provider: p, square: squareKey(last.center, last.model.sizeM) });
    } catch (err) {
      if (ac.signal.aborted || this.abort !== ac) return;
      this.abort = null;
      this.downloading = false;
      console.warn('Values could not be downloaded', err);
      this.fail('download');
    }
  }

  /** Take the values off. */
  remove(): void {
    this.abort?.abort();
    this.abort = null;
    this.source = null;
    this.cut = null;
    this.key = '';
    this.status = 'empty';
    this.problem = '';
    this.detach();
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  /** The pin moved: say what it stands in. */
  pinMoved(): void {
    const d = this.display;
    if (!d || !this.on) return;
    const pin = this.host.pin();
    const picked = pin ? d.overlay.index.at(pin[0], pin[1]) : -1;
    if (picked !== d.overlay.picked) {
      d.overlay.picked = picked;
      d.model.repaint();
    }
    this.renderPin();
  }

  /** A line for the model's text description, or null. */
  describe(): string | null {
    if (!this.shown || !this.values.length) return null;
    const lo = this.values[0];
    const hi = this.values[this.values.length - 1];
    const at = this.valueAtPin();
    return t.areaDescribe(this.columnLabel(), this.format(lo), this.format(hi), at === null ? null : this.format(at));
  }

  /** What the tests and tools look at. */
  debugInfo(): unknown {
    return {
      layer: this.layer,
      on: this.on,
      status: this.status,
      problem: this.problem,
      source: this.source ? { name: this.source.name, demo: this.source.demo, provider: this.source.provider?.id ?? null } : null,
      geometry: this.cut?.geometry ?? null,
      columns: this.cut?.columns ?? [],
      column: this.cut?.columns[this.column] ?? null,
      areas: this.areas?.shapes.length ?? 0,
      breaks: this.breaks,
      atPin: this.valueAtPin(),
      tinted: this.display?.model.tinted ?? false,
      providers: this.last ? providersFor(this.layer, this.last.center.lat, this.last.center.lon).map((p) => p.id) : [],
    };
  }

  // ------------------------------------------------------------------ reading

  private refresh(): void {
    if (!this.on) return;
    this.renderProviders();
    const src = this.source;
    if (!src) {
      if (this.status !== 'error' && this.status !== 'reading') this.status = 'empty';
      this.detach();
      this.syncPanel();
      return;
    }
    if (this.opening) return;
    const model = this.host.model();
    const last = this.last;
    if (!model || !last || last.model !== model) return;
    // a provider's download is for one square: get this one's
    if (src.provider?.load && src.square !== squareKey(last.center, model.sizeM)) {
      void this.loadProvider(src.provider);
      return;
    }
    const key = `${squareKey(last.center, model.sizeM)}`;
    if (this.cut && this.key === key) {
      if (this.display?.model !== model) this.show(model);
      return;
    }
    this.read(model, last.center, key);
  }

  private read(model: CityModel, center: LngLat, key: string): void {
    const src = this.source!;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.detach();
    this.status = 'reading';
    this.progress = 0;
    this.problem = '';
    this.syncPanel();
    let shown = 0;
    readAreaValues(
      { file: src.blob, name: src.name, center, sizeM: model.sizeM },
      (share) => {
        if (this.abort !== ac) return;
        this.progress = share;
        if (Math.floor(share * 100) !== shown) {
          shown = Math.floor(share * 100);
          this.syncPanel();
        }
      },
      ac.signal,
    ).then(
      (cut) => {
        if (this.abort !== ac) return;
        this.abort = null;
        if (this.host.model() !== model) return;
        this.cut = cut;
        this.key = key;
        const named = this.columnName ? cut.columns.indexOf(this.columnName) : -1;
        this.column = named >= 0 ? named : pickColumn(cut.columns, this.layer);
        this.show(model);
      },
      (err) => {
        if (ac.signal.aborted || this.abort !== ac) return;
        this.abort = null;
        if (err instanceof AreaReadProblem && err.kind === 'outside') {
          this.cut = null;
          this.status = 'outside';
          this.syncPanel();
          this.host.changed();
          return;
        }
        this.fail(err instanceof AreaReadProblem ? err.kind : 'unreadable', err instanceof AreaReadProblem ? err.detail : '');
      },
    );
  }

  private fail(kind: string, detail = ''): void {
    // a file that can't be read is let go: a new place won't try it again
    this.source = null;
    this.cut = null;
    this.key = '';
    this.status = 'error';
    this.problem = kind;
    this.problemDetail = detail;
    this.detach();
    this.syncPanel();
    this.host.changed();
  }

  /** Put the values on the model. */
  private show(model: CityModel): void {
    this.detach(false);
    const cut = this.cut!;
    const areas = areasFor(cut, this.column);
    this.areas = areas;
    const h = model.sizeM / 2;
    // the classes split the areas in the square (not those just over its edge)
    this.values = areas.shapes.filter((s) => s.e1 >= -h && s.e0 <= h && s.n1 >= -h && s.n0 <= h).map((s) => s.value).sort((a, b) => a - b);
    if (!this.values.length) {
      this.status = 'outside';
      this.syncPanel();
      this.host.changed();
      return;
    }
    this.breaks = classBreaks(this.values);
    const overlay = new AreaDisplay(areas, new AreaIndex(areas.shapes, model.sizeM), this.breaks, this.host.accent);
    this.display = { model, overlay };
    model.addOverlay(overlay);
    model.setBuildingTint(overlay.colourAt);
    this.status = 'ready';
    this.pinMoved();
    this.syncPanel();
    this.host.changed();
    this.host.viewer.requestRender();
  }

  private detach(repaint = true): void {
    const d = this.display;
    if (!d) return;
    this.display = null;
    d.model.setBuildingTint(null);
    d.model.removeOverlay(d.overlay, repaint);
  }

  // ------------------------------------------------------------------ words and numbers

  private profile(): AreaProfile | null {
    const col = this.cut?.columns[this.column];
    return col ? profileOf(col) : null;
  }

  private columnLabel(k = this.column): string {
    const col = this.cut?.columns[k] ?? '';
    const p = profileOf(col);
    if (p) return t.areaMeasures[p.measure];
    return this.cut?.titles[col] ?? col;
  }

  /** A value as the profile says (€, $, thousands), else as a plain number. */
  private format(v: number): string {
    const p = this.profile();
    if (p) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: p.currency, minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals }).format(v * p.scale);
    }
    const a = Math.abs(v);
    return num(v, a > 0 && a < 10 && !Number.isInteger(v) ? 2 : a < 100 && !Number.isInteger(v) ? 1 : 0);
  }

  private valueAtPin(): number | null {
    const d = this.display?.overlay;
    const s = d && d.picked >= 0 ? d.areas.shapes[d.picked] : null;
    return s ? s.value : null;
  }

  // ------------------------------------------------------------------ the panel

  private build(): AreaController['ui'] {
    const layer = this.layer;
    const input = el('input', { type: 'file', accept: '.csv,.txt,.tsv,.geojson,.json,.zip', hidden: true });
    const providers = el('ul', { className: 'feed-list area-providers' });
    providers.setAttribute('aria-label', t.areaProvidersHere);
    const none = el('p', { className: 'route-note', hidden: true });
    const load = el('button', { type: 'button', className: 'btn btn-wide', textContent: t.areaLoad, dataset: { act: 'load' } });
    const demo = el('button', { type: 'button', className: 'btn btn-wide', textContent: t.areaTry[layer], dataset: { act: 'demo' } });
    const empty = el(
      'div',
      { className: 'area-empty' },
      el('p', { className: 'route-note area-intro', textContent: t.areaIntro[layer] }),
      el('p', { className: 'area-sub', textContent: t.areaProvidersHere }),
      providers,
      none,
      load,
      demo,
      el('p', { className: 'route-note', textContent: `${t.areaFileNote} ${t.routeLocal}` }),
    );
    const status = el('p', { className: 'traffic-status', hidden: true });
    status.setAttribute('role', 'status');
    const progress = el('progress', { className: 'transit-progress', max: 1, value: 0, hidden: true });
    const go = el('button', { type: 'button', className: 'btn', hidden: true, textContent: t.areaGoThere, dataset: { act: 'go' } });
    const select = el('select', { className: 'area-select', id: `${layer}-column` });
    const columnRow = el('div', { className: 'control-label area-column' }, el('label', { htmlFor: `${layer}-column`, textContent: t.areaShowing }), select);
    const measure = el('p', { className: 'area-measure' });
    const legend = el('ul', { className: 'area-legend' });
    legend.setAttribute('aria-label', t.areaLegend);
    const pin = el('p', { className: 'area-pin' });
    pin.setAttribute('role', 'status');
    const note = el('p', { className: 'route-note' });
    const credit = el('p', { className: 'route-note traffic-credit' });
    const loaded = el(
      'div',
      { className: 'area-loaded', hidden: true },
      columnRow,
      measure,
      legend,
      pin,
      note,
      credit,
      el(
        'div',
        { className: 'traffic-actions' },
        el('button', { type: 'button', className: 'btn', textContent: t.areaAnother, dataset: { act: 'another' } }),
        el('button', { type: 'button', className: 'btn', textContent: t.areaRemove, dataset: { act: 'remove' } }),
      ),
    );
    this.root.append(empty, status, progress, el('div', { className: 'traffic-actions' }, go), loaded, input);

    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'load' || act === 'another') this.pickFile();
      else if (act === 'demo') void this.loadDemo();
      else if (act === 'remove') this.remove();
      else if (act === 'go') this.goThere();
      else if (act === 'provider') {
        const p = providersFor(layer, this.last?.center.lat ?? NaN, this.last?.center.lon ?? NaN).find((x) => x.id === b.dataset.id);
        if (p) void this.loadProvider(p);
      }
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) this.loadFile(file);
    });
    select.addEventListener('change', () => {
      const k = Number(select.value);
      if (!this.cut || !Number.isFinite(k)) return;
      this.column = k;
      this.columnName = this.cut.columns[k];
      const model = this.host.model();
      if (model) this.show(model);
    });
    // a file dropped while this layer is on is its values (before the timetable's handler sees a ZIP)
    window.addEventListener(
      'drop',
      (e) => {
        const file = e.dataTransfer?.files[0];
        if (!this.on || !file || !/\.(csv|txt|tsv|geojson|json|zip)$/i.test(file.name)) return;
        e.preventDefault();
        e.stopPropagation();
        this.loadFile(file);
      },
      { capture: true },
    );
    return { empty, providers, none, status, progress, go, loaded, columnRow, select, measure, legend, pin, note, credit, input };
  }

  /** Where the file has data, when it's a city's: open a square there. */
  private goThere(): void {
    const x = this.cut?.extent;
    if (!x) return;
    this.opening = true;
    this.host.open({ lat: (x.south + x.north) / 2, lon: (x.west + x.east) / 2 }, this.last?.model.sizeM ?? 2000, this.source?.name || t.dataLayers[this.layer]);
  }

  private renderProviders(): void {
    const c = this.last?.center;
    const list = c ? providersFor(this.layer, c.lat, c.lon) : [];
    const ul = this.ui.providers;
    ul.replaceChildren(
      ...list.map((p) => {
        const what = el('span', { className: 'route-note', textContent: t.areaProviderInfo[p.info] });
        const action = p.load
          ? el('button', { type: 'button', className: 'btn btn-small', textContent: t.areaLoadHere, dataset: { act: 'provider', id: p.id } })
          : el('a', { className: 'btn btn-small', href: p.link ?? '#', target: '_blank', rel: 'noopener', textContent: p.size ? t.areaDownload(p.size) : t.areaOpenSite });
        return el('li', { className: 'area-provider' }, el('div', {}, el('strong', { textContent: p.name }), ' ', what), action);
      }),
    );
    ul.hidden = !list.length;
    this.ui.none.hidden = !!list.length;
    this.ui.none.textContent = t.areaNoProvider[this.layer];
  }

  private renderColumns(): void {
    const cut = this.cut;
    const sel = this.ui.select;
    if (!cut) return;
    // the measures we know first (this layer's, then the other's), then the file's other columns
    const known = cut.columns.map((c) => profileOf(c));
    const order = (k: number) => (known[k]?.layer === this.layer ? 0 : known[k] ? 1 : 2);
    const ks = cut.columns.map((_, k) => k).sort((a, b) => order(a) - order(b) || a - b);
    const option = (k: number) => el('option', { value: String(k), textContent: this.columnLabel(k), selected: k === this.column });
    const first = ks.filter((k) => order(k) < 2);
    const rest = ks.filter((k) => order(k) === 2);
    const group = el('optgroup');
    group.label = t.areaOtherColumns;
    group.append(...rest.map(option));
    sel.replaceChildren(...first.map(option), ...(rest.length && first.length ? [group] : rest.map(option)));
    this.ui.columnRow.hidden = cut.columns.length < 2;
  }

  private renderLegend(): void {
    const d = this.display?.overlay;
    const ul = this.ui.legend;
    if (!d) return ul.replaceChildren();
    const b = this.breaks;
    const rows: { colour: string; text: string }[] = [];
    if (!b.length) rows.push({ colour: d.cssColour(this.values[0]), text: this.format(this.values[0]) });
    else {
      rows.push({ colour: d.cssColour(b[0] - 1e-9 * Math.abs(b[0] || 1)), text: t.areaUnder(this.format(b[0])) });
      for (let k = 1; k < b.length; k++) rows.push({ colour: d.cssColour(b[k - 1]), text: `${this.format(b[k - 1])} – ${this.format(b[k])}` });
      rows.push({ colour: d.cssColour(b[b.length - 1]), text: t.areaAndMore(this.format(b[b.length - 1])) });
    }
    // highest first, as on a map key
    rows.reverse();
    rows.push({ colour: AREA_NONE, text: t.areaNone });
    ul.replaceChildren(
      ...rows.map((r) => {
        const sw = el('i', { className: 'area-swatch' });
        sw.style.background = r.colour;
        sw.setAttribute('aria-hidden', 'true');
        return el('li', {}, sw, r.text);
      }),
    );
  }

  private renderPin(): void {
    const p = this.ui.pin;
    const d = this.display?.overlay;
    if (!d) return void (p.textContent = '');
    const s = d.picked >= 0 ? d.areas.shapes[d.picked] : null;
    if (!s) {
      p.textContent = t.areaPinNone;
      return;
    }
    const share = shareBelow(s.value, this.values);
    const parts = [`${t.areaAtPin}: ${this.format(s.value)}`];
    if (s.name) parts[0] += ` (${s.name})`;
    if (this.values.length > 4 && Number.isFinite(share)) parts.push(t.areaHigherThan(`${Math.round(share * 100)} %`));
    if (s.uncertain) parts.push(t.areaUncertain);
    if (this.areas?.geometry === 'points') parts.push(t.areaPointsCount(num(s.count)));
    p.textContent = parts.join(' · ');
  }

  private syncPanel(): void {
    const ui = this.ui;
    const st = this.status;
    ui.empty.hidden = st !== 'empty' && st !== 'error';
    ui.loaded.hidden = st !== 'ready';
    ui.progress.hidden = st !== 'reading' || this.downloading;
    ui.progress.value = this.progress;
    ui.go.hidden = true;
    let msg = '';
    if (st === 'reading') msg = this.downloading ? t.areaDownloading : t.areaReading(`${num(Math.round(this.progress * 100))} %`);
    else if (st === 'error') msg = (t.areaProblems[this.problem] ?? t.areaProblems.unreadable) + (this.problem === 'projection' && this.problemDetail ? ` (${this.problemDetail})` : '');
    else if (st === 'outside') {
      msg = t.areaOutside;
      const x = this.cut?.extent;
      const km = x ? Math.hypot((x.north - x.south) * 111, (x.east - x.west) * 111 * Math.cos(((x.north + x.south) / 2) * (Math.PI / 180))) : Infinity;
      ui.go.hidden = !(km < GO_THERE_KM);
    }
    ui.status.textContent = msg;
    ui.status.hidden = !msg;
    if (st === 'outside') {
      // let the file go from here: load another, or remove it
      ui.empty.hidden = false;
    }
    if (st !== 'ready') return;
    this.renderColumns();
    this.renderLegend();
    this.renderPin();
    const cut = this.cut!;
    const geometry = this.areas?.geometry ?? cut.geometry;
    const per = geometry === 'cells' ? t.areaPerSquare(num(cut.cellM)) : geometry === 'points' ? t.areaPerPoints(num(this.areas?.cellM ?? 100)) : t.areaPerArea(num(this.values.length));
    // with one column there's no picker: say what the colours are here
    ui.measure.textContent = cut.columns.length < 2 ? `${this.columnLabel()}. ${per}` : per;
    const notes = [t.areaNote];
    if (cut.features.some((f) => f.uncertain)) notes.push(t.areaUncertainNote);
    ui.note.textContent = notes.join(' ');
    const p = this.profile();
    const src = this.source;
    ui.credit.textContent = p ? `${t.areaSource}: ${p.credit.text}${p.credit.licence ? ` (${p.credit.licence})` : ''}.` : src?.name ? t.areaOwnFile(src.name) : '';
  }
}
