import { describe, expect, it } from 'vitest';
import { gtfsFiles, gtfsZip, zipFiles } from '../e2e/fixtures/transit.mjs';
import { findItem, listZip, openItem, ZipProblem } from '../src/data/sources/zipFile';
import { crossesBox, cutGtfs, GtfsProblem, modeOf, parseDay, parseTime, runsOn, splitCsv, weekday, type GtfsCut } from '../src/data/sources/gtfs';
import { cumulative, DAY_S, dayRuns, dayWithin, makeRuns, projectStops, runAt, runsPerHour, spanInside, stretch, type TransitRuns, type VehicleAt } from '../src/data/match/transit';
import { resample, transitForPrint, TRANSIT_PRINT_MM } from '../src/export/transit';

const CENTRE = { lat: 53.5511, lon: 9.9937 };
const SIZE = 2000;
const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);
const text = async (b: Blob, name: string) => {
  const it = findItem(await listZip(b), name);
  if (!it) throw new Error(`no ${name}`);
  return new Response(await openItem(b, it)).text();
};
const day = (s: string) => parseDay(s);
/** Monday 9 November 2026 */
const MONDAY = day('20261109');

let cutCache: GtfsCut | null = null;
async function cut(): Promise<GtfsCut> {
  cutCache ??= await cutGtfs(blob(gtfsZip(CENTRE)), { center: CENTRE, sizeM: SIZE });
  return cutCache;
}
async function runs(): Promise<TransitRuns> {
  return makeRuns(await cut(), SIZE);
}
const routeIndex = (c: { routes: Array<{ short: string }> }, name: string) => c.routes.findIndex((r) => r.short === name);

describe('ZIP files', () => {
  it('reads stored and deflated files, in a folder too', async () => {
    for (const opts of [{ deflate: true }, { deflate: false }, { deflate: true, folder: 'gtfs/' }]) {
      const b = blob(zipFiles({ 'a.txt': 'hello', 'Stops.TXT': 'x,y\n1,2\n' }, opts));
      const items = await listZip(b);
      expect(items.map((i) => i.name)).toEqual([`${opts.folder ?? ''}a.txt`, `${opts.folder ?? ''}Stops.TXT`]);
      expect(await text(b, 'a.txt')).toBe('hello');
      // names are matched without case, in any folder
      expect(await text(b, 'stops.txt')).toBe('x,y\n1,2\n');
      expect(findItem(items, 'nope.txt')).toBeNull();
    }
  });

  it('says so when a file is not a ZIP', async () => {
    await expect(listZip(new Blob(['just text, no archive']))).rejects.toBeInstanceOf(ZipProblem);
  });
});

describe('GTFS parsing', () => {
  it('splits CSV lines with quotes, doubled quotes and empty fields', () => {
    const out: string[] = [];
    expect(out.slice(0, splitCsv('a,b,,c', out))).toEqual(['a', 'b', '', 'c']);
    expect(out.slice(0, splitCsv('"x, y","say ""hi""",3', out))).toEqual(['x, y', 'say "hi"', '3']);
    expect(out.slice(0, splitCsv('1,2,', out))).toEqual(['1', '2', '']);
    expect(out.slice(0, splitCsv('"a","b"', out))).toEqual(['a', 'b']);
  });

  it('reads times past midnight and days', () => {
    expect(parseTime('08:05:00')).toBe(8 * 3600 + 300);
    expect(parseTime(' 7:05:30')).toBe(7 * 3600 + 330);
    expect(parseTime('25:10:00')).toBe(25 * 3600 + 600);
    expect(parseTime('')).toBeNaN();
    expect(parseTime('soon')).toBeNaN();
    expect(weekday(MONDAY)).toBe(0);
    expect(weekday(day('20261115'))).toBe(6);
    expect(parseDay('2026-11-09')).toBeNaN();
  });

  it('knows which days a service runs', () => {
    const s = { week: 0b0011111, start: day('20260101'), end: day('20261231'), add: [day('20261226')], remove: [day('20261225')] };
    expect(runsOn(s, MONDAY)).toBe(true);
    expect(runsOn(s, day('20261114'))).toBe(false); // Saturday
    expect(runsOn(s, day('20261225'))).toBe(false); // a Friday, taken out
    expect(runsOn(s, day('20261226'))).toBe(true); // a Saturday, added
    expect(runsOn(s, day('20270104'))).toBe(false); // after the end
  });

  it('turns route types, basic and extended, into modes', () => {
    const cases: Array<[number, string]> = [[0, 'tram'], [1, 'subway'], [2, 'rail'], [3, 'bus'], [4, 'ferry'], [7, 'other'], [109, 'rail'], [402, 'subway'], [702, 'bus'], [900, 'tram'], [1200, 'ferry'], [1300, 'other'], [11, 'bus']];
    for (const [type, mode] of cases) expect(modeOf(type), String(type)).toBe(mode);
  });

  it('finds lines that cross the square without a point in it', () => {
    expect(crossesBox(-2000, 0, 2000, 0, 1000)).toBe(true);
    expect(crossesBox(-2000, -2000, 2000, 2000, 1000)).toBe(true);
    expect(crossesBox(-2000, 1500, 2000, 1500, 1000)).toBe(false);
    expect(crossesBox(1200, -3000, 3000, -1200, 1000)).toBe(false);
  });
});

describe('cutting a timetable to the square', () => {
  it('keeps the trips through it: stopping in it, running through on a shape, or straight between stops', async () => {
    const c = await cut();
    const kept = new Set(Array.from(c.tripRoute, (r) => c.routes[r].short));
    expect([...kept].sort()).toEqual(['B2', 'S3', 'T1', 'U4']);
    expect(c.agencies).toEqual(['Test Transit']);
    expect(c.timeZone).toBe('Europe/Berlin');
    expect(c.firstDay).toBe(day('20260101'));
    expect(c.lastDay).toBe(day('20271231'));
    expect(c.hasShapes).toBe(true);
    // the bus has no shape; the train stops nowhere near the square but runs through it
    const bus = Array.from(c.tripRoute).findIndex((r) => c.routes[r].short === 'B2');
    expect(c.tripShape[bus]).toBe(-1);
    const s3 = Array.from(c.tripRoute).filter((r) => c.routes[r].short === 'S3').length;
    expect(s3).toBe(37);
    // the U-Bahn's one trip is run every 10 minutes
    expect(c.frequencies.length).toBe(4);
    expect(c.routes[c.tripRoute[c.frequencies[0]]].short).toBe('U4');
    // the busiest place of the whole file is around the centre, where the tram runs
    expect(c.busiest).not.toBeNull();
    expect(Math.abs(c.busiest!.lat - CENTRE.lat)).toBeLessThan(0.01);
    expect(Math.abs(c.busiest!.lon - CENTRE.lon)).toBeLessThan(0.02);
  });

  it('reads stop times out of order, and the same from a stored ZIP in a folder', async () => {
    const c = await cut();
    const again = await cutGtfs(blob(gtfsZip(CENTRE, { deflate: false, folder: 'feed/' })), { center: CENTRE, sizeM: SIZE });
    expect(again.tripRoute.length).toBe(c.tripRoute.length);
    expect(again.stStop.length).toBe(c.stStop.length);
    // the bus trip written out of order has its stops in order
    const k = Array.from(c.tripRoute).findIndex((r) => c.routes[r].short === 'B2');
    const ns = Array.from(c.stStop.slice(c.tripFirst[k], c.tripFirst[k + 1]), (s) => c.stopAt[s * 2 + 1]);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });

  it('keeps nothing for a square far from the lines, and still knows where they run', async () => {
    const far = { lat: CENTRE.lat + 0.2, lon: CENTRE.lon };
    const c = await cutGtfs(blob(gtfsZip(CENTRE)), { center: far, sizeM: SIZE });
    expect(c.tripRoute.length).toBe(0);
    expect(Math.abs(c.busiest!.lat - CENTRE.lat)).toBeLessThan(0.01);
    // a quick look without a square: only where it runs and its days
    const scan = await cutGtfs(blob(gtfsZip(CENTRE)), { center: CENTRE, sizeM: 0 });
    expect(scan.tripRoute.length).toBe(0);
    expect(scan.busiest).toEqual(c.busiest);
    expect(scan.lastDay).toBe(day('20271231'));
  });

  it('says what is wrong with a file that is not a timetable', async () => {
    const files = gtfsFiles(CENTRE);
    const noTimes = Object.fromEntries(Object.entries(files).filter(([n]) => n !== 'stop_times.txt'));
    await expect(cutGtfs(blob(zipFiles(noTimes)), { center: CENTRE, sizeM: SIZE })).rejects.toMatchObject({ kind: 'notGtfs' });
    await expect(cutGtfs(blob(zipFiles(noTimes)), { center: CENTRE, sizeM: SIZE })).rejects.toBeInstanceOf(GtfsProblem);
    await expect(cutGtfs(new Blob(['nope']), { center: CENTRE, sizeM: SIZE })).rejects.toMatchObject({ kind: 'notZip' });
  });
});

describe('runs through the square', () => {
  it('has the lines of a weekday, by mode, and the trips per hour', async () => {
    const r = await runs();
    const d = dayRuns(r, MONDAY);
    expect(d.lines.map((l) => `${l.mode}:${l.name}`)).toEqual(['rail:S3', 'subway:U4', 'tram:T1', 'bus:B2']);
    const per = runsPerHour(d);
    expect(per.reduce((a, b) => a + b, 0)).toBe(d.run.length);
    // the U-Bahn runs 06:00–08:50 every 10 minutes: 18 runs
    const u4 = new Set([routeIndex(r, 'U4')]);
    expect(runsPerHour(d, u4).reduce((a, b) => a + b, 0)).toBe(18);
    expect(runsPerHour(d, u4).slice(6, 9)).toEqual([6, 6, 6]);
    expect(d.most).toBeGreaterThan(0);
  });

  it('takes the evening before’s trips after midnight, and the weekend timetable on Christmas Day', async () => {
    const r = await runs();
    const tue = dayRuns(r, MONDAY + 1);
    const after = Array.from(tue.shift).filter((s) => s === -DAY_S).length;
    expect(after).toBeGreaterThan(0);
    // those are Monday's trams after midnight: they show in Tuesday's first hour
    expect(runsPerHour(tue)[0]).toBeGreaterThan(0);
    const xmas = dayRuns(r, day('20261225'));
    expect(xmas.lines.map((l) => l.name)).toEqual(['T1']);
    const sat = dayRuns(r, day('20261114'));
    expect(sat.lines.map((l) => l.name)).toEqual(['T1']);
  });

  it('moves a vehicle between its stops as the timetable has it', async () => {
    const r = await runs();
    const v: VehicleAt = { e: 0, n: 0, dx: 0, dy: 0 };
    // the first eastbound tram leaves the first stop (E −1500) at 05:00, 2 minutes a stop
    const tram = Array.from(r.runRoute).findIndex((x, i) => x === routeIndex(r, 'T1') && r.dep[r.runFirst[i]] <= 5 * 3600 + 400 && r.runHeadsign[i] === 'East');
    expect(tram).toBeGreaterThanOrEqual(0);
    // halfway between the stops at E −300 (05:04) and E 300 (05:06)
    expect(runAt(r, tram, 5 * 3600 + 300, v)).toBe(true);
    expect(Math.abs(v.e)).toBeLessThan(15);
    expect(v.dx).toBeGreaterThan(0.9);
    // standing at the stop at E −300 at 05:04
    runAt(r, tram, 5 * 3600 + 240, v);
    expect(v.e).toBeCloseTo(-300, 0);
    // before it comes into the square, it's outside: not shown
    expect(runAt(r, tram, 5 * 3600 + 30, v)).toBe(false);
    // the bus, without a shape, runs straight north along E 200
    const bus = Array.from(r.runRoute).indexOf(routeIndex(r, 'B2'));
    expect(runAt(r, bus, r.tIn[bus] + 60, v)).toBe(true);
    expect(v.e).toBeCloseTo(200, 1);
    expect(v.dy).toBeCloseTo(1, 3);
  });

  it('times a train running through without stopping by where it is on its line', async () => {
    const r = await runs();
    const s3 = Array.from(r.runRoute).indexOf(routeIndex(r, 'S3'));
    const start = r.dep[r.runFirst[s3]];
    // 8.5 km in 10 minutes: the square's corner at a third of the way, the opposite one at two thirds
    expect(r.tIn[s3] - start).toBeCloseTo(200, -1);
    expect(r.tOut[s3] - start).toBeCloseTo(400, -1);
  });

  it('puts stops on their line in order, on the right pass of a loop', () => {
    // out east, round a loop and back west 40 m from the way out, past the start
    const pts = [0, 0, 1000, 0, 1000, 40, 0, 40, -500, 40];
    const cum = cumulative(pts);
    // on the way out, at the turn, on the way back (closer to it than to the way out), and back past the start
    const d = projectStops(pts, cum, [10, 5, 500, 2, 900, 38, 300, 39, -200, 41]);
    expect(Array.from(d).map(Math.round)).toEqual([10, 500, 1140, 1740, 2240]);
    // a stop on the way out stays there, though the way back passes 35 m off
    const out = projectStops(pts, cum, [10, 0, 600, 3, 900, 5]);
    expect(Array.from(out).map(Math.round)).toEqual([10, 600, 900]);
  });

  it('finds where a line is in the square and cuts out a stretch', () => {
    const pts = [-3000, 0, 3000, 0];
    const cum = cumulative(pts);
    expect(spanInside(pts, cum, 1000)).toEqual([2000, 4000]);
    expect(spanInside([-3000, 2000, 3000, 2000], cumulative([-3000, 2000, 3000, 2000]), 1000)).toBeNull();
    expect(Array.from(stretch(pts, cum, 2000, 4000))).toEqual([-1000, 0, 1000, 0]);
  });

  it('shows the nearest day on the same weekday when the timetable doesn’t have the one asked for', () => {
    const first = day('20260101'); // a Thursday
    const last = day('20261212'); // a Saturday
    expect(dayWithin(MONDAY, first, last)).toBe(MONDAY);
    const after = dayWithin(day('20261216'), first, last); // a Wednesday after the end
    expect(weekday(after)).toBe(2);
    expect(after).toBeLessThanOrEqual(last);
    expect(after).toBeGreaterThan(last - 7);
    const before = dayWithin(day('20251229'), first, last); // a Monday before the start
    expect(weekday(before)).toBe(0);
    expect(before).toBeGreaterThanOrEqual(first);
  });
});

describe('transit lines in the 3D print', () => {
  it('raises lines by their trips, adding up where they meet, and keeps them wide enough', async () => {
    const r = await runs();
    const d = dayRuns(r, MONDAY);
    const mmPerM = 150 / SIZE;
    const pieces = transitForPrint(d, null, mmPerM);
    expect(pieces.length).toBeGreaterThan(3);
    let top = { raise: 0, at: [0, 0] as [number, number] };
    for (const p of pieces) {
      expect(p.widthM).toBeCloseTo(TRANSIT_PRINT_MM.width / mmPerM, 6);
      expect(p.raises!.length).toBe(p.pts.length);
      p.raises!.forEach((h, i) => {
        expect(h).toBeGreaterThanOrEqual(TRANSIT_PRINT_MM.low - 1e-9);
        expect(h).toBeLessThanOrEqual(TRANSIT_PRINT_MM.high + 1e-9);
        if (h > top.raise) top = { raise: h, at: p.pts[i] };
      });
      for (const [e, n] of p.pts) expect(Math.max(Math.abs(e), Math.abs(n))).toBeLessThanOrEqual(SIZE / 2 + 8);
    }
    // highest where the tram and the bus cross (E 200 on the tram's line)
    expect(top.raise).toBeCloseTo(TRANSIT_PRINT_MM.high, 6);
    expect(Math.hypot(top.at[0] - 200, top.at[1])).toBeLessThan(25);
    // one line picked: only its trips
    const u4 = transitForPrint(d, new Set([routeIndex(r, 'U4')]), mmPerM);
    expect(u4.length).toBe(1);
  });

  it('samples a line evenly, ends included', () => {
    const pts = resample([0, 0, 25, 0], 8);
    expect(pts.map((p) => p[0])).toEqual([0, 8, 16, 25]);
  });
});
