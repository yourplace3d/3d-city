import { describe, expect, it } from 'vitest';
import { parseTrafficCounts, trafficCovers, TrafficProblem, trafficUrl, TRAFFIC_API, type CountingPoint } from '../src/data/sources/hamburgTraffic';
import { busiestHour, HOURS, lastDay, MERGE_M, topColumns, valueAt, type TrafficDay } from '../src/data/match/traffic';
import { columnValues, fade, spreadStreets, streetValues, StreetNetwork, type StreetLine, type TrafficStreets } from '../src/data/match/trafficStreets';
import type { Pt } from '../src/data/types';
import { trafficColour, TRAFFIC_RAMP } from '../src/data/display/traffic';
import { Color } from 'three';
import { barShares, chartTicks } from '../src/data/display/trafficChart';
import { makeProjector, squareBBox } from '../src/geo/projection';

const HOUR = 3_600_000;
const CENTRE = { lat: 53.5511, lon: 9.9937 };
const T0 = Date.parse('2026-11-08T00:00:00Z');

/** one datastream as the API sends it */
function ds(id: number, lon: number, lat: number, counts: Array<[number, number]>) {
  return {
    '@iot.id': id,
    name: `Kfz-Aufkommen an Verkehrszählstelle ${id} im 1-Stunde-Intervall`,
    observedArea: { type: 'Point', coordinates: [lon, lat] },
    Observations: counts.map(([h, v]) => ({
      phenomenonTime: `${new Date(T0 + h * HOUR).toISOString().replace('.000Z', 'Z')}/${new Date(T0 + h * HOUR + HOUR - 1000).toISOString().replace('.000Z', 'Z')}`,
      result: v,
    })),
  };
}

/** a counting point at metres E, N of the centre */
function point(id: string, e: number, n: number, counts: Array<[number, number]>): CountingPoint {
  const ll = makeProjector(CENTRE).toLngLat(e, n);
  return { id, lon: ll.lon, lat: ll.lat, counts: new Map(counts.map(([h, v]) => [T0 + h * HOUR, v])) };
}

describe('Hamburg traffic counts: the source', () => {
  it('asks for one layer, inside the square, since an hour, leaving out retired points', () => {
    const box = squareBBox(CENTRE, 3000);
    const url = new URL(trafficUrl('cars', box, T0 + 30 * 60_000));
    expect(url.origin + url.pathname).toBe(`${TRAFFIC_API}/Datastreams`);
    const filter = url.searchParams.get('$filter')!;
    expect(filter).toContain("properties/layerName eq 'Anzahl_Kfz_Zaehlstelle_1-Stunde'");
    expect(filter).toContain("not substringof('veraltet', name)");
    expect(filter).toMatch(/st_within\(observedArea, geography'POLYGON\(\(9\.97\d+ 53\.53\d+, /);
    expect(url.searchParams.get('$expand')).toContain('phenomenonTime ge 2026-11-08T00:00:00Z;');
    expect(new URL(trafficUrl('bikes', box, T0)).searchParams.get('$filter')).toContain('Anzahl_Fahrraeder_Zaehlstelle_1-Stunde');
  });

  it('has counts for Hamburg only', () => {
    expect(trafficCovers(squareBBox(CENTRE, 3000))).toBe(true);
    expect(trafficCovers(squareBBox({ lat: 53.4609, lon: 9.9839 }, 2000))).toBe(true); // Harburg
    expect(trafficCovers(squareBBox({ lat: 48.7765, lon: 9.1772 }, 4000))).toBe(false); // Stuttgart
    expect(trafficCovers(squareBBox({ lat: 53.0793, lon: 8.8017 }, 4000))).toBe(false); // Bremen
  });

  it('reads counting points and their hourly counts, skipping anything without a place or counts', () => {
    const page = {
      value: [
        ds(1, 9.99, 53.55, [
          [0, 120],
          [1, 80],
        ]),
        ds(2, 9.98, 53.56, []),
        { '@iot.id': 3, name: 'no place', Observations: [{ phenomenonTime: '2026-11-08T00:00:00Z/2026-11-08T00:59:59Z', result: 5 }] },
        { ...ds(4, 10, 53.5, [[0, 7]]), Observations: [{ phenomenonTime: 'soon', result: 3 }, { phenomenonTime: '2026-11-08T02:00:00Z/x', result: -1 }, { phenomenonTime: '2026-11-08T03:00:00Z/x', result: 9 }] },
        null,
      ],
      '@iot.nextLink': `${TRAFFIC_API}/Datastreams?$skip=1000`,
    };
    const { points, next } = parseTrafficCounts(page);
    expect(points.map((p) => p.id)).toEqual(['1', '4']);
    expect([...points[0].counts.entries()]).toEqual([
      [T0, 120],
      [T0 + HOUR, 80],
    ]);
    expect([...points[1].counts.entries()]).toEqual([[T0 + 3 * HOUR, 9]]);
    expect(next).toBe(`${TRAFFIC_API}/Datastreams?$skip=1000`);
  });

  it('follows next pages only on the same server, and refuses an answer that isn’t one', () => {
    expect(parseTrafficCounts({ value: [], '@iot.nextLink': 'https://elsewhere.example/x' }).next).toBeNull();
    expect(() => parseTrafficCounts({ error: 'down' })).toThrow(TrafficProblem);
    expect(() => parseTrafficCounts(null)).toThrow(TrafficProblem);
  });
});

describe('Hamburg traffic counts: the last day, as columns', () => {
  it('takes the 24 hours up to the latest count that came in', () => {
    const day = lastDay([point('a', 0, 0, Array.from({ length: 30 }, (_, h) => [h, h * 10] as [number, number]))], CENTRE, 3000)!;
    expect(day.hours).toHaveLength(HOURS);
    expect(day.hours[HOURS - 1]).toBe(T0 + 29 * HOUR);
    expect(day.hours[0]).toBe(T0 + 6 * HOUR);
    expect(Array.from(day.columns[0].values)).toEqual(Array.from({ length: 24 }, (_, i) => (i + 6) * 10));
    expect(day.max).toBe(290);
  });

  it('adds up points a few metres apart (both directions of a road) and stands the column between them', () => {
    const counts: Array<[number, number]> = [
      [22, 100],
      [23, 200],
    ];
    const day = lastDay([point('n', 100, 100, counts), point('s', 106, 100, counts), point('far', 100 + MERGE_M + 30, 100, counts)], CENTRE, 3000)!;
    expect(day.columns).toHaveLength(2);
    const both = day.columns.find((c) => c.ids.length === 2)!;
    expect(both.ids).toEqual(['n', 's']);
    expect(both.at[0]).toBeCloseTo(103, 0);
    expect(both.values[23]).toBe(400);
    expect(day.totals[23]).toBe(600);
    expect(day.counted[23]).toBe(2);
  });

  it('leaves out points outside the square, keeps hours without counts empty, and has nothing without counts', () => {
    const day = lastDay(
      [
        point('in', 0, 0, [
          [10, 5],
          [12, 7],
        ]),
        point('out', 1600, 0, [[12, 900]]),
      ],
      CENTRE,
      3000,
    )!;
    expect(day.columns.map((c) => c.ids[0])).toEqual(['in']);
    expect(day.max).toBe(7);
    const i11 = day.hours.indexOf(T0 + 11 * HOUR);
    expect(Number.isNaN(day.columns[0].values[i11])).toBe(true);
    expect(day.totals[i11]).toBe(0);
    expect(day.counted[i11]).toBe(0);
    expect(lastDay([], CENTRE, 3000)).toBeNull();
  });

  it('grows the columns smoothly between hours while replaying', () => {
    const v = [10, 20, NaN, 40];
    expect(valueAt(v, 0)).toBe(10);
    expect(valueAt(v, 0.5)).toBe(15);
    expect(valueAt(v, 1.5)).toBe(10); // towards an hour without counts: down to nothing
    expect(valueAt(v, 3)).toBe(40);
    expect(valueAt(v, 7)).toBe(40);
  });

  it('finds the busiest hour and the busiest columns', () => {
    expect(busiestHour([1, 5, 3, 4])).toBe(1);
    // on a tie, the latest
    expect(busiestHour([1, 5, 3, 5])).toBe(3);
    expect(busiestHour([0, 0])).toBe(1);
    const day = lastDay(
      [point('a', 0, 0, [[0, 5]]), point('b', 300, 0, [[0, 50]]), point('c', 600, 0, [[0, 20]]), point('d', 900, 0, [[0, 0]])],
      CENTRE,
      3000,
    )!;
    const h = HOURS - 1;
    expect(topColumns(day, h, 2).map((i) => day.columns[i].ids[0])).toEqual(['b', 'c']);
    expect(topColumns(day, h, 9)).toHaveLength(3);
  });
});

describe('Hamburg traffic counts: the bar chart', () => {
  it('puts lines at round numbers and leaves room above the highest bar', () => {
    expect(chartTicks(37602)).toEqual({ top: 37602 * 1.08, ticks: [0, 20000] });
    expect(chartTicks(3705).ticks).toEqual([0, 2000]);
    expect(chartTicks(4161).ticks).toEqual([0, 2500]);
    expect(chartTicks(100).ticks).toEqual([0, 50, 100]);
    expect(chartTicks(0)).toEqual({ top: 1, ticks: [0] });
  });

  it('sizes bars against the top, with nothing for an hour without counts', () => {
    expect(barShares([0, 50, NaN, 100], 200)).toEqual([0, 0.25, 0, 0.5]);
  });
});

describe('Hamburg traffic counts: spread along the streets', () => {
  /** one column at (e, n) with `v` counted in every hour */
  const dayOf = (cols: Array<[number, number, number]>): TrafficDay => {
    const columns = cols.map(([e, n, v], i) => ({ ids: [String(i)], at: [e, n] as Pt, values: new Float32Array(HOURS).fill(v) }));
    return { hours: Array.from({ length: HOURS }, (_, i) => T0 + i * HOUR), columns, totals: [], counted: [], max: Math.max(...cols.map((c) => c[2])) };
  };
  const line = (kind: string, ...pts: Pt[]): StreetLine => ({ kind, pts, widthM: 10, bridge: false });
  /** the value at the sample nearest to a point */
  const valueNear = (s: TrafficStreets, values: Float32Array, p: Pt) => {
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < s.streetSamples; k++) {
      const d = Math.hypot(s.at[2 * k] - p[0], s.at[2 * k + 1] - p[1]);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return values[best];
  };

  it('fades a count out over the spread distance', () => {
    expect(fade(0, 200)).toBe(1);
    expect(fade(100, 200)).toBeCloseTo(0.5625);
    expect(fade(200, 200)).toBe(0);
    expect(fade(250, 200)).toBe(0);
  });

  it('spreads a count along its street both ways, and not to a street nearby that isn’t joined to it', () => {
    const net = new StreetNetwork([line('primary', [-500, 0], [500, 0]), line('primary', [-500, 40], [500, 40])], 'cars');
    const day = dayOf([[0, 2, 1000]]);
    const s = spreadStreets(net, day, 200);
    const v = streetValues(s, columnValues(day, 0));
    expect(valueNear(s, v, [0, 0])).toBeCloseTo(1000, -1);
    expect(valueNear(s, v, [100, 0])).toBeCloseTo(562.5, -1);
    expect(valueNear(s, v, [-100, 0])).toBeCloseTo(562.5, -1);
    // the parallel street 40 m away gets nothing: it isn't joined, so it has no samples at all
    for (let k = 0; k < s.streetSamples; k++) expect(s.at[2 * k + 1]).toBe(0);
    // where the column sits: its own count
    expect(v[s.streetSamples]).toBeCloseTo(1000);
    expect(s.onStreet).toEqual([true]);
    expect(s.max).toBeCloseTo(1000);
    // the runs reach to where the count has faded out, a sample past it
    const xs = Array.from({ length: s.streetSamples }, (_, k) => s.at[2 * k]);
    expect(Math.min(...xs)).toBeCloseTo(-200, 0);
    expect(Math.max(...xs)).toBeCloseTo(200, 0);
  });

  it('fades four times as fast into a smaller street, and adds counts up where they meet', () => {
    // a main road east–west, a side street north from its middle
    const net = new StreetNetwork([line('primary', [-500, 0], [0, 0], [500, 0]), line('minor', [0, 0], [0, 300])], 'cars');
    const day = dayOf([
      [-50, 0, 800],
      [50, 0, 800],
    ]);
    const s = spreadStreets(net, day, 400);
    const v = streetValues(s, columnValues(day, 0));
    // the crossing between the two gets both
    const crossing = 2 * 800 * fade(50, 400);
    expect(valueNear(s, v, [0, 0])).toBeCloseTo(crossing, 0);
    expect(valueNear(s, v, [0, 0])).toBeGreaterThan(800);
    // 40 m up the side street: (50 + 4 × 40) m of fade for each
    expect(valueNear(s, v, [0, 40])).toBeCloseTo(2 * 800 * fade(50 + 4 * 40, 400), 0);
    // a side street's count spreads along the main road as fast as along its own
    const side = spreadStreets(net, dayOf([[0, 100, 500]]), 400);
    const sv = streetValues(side, new Float32Array([500]));
    expect(valueNear(side, sv, [100, 0])).toBeCloseTo(500 * fade(200, 400), 0);
  });

  it('joins lines that meet (or are cut at a tile’s edge) and leaves out what isn’t a street for the mode', () => {
    const net = new StreetNetwork(
      [line('secondary', [0, 0], [100, 0]), line('secondary', [100.1, 0.1], [200, 0]), line('path', [0, 0], [0, 100]), line('rail', [0, 0], [-100, 0]), line('river', [0, 0], [0, -100])],
      'cars',
    );
    expect(net.size).toBe(2);
    expect(net.chains).toHaveLength(1);
    expect(net.chains[0].nodes).toHaveLength(3);
    const bikes = new StreetNetwork([line('motorway', [0, 0], [100, 0]), line('path', [0, 0], [0, 100]), line('minor', [0, 100], [50, 100])], 'bikes');
    expect(bikes.size).toBe(2);
  });

  it('leaves a counting point that isn’t on a street as a point', () => {
    const net = new StreetNetwork([line('primary', [-500, 0], [500, 0])], 'cars');
    const day = dayOf([
      [0, 300, 700],
      [0, 0, 100],
    ]);
    const s = spreadStreets(net, day, 200);
    expect(s.onStreet).toEqual([false, true]);
    const v = streetValues(s, columnValues(day, 0));
    expect(v[s.streetSamples]).toBe(700);
    expect(s.at[2 * s.streetSamples + 1]).toBe(300);
    expect(s.max).toBe(700);
  });

  it('follows the hour: none counted is nothing', () => {
    const net = new StreetNetwork([line('primary', [-500, 0], [500, 0])], 'cars');
    const day = dayOf([[0, 0, 0]]);
    day.columns[0].values[3] = 400;
    day.columns[0].values[4] = NaN;
    const s = spreadStreets(net, day, 200);
    expect(s.max).toBe(400);
    expect(columnValues(day, 3.5)[0]).toBe(200);
    expect(Math.max(...streetValues(s, columnValues(day, 4)))).toBe(0);
  });
});

describe('Hamburg traffic counts: the reds', () => {
  it('runs from the roads’ white, through the lightest red, to the darkest, getting darker all the way', () => {
    expect(trafficColour(0).getHexString()).toBe('fbf9f5');
    expect(`#${trafficColour(0.06).getHexString()}`).toBe(TRAFFIC_RAMP[0]);
    expect(`#${trafficColour(1).getHexString()}`).toBe(TRAFFIC_RAMP[TRAFFIC_RAMP.length - 1]);
    const lum = (q: number) => {
      const c = trafficColour(q, new Color());
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    for (let q = 0; q < 1; q += 0.05) expect(lum(q + 0.05)).toBeLessThan(lum(q));
  });
});
