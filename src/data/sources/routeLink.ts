/**
 * Source: a route carried by a share link, only when its owner turned that on.
 *
 * The link holds the stretch shown, never the whole file: positions to about a metre, where the
 * stretch starts on the route (so km markers keep their numbers), and whether the route's real
 * start and finish are in it. No times, no name, no heights. It goes after the `#`, which
 * browsers never send to a server.
 *
 * Format (base64url): version, flags, start metres, point count, then latitude and longitude in
 * 1e-5 degrees as zigzag varints, each point as the difference from the one before.
 */

import type { TrackPoint } from '../types';

const VERSION = 1;
const SCALE = 1e5;
/** About 4 KB of link at most; a 4 km stretch simplified to 2 m needs a few hundred points. */
export const MAX_LINK_POINTS = 1500;

export interface LinkedRoute {
  points: TrackPoint[];
  /** route metres where the stretch starts */
  startM: number;
  hasStart: boolean;
  hasFinish: boolean;
}

export function encodeRouteLink(r: LinkedRoute): string {
  const bytes: number[] = [VERSION, (r.hasStart ? 1 : 0) | (r.hasFinish ? 2 : 0)];
  const varint = (v: number) => {
    let x = v;
    while (x >= 0x80) {
      bytes.push((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    bytes.push(x);
  };
  const zigzag = (v: number) => varint(v < 0 ? -2 * v - 1 : 2 * v);
  const pts = r.points.slice(0, MAX_LINK_POINTS);
  varint(Math.max(0, Math.round(r.startM)));
  varint(pts.length);
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    const la = Math.round(p.lat * SCALE);
    const lo = Math.round(p.lon * SCALE);
    zigzag(la - lat);
    zigzag(lo - lon);
    lat = la;
    lon = lo;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The route in a link, or null if the text isn't one (a mangled or hand-edited link). */
export function decodeRouteLink(code: string): LinkedRoute | null {
  if (!/^[A-Za-z0-9_-]{6,12000}$/.test(code)) return null;
  let bin: string;
  try {
    bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  let at = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      if (at >= bin.length) throw new Error('short');
      const b = bin.charCodeAt(at++);
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 128;
    }
    throw new Error('long');
  };
  const zigzag = () => {
    const v = varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  try {
    if (bin.charCodeAt(at++) !== VERSION) return null;
    const flags = bin.charCodeAt(at++);
    const startM = varint();
    const count = varint();
    if (count < 2 || count > MAX_LINK_POINTS) return null;
    const points: TrackPoint[] = [];
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < count; i++) {
      lat += zigzag();
      lon += zigzag();
      const p = { lat: lat / SCALE, lon: lon / SCALE };
      if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
      points.push(p);
    }
    if (at !== bin.length) return null;
    return { points, startM, hasStart: !!(flags & 1), hasFinish: !!(flags & 2) };
  } catch {
    return null;
  }
}
