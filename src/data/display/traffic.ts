/**
 * Display: traffic streets. The streets near counting points stand up from the model and turn
 * red, higher and darker the more traffic the spread counts add up to there (match/trafficStreets);
 * where nothing reaches they lie flat as the map's roads. One scale for the whole day, so the
 * streets rise and fall as the day is replayed. The heights are the 3D print's, at 15 cm: a
 * gentle relief, no spikes, so what you see is what prints.
 *
 * The counting points themselves, the only places actually counted, are small white discs with
 * a dark rim on top of the streets; tap one to see its day. Labels give the counts.
 *
 * The reds run from a light red (2.2:1 on the ground) to a very dark red, in even steps of
 * lightness, so the order reads without colour vision and in black and white. They're only
 * shown with no other data layer, so they don't meet steepness's reds; a route on top is drawn
 * in dark ink instead of its usual red.
 */

import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Raycaster, type Sprite } from 'three';
import type { ModelOverlay, ModelSurface } from '../types';
import type { TrafficDay } from '../match/traffic';
import { columnValues, streetValues, type TrafficStreets } from '../match/trafficStreets';
import { CASING, INK, makeLabel } from './label';

/** Little traffic → a lot, light red → very dark red (checked: one hue, even steps, the lightest clears the ground). */
export const TRAFFIC_RAMP = ['#ec7e68', '#dc523e', '#c02c27', '#911920', '#5a0c14'] as const;
/** the map's roads, where a street has faded out to nothing */
const ROAD = '#fbf9f5';
/** Below this share of the top, a street fades from the lightest red to the road's white. */
const FADE_IN = 0.06;

/** The 3D print's traffic streets (mm): how high above the ground at nothing and at the most, and their least width. */
export const TRAFFIC_PRINT_MM = { low: 0.5, high: 2, width: 0.8 } as const;
/** …and the print they are shown at on screen (mm). */
const SHOWN_AT_MM = 150;
/** A counting point's disc: how thick, for its radius. */
const DISC = 0.35;

/** The colour at a share of the top (0 … 1). */
export function trafficColour(q: number, out = new Color()): Color {
  if (!(q > 0)) return out.set(ROAD);
  if (q < FADE_IN) return out.set(ROAD).lerp(tmp.set(TRAFFIC_RAMP[0]), q / FADE_IN);
  const x = ((Math.min(q, 1) - FADE_IN) / (1 - FADE_IN)) * (TRAFFIC_RAMP.length - 1);
  const i = Math.min(TRAFFIC_RAMP.length - 2, Math.floor(x));
  return out.set(TRAFFIC_RAMP[i]).lerp(tmp.set(TRAFFIC_RAMP[i + 1]), x - i);
}
const tmp = new Color();

/** How far a street stands above the ground in the print (mm), at a share of the top. */
export function printRaiseMm(q: number): number {
  return TRAFFIC_PRINT_MM.low + (TRAFFIC_PRINT_MM.high - TRAFFIC_PRINT_MM.low) * Math.max(0, Math.min(1, q));
}

export class TrafficDisplay implements ModelOverlay {
  readonly object = new Group();
  /** over steepness, under a route */
  readonly order = 5;
  readonly streets: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly markers: InstancedMesh<CylinderGeometry, MeshStandardMaterial>;
  private readonly cores: InstancedMesh<CylinderGeometry, MeshStandardMaterial>;
  /** per street vertex: its sample, its point (m) and its ground (scene y) */
  private readonly vSample: Uint32Array;
  private readonly vAt: Float32Array;
  private readonly vGround: Float32Array;
  /** 1 for a vertex on a street's top or the top of its sides, 0 at the bottom of a side */
  private readonly vTop: Uint8Array;
  private readonly values: Float32Array;
  private readonly markerBase: Float32Array;
  private surface: ModelSurface | null = null;
  private pos = 0;
  private picked: number | null = null;
  private labels: Array<{ sprite: Sprite; column: number }> = [];
  /** the most a street rises (m), and a hair it always stands up so it doesn't flicker into the ground */
  private readonly tallest: number;
  private readonly lift: number;
  private readonly markerR: number;
  private readonly minWidth: number;
  /** the streets' stretches between samples, by 50 m cell, for liftAt */
  private segIndex: Map<string, Array<[number, number, number]>> | null = null;

  constructor(
    readonly day: TrafficDay,
    readonly data: TrafficStreets,
    readonly sizeM: number,
  ) {
    this.object.name = 'traffic';
    const mmPerM = SHOWN_AT_MM / sizeM;
    this.tallest = (TRAFFIC_PRINT_MM.high - TRAFFIC_PRINT_MM.low) / mmPerM;
    this.lift = sizeM * 0.0004;
    const minWidth = TRAFFIC_PRINT_MM.width / mmPerM;
    this.minWidth = minWidth;
    this.values = new Float32Array(data.width.length);
    this.markerBase = new Float32Array(day.columns.length);

    // each sample: a cross-section of six vertices: the top's two edges, and each side's top and bottom
    const verts: number[] = [];
    const normals: number[] = [];
    const sample: number[] = [];
    const top: number[] = [];
    const index: number[] = [];
    const at = data.at;
    const push = (k: number, x: number, y: number, nx: number, ny: number, nz: number, isTop: boolean): number => {
      verts.push(x, y);
      normals.push(nx, ny, nz);
      sample.push(k);
      top.push(isTop ? 1 : 0);
      return sample.length - 1;
    };
    for (const run of data.runs) {
      const first = verts.length / 2;
      const ends: Array<{ k: number; l: [number, number]; r: [number, number]; t: [number, number]; start: boolean }> = [];
      for (let j = 0; j < run.count; j++) {
        const k = run.start + j;
        const p = Math.max(run.start, k - 1);
        const q = Math.min(run.start + run.count - 1, k + 1);
        let tx = at[2 * q] - at[2 * p];
        let ty = at[2 * q + 1] - at[2 * p + 1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const hw = Math.max(data.width[k], minWidth) / 2;
        // the ends run on half a width, so streets meeting at a crossing close up
        const along = j === 0 ? -hw : j === run.count - 1 ? hw : 0;
        const cx = at[2 * k] + tx * along;
        const cy = at[2 * k + 1] + ty * along;
        // left (west of north) and right of the street's direction
        const lx = cx - ty * hw;
        const ly = cy + tx * hw;
        const rx = cx + ty * hw;
        const ry = cy - tx * hw;
        // scene normals: x east, y up, z south
        push(k, lx, ly, 0, 1, 0, true);
        push(k, rx, ry, 0, 1, 0, true);
        push(k, lx, ly, -ty, 0, -tx, true);
        push(k, lx, ly, -ty, 0, -tx, false);
        push(k, rx, ry, ty, 0, tx, true);
        push(k, rx, ry, ty, 0, tx, false);
        if (j === 0 || j === run.count - 1) ends.push({ k, l: [lx, ly], r: [rx, ry], t: [tx, ty], start: j === 0 });
      }
      for (let j = 0; j < run.count - 1; j++) {
        const a = first + j * 6;
        const b = a + 6;
        // top, left side, right side: anticlockwise seen from outside
        index.push(a, a + 1, b, a + 1, b + 1, b);
        index.push(a + 2, b + 2, a + 3, b + 2, b + 3, a + 3);
        index.push(a + 4, a + 5, b + 4, b + 4, a + 5, b + 5);
      }
      // the ends, closed
      for (const { k, l, r, t, start } of ends) {
        const s = start ? -1 : 1;
        const [nx, nz] = [s * t[0], -s * t[1]];
        const lt = push(k, l[0], l[1], nx, 0, nz, true);
        const lb = push(k, l[0], l[1], nx, 0, nz, false);
        const rt = push(k, r[0], r[1], nx, 0, nz, true);
        const rb = push(k, r[0], r[1], nx, 0, nz, false);
        if (start) index.push(lt, lb, rt, rt, lb, rb);
        else index.push(lt, rt, lb, rt, rb, lb);
      }
    }
    const n = verts.length / 2;
    this.vSample = Uint32Array.from(sample);
    this.vAt = Float32Array.from(verts);
    this.vGround = new Float32Array(n);
    this.vTop = Uint8Array.from(top);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
    geo.setIndex(index);
    this.streets = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 }));
    this.streets.name = 'traffic-streets';
    this.streets.castShadow = true;
    this.streets.receiveShadow = true;
    this.streets.frustumCulled = false;
    this.object.add(this.streets);

    // counting points: a dark rim round a white disc
    this.markerR = Math.max(minWidth * 0.42, 3);
    const count = Math.max(1, day.columns.length);
    this.markers = new InstancedMesh(new CylinderGeometry(1, 1, 1, 20), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), count);
    this.cores = new InstancedMesh(new CylinderGeometry(1, 1, 1, 20), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), count);
    for (const m of [this.markers, this.cores]) {
      m.count = day.columns.length;
      m.frustumCulled = false;
      m.castShadow = true;
      this.object.add(m);
    }
    this.markers.name = 'traffic-points';
    this.paintMarkers();
  }

  place(surface: ModelSurface): void {
    this.surface = surface;
    for (let v = 0; v < this.vGround.length; v++) this.vGround[v] = surface.groundY(this.vAt[2 * v], this.vAt[2 * v + 1]);
    const at = this.data.at;
    this.day.columns.forEach((_, i) => {
      const s = this.data.streetSamples + i;
      this.markerBase[i] = surface.groundY(at[2 * s], at[2 * s + 1]);
    });
    this.update();
  }

  /** The moment shown: 0 … 23, between hours while replaying. */
  setTime(pos: number): void {
    this.pos = pos;
    this.update();
  }

  /** Mark one counting point (or none). */
  pick(i: number | null): void {
    this.picked = i;
    this.paintMarkers();
  }

  /** Labels with counts over some counting points; none while replaying. */
  setLabels(list: Array<{ column: number; text: string }>): void {
    this.clearLabels();
    for (const { column, text } of list) {
      const picked = column === this.picked;
      const sprite = makeLabel(text, picked ? { bg: INK, fg: '#ffffff', border: CASING } : { bg: CASING, fg: INK, border: TRAFFIC_RAMP[3] });
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

  /** How many street samples are shown, and the share of the top at the highest one now (for tests). */
  stats(): { samples: number; runs: number; highest: number } {
    let hi = 0;
    for (let k = 0; k < this.data.streetSamples; k++) hi = Math.max(hi, this.values[k]);
    return { samples: this.data.streetSamples, runs: this.data.runs.length, highest: this.data.max > 0 ? hi / this.data.max : 0 };
  }

  /** The value and its share of the top at every sample now. */
  shares(): Float32Array {
    const out = new Float32Array(this.values.length);
    const top = this.data.max || 1;
    for (let k = 0; k < out.length; k++) out[k] = this.values[k] / top;
    return out;
  }

  /**
   * How high the street top stands above the ground at a point now (m), or 0 off the streets:
   * for a route riding on them.
   */
  liftAt(e: number, n: number): number {
    const CELL = 50;
    if (!this.segIndex) {
      const index = new Map<string, Array<[number, number, number]>>();
      for (const run of this.data.runs) {
        for (let k = run.start; k < run.start + run.count - 1; k++) {
          const hw = Math.max(this.data.width[k], this.data.width[k + 1], this.minWidth) / 2;
          const [x0, y0, x1, y1] = [this.data.at[2 * k], this.data.at[2 * k + 1], this.data.at[2 * k + 2], this.data.at[2 * k + 3]];
          for (let cx = Math.floor((Math.min(x0, x1) - hw) / CELL); cx <= Math.floor((Math.max(x0, x1) + hw) / CELL); cx++) {
            for (let cy = Math.floor((Math.min(y0, y1) - hw) / CELL); cy <= Math.floor((Math.max(y0, y1) + hw) / CELL); cy++) {
              const key = `${cx},${cy}`;
              const list = index.get(key);
              if (list) list.push([k, k + 1, hw]);
              else index.set(key, [[k, k + 1, hw]]);
            }
          }
        }
      }
      this.segIndex = index;
    }
    let top = -1;
    const at = this.data.at;
    for (const [a, b, hw] of this.segIndex.get(`${Math.floor(e / CELL)},${Math.floor(n / CELL)}`) ?? []) {
      const dx = at[2 * b] - at[2 * a];
      const dy = at[2 * b + 1] - at[2 * a + 1];
      const len2 = dx * dx + dy * dy;
      const f = len2 > 0 ? Math.max(0, Math.min(1, ((e - at[2 * a]) * dx + (n - at[2 * a + 1]) * dy) / len2)) : 0;
      if (Math.hypot(at[2 * a] + dx * f - e, at[2 * a + 1] + dy * f - n) > hw) continue;
      top = Math.max(top, this.share(this.values[a] + (this.values[b] - this.values[a]) * f));
    }
    return top < 0 ? 0 : this.lift + this.tallest * top;
  }

  /** The counting point under a ray, if any. */
  hit(raycaster: Raycaster): number | null {
    const hits = raycaster.intersectObjects([this.cores, this.markers], false);
    const id = hits[0]?.instanceId;
    return id == null ? null : id;
  }

  /** a counting point's disc (its top's middle), in scene coordinates */
  topOf(i: number): [number, number, number] {
    const s = this.data.streetSamples + i;
    return [this.data.at[2 * s], this.markerBase[i] + this.raiseOf(i) + this.markerR * DISC, -this.data.at[2 * s + 1]];
  }

  /** where a counting point is, on the street's top, in scene coordinates */
  footOf(i: number): [number, number, number] {
    const s = this.data.streetSamples + i;
    return [this.data.at[2 * s], this.markerBase[i] + this.raiseOf(i), -this.data.at[2 * s + 1]];
  }

  /** the middle of a counting point's disc, in scene coordinates, for tests */
  midOf(i: number): [number, number, number] {
    const [x, y, z] = this.topOf(i);
    return [x, y - this.markerR * DISC * 0.5, z];
  }

  dispose(): void {
    this.clearLabels();
    this.streets.geometry.dispose();
    this.streets.material.dispose();
    for (const m of [this.markers, this.cores]) {
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
  }

  /** how far the street stands up where counting point i is (m) */
  private raiseOf(i: number): number {
    if (!this.data.onStreet[i]) return 0;
    return this.lift + this.tallest * this.share(this.values[this.data.streetSamples + i]);
  }

  private share(v: number): number {
    return this.data.max > 0 ? Math.min(1, v / this.data.max) : 0;
  }

  private update(): void {
    if (!this.surface) return;
    streetValues(this.data, columnValues(this.day, this.pos), this.values);
    const geo = this.streets.geometry;
    const pos = geo.getAttribute('position') as BufferAttribute;
    const col = geo.getAttribute('color') as BufferAttribute;
    const c = new Color();
    // the bottoms reach a little into the ground, so slopes leave no gap under a street
    const bury = this.lift * 3;
    for (let v = 0; v < this.vSample.length; v++) {
      const q = this.share(this.values[this.vSample[v]]);
      const y = this.vTop[v] ? this.vGround[v] + this.lift + this.tallest * q : this.vGround[v] - bury;
      pos.setXYZ(v, this.vAt[2 * v], y, -this.vAt[2 * v + 1]);
      trafficColour(q, c);
      col.setXYZ(v, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeBoundingSphere();

    const m = new Matrix4();
    const rot = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    const r = this.markerR;
    this.day.columns.forEach((_, i) => {
      const [x, y, z] = this.footOf(i);
      // a thin disc standing a little proud of the street, so it shows from the side too
      p.set(x, y + r * DISC * 0.5, z);
      this.markers.setMatrixAt(i, m.compose(p, rot, s.set(r, r * DISC, r)));
      p.set(x, y + r * DISC * 0.55, z);
      this.cores.setMatrixAt(i, m.compose(p, rot, s.set(r * 0.72, r * DISC, r * 0.72)));
    });
    this.markers.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.markers.computeBoundingSphere();
    this.cores.computeBoundingSphere();
    this.placeLabels();
  }

  private placeLabels(): void {
    for (const { sprite, column } of this.labels) {
      const [x, y, z] = this.topOf(column);
      sprite.position.set(x, y + this.markerR * 0.3, z);
    }
  }

  /** a dark rim round a white disc; the one picked the other way round */
  private paintMarkers(): void {
    const ink = new Color(INK);
    const white = new Color(CASING);
    for (let i = 0; i < this.day.columns.length; i++) {
      const picked = i === this.picked;
      this.markers.setColorAt(i, picked ? white : ink);
      this.cores.setColorAt(i, picked ? ink : white);
    }
    for (const m of [this.markers, this.cores]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
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
