/**
 * Display: a route on the model. The line is painted into the ground texture, so it stays glued
 * to the terrain at any exaggeration and costs no triangles; start, finish and km markers are
 * labels that keep their size on screen; the replay runner is a small ball on the ground.
 */

import { Color, Group, Mesh, MeshStandardMaterial, SphereGeometry, type Sprite } from 'three';
import type { ModelOverlay, ModelSurface, Pt } from '../types';
import type { ClassPiece } from '../match/slope';
import { STEEP_COLOURS } from './steepness';
import { CASING, INK, makeLabel } from './label';

export interface RouteMark {
  at: Pt;
  label: string;
  kind: 'start' | 'finish' | 'km' | 'climb';
  /** a climb label's background: its steepness colour */
  colour?: string;
}

export interface RouteView {
  /** the whole route, as far as it is in the square: drawn faint */
  rest: Pt[];
  /** the stretch the user picked */
  stretch: Pt[];
  /** the stretch cut by steepness, when the steepness layer is on: drawn in its colours */
  steep?: ClassPiece[];
  marks: RouteMark[];
}

/** The route's line where it's flat, when it shows steepness (the accent would read as a steepness colour). */
const ROUTE_INK = '#3d3832';


export class RouteDisplay implements ModelOverlay {
  readonly object = new Group();
  /** over the steepness layer */
  readonly order = 10;
  private readonly labels: Array<{ sprite: Sprite; at: Pt }> = [];
  private readonly runner: Mesh<SphereGeometry, MeshStandardMaterial>;
  private runnerAt: Pt | null = null;
  private surface: ModelSurface | null = null;

  constructor(
    readonly view: RouteView,
    private readonly accent: string,
    readonly sizeM: number,
  ) {
    this.object.name = 'route';
    for (const m of view.marks) {
      const colours =
        m.kind === 'km' ? { bg: CASING, fg: INK, border: accent } : m.kind === 'climb' ? { bg: m.colour ?? accent, fg: '#ffffff', border: CASING } : { bg: accent, fg: '#ffffff', border: CASING };
      const sprite = makeLabel(m.label, colours);
      sprite.name = `route-${m.kind}`;
      // start and finish over climbs over km markers
      sprite.renderOrder = m.kind === 'km' ? 10 : m.kind === 'climb' ? 11 : 12;
      this.labels.push({ sprite, at: m.at });
      this.object.add(sprite);
    }
    const r = sizeM * 0.008;
    const colour = new Color(accent);
    this.runner = new Mesh(new SphereGeometry(r, 24, 16), new MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.35, roughness: 0.45 }));
    this.runner.castShadow = true;
    this.runner.visible = false;
    this.runner.name = 'route-runner';
    this.object.add(this.runner);
  }

  /** Line width on the ground (m): the same share of the square at any size, so it looks the same on screen. */
  static lineWidth(sizeM: number): number {
    return Math.max(3, sizeM * 0.0042);
  }

  paint = (ctx: CanvasRenderingContext2D, sizeM: number): void => {
    const w = RouteDisplay.lineWidth(sizeM);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = w * 0.55;
    stroke(ctx, this.view.rest);
    ctx.globalAlpha = 1;
    const steep = this.view.steep;
    // a light casing keeps the line readable on roads, water and in building shadows; wider when the
    // line takes the steepness colours, so it still stands out from the coloured roads
    ctx.strokeStyle = CASING;
    ctx.lineWidth = w * (steep ? 2.5 : 1.9);
    stroke(ctx, this.view.stretch);
    ctx.strokeStyle = steep ? ROUTE_INK : this.accent;
    ctx.lineWidth = w;
    stroke(ctx, this.view.stretch);
    if (steep) {
      for (const p of steep) {
        if (!p.cls) continue;
        ctx.strokeStyle = STEEP_COLOURS[p.cls - 1];
        stroke(ctx, p.pts);
      }
    }
    for (const m of this.view.marks) {
      ctx.beginPath();
      ctx.arc(m.at[0], m.at[1], w * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'km' ? CASING : m.kind === 'climb' ? (m.colour ?? this.accent) : this.accent;
      ctx.fill();
      ctx.lineWidth = w * 0.55;
      ctx.strokeStyle = m.kind === 'km' ? this.accent : CASING;
      ctx.stroke();
    }
    ctx.restore();
  };

  place(surface: ModelSurface): void {
    this.surface = surface;
    for (const { sprite, at } of this.labels) sprite.position.set(at[0], surface.groundY(at[0], at[1]), -at[1]);
    this.placeRunner();
  }

  /** The replay runner at a point (metres E, N), or hidden. */
  setRunner(at: Pt | null): void {
    this.runnerAt = at;
    this.placeRunner();
  }

  get runnerVisible(): boolean {
    return this.runner.visible;
  }

  private placeRunner(): void {
    const at = this.runnerAt;
    this.runner.visible = !!at && !!this.surface;
    if (!at || !this.surface) return;
    const r = this.runner.geometry.parameters.radius;
    this.runner.position.set(at[0], this.surface.groundY(at[0], at[1]) + r, -at[1]);
  }

  dispose(): void {
    for (const { sprite } of this.labels) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.runner.geometry.dispose();
    this.runner.material.dispose();
  }
}

/**
 * Leave out markers whose labels would overlap: start and finish first, then climbs, then the km markers in
 * order, each at least 14 % of the square from those already placed (labels keep their size on
 * screen, and the whole square fills the view).
 */
export function declutter(marks: RouteMark[], sizeM: number): RouteMark[] {
  const min = sizeM * 0.14;
  const kept: RouteMark[] = [];
  const order = [...marks.filter((m) => m.kind !== 'km'), ...marks.filter((m) => m.kind === 'km')];
  for (const m of order) if (kept.every((k) => Math.hypot(k.at[0] - m.at[0], k.at[1] - m.at[1]) >= min)) kept.push(m);
  return kept;
}

function stroke(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  ctx.stroke();
}
