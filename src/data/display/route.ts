/**
 * Display: a route on the model. The line is painted into the ground texture, so it stays glued
 * to the terrain at any exaggeration and costs no triangles; start, finish and km markers are
 * labels that keep their size on screen; the replay runner is a small ball on the ground.
 */

import { CanvasTexture, Color, Group, LinearFilter, Mesh, MeshStandardMaterial, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, type PerspectiveCamera } from 'three';
import type { ModelOverlay, ModelSurface, Pt } from '../types';

export interface RouteMark {
  at: Pt;
  label: string;
  kind: 'start' | 'finish' | 'km';
}

export interface RouteView {
  /** the whole route, as far as it is in the square: drawn faint */
  rest: Pt[];
  /** the stretch the user picked */
  stretch: Pt[];
  marks: RouteMark[];
}

/** Label height as a share of the view's height (the sprites keep their size on screen). */
const LABEL_SCREEN = 0.026;
const CASING = '#fffdf8';
const INK = '#1e1c19';

export class RouteDisplay implements ModelOverlay {
  readonly object = new Group();
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
      const sprite = makeLabel(m.label, m.kind === 'km' ? { bg: CASING, fg: INK, border: accent } : { bg: accent, fg: '#ffffff', border: CASING });
      sprite.name = `route-${m.kind}`;
      // start and finish over km markers
      sprite.renderOrder = m.kind === 'km' ? 10 : 11;
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
    // a light casing keeps the line readable on roads, water and in building shadows
    ctx.strokeStyle = CASING;
    ctx.lineWidth = w * 1.9;
    stroke(ctx, this.view.stretch);
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = w;
    stroke(ctx, this.view.stretch);
    for (const m of this.view.marks) {
      ctx.beginPath();
      ctx.arc(m.at[0], m.at[1], w * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'km' ? CASING : this.accent;
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
 * Leave out markers whose labels would overlap: start and finish first, then the km markers in
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

/** A rounded label with a small tail; its tip is the sprite's anchor, on the ground. */
function makeLabel(text: string, colours: { bg: string; fg: string; border: string }): Sprite {
  const font = "600 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const padX = 16;
  const boxH = 46;
  const tail = 12;
  const line = 4;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2 + line;
  c.width = w;
  c.height = boxH + tail + line;
  ctx.font = font;
  const x0 = line / 2;
  const y0 = line / 2;
  const bw = w - line;
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + bw, y0, x0 + bw, y0 + boxH, r);
  ctx.arcTo(x0 + bw, y0 + boxH, x0, y0 + boxH, r);
  ctx.lineTo(w / 2 + tail * 0.8, y0 + boxH);
  ctx.lineTo(w / 2, y0 + boxH + tail);
  ctx.lineTo(w / 2 - tail * 0.8, y0 + boxH);
  ctx.arcTo(x0, y0 + boxH, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + bw, y0, r);
  ctx.closePath();
  ctx.fillStyle = colours.bg;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = colours.border;
  ctx.stroke();
  ctx.fillStyle = colours.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, y0 + boxH / 2 + 1);

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  // drawn over everything, like map labels: a marker behind a tower is still readable
  const mat = new SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const sprite = new Sprite(mat);
  sprite.center.set(0.5, 0);
  const aspect = c.width / c.height;
  let fitted = 0;
  // the size is a share of the view's height: on a tall phone screen the model only fills the
  // width, so the labels shrink with it (not all the way, so they stay readable)
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const k = LABEL_SCREEN * Math.min(1, (camera as PerspectiveCamera).aspect || 1) ** 0.6;
    if (k === fitted) return;
    fitted = k;
    sprite.scale.set(k * aspect, k, 1);
    sprite.updateMatrixWorld();
  };
  sprite.scale.set(LABEL_SCREEN * aspect, LABEL_SCREEN, 1);
  return sprite;
}
