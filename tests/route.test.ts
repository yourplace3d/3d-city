import { describe, expect, it } from 'vitest';
import { isFit, nameFromFile, parseTrack, TrackFileProblem } from '../src/data/sources/trackFile';
import { decodeRouteLink, encodeRouteLink, MAX_LINK_POINTS } from '../src/data/sources/routeLink';
import {
  defaultStretch,
  endOf,
  fitStretch,
  formatClock,
  distanceM,
  kmMarks,
  makeRoute,
  pointAt,
  replayAt,
  simplify,
  sizeFor,
  squareFor,
  startOf,
  stretchOf,
  toLocal,
  trimEnds,
} from '../src/data/match/route';
import { makeProjector } from '../src/geo/projection';
import { Playback } from '../src/data/time/playback';
import { decodeState, DEFAULT_STATE, encodeState, type ViewState } from '../src/state';
import type { Track, TrackPoint } from '../src/data/types';

const CENTER = { lat: 48.7765, lon: 9.1772 };
const proj = makeProjector(CENTER);

/** A track along local (E, N) metres, one point every `step` m, `secPerM` seconds per metre. */
function trackAlong(path: Array<[number, number]>, step = 20, secPerM = 0.3): Track {
  const points: TrackPoint[] = [];
  let t = Date.UTC(2026, 3, 26, 7, 30);
  for (let k = 0; k < path.length - 1; k++) {
    const [ax, ay] = path[k];
    const [bx, by] = path[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let i = k === 0 ? 0 : 1; i <= n; i++) {
      const p = proj.toLngLat(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
      if (points.length) t += ((len / n) * secPerM) * 1000;
      points.push({ lat: p.lat, lon: p.lon, time: t });
    }
  }
  return { name: 'Test run', points };
}

const gpx = (body: string, head = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${head}${body}</gpx>`;

describe('reading GPX and TCX files', () => {
  it('reads a recorded track across segments, with heights and times', () => {
    const t = parseTrack(
      gpx(`<trk><name>Morning &amp; run</name><trkseg>
        <trkpt lat="48.1" lon="11.5"><ele>520.5</ele><time>2026-04-26T07:30:00Z</time></trkpt>
        <trkpt lon='11.501' lat='48.1001'><ele>521</ele><time>2026-04-26T07:30:05Z</time></trkpt>
      </trkseg><trkseg><trkpt lat="48.1002" lon="11.502"/></trkseg></trk>`),
    );
    expect(t.name).toBe('Morning & run');
    expect(t.points).toHaveLength(3);
    expect(t.points[0]).toEqual({ lat: 48.1, lon: 11.5, ele: 520.5, time: Date.UTC(2026, 3, 26, 7, 30, 0) });
    expect(t.points[1].lon).toBe(11.501);
    expect(t.points[2].time).toBeUndefined();
  });

  it('reads a planned course (route points) when there is no track, and names from metadata or CDATA', () => {
    const t = parseTrack(gpx(`<rte><rtept lat="52.5" lon="13.4"/><rtept lat="52.51" lon="13.41"/></rte>`, '<metadata><author><name>Someone</name></author><name><![CDATA[City Marathon 2026]]></name></metadata>'));
    expect(t.name).toBe('City Marathon 2026');
    expect(t.points).toHaveLength(2);
  });

  it('never takes the author for the name', () => {
    const t = parseTrack(gpx(`<trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2"/></trkseg></trk>`, '<metadata><author><name>A Person</name></author></metadata>'));
    expect(t.name).toBe('');
  });

  it('copes with namespace prefixes, comments, bad and repeated points', () => {
    const t = parseTrack(`<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><!-- <trkpt lat="9" lon="9"/> -->
      <g:trk><g:trkseg>
        <g:trkpt lat="10" lon="20"></g:trkpt>
        <g:trkpt lat="10" lon="20"></g:trkpt>
        <g:trkpt lat="abc" lon="20"></g:trkpt>
        <g:trkpt lat="95" lon="20"></g:trkpt>
        <g:trkpt lat="10.001" lon="20"></g:trkpt>
      </g:trkseg></g:trk></g:gpx>`);
    expect(t.points.map((p) => p.lat)).toEqual([10, 10.001]);
  });

  it('reads TCX activities and courses, skipping samples without a position', () => {
    const t = parseTrack(`<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
      <Courses><Course><Name>Hill loop</Name><Track>
        <Trackpoint><Time>2026-04-26T07:30:00Z</Time><Position><LatitudeDegrees>47.0</LatitudeDegrees><LongitudeDegrees>8.0</LongitudeDegrees></Position><AltitudeMeters>400</AltitudeMeters></Trackpoint>
        <Trackpoint><Time>2026-04-26T07:30:01Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
        <Trackpoint><Time>2026-04-26T07:30:02Z</Time><Position><LatitudeDegrees>47.001</LatitudeDegrees><LongitudeDegrees>8.001</LongitudeDegrees></Position></Trackpoint>
      </Track></Course></Courses></TrainingCenterDatabase>`);
    expect(t.name).toBe('Hill loop');
    expect(t.points).toHaveLength(2);
    expect(t.points[0].ele).toBe(400);
    expect(t.points[1].time).toBe(Date.UTC(2026, 3, 26, 7, 30, 2));
  });

  it('says why a file can’t be used', () => {
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof TrackFileProblem ? e.reason : 'other';
      }
      return 'none';
    };
    expect(reason(() => parseTrack('{"type":"FeatureCollection"}'))).toBe('unsupported');
    expect(reason(() => parseTrack(gpx('<wpt lat="1" lon="2"/>')))).toBe('empty');
    expect(reason(() => parseTrack(gpx('<trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk>')))).toBe('empty');
    const fit = new Uint8Array([14, 16, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0]);
    expect(isFit(fit)).toBe(true);
    expect(isFit(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
    expect(nameFromFile('Morning_Run--2026.gpx')).toBe('Morning Run 2026');
  });
});

describe('route geometry', () => {
  // an L: 3 km east, then 3 km north (6 km in all)
  const L = makeRoute(trackAlong([[-1500, -1500], [1500, -1500], [1500, 1500]]));

  it('measures along the route', () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 })).toBeCloseTo(1105.74, 1);
    expect(distanceM({ lat: 48, lon: 9 }, { lat: 48, lon: 9.01 })).toBeCloseTo(746.25, 1);
    expect(endOf(L)).toBeGreaterThan(5990);
    expect(endOf(L)).toBeLessThan(6010);
    const corner = proj.toLocal(pointAt(L, 3000).lon, pointAt(L, 3000).lat);
    expect(Math.hypot(corner[0] - 1500, corner[1] + 1500)).toBeLessThan(5);
    expect(L.hasTime).toBe(true);
  });

  it('cuts a stretch with exact ends', () => {
    const s = toLocal(stretchOf(L, 1000, 4000), CENTER);
    expect(Math.hypot(s[0][0] + 500, s[0][1] + 1500)).toBeLessThan(5);
    expect(Math.hypot(s[s.length - 1][0] - 1500, s[s.length - 1][1] + 500)).toBeLessThan(5);
  });

  it('fits the square to a stretch, in 100 m steps with some room around it', () => {
    expect(sizeFor(0)).toBe(300);
    expect(sizeFor(1000)).toBe(1200);
    const sq = squareFor(stretchOf(L, 0, 3000));
    const [e, n] = proj.toLocal(sq.center.lon, sq.center.lat);
    expect(Math.abs(e)).toBeLessThan(5);
    expect(Math.abs(n + 1500)).toBeLessThan(5);
    expect(sq.size).toBe(3500);
  });

  it('shortens a stretch that doesn’t fit, keeping the end the user moves', () => {
    // 5 km east, then 5 km north: too big for one model
    const long = makeRoute(trackAlong([[-2500, -2500], [2500, -2500], [2500, 2500]]));
    const extent = (a: number, b: number) => {
      const pts = toLocal(stretchOf(long, a, b), CENTER);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    };
    const fromStart = fitStretch(long, 0, endOf(long), 'from');
    expect(fromStart.fromM).toBe(0);
    expect(sizeFor(extent(0, fromStart.toM))).toBeLessThanOrEqual(4000);
    expect(sizeFor(extent(0, fromStart.toM + 30))).toBeGreaterThan(4000);
    expect(squareFor(stretchOf(long, 0, fromStart.toM)).size).toBe(4000);
    const toEnd = fitStretch(long, 0, endOf(long), 'to');
    expect(toEnd.toM).toBe(endOf(long));
    expect(sizeFor(extent(toEnd.fromM, toEnd.toM))).toBeLessThanOrEqual(4000);
    expect(sizeFor(extent(toEnd.fromM - 30, toEnd.toM))).toBeGreaterThan(4000);
    // the finish is what shows first
    expect(defaultStretch(long)).toEqual(toEnd);
    // never shorter than 100 m; the moving end pushes the other
    expect(fitStretch(long, 2000, 1500, 'from')).toEqual({ fromM: 2000, toM: 2100 });
    const atEnd = fitStretch(long, endOf(long), endOf(long), 'from');
    expect(atEnd.toM - atEnd.fromM).toBeCloseTo(100, 5);
    // a route that fits is shown whole
    expect(defaultStretch(L)).toEqual({ fromM: 0, toM: endOf(L) });
  });

  it('numbers whole kilometres inside a stretch', () => {
    expect(kmMarks(0, 3000)).toEqual([1, 2, 3]);
    expect(kmMarks(38200, 42195)).toEqual([39, 40, 41, 42]);
    expect(kmMarks(1200, 1900)).toEqual([]);
  });

  it('hides the ends, keeping the km numbering and the race clock', () => {
    const t = trimEnds(L, 500);
    expect(startOf(t)).toBeCloseTo(500, 5);
    expect(endOf(t)).toBeCloseTo(endOf(L) - 500, 3);
    expect(t.hasStart || t.hasFinish).toBe(false);
    expect(t.t0).toBe(L.t0);
    const first = proj.toLocal(t.points[0].lon, t.points[0].lat);
    expect(Math.hypot(first[0] + 1000, first[1] + 1500)).toBeLessThan(5);
    // nothing left to hide on a route without its ends
    expect(trimEnds(t, 500)).toBe(t);
  });

  it('replays at the recorded pace, or evenly without times', () => {
    // first 1 km slow (0.5 s/m), then fast (0.25 s/m): half the time is still in the first km
    const p = makeRoute(trackAlong([[0, 0], [1000, 0], [3000, 0]], 20, 0.5));
    const fast = p.points.map((q, i) => (i === 0 ? q : q));
    for (let i = 1; i < fast.length; i++) {
      const dt = p.dist[i] > 1000 ? 0.25 : 0.5;
      fast[i] = { ...fast[i], time: fast[i - 1].time! + (p.dist[i] - p.dist[i - 1]) * dt * 1000 };
    }
    const r = makeRoute({ name: '', points: fast });
    const half = replayAt(r, 0, endOf(r), 0.5);
    expect(half.m).toBeGreaterThan(990);
    expect(half.m).toBeLessThan(1010);
    expect(half.elapsed).toBeCloseTo(500_000, -3);
    const even = makeRoute({ name: '', points: fast.map(({ lat, lon }) => ({ lat, lon })) });
    expect(even.hasTime).toBe(false);
    const e = replayAt(even, 0, 3000, 0.5);
    expect(e.m).toBeCloseTo(1500, 0);
    expect(e.elapsed).toBeNull();
    expect(replayAt(r, 1000, 2000, 1).m).toBeCloseTo(2000, 0);
  });

  it('keeps time running forwards when a clock jumps back', () => {
    const t = trackAlong([[0, 0], [100, 0]], 20);
    t.points[3] = { ...t.points[3], time: t.points[0].time! - 5000 };
    const r = makeRoute(t);
    for (let i = 1; i < r.points.length; i++) expect(r.points[i].time!).toBeGreaterThanOrEqual(r.points[i - 1].time!);
  });

  it('simplifies a line within a tolerance, keeping its ends and corners', () => {
    const line: Array<[number, number]> = [];
    for (let i = 0; i <= 100; i++) line.push([i * 10, i % 2 ? 0.4 : 0]);
    line.push([1000, 500]);
    const keep = simplify(line, 1);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(line.length - 1);
    expect(keep).toContain(100);
    expect(keep.length).toBeLessThan(6);
  });

  it('formats the race clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3 * 3600_000 + 12 * 60_000 + 5_000)).toBe('3:12:05');
  });
});

describe('a route in a share link', () => {
  const pts = trackAlong([[0, 0], [1200, 300], [1500, 1400]], 15).points;

  it('round-trips the stretch to about a metre, without times', () => {
    const code = encodeRouteLink({ points: pts, startM: 38200, hasStart: false, hasFinish: true });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeRouteLink(code)!;
    expect(back.startM).toBe(38200);
    expect(back.hasStart).toBe(false);
    expect(back.hasFinish).toBe(true);
    expect(back.points).toHaveLength(pts.length);
    for (let i = 0; i < pts.length; i++) expect(distanceM(back.points[i], pts[i])).toBeLessThan(1);
    expect(back.points.every((p) => p.time === undefined)).toBe(true);
    // short: a couple of bytes per point
    expect(code.length).toBeLessThan(pts.length * 6);
  });

  it('rejects what isn’t a route', () => {
    expect(decodeRouteLink('')).toBeNull();
    expect(decodeRouteLink('not a code!')).toBeNull();
    expect(decodeRouteLink('AAAAAAAA')).toBeNull();
    const code = encodeRouteLink({ points: pts.slice(0, 5), startM: 0, hasStart: true, hasFinish: true });
    expect(decodeRouteLink(code.slice(0, -3))).toBeNull();
    expect(decodeRouteLink(`${code}AAAA`)).toBeNull();
  });

  it('caps the points it carries', () => {
    const many = Array.from({ length: MAX_LINK_POINTS + 50 }, (_, i) => ({ lat: 48 + i * 1e-4, lon: 9 }));
    expect(decodeRouteLink(encodeRouteLink({ points: many, startM: 0, hasStart: true, hasFinish: false }))!.points).toHaveLength(MAX_LINK_POINTS);
  });

  it('goes into the view state only when set', () => {
    const base: ViewState = { ...DEFAULT_STATE, center: CENTER };
    expect(encodeState(base)).not.toMatch(/rt=/);
    const code = encodeRouteLink({ points: pts.slice(0, 20), startM: 1000, hasStart: false, hasFinish: false });
    const hash = encodeState({ ...base, route: code });
    expect(hash).toContain(`rt=${code}`);
    expect(decodeState(hash).route).toBe(code);
    expect(decodeState(`${encodeState(base)}&rt=bad%20code`).route).toBeNull();
    // a link without a route drops one the base state had
    expect(decodeState(encodeState(base), { ...base, route: code }).route).toBeNull();
  });
});

describe('playback', () => {
  it('plays to the end, pauses, seeks and starts again', () => {
    const seen: Array<[number, boolean]> = [];
    const p = new Playback(1000, (pos, playing) => seen.push([pos, playing]));
    expect(p.advance(16)).toBe(false); // never starts by itself
    p.play();
    expect(p.advance(50)).toBe(true);
    expect(p.position).toBeCloseTo(0.05);
    p.advance(5000); // a hidden tab: one frame moves at most 100 ms
    expect(p.position).toBeCloseTo(0.15);
    p.pause();
    expect(p.advance(50)).toBe(false);
    p.seek(0.95);
    p.play();
    for (let k = 0; k < 10; k++) p.advance(50);
    expect(p.position).toBe(1);
    expect(p.playing).toBe(false);
    expect(seen[seen.length - 1]).toEqual([1, false]);
    p.play(); // from the start again
    expect(p.position).toBe(0);
    p.reset();
    expect(p.playing).toBe(false);
  });
});

describe('route markers', () => {
  it('leave out km labels that would overlap the finish or each other', async () => {
    const { declutter } = await import('../src/data/display/route');
    const kept = declutter(
      [
        { at: [0, 0], label: '13 km', kind: 'km' },
        { at: [300, 0], label: 'Finish', kind: 'finish' },
        { at: [-1000, 0], label: '12 km', kind: 'km' },
        { at: [-1200, 100], label: '11 km', kind: 'km' },
        { at: [-1000, 600], label: '10 km', kind: 'km' },
      ],
      4000,
    );
    expect(kept.map((m) => m.label)).toEqual(['Finish', '12 km', '10 km']);
  });
});
