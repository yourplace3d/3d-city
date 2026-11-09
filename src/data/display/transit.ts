/**
 * Display: public transport from a timetable. The lines that run on the day are painted on the
 * ground in their mode's colour (rail, U-Bahn and metro, tram, bus, ferry) over a light casing,
 * so they read on streets, parks and water alike; U-Bahn and metro lines are dashed, as most of
 * them run underground. The vehicles are small blocks moving along the lines as the timetable
 * has them, longer for trains than for buses, and see-through for the U-Bahn.
 *
 * Mode colours, checked as a set on the ground: green, blue and red for rail, U-Bahn and tram
 * (the usual colours in many cities), a neutral grey for buses (the most lines, the background),
 * dark yellow for ferries. Every line also has its name on a chip in the panel and on its
 * vehicles, and modes differ in line width, dashes and vehicle length, so colour is never the
 * only cue.
 */

import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type Sprite } from 'three';
import type { ModelOverlay, ModelSurface } from '../types';
import type { TransitMode } from '../sources/gtfs';
import { DAY_S, MODE_ORDER, runAt, type TransitDay, type VehicleAt } from '../match/transit';
import { CASING, INK, makeLabel } from './label';

export const MODE_COLOURS: Record<TransitMode, string> = {
  rail: '#008300',
  subway: '#2a78d6',
  tram: '#e34948',
  bus: '#5f5a55',
  ferry: '#c98500',
  other: '#9a5bd0',
};

/** Line widths for each mode, as a share of the base width. */
const LINE_WIDTH: Record<TransitMode, number> = { rail: 1.3, subway: 1, tram: 1, bus: 0.75, ferry: 0.8, other: 0.8 };
/** Vehicle lengths, as a share of their width. */
const VEHICLE_LENGTH: Record<TransitMode, number> = { rail: 6, subway: 5, tram: 3.5, bus: 2, ferry: 2.6, other: 1.6 };
/** The ground, for lines and vehicles of the lines not picked. */
const GROUND = '#ebe6dc';
/** Lines are drawn this much lighter than their vehicles, so a vehicle stands out on its line. */
const LINE_TINT = 0.3;
/** Vehicles are this much darker than their mode's colour. */
const VEHICLE_SHADE = 0.18;
/** How far lines that aren't picked fade towards the ground. */
const FADE = 0.72;

/** One vehicle on the model now: its run, where it is (m) and its scene position. */
export interface ShownVehicle {
  run: number;
  route: number;
  e: number;
  n: number;
  /** scene x, y (its top), z */
  top: [number, number, number];
}

export class TransitDisplay implements ModelOverlay {
  readonly object = new Group();
  /** over steepness, under a route */
  readonly order = 4;
  /** a vehicle's width and height (m) */
  readonly width: number;
  private readonly height: number;
  private readonly surfaceMesh: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  private readonly underMesh: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  private surface: ModelSurface | null = null;
  private time = 8 * 3600;
  private picked: ReadonlySet<number> | null = null;
  /** the paths that run on the day, and their mode, drawn in this order */
  private readonly drawn: Array<{ path: number; route: number; mode: TransitMode }>;
  private shown: ShownVehicle[] = [];
  private labels: Array<{ sprite: Sprite; run: number }> = [];

  constructor(
    readonly day: TransitDay,
    readonly sizeM: number,
  ) {
    const runs = day.runs;
    this.width = Math.max(6, sizeM * 0.0075);
    this.height = this.width * 0.6;
    // the paths with runs on the day: buses first, so trams and trains are drawn over them
    const seen = new Map<number, number>();
    for (let i = 0; i < day.run.length; i++) {
      const r = day.run[i];
      if (!seen.has(runs.runPath[r])) seen.set(runs.runPath[r], runs.runRoute[r]);
    }
    const drawOrder: TransitMode[] = ['bus', 'other', 'ferry', 'subway', 'tram', 'rail'];
    this.drawn = [...seen].map(([path, route]) => ({ path, route, mode: runs.routes[route].mode }));
    this.drawn.sort((a, b) => drawOrder.indexOf(a.mode) - drawOrder.indexOf(b.mode));

    const cap = Math.max(8, day.most + 8);
    const geo = new BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.surfaceMesh = new InstancedMesh(geo, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }), cap);
    this.underMesh = new InstancedMesh(geo, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, transparent: true, opacity: 0.5, depthWrite: false }), cap);
    this.surfaceMesh.name = 'transit-vehicles';
    this.underMesh.name = 'transit-underground';
    for (const m of [this.surfaceMesh, this.underMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      this.object.add(m);
    }
    this.surfaceMesh.castShadow = true;
  }

  /** The lines, on the ground: a light casing under all of them, then each in its mode's colour. */
  paint = (ctx: CanvasRenderingContext2D, sizeM: number): void => {
    const runs = this.day.runs;
    const base = Math.max(4, sizeM * 0.0035);
    const ground = new Color(GROUND);
    const white = new Color('#ffffff');
    const c = new Color();
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const trace = (path: number) => {
      const { pts } = runs.paths[path];
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
    };
    const isPicked = (route: number) => !this.picked || this.picked.has(route);
    // lines not picked first, so the ones picked lie on top
    const order = [...this.drawn].sort((a, b) => Number(isPicked(a.route)) - Number(isPicked(b.route)));
    for (const pass of ['casing', 'ink'] as const) {
      for (const { path, route, mode } of order) {
        const w = base * LINE_WIDTH[mode];
        const on = isPicked(route);
        if (pass === 'casing') {
          if (!on) continue;
          ctx.setLineDash([]);
          ctx.strokeStyle = CASING;
          ctx.lineWidth = w + base * 0.7;
        } else {
          c.set(MODE_COLOURS[mode]).lerp(white, LINE_TINT);
          if (!on) c.lerp(ground, FADE);
          ctx.strokeStyle = `#${c.getHexString()}`;
          ctx.lineWidth = on ? w : w * 0.7;
          ctx.setLineDash(mode === 'subway' ? [w * 3, w * 1.6] : mode === 'ferry' ? [w * 2, w * 1.4] : []);
        }
        trace(path);
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  place(surface: ModelSurface): void {
    this.surface = surface;
    this.update();
  }

  /** The moment shown, in seconds after midnight of the day. */
  setTime(t: number): void {
    this.time = Math.max(0, Math.min(DAY_S - 1, t));
    this.update();
  }

  /** Show some lines' routes over the rest (the caller repaints the ground), or all of them. */
  pick(routes: ReadonlySet<number> | null): void {
    this.picked = routes && routes.size ? routes : null;
    this.update();
  }

  /** The vehicles on the model now. */
  get vehicles(): readonly ShownVehicle[] {
    return this.shown;
  }

  get labelCount(): number {
    return this.labels.length;
  }

  /** Labels with line names over some vehicles (picked by the caller); none while replaying. */
  setLabels(list: Array<{ run: number; text: string }>): void {
    this.clearLabels();
    const runs = this.day.runs;
    for (const { run, text } of list) {
      const mode = runs.routes[runs.runRoute[run]].mode;
      const sprite = makeLabel(text, { bg: CASING, fg: INK, border: MODE_COLOURS[mode] });
      sprite.name = 'transit-label';
      sprite.renderOrder = 8;
      this.labels.push({ sprite, run });
      this.object.add(sprite);
    }
    this.placeLabels();
  }

  dispose(): void {
    this.clearLabels();
    this.surfaceMesh.geometry.dispose();
    this.surfaceMesh.material.dispose();
    this.underMesh.material.dispose();
    this.surfaceMesh.dispose();
    this.underMesh.dispose();
  }

  private update(): void {
    const surface = this.surface;
    if (!surface) return;
    const day = this.day;
    const runs = day.runs;
    const v: VehicleAt = { e: 0, n: 0, dx: 1, dy: 0 };
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const p = new Vector3();
    const s = new Vector3();
    const c = new Color();
    const ground = new Color(GROUND);
    const black = new Color('#000000');
    let nSurface = 0;
    let nUnder = 0;
    this.shown = [];
    for (let i = 0; i < day.run.length; i++) {
      const r = day.run[i];
      const t = this.time - day.shift[i];
      if (t < runs.tIn[r] - 60 || t > runs.tOut[r] + 60) continue;
      if (!runAt(runs, r, t, v)) continue;
      const route = runs.runRoute[r];
      const mode = runs.routes[route].mode;
      const under = mode === 'subway';
      const mesh = under ? this.underMesh : this.surfaceMesh;
      const k = under ? nUnder : nSurface;
      if (k >= mesh.instanceMatrix.count) continue;
      const y = surface.groundY(v.e, v.n);
      p.set(v.e, y, -v.n);
      // along the line: the box's length (x) turns to the heading (scene x = E, z = −N)
      q.setFromAxisAngle(up, Math.atan2(v.dy, v.dx));
      s.set(this.width * VEHICLE_LENGTH[mode], this.height, this.width);
      mesh.setMatrixAt(k, m.compose(p, q, s));
      c.set(MODE_COLOURS[mode]).lerp(black, VEHICLE_SHADE);
      if (this.picked && !this.picked.has(route)) c.lerp(ground, FADE);
      mesh.setColorAt(k, c);
      if (under) nUnder++;
      else nSurface++;
      this.shown.push({ run: r, route, e: v.e, n: v.n, top: [v.e, y + this.height, -v.n] });
    }
    for (const [mesh, n] of [
      [this.surfaceMesh, nSurface],
      [this.underMesh, nUnder],
    ] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.placeLabels();
  }

  private placeLabels(): void {
    for (const { sprite, run } of this.labels) {
      const v = this.shown.find((x) => x.run === run);
      sprite.visible = !!v;
      if (v) sprite.position.set(v.top[0], v.top[1] + this.height * 0.3, v.top[2]);
    }
  }

  private clearLabels(): void {
    for (const { sprite } of this.labels) {
      this.object.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.labels = [];
  }
}

/** Modes in the order the key lists them, of those on the day. */
export function modesOn(day: TransitDay): TransitMode[] {
  const on = new Set(day.lines.map((l) => l.mode));
  return MODE_ORDER.filter((m) => on.has(m));
}
