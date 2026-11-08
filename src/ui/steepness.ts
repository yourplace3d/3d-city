/**
 * The "Steepness" map layer: roads and paths coloured by how steep they are, with a legend.
 * Works anywhere, from the terrain and roads the model already has; nothing new is fetched.
 * With a route loaded only the route is coloured (RouteController does that), so the coloured
 * streets don't compete with it; without one, all roads are, for planning.
 */

import { num, t } from '../i18n';
import type { CityModel } from '../scene/cityModel';
import type { Viewer } from '../scene/viewer';
import { STEEP_BOUNDS, steepRoads } from '../data/match/slope';
import { STEEP_COLOURS, SteepnessDisplay } from '../data/display/steepness';

export interface SteepHost {
  viewer: Viewer;
  model(): CityModel | null;
  /** a route is loaded: it carries the colours instead of the roads */
  routeActive(): boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "3–6 %" … "15 %+" in the visitor's language */
export function steepLabels(): string[] {
  const pct = (g: number) => num(g * 100);
  return STEEP_BOUNDS.map((lo, i) => (i < STEEP_BOUNDS.length - 1 ? t.steepRange(pct(lo), pct(STEEP_BOUNDS[i + 1])) : t.steepOver(pct(lo))));
}

export class SteepController {
  on = false;
  private display: { model: CityModel; overlay: SteepnessDisplay; lengths: number[] } | null = null;
  /** whether the last refresh left the roads to a route */
  private routeOnly = false;

  constructor(private readonly host: SteepHost) {
    const scale = $('steep-scale');
    scale.replaceChildren(
      ...steepLabels().map((label, i) => {
        const li = document.createElement('li');
        const sw = document.createElement('i');
        sw.className = 'steep-swatch';
        sw.style.background = STEEP_COLOURS[i];
        li.append(sw, document.createTextNode(label));
        return li;
      }),
    );
  }

  set(on: boolean): void {
    this.on = on;
    $('steep-legend').hidden = !on;
    this.refresh();
  }

  /** Refresh when a route came or went (the roads give their colours to it, or take them back). */
  sync(): void {
    if (this.host.routeActive() !== this.routeOnly) this.refresh();
  }

  /** Colour the roads of the current model again (its roads arrived, or its terrain changed). */
  refresh(): void {
    const model = this.host.model();
    const features = model?.featureSet;
    this.routeOnly = this.host.routeActive();
    $('steep-route-note').hidden = !this.routeOnly;
    const roads = this.on && !!model && !!features && !this.routeOnly;
    if (this.display) {
      // on a model that has been replaced, it went with that model
      if (this.display.model === model) model.removeOverlay(this.display.overlay, !roads);
      this.display = null;
    }
    if (roads && model && features) {
      const { pieces, lengths } = steepRoads(features.lines, (e, n) => model.elevationAt(e, n));
      const overlay = new SteepnessDisplay(pieces);
      model.addOverlay(overlay);
      this.display = { model, overlay, lengths };
    }
    this.host.viewer.requestRender();
  }

  /** A sentence for the model's description, or null when the layer is off. */
  describe(): string | null {
    const d = this.display;
    if (!this.on || !d || d.model !== this.host.model()) return null;
    const km = (m: number) => num(m / 1000, 1);
    const over6 = d.lengths[2] + d.lengths[3] + d.lengths[4];
    const over10 = d.lengths[3] + d.lengths[4];
    return t.steepSummary(km(over6), km(over10));
  }

  debugInfo(): unknown {
    const d = this.display;
    return { on: this.on, routeOnly: this.routeOnly, shown: !!d && d.model === this.host.model(), pieces: d?.overlay.pieces.length ?? 0, lengths: d?.lengths.map(Math.round) ?? [] };
  }
}
