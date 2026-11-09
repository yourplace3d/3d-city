/**
 * Match: traffic spread along the streets.
 *
 * Only the counting points are counted. To show a street's traffic instead of a spike at each
 * point, every count spreads along the streets around its point and fades out over the spread
 * distance (100–500 m, set by the user): all of it at the point, half of it a little past
 * halfway, none at the end. It walks the street network rather than going as the crow flies, so
 * a quiet street running alongside a busy one stays quiet; into a smaller street than the
 * counted one it fades four times as fast, since a side street doesn't carry the main road's
 * traffic. Where counts meet, as at a crossing counted on every side, they add up, so the whole
 * crossing rises. Everything between the points is an estimate, and the panel says so.
 *
 * The network is built once per model and mode (cars or bikes); the spread is worked out again
 * when the counts or the distance change: one short walk per counting point.
 */

import { DEFAULT_STATE, SPREAD_RANGE } from '../../state';
import type { TrafficMode } from '../sources/hamburgTraffic';
import type { Pt } from '../types';
import { HOURS, valueAt, type TrafficDay } from './traffic';

/** The spread distance (m): its range on the slider, and where it starts. */
export const SPREAD = { ...SPREAD_RANGE, initial: DEFAULT_STATE.spread } as const;
/** Into a smaller street than the counted one, a count fades this many times as fast. */
export const SIDE_COST = 4;
/** A counting point further than this from a street (m) isn't on one: it stays a point. */
export const SNAP_M = 30;
/** Points along the streets are at most this far apart (m): the steps of the fade. */
export const SAMPLE_M = 10;
/** Line ends closer than this (m) are one point of the network (roads cut at a tile's edge). */
const JOIN_M = 0.3;

/** How big a street is, for the fade, by what each mode counts on; other lines aren't streets for it. */
const RANKS: Record<TrafficMode, Record<string, number>> = {
  cars: { motorway: 4, primary: 3, secondary: 2, tertiary: 1, minor: 0 },
  bikes: { primary: 3, secondary: 2, tertiary: 1, minor: 0, path: 0 },
};

/** A line of the map, as far as the network needs it. */
export interface StreetLine {
  kind: string;
  pts: Pt[];
  widthM: number;
  bridge: boolean;
}

/** How much of a count is left `d` metres along the streets from its point. */
export function fade(d: number, spreadM: number): number {
  if (!(d < spreadM)) return 0;
  const x = d / spreadM;
  return (1 - x * x) ** 2;
}

interface Edge {
  a: number;
  b: number;
  len: number;
  rank: number;
  widthM: number;
  bridge: boolean;
}

/** Where a counting point sits on the network: an edge, and how far along it from a to b (0 … 1). */
export interface Snap {
  edge: number;
  f: number;
  at: Pt;
}

/** The streets of a model for one mode, joined where they meet. */
export class StreetNetwork {
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  readonly edges: Edge[] = [];
  /** the edges at each node */
  readonly adj: number[][] = [];
  /** runs of edges between crossings and line ends, each with its nodes in order */
  readonly chains: Array<{ edges: number[]; nodes: number[] }> = [];

  constructor(lines: StreetLine[], mode: TrafficMode) {
    const ranks = RANKS[mode];
    const cells = new Map<number, number[]>();
    const cell = (cx: number, cy: number) => cx * 1_000_003 + cy;
    const node = (p: Pt): number => {
      const cx = Math.floor(p[0]);
      const cy = Math.floor(p[1]);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const k of cells.get(cell(cx + dx, cy + dy)) ?? []) if (Math.hypot(this.xs[k] - p[0], this.ys[k] - p[1]) <= JOIN_M) return k;
        }
      }
      const k = this.xs.length;
      this.xs.push(p[0]);
      this.ys.push(p[1]);
      this.adj.push([]);
      const key = cell(cx, cy);
      const list = cells.get(key);
      if (list) list.push(k);
      else cells.set(key, [k]);
      return k;
    };
    // a road cut at a tile's edge comes twice where the tiles overlap: keep each stretch once
    const seen = new Set<number>();
    for (const l of lines) {
      const rank = ranks[l.kind];
      if (rank == null || l.pts.length < 2) continue;
      let prev = node(l.pts[0]);
      for (let k = 1; k < l.pts.length; k++) {
        const cur = node(l.pts[k]);
        if (cur === prev) continue;
        const key = Math.min(prev, cur) * 67_108_864 + Math.max(prev, cur);
        if (!seen.has(key)) {
          seen.add(key);
          const len = Math.hypot(this.xs[cur] - this.xs[prev], this.ys[cur] - this.ys[prev]);
          this.adj[prev].push(this.edges.length);
          this.adj[cur].push(this.edges.length);
          this.edges.push({ a: prev, b: cur, len, rank, widthM: l.widthM, bridge: l.bridge });
        }
        prev = cur;
      }
    }
    this.buildChains();
  }

  get size(): number {
    return this.edges.length;
  }

  /** The nearest street to a point, within SNAP_M; null if there is none that close. */
  snap(p: Pt): Snap | null {
    let best: Snap | null = null;
    let bestD = SNAP_M;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const ax = this.xs[e.a];
      const ay = this.ys[e.a];
      const dx = this.xs[e.b] - ax;
      const dy = this.ys[e.b] - ay;
      if (Math.abs(p[0] - ax) > e.len + bestD || Math.abs(p[1] - ay) > e.len + bestD) continue;
      const f = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (e.len * e.len)));
      const at: Pt = [ax + dx * f, ay + dy * f];
      const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
      if (d < bestD) {
        bestD = d;
        best = { edge: i, f, at };
      }
    }
    return best;
  }

  /**
   * How far each node is along the streets from a counting point (m, the fade's metres: four
   * for each one into a smaller street), up to `limit`.
   */
  walk(from: Snap, limit: number): Map<number, number> {
    const src = this.edges[from.edge];
    const dist = new Map<number, number>();
    const heap = new Heap();
    const reach = (k: number, d: number) => {
      if (d >= limit || d >= (dist.get(k) ?? Infinity)) return;
      dist.set(k, d);
      heap.push(k, d);
    };
    reach(src.a, from.f * src.len);
    reach(src.b, (1 - from.f) * src.len);
    while (heap.size) {
      const [k, d] = heap.pop();
      if (d > (dist.get(k) ?? Infinity)) continue;
      for (const ei of this.adj[k]) {
        const e = this.edges[ei];
        reach(e.a === k ? e.b : e.a, d + e.len * cost(e.rank, src.rank));
      }
    }
    return dist;
  }

  /** Runs of edges between nodes that aren't simply on the way (crossings, line ends, a bridge's ends). */
  private buildChains(): void {
    const used = new Uint8Array(this.edges.length);
    const stop = (k: number) => {
      const a = this.adj[k];
      return a.length !== 2 || this.edges[a[0]].bridge !== this.edges[a[1]].bridge;
    };
    const follow = (start: number, first: number) => {
      const edges: number[] = [];
      const nodes = [start];
      let k = start;
      let ei = first;
      while (!used[ei]) {
        used[ei] = 1;
        const e = this.edges[ei];
        k = e.a === k ? e.b : e.a;
        edges.push(ei);
        nodes.push(k);
        if (stop(k)) break;
        const next = this.adj[k].find((x) => !used[x]);
        if (next == null) break;
        ei = next;
      }
      this.chains.push({ edges, nodes });
    };
    for (let k = 0; k < this.adj.length; k++) if (stop(k)) for (const ei of this.adj[k]) if (!used[ei]) follow(k, ei);
    // what's left are loops with no crossing on them
    this.edges.forEach((e, ei) => {
      if (!used[ei]) follow(e.a, ei);
    });
  }
}

/** The fade's metres per metre of a street, for a count from a street of rank `from`. */
function cost(rank: number, from: number): number {
  return rank >= from ? 1 : SIDE_COST;
}

/** A stretch of street near counting points: samples [start, start + count). */
export interface StreetRun {
  start: number;
  count: number;
  bridge: boolean;
}

export interface TrafficStreets {
  spreadM: number;
  /**
   * Sample positions (m), [e0, n0, e1, n1, …]: first the streets' (`streetSamples` of them, run
   * by run), then one per column, where it sits on its street (or where it is, if on none).
   */
  at: Float32Array;
  /** the street's width at each sample (m) */
  width: Float32Array;
  runs: StreetRun[];
  streetSamples: number;
  /** each sample's share of each column's count: entries offset[s] … offset[s + 1] − 1 of col / weight */
  offset: Uint32Array;
  col: Uint16Array;
  weight: Float32Array;
  /** whether each column sits on a street (if not, it isn't spread) */
  onStreet: boolean[];
  /** the highest value at any sample in any hour: the top of the scale */
  max: number;
}

/** Spread the day's counts along the network, `spreadM` metres. */
export function spreadStreets(net: StreetNetwork, day: TrafficDay, spreadM: number): TrafficStreets {
  const snaps = day.columns.map((c) => net.snap(c.at));
  const walks = snaps.map((s) => (s ? net.walk(s, spreadM) : null));
  const ranks = snaps.map((s) => (s ? net.edges[s.edge].rank : 0));

  // how far a point on edge `ei`, `f` of the way from a to b, is from column i (the fade's metres)
  const distance = (i: number, ei: number, f: number): number => {
    const w = walks[i];
    if (!w) return Infinity;
    const e = net.edges[ei];
    const c = cost(e.rank, ranks[i]);
    let d = Math.min((w.get(e.a) ?? Infinity) + f * e.len * c, (w.get(e.b) ?? Infinity) + (1 - f) * e.len * c);
    if (snaps[i]!.edge === ei) d = Math.min(d, Math.abs(f - snaps[i]!.f) * e.len * c);
    return d;
  };

  const at: number[] = [];
  const width: number[] = [];
  const offset: number[] = [0];
  const col: number[] = [];
  const weight: number[] = [];
  const runs: StreetRun[] = [];

  // the edges a count reaches
  const reached = new Uint8Array(net.edges.length);
  walks.forEach((w, i) => {
    if (!w) return;
    reached[snaps[i]!.edge] = 1;
    for (const k of w.keys()) for (const ei of net.adj[k]) reached[ei] = 1;
  });

  for (const chain of net.chains) {
    if (!chain.edges.some((ei) => reached[ei])) continue;
    // samples along the chain: each edge from its first node, then the chain's last node
    const samples: Array<{ ei: number; f: number }> = [];
    chain.edges.forEach((ei, j) => {
      const e = net.edges[ei];
      const forward = e.a === chain.nodes[j];
      const parts = Math.max(1, Math.ceil(e.len / SAMPLE_M));
      for (let p = 0; p < parts; p++) samples.push({ ei, f: forward ? p / parts : 1 - p / parts });
    });
    const lastEdge = net.edges[chain.edges[chain.edges.length - 1]];
    samples.push({ ei: chain.edges[chain.edges.length - 1], f: lastEdge.a === chain.nodes[chain.nodes.length - 1] ? 0 : 1 });
    const shares = samples.map(({ ei, f }) => {
      const list: Array<[number, number]> = [];
      walks.forEach((_, i) => {
        const w = fade(distance(i, ei, f), spreadM);
        if (w > 1e-4) list.push([i, w]);
      });
      return list;
    });
    // runs of samples with a share of some count, and one sample either side (where it has faded out)
    let k = 0;
    while (k < samples.length) {
      if (!shares[k].length) {
        k++;
        continue;
      }
      let j = k;
      while (j < samples.length && shares[j].length) j++;
      const a = Math.max(0, k - 1);
      const b = Math.min(samples.length, j + 1);
      if (b - a >= 2) {
        runs.push({ start: width.length, count: b - a, bridge: lastEdge.bridge });
        for (let s = a; s < b; s++) {
          const { ei, f } = samples[s];
          const e = net.edges[ei];
          at.push(net.xs[e.a] + (net.xs[e.b] - net.xs[e.a]) * f, net.ys[e.a] + (net.ys[e.b] - net.ys[e.a]) * f);
          width.push(e.widthM);
          for (const [i, w] of shares[s]) {
            col.push(i);
            weight.push(w);
          }
          offset.push(col.length);
        }
      }
      k = j;
    }
  }

  const streetSamples = width.length;
  // the columns themselves: what the street adds up to where each one sits
  day.columns.forEach((c, ci) => {
    const s = snaps[ci];
    at.push(...(s ? s.at : c.at));
    width.push(s ? net.edges[s.edge].widthM : 0);
    if (s) {
      walks.forEach((_, i) => {
        const w = fade(distance(i, s.edge, s.f), spreadM);
        if (w > 1e-4) {
          col.push(i);
          weight.push(w);
        }
      });
    } else {
      col.push(ci);
      weight.push(1);
    }
    offset.push(col.length);
  });

  const out: TrafficStreets = {
    spreadM,
    at: Float32Array.from(at),
    width: Float32Array.from(width),
    runs,
    streetSamples,
    offset: Uint32Array.from(offset),
    col: Uint16Array.from(col),
    weight: Float32Array.from(weight),
    onStreet: snaps.map((s) => !!s),
    max: 0,
  };
  const values = new Float32Array(width.length);
  for (let h = 0; h < HOURS; h++) {
    streetValues(out, columnValues(day, h), values);
    for (let s = 0; s < values.length; s++) out.max = Math.max(out.max, values[s]);
  }
  return out;
}

/** Each column's count at a moment (`pos` 0 … 23, between hours while replaying); none counts as 0. */
export function columnValues(day: TrafficDay, pos: number): Float32Array {
  return Float32Array.from(day.columns, (c) => valueAt(c.values, pos));
}

/** The value at every sample: each column's count times its share there, added up. */
export function streetValues(s: TrafficStreets, counts: ArrayLike<number>, out: Float32Array = new Float32Array(s.width.length)): Float32Array {
  for (let k = 0; k < s.width.length; k++) {
    let v = 0;
    for (let q = s.offset[k]; q < s.offset[k + 1]; q++) {
      const c = counts[s.col[q]];
      if (c > 0) v += c * s.weight[q];
    }
    out[k] = v;
  }
  return out;
}

/** A binary heap of (node, distance), smallest distance first. */
class Heap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(k: number, v: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (vals[p] <= v) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }

  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0], vals[0]];
    const k = keys.pop()!;
    const v = vals.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= keys.length) break;
        const r = l + 1;
        const c = r < keys.length && vals[r] < vals[l] ? r : l;
        if (vals[c] >= v) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}
