import { describe, expect, it } from 'vitest';
import { catalogCsv, gtfsFiles, gtfsZip, zipFiles } from '../e2e/fixtures/transit.mjs';
import { feedAreaKm2, feedsFor, licenceName, parseCatalog } from '../src/data/sources/feedCatalog';
import { findItem, listZip, openItem, ZipProblem } from '../src/data/sources/zipFile';
import { crossesBox, cutGtfs, GtfsProblem, modeOf, parseDay, parseTime, runsOn, splitCsv, weekday, type GtfsCut } from '../src/data/sources/gtfs';
import { cumulative, DAY_S, dayRuns, dayWithin, distanceAt, makeRuns, mergeRuns, stretchOn, projectStops, runAt, runsPerHour, spanInside, stretch, type TransitRuns, type VehicleAt } from '../src/data/match/transit';
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

  it('says how far along a vehicle is, and the stretch of line it covered (for trails)', async () => {
    const r = await runs();
    const tram = Array.from(r.runRoute).findIndex((x, i) => x === routeIndex(r, 'T1') && r.runHeadsign[i] === 'East');
    const first = r.runFirst[tram];
    // before its first stop and after its last it stays there
    expect(distanceAt(r, tram, r.dep[first] - 600)).toBe(r.at[first]);
    expect(distanceAt(r, tram, 99 * 3600)).toBe(r.at[r.runFirst[tram + 1] - 1]);
    const t = r.tIn[tram] + 90;
    const m1 = distanceAt(r, tram, t);
    const m0 = distanceAt(r, tram, t - 120);
    expect(m1).toBeGreaterThan(m0);
    const line = stretchOn(r.paths[r.runPath[tram]], m0, m1, []);
    // its ends are where the vehicle was and is
    const v: VehicleAt = { e: 0, n: 0, dx: 0, dy: 0 };
    runAt(r, tram, t, v);
    expect(line[line.length - 2]).toBeCloseTo(v.e, 3);
    let len = 0;
    for (let k = 2; k < line.length; k += 2) len += Math.hypot(line[k] - line[k - 2], line[k + 1] - line[k - 1]);
    expect(len).toBeCloseTo(m1 - m0, 1);
    expect(stretchOn(r.paths[r.runPath[tram]], m1, m1, [1, 2])).toEqual([]);
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

describe('several timetables at once', () => {
  it('shows another operator’s lines with the first one’s, each run where it was', async () => {
    const a = await runs();
    const other = await cutGtfs(blob(gtfsZip(CENTRE, { tag: 'x' })), { center: CENTRE, sizeM: SIZE });
    const b = makeRuns(other, SIZE);
    const m = mergeRuns([a, b]);
    expect(m.routes.length).toBe(a.routes.length + b.routes.length);
    expect(m.tIn.length).toBe(a.tIn.length + b.tIn.length);
    expect(m.runFirst.length).toBe(m.tIn.length + 1);
    expect(m.runFirst[m.runFirst.length - 1]).toBe(m.at.length);
    const d = dayRuns(m, MONDAY);
    expect(d.lines.map((l) => l.name)).toEqual(['S3', 'S3x', 'U4', 'U4x', 'T1', 'T1x', 'B2', 'B2x']);
    expect(d.run.length).toBe(dayRuns(a, MONDAY).run.length + dayRuns(b, MONDAY).run.length);
    // a run of the second timetable is where it was in its own
    const k = a.tIn.length + 5;
    const v1: VehicleAt = { e: 0, n: 0, dx: 0, dy: 0 };
    const v2: VehicleAt = { e: 0, n: 0, dx: 0, dy: 0 };
    const t = b.tIn[5] + 30;
    expect(runAt(m, k, t, v1)).toBe(runAt(b, 5, t, v2));
    expect([v1.e, v1.n]).toEqual([v2.e, v2.n]);
    expect(m.routes[m.runRoute[k]].short).toBe(b.routes[b.runRoute[5]].short);
    expect(m.paths[m.runPath[k]].pts).toBe(b.paths[b.runPath[5]].pts);
    expect(mergeRuns([a])).toBe(a);
  });
});

describe('finding a place’s timetables', () => {
  const box = (lat: number, lon: number, d: number) => ({ south: lat - d, north: lat + d, west: lon - d * 1.6, east: lon + d * 1.6 });
  const csv = catalogCsv([
    { id: 'region', provider: 'Regional, Buses & Trains', ...box(53.55, 9.99, 0.6), url: 'https://files.example/region/latest.zip', licence: 'https://www.govdata.de/dl-de/by-2-0' },
    { id: 'city', provider: 'City Trams', name: 'Trams and buses', place: 'Hamburg', ...box(53.55, 9.99, 0.08), url: 'https://files.example/city/latest.zip', licence: 'https://creativecommons.org/licenses/by/4.0/' },
    { id: 'far', provider: 'Far Away Buses', ...box(48.1, 11.6, 0.1), url: 'https://files.example/far/latest.zip' },
    { id: 'old', provider: 'Old Feed', ...box(53.55, 9.99, 0.05), url: 'https://files.example/old/latest.zip', status: 'deprecated' },
    { id: 'key', provider: 'Needs A Key', ...box(53.55, 9.99, 0.05), url: 'https://files.example/key/latest.zip', auth: '2' },
    { id: 'rt', provider: 'Live Positions', ...box(53.55, 9.99, 0.05), url: 'https://files.example/rt/latest.zip', type: 'gtfs_rt' },
    { id: 'nocopy', provider: 'No Copy', ...box(53.55, 9.99, 0.05), url: '' },
    { id: 'country', provider: 'A Whole Country', ...box(51, 10, 4), url: 'https://files.example/country/latest.zip' },
  ]);

  it('reads the list: timetables in use, open, with a copy to download and an area', () => {
    const feeds = parseCatalog(csv);
    expect(feeds.map((f) => f.id)).toEqual(['region', 'city', 'far', 'country']);
    const city = feeds[1];
    expect(city.provider).toBe('City Trams');
    expect(city.name).toBe('Trams and buses');
    expect(city.place).toBe('Hamburg');
    expect(city.url).toBe('https://files.example/city/latest.zip');
    expect(feeds[0].provider).toBe('Regional, Buses & Trains');
    expect(feedAreaKm2(feeds[0])).toBeGreaterThan(feedAreaKm2(city));
  });

  it('picks those for the place, the most local first, and leaves out a whole country’s', () => {
    const feeds = parseCatalog(csv);
    expect(feedsFor(feeds, { lat: 53.55, lon: 9.99 }).map((f) => f.id)).toEqual(['city', 'region']);
    expect(feedsFor(feeds, { lat: 48.1, lon: 11.6 }).map((f) => f.id)).toEqual(['far']);
    expect(feedsFor(feeds, { lat: 0, lon: 0 })).toEqual([]);
    expect(feedsFor(feeds, { lat: 53.55, lon: 9.99 }, 1).map((f) => f.id)).toEqual(['city']);
  });

  it('names common licences from their links', () => {
    expect(licenceName('https://www.govdata.de/dl-de/by-2-0')).toBe('dl-de/by-2-0');
    expect(licenceName('https://creativecommons.org/licenses/by/4.0/')).toBe('CC BY 4.0');
    expect(licenceName('https://creativecommons.org/licenses/by-sa/4.0/deed.de')).toBe('CC BY-SA 4.0');
    expect(licenceName('https://creativecommons.org/publicdomain/zero/1.0/deed.ja')).toBe('CC0');
    expect(licenceName('https://opendatacommons.org/licenses/odbl/1.0/')).toBe('ODbL');
    expect(licenceName('https://www.data.gouv.fr/pages/legal/licences/etalab-2.0')).toBe('Licence Ouverte');
    expect(licenceName('https://www.vag-freiburg.de/service-info')).toBeNull();
  });
});
