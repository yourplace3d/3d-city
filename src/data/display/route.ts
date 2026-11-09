/**
 * Display: a route on the model. The line is painted into the ground texture, so it stays glued
 * to the terrain at any exaggeration and costs no triangles; start, finish and km markers are
 * labels that keep their size on screen; the replay runner is a small ball on the ground.
 *
 * Over a data layer that stands up from the model (traffic streets), the route rides on top of
 * it instead: a ribbon in dark ink with a light casing, as high as what's under it, so it's never
 * buried; its markers and the runner ride along.
 */

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, SphereGeometry, type Sprite } from 'three';
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

/** How high a data layer stands at a point (m above the ground), 0 where it doesn't. */
export type Lift = (e: number, n: number) => number;


export class RouteDisplay implements ModelOverlay {
  readonly object = new Group();
  /** over the steepness layer */
  readonly order = 10;
  private readonly labels: Array<{ sprite: Sprite; at: Pt }> = [];
  private readonly runner: Mesh<SphereGeometry, MeshStandardMaterial>;
  private runnerAt: Pt | null = null;
  private surface: ModelSurface | null = null;
  private lift: Lift | null = null;
  private ribbon: { pts: Pt[]; casing: Mesh<BufferGeometry, MeshStandardMaterial>; ink: Mesh<BufferGeometry, MeshStandardMaterial> } | null = null;

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
    this.placeAll();
  }

  /** Ride on a data layer that stands up from the model (null: back on the ground). */
  setLift(lift: Lift | null): void {
    this.lift = lift;
    if (lift && !this.ribbon && this.view.stretch.length >= 2) this.buildRibbon();
    if (!lift && this.ribbon) this.removeRibbon();
    this.placeAll();
  }

  get lifted(): boolean {
    return !!this.ribbon;
  }

  /** scene y of the route at a point: on the ground, or on what stands there */
  private yAt(e: number, n: number): number {
    return this.surface!.groundY(e, n) + (this.lift?.(e, n) ?? 0);
  }

  private placeAll(): void {
    if (!this.surface) return;
    for (const { sprite, at } of this.labels) sprite.position.set(at[0], this.yAt(at[0], at[1]), -at[1]);
    this.placeRibbon();
    this.placeRunner();
  }

  /** The stretch as two flat ribbons, the light casing under the ink, every few metres. */
  private buildRibbon(): void {
    const step = Math.max(3, this.sizeM * 0.003);
    const pts: Pt[] = [this.view.stretch[0]];
    for (let k = 1; k < this.view.stretch.length; k++) {
      const [x0, y0] = this.view.stretch[k - 1];
      const [x1, y1] = this.view.stretch[k];
      const parts = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let j = 1; j <= parts; j++) pts.push([x0 + ((x1 - x0) * j) / parts, y0 + ((y1 - y0) * j) / parts]);
    }
    const make = (colour: string, offset: number) => {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(pts.length * 6), 3));
      const normals = new Float32Array(pts.length * 6);
      for (let k = 0; k < pts.length * 2; k++) normals[k * 3 + 1] = 1;
      geo.setAttribute('normal', new BufferAttribute(normals, 3));
      const index: number[] = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = k * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      geo.setIndex(index);
      // drawn over what it lies on without lifting it off: the ink over the casing over the street
      const mat = new MeshStandardMaterial({ color: new Color(colour), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      return mesh;
    };
    const casing = make(CASING, -4);
    casing.name = 'route-ribbon-casing';
    casing.renderOrder = 1;
    const ink = make(ROUTE_INK, -8);
    ink.name = 'route-ribbon';
    ink.renderOrder = 2;
    this.ribbon = { pts, casing, ink };
    this.object.add(casing, ink);
  }

  private placeRibbon(): void {
    const r = this.ribbon;
    if (!r || !this.surface) return;
    const w = RouteDisplay.lineWidth(this.sizeM);
    const pts = r.pts;
    const ys = pts.map(([e, n]) => this.yAt(e, n) + w * 0.15);
    for (const [mesh, half] of [
      [r.casing, w * 1.1],
      [r.ink, w * 0.5],
    ] as const) {
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      pts.forEach(([e, n], k) => {
        const p = pts[Math.max(0, k - 1)];
        const q = pts[Math.min(pts.length - 1, k + 1)];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        const nx = -(q[1] - p[1]) / len;
        const ny = (q[0] - p[0]) / len;
        pos.setXYZ(k * 2, e + nx * half, ys[k], -(n + ny * half));
        pos.setXYZ(k * 2 + 1, e - nx * half, ys[k], -(n - ny * half));
      });
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    }
  }

  private removeRibbon(): void {
    const r = this.ribbon;
    if (!r) return;
    for (const m of [r.casing, r.ink]) {
      this.object.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.ribbon = null;
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
    this.runner.position.set(at[0], this.yAt(at[0], at[1]) + r, -at[1]);
  }

  dispose(): void {
    this.removeRibbon();
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
