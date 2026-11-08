/**
 * Source: a GPX or TCX file the user picks (Strava, Garmin, Komoot, race websites).
 *
 * The file is read in the browser and never leaves it: nothing here touches the network or
 * storage. A small tolerant scanner rather than DOMParser, so the same code runs in the unit
 * tests (Node) and copes with what exporters write: namespace prefixes, single-quoted
 * attributes, CDATA names, track points without a position (TCX heart-rate samples).
 */

import type { Track, TrackPoint } from '../types';

export type TrackFileError = 'empty' | 'fit' | 'unsupported' | 'tooBig';

export class TrackFileProblem extends Error {
  constructor(readonly reason: TrackFileError) {
    super(`track file: ${reason}`);
  }
}

/** Larger than any real activity (a day of 1 s GPS points is ~15 MB). */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Read a picked or dropped file. The name is a fallback title when the file has none. */
export async function readTrackFile(file: File): Promise<Track> {
  if (file.size > MAX_FILE_BYTES) throw new TrackFileProblem('tooBig');
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (isFit(head)) throw new TrackFileProblem('fit');
  const track = parseTrack(await file.text());
  if (!track.name) track.name = nameFromFile(file.name);
  return track;
}

/** Garmin's binary FIT format: ".FIT" at bytes 8–11. */
export function isFit(head: Uint8Array): boolean {
  return head.length >= 12 && head[8] === 0x2e && head[9] === 0x46 && head[10] === 0x49 && head[11] === 0x54;
}

/** "Morning_Run-2026.gpx" → "Morning Run 2026" */
export function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A GPX or TCX document as a track. Throws TrackFileProblem when there's nothing to draw. */
export function parseTrack(xml: string): Track {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  let track: Track;
  if (/<(?:\w+:)?gpx[\s>]/.test(text)) track = parseGpx(text);
  else if (/<(?:\w+:)?TrainingCenterDatabase[\s>]/.test(text)) track = parseTcx(text);
  else throw new TrackFileProblem('unsupported');
  if (track.points.length < 2) throw new TrackFileProblem('empty');
  return track;
}

const TAG = (name: string) => `(?:\\w+:)?${name}`;

/** The elements called `name` (with or without a namespace prefix): attributes and inner text. */
function elements(text: string, name: string): Array<{ attrs: string; body: string }> {
  const re = new RegExp(`<${TAG(name)}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${TAG(name)}\\s*>)`, 'g');
  const out: Array<{ attrs: string; body: string }> = [];
  for (const m of text.matchAll(re)) out.push({ attrs: m[1], body: m[2] ?? '' });
  return out;
}

/** The text of the first child element called `name`, entities decoded; '' if there is none. */
function child(body: string, name: string): string {
  const m = new RegExp(`<${TAG(name)}\\b[^>]*>([\\s\\S]*?)<\\/${TAG(name)}\\s*>`).exec(body);
  return m ? decodeText(m[1]) : '';
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : '';
}

function decodeText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function point(lat: string, lon: string, ele: string, time: string): TrackPoint | null {
  const la = Number(lat);
  const lo = Number(lon);
  if (!lat || !lon || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const p: TrackPoint = { lat: la, lon: lo };
  const e = Number(ele);
  if (ele && Number.isFinite(e)) p.ele = e;
  const t = Date.parse(time);
  if (time && Number.isFinite(t)) p.time = t;
  return p;
}

/** Tracks (recorded) first; a route (planned course) or bare waypoints only when there are none. */
function parseGpx(text: string): Track {
  // the file's own name: GPX 1.1 keeps it in <metadata>, 1.0 right under <gpx>; never the author's
  const header = text.split(/<(?:\w+:)?(?:trk|rte|wpt)\b/)[0].replace(/<(?:\w+:)?(author|copyright|link|email)\b[\s\S]*?<\/(?:\w+:)?\1\s*>/g, '');
  const metaName = child(header, 'name');
  for (const [container, pt] of [
    ['trk', 'trkpt'],
    ['rte', 'rtept'],
  ] as const) {
    const parts = elements(text, container);
    const points: TrackPoint[] = [];
    let name = '';
    for (const part of parts) {
      // the part's own name: the text before its first point or segment
      name ||= child(part.body.split(/<(?:\w+:)?(?:trkseg|rtept)\b/)[0], 'name');
      for (const p of elements(part.body, pt)) {
        const q = point(attr(p.attrs, 'lat'), attr(p.attrs, 'lon'), child(p.body, 'ele'), child(p.body, 'time'));
        if (q) points.push(q);
      }
    }
    if (points.length) return { name: name || metaName, points: dedupe(points) };
  }
  return { name: metaName, points: [] };
}

function parseTcx(text: string): Track {
  const course = elements(text, 'Course')[0];
  const name = course ? child(course.body.split(/<(?:\w+:)?Track\b/)[0], 'Name') : '';
  const points: TrackPoint[] = [];
  for (const tp of elements(text, 'Trackpoint')) {
    // heart-rate or cadence samples have no position
    if (!new RegExp(`<${TAG('Position')}\\b`).test(tp.body)) continue;
    const q = point(child(tp.body, 'LatitudeDegrees'), child(tp.body, 'LongitudeDegrees'), child(tp.body, 'AltitudeMeters'), child(tp.body, 'Time'));
    if (q) points.push(q);
  }
  return { name, points: dedupe(points) };
}

/** Drop points that repeat the previous position (pauses, duplicated segment joints). */
function dedupe(points: TrackPoint[]): TrackPoint[] {
  return points.filter((p, i) => i === 0 || p.lat !== points[i - 1].lat || p.lon !== points[i - 1].lon);
}
