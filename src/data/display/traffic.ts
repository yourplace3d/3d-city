/**
 * Display: traffic counts as columns standing on the model, like a bar chart on the map. Each
 * column is a counting point; its height is how many cars (or bikes) passed in the hour shown.
 * One scale for the whole day, so the columns grow and shrink as the day is replayed. A small
 * dot is painted where each column stands, so a quiet point still shows from above.
 *
 * One violet for every column: a hue the map doesn't use (blue is water, green is parks, the
 * steepness colours run yellow to dark red), at 4.6:1 on the ground. The column picked is darker.
 */

import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type Raycaster, type Sprite } from 'three';
import type { ModelOverlay, ModelSurface } from '../types';
import { valueAt, type TrafficDay } from '../match/traffic';
import { CASING, INK, makeLabel } from './label';

export const TRAFFIC_COLOUR = '#6250d6';
/** the column picked, and the hour picked in the chart */
export const TRAFFIC_PICKED = '#3a2d9c';
/** the other hours in the chart: a lighter step of the same violet (2:1 on the chart's paper) */
export const TRAFFIC_MUTED = '#a79ee6';

/** The tallest column, as a share of the square's side. */
const TALLEST = 0.16;

export class TrafficDisplay implements ModelOverlay {
  readonly object = new Group();
  /** over steepness, under a route */
  readonly order = 5;
  readonly mesh: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  private readonly base: number[];
  private surface: ModelSurface | null = null;
  private pos = 0;
  private picked: number | null = null;
  private labels: Array<{ sprite: Sprite; column: number }> = [];
  private readonly width: number;
  private readonly tallest: number;

  constructor(
    readonly day: TrafficDay,
    readonly sizeM: number,
  ) {
    this.object.name = 'traffic';
    this.width = Math.max(8, sizeM * 0.0085);
    this.tallest = sizeM * TALLEST;
    const geo = new BoxGeometry(1, 1, 1);
    // the box stands on its base
    geo.translate(0, 0.5, 0);
    // a little light of its own, so the sides in the shade still read as violet
    const mat = new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(TRAFFIC_COLOUR), emissiveIntensity: 0.3, roughness: 0.6, metalness: 0 });
    this.mesh = new InstancedMesh(geo, mat, Math.max(1, day.columns.length));
    this.mesh.count = day.columns.length;
    this.mesh.name = 'traffic-columns';
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.base = day.columns.map(() => 0);
    this.paintColours();
    this.object.add(this.mesh);
  }

  /** a column's height (m) for a count */
  heightOf(v: number): number {
    return this.day.max > 0 ? (v / this.day.max) * this.tallest : 0;
  }

  paint = (ctx: CanvasRenderingContext2D): void => {
    const r = this.width * 0.75;
    ctx.save();
    for (const c of this.day.columns) {
      ctx.beginPath();
      ctx.arc(c.at[0], c.at[1], r, 0, Math.PI * 2);
      ctx.fillStyle = TRAFFIC_COLOUR;
      ctx.fill();
      ctx.lineWidth = r * 0.45;
      ctx.strokeStyle = CASING;
      ctx.stroke();
    }
    ctx.restore();
  };

  place(surface: ModelSurface): void {
    this.surface = surface;
    this.day.columns.forEach((c, i) => (this.base[i] = surface.groundY(c.at[0], c.at[1])));
    this.update();
  }

  /** The moment shown: 0 … 23, between hours while replaying. */
  setTime(pos: number): void {
    this.pos = pos;
    this.update();
  }

  /** Mark one column (or none). */
  pick(i: number | null): void {
    this.picked = i;
    this.paintColours();
  }

  /** Labels with counts on top of some columns; none while replaying. */
  setLabels(list: Array<{ column: number; text: string }>): void {
    this.clearLabels();
    for (const { column, text } of list) {
      const picked = column === this.picked;
      const sprite = makeLabel(text, picked ? { bg: TRAFFIC_PICKED, fg: '#ffffff', border: CASING } : { bg: CASING, fg: INK, border: TRAFFIC_COLOUR });
      sprite.name = 'traffic-label';
      sprite.renderOrder = picked ? 9 : 8;
      this.labels.push({ sprite, column });
      this.object.add(sprite);
    }
    this.placeLabels();
  }

  get labelCount(): number {
    return this.labels.length;
  }

  /** The column under a ray, if any. */
  hit(raycaster: Raycaster): number | null {
    const hits = raycaster.intersectObject(this.mesh, false);
    const id = hits[0]?.instanceId;
    return id == null ? null : id;
  }

  /** a column's top, in scene coordinates, for tests */
  topOf(i: number): [number, number, number] {
    const c = this.day.columns[i];
    return [c.at[0], this.base[i] + this.heightOf(valueAt(c.values, this.pos)), -c.at[1]];
  }

  /** a column's foot, in scene coordinates */
  footOf(i: number): [number, number, number] {
    const c = this.day.columns[i];
    return [c.at[0], this.base[i], -c.at[1]];
  }

  /** halfway up a column, in scene coordinates, for tests */
  midOf(i: number): [number, number, number] {
    const [x, y, z] = this.topOf(i);
    return [x, (y + this.base[i]) / 2, z];
  }

  dispose(): void {
    this.clearLabels();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }

  private update(): void {
    if (!this.surface) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    this.day.columns.forEach((c, i) => {
      const h = this.heightOf(valueAt(c.values, this.pos));
      // a column with nothing counted folds away to nothing (the painted dot stays)
      const w = h > 0 ? this.width : 0;
      p.set(c.at[0], this.base[i], -c.at[1]);
      s.set(w, Math.max(h, 0.001), w);
      this.mesh.setMatrixAt(i, m.compose(p, q, s));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.placeLabels();
  }

  private placeLabels(): void {
    for (const { sprite, column } of this.labels) {
      const [x, y, z] = this.topOf(column);
      sprite.position.set(x, y + this.width * 0.4, z);
    }
  }

  private paintColours(): void {
    const normal = new Color(TRAFFIC_COLOUR);
    const picked = new Color(TRAFFIC_PICKED);
    for (let i = 0; i < this.day.columns.length; i++) this.mesh.setColorAt(i, i === this.picked ? picked : normal);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
