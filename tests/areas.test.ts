import { describe, expect, it } from 'vitest';
import { zipFiles } from '../e2e/fixtures/transit.mjs';
import { areasGeoJson, censusZip, gridCsv, laea, pointsCsv, QUARTERS } from '../e2e/fixtures/areas.mjs';
import { epsgOf, laeaForward, laeaInverse, toLonLatFor, utmForward, utmInverse } from '../src/geo/crs';
import { makeProjector } from '../src/geo/projection';
import { AreaProblem, cutAreas, parseCellId, parseValue, pickPart, separatorOf, titlesFromMetadata, type AreaCut } from '../src/data/sources/areaFile';
import { AREA_PROVIDERS, pickColumn, profileOf, providersFor } from '../src/data/sources/areaProviders';
import { AreaIndex, areasFor, classBreaks, classOf, insideShape, median, MIN_POINTS, roundNicely, shareBelow } from '../src/data/match/areas';

const CENTRE = { lat: 48.7765, lon: 9.1772 };
const AREA = { center: CENTRE, sizeM: 2000 };
const blob = (data: Uint8Array | string) => new Blob([data as BlobPart]);
const cut = (data: Uint8Array | string, name = 'file') => cutAreas(blob(data), name, AREA);
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof AreaProblem ? e.kind : String(e);
  }
  return null;
};

describe('map projections', () => {
  it('turns the European grid (EPSG:3035) into longitude and latitude and back', () => {
    // EPSG's own worked example: 50° N, 5° E
    const [x, y] = laeaForward(5, 50);
    expect(x).toBeCloseTo(3962799.45, 1);
    expect(y).toBeCloseTo(2999718.85, 1);
    const [lon, lat] = laeaInverse(x, y);
    expect(lon).toBeCloseTo(5, 7);
    expect(lat).toBeCloseTo(50, 7);
    // the test fixture's own copy agrees
    expect(laea(9.1772, 48.7765)[0]).toBeCloseTo(laeaForward(9.1772, 48.7765)[0], 3);
  });

  it('turns UTM into longitude and latitude and back, north and south', () => {
    expect(utmForward(3, 0, 31)).toEqual([500000, 0]);
    // Hamburg in ETRS89 / UTM 32N, as its land values come
    const [lon, lat] = utmInverse(563574, 5940473, 32);
    expect(lon).toBeCloseTo(9.9609, 3);
    expect(lat).toBeCloseTo(53.6092, 3);
    for (const [lo, la, zone, south] of [[9.96, 53.6, 32, false], [-46.63, -23.55, 23, true], [151.2, -33.87, 56, true]] as const) {
      const [x, y] = utmForward(lo, la, zone, south);
      const back = utmInverse(x, y, zone, south);
      expect(back[0]).toBeCloseTo(lo, 6);
      expect(back[1]).toBeCloseTo(la, 6);
    }
  });

  it('knows a projection by its name in a file', () => {
    expect(epsgOf('urn:ogc:def:crs:OGC:1.3:CRS84')).toBe(4326);
    expect(epsgOf('urn:ogc:def:crs:EPSG::25832')).toBe(25832);
    expect(epsgOf('EPSG:3035')).toBe(3035);
    expect(epsgOf('http://www.opengis.net/def/crs/EPSG/0/28992')).toBe(28992);
    expect(toLonLatFor(4326)!(9, 48)).toEqual([9, 48]);
    // Germany's UTM with the zone in front of the easting
    const [x, y] = utmForward(9.96, 53.6, 32);
    const [lon] = toLonLatFor(4647)!(x + 32000000, y);
    expect(lon).toBeCloseTo(9.96, 6);
    // the Dutch national grid isn't one we know: the app asks for longitude and latitude
    expect(toLonLatFor(28992)).toBeNull();
  });
});

describe('values in files', () => {
  it('reads numbers the way statistics offices write them, and leaves out their placeholders', () => {
    expect(parseValue('6,26', true)).toBe(6.26);
    expect(parseValue('1.234,5', true)).toBe(1234.5);
    expect(parseValue('6.26')).toBe(6.26);
    expect(parseValue('6,26')).toBe(6.26);
    expect(parseValue('1,234,567')).toBe(1234567);
    expect(parseValue(' 12 ')).toBe(12);
    expect(parseValue(250001)).toBe(250001);
    // "secret" or "not available": CBS, the US Census
    expect(parseValue(-99997)).toBeNaN();
    expect(parseValue(-666666666)).toBeNaN();
    expect(parseValue('–')).toBeNaN();
    expect(parseValue('.')).toBeNaN();
    expect(parseValue('KLAMMERN')).toBeNaN();
    expect(parseValue(null)).toBeNaN();
  });

  it('reads grid cells’ codes and a CSV’s separator', () => {
    expect(parseCellId('CRS3035RES100mN2691700E4341100')).toEqual({ crs: 3035, size: 100, n: 2691700, e: 4341100 });
    expect(parseCellId('CRS3035RES1000mN2691000E4341000')?.size).toBe(1000);
    // Eurostat's older codes count in cells
    expect(parseCellId('1kmN2689E4337')).toEqual({ crs: 3035, size: 1000, n: 2689000, e: 4337000 });
    expect(parseCellId('Testville')).toBeNull();
    expect(separatorOf('a;b;c')).toBe(';');
    expect(separatorOf('a,b,c')).toBe(',');
    expect(separatorOf('a\tb')).toBe('\t');
  });

  it('picks the finest grid of an archive, and GeoJSON over its metadata', () => {
    const item = (name: string, size = 10) => ({ name, size, method: 8, packed: size, offset: 0 });
    expect(pickPart([item('Zensus_10km-Gitter.csv'), item('Zensus_100m-Gitter.csv', 5), item('Zensus_1km-Gitter.csv'), item('Beschreibung.xlsx')])?.name).toBe('Zensus_100m-Gitter.csv');
    expect(pickPart([item('x/metadata.json'), item('x/latest_B19013.geojson')])?.name).toBe('x/latest_B19013.geojson');
    expect(pickPart([item('readme.pdf')])).toBeNull();
    expect(titlesFromMetadata('{"tables":{"B19013":{"columns":{"B19013001":{"name":"Median household income"}}}}}')).toEqual({ B19013001: 'Median household income' });
  });
});

describe('reading files for a square', () => {
  it('reads the census grid: the squares in the model’s square, their rents, and the uncertain ones', async () => {
    const c = await cut(gridCsv(CENTRE));
    expect(c.geometry).toBe('cells');
    expect(c.cellM).toBe(100);
    expect(c.columns).toEqual(['durchschnMieteQM']);
    // 25 × 25 squares in the file; about 22 × 22 reach into the 2 km square (with its margin), less the empty ones
    expect(c.inFile).toBeGreaterThan(500);
    expect(c.features.length).toBeGreaterThan(400);
    expect(c.features.length).toBeLessThan(c.inFile);
    expect(c.features.some((f) => f.uncertain)).toBe(true);
    // each square is a ring of four corners about 100 m apart, near the centre
    const ring = c.features[0].rings[0];
    expect(ring).toHaveLength(8);
    expect(Math.hypot(ring[2] - ring[0], ring[3] - ring[1])).toBeCloseTo(100, -0.5);
    // the rent rises to the north-east
    const v = c.values[0];
    const mean = (ne: boolean) => {
      const ks = c.features.map((f, k) => [f.rings[0][0], f.rings[0][1], k]).filter(([e, n]) => (ne ? e > 300 && n > 300 : e < -300 && n < -300)).map(([, , k]) => v[k]);
      return ks.reduce((s, x) => s + x, 0) / ks.length;
    };
    expect(mean(true)).toBeGreaterThan(mean(false) + 3);
    expect(c.extent!.south).toBeLessThan(CENTRE.lat);
    expect(c.extent!.north).toBeGreaterThan(CENTRE.lat);
  });

  it('reads the census ZIP as it comes, from its finest grid', async () => {
    const c = await cut(censusZip(CENTRE), 'Zensus2022_Durchschn_Nettokaltmiete.zip');
    expect(c.part).toBe('Zensus2022_Durchschn_Nettokaltmiete_100m-Gitter.csv');
    expect(c.cellM).toBe(100);
  });

  it('reads neighbourhoods from GeoJSON: names, the columns with numbers, holes, secrets', async () => {
    const c = await cut(JSON.stringify(areasGeoJson(CENTRE)), 'buurten.json');
    expect(c.geometry).toBe('shapes');
    expect(c.features.map((f) => f.name)).toEqual(QUARTERS.map((q) => q.name));
    // codes, postcodes and years are not values
    expect(c.columns).toEqual(['aantalInwoners', 'gemiddeldeWoningwaarde', 'gemiddeldInkomenPerInwoner']);
    const income = c.values[c.columns.indexOf('gemiddeldInkomenPerInwoner')];
    expect([...income].map((x) => (Number.isNaN(x) ? null : x))).toEqual([45, 35, 30, null]);
    const areas = areasFor(c, c.columns.indexOf('gemiddeldeWoningwaarde'));
    const ne = areas.shapes[0];
    expect(insideShape(ne, 800, 800)).toBe(true);
    // the park in the north-east is not part of it
    expect(insideShape(ne, 350, 350)).toBe(false);
    expect(ne.size).toBeCloseTo(1200 * 1200 - 300 * 300, -3);
  });

  it('reads GeoJSON in a projection, named or not', async () => {
    const geo = areasGeoJson(CENTRE);
    const utm = (ring: number[][]) => ring.map(([lon, lat]) => utmForward(lon, lat, 32));
    const projected = { ...geo, features: geo.features.map((f) => ({ ...f, geometry: { ...f.geometry, coordinates: f.geometry.coordinates.map(utm) } })) };
    for (const doc of [{ ...projected, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::25832' } } }, projected]) {
      const c = await cut(JSON.stringify(doc));
      const s = areasFor(c, 1).shapes;
      expect(s).toHaveLength(4);
      expect(insideShape(s[0], 800, 800)).toBe(true);
    }
    expect(await problem(cut(JSON.stringify({ ...projected, crs: { type: 'name', properties: { name: 'EPSG:28992' } } })))).toBe('projection');
  });

  it('reads Census Reporter’s download: a ZIP with GeoJSON and the columns’ titles', async () => {
    const geo = areasGeoJson(CENTRE);
    geo.features.forEach((f, k) => (f.properties = { geoid: `15000US0607501010${k}`, name: `BG ${k}`, B25077001: 900000 + k * 1000, 'B25077001, Error': 5000 }));
    const zip = zipFiles({
      'latest_B25077/latest_B25077.geojson': JSON.stringify(geo),
      'latest_B25077/metadata.json': JSON.stringify({ tables: { B25077: { columns: { B25077001: { name: 'Median value (dollars)' } } } } }),
    });
    const c = await cut(zip, 'latest_B25077.zip');
    expect(c.columns).toEqual(['B25077001']);
    expect(c.titles).toEqual({ B25077001: 'Median value (dollars)' });
    expect(c.features[0].name).toBe('BG 0');
  });

  it('reads single points and shows only medians of squares with enough of them', async () => {
    const c = await cut(pointsCsv(CENTRE), 'sales.csv');
    expect(c.geometry).toBe('points');
    expect(c.columns).toEqual(['prix_m2']);
    const areas = areasFor(c, 0);
    expect(areas.shapes.map((s) => [s.value, s.count]).sort((a, b) => a[0] - b[0])).toEqual([
      [2050, 7],
      [3075, 6],
      [4025, 6],
    ]);
    expect(MIN_POINTS).toBe(5);
  });

  it('reads files in Windows-1252, and says what’s wrong with one it can’t use', async () => {
    const latin = new Uint8Array([...new TextEncoder().encode('lat;lon;Name;Wert\n48,7765;9,1772;'), 0x53, 0x74, 0x72, 0x61, 0xdf, 0x65, ...new TextEncoder().encode(';5,5\n')]);
    const c = await cut(latin, 'old.csv');
    expect(c.features[0].name).toBe('Straße');
    expect(c.values[0][0]).toBe(5.5);
    expect(await problem(cut('hello there\n'))).toBe('noPlace');
    expect(await problem(cut('{"type":"FeatureCollection","features":[]}'))).toBe('noValues');
    expect(await problem(cut('{"oops'))).toBe('unreadable');
    expect(await problem(cut('lat,lon,name\n48.7765,9.1772,a\n'))).toBe('noValues');
    expect(await problem(cut(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])))).toBe('sevenZip');
    expect(await problem(cut(zipFiles({ 'readme.pdf': 'x' })))).toBe('unreadable');
  });

  it('gives no areas, and where the file has data, when none are in the square', async () => {
    const far = { lat: CENTRE.lat + 0.2, lon: CENTRE.lon };
    const c = await cut(JSON.stringify(areasGeoJson(far)));
    expect(c.features).toHaveLength(0);
    expect((c.extent!.north + c.extent!.south) / 2).toBeCloseTo(far.lat, 2);
    const g = await cut(gridCsv(far));
    expect(g.features).toHaveLength(0);
    expect((g.extent!.north + g.extent!.south) / 2).toBeCloseTo(far.lat, 2);
  });
});

describe('values on the model', () => {
  it('finds the area a point is in, the smallest where they overlap', () => {
    const square = (e0: number, n0: number, s: number) => ({ rings: [Float32Array.of(e0, n0, e0 + s, n0, e0 + s, n0 + s, e0, n0 + s)], e0, n0, e1: e0 + s, n1: n0 + s, size: s * s, value: s, name: '', uncertain: false, count: 1 });
    const index = new AreaIndex([square(-1000, -1000, 2000), square(100, 100, 200), square(-900, -900, 100)], 2000);
    expect(index.at(150, 150)).toBe(1);
    expect(index.at(-850, -850)).toBe(2);
    expect(index.at(0, 0)).toBe(0);
    expect(index.at(1200, 0)).toBe(-1);
  });

  it('splits the values into fifths, rounded nicely', () => {
    expect(roundNicely(8.37)).toBe(8.4);
    expect(roundNicely(602)).toBe(600);
    expect(roundNicely(111364)).toBe(110000);
    const values = Array.from({ length: 100 }, (_, k) => 5 + k * 0.1);
    const b = classBreaks(values);
    expect(b).toEqual([7, 9, 11, 13]);
    expect(classOf(5, b)).toBe(0);
    expect(classOf(9, b)).toBe(2);
    expect(classOf(14.9, b)).toBe(4);
    expect(shareBelow(10, values)).toBeCloseTo(0.5, 1);
    // the same value everywhere: one class
    expect(classBreaks([3, 3, 3, 3])).toEqual([]);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('where to get values', () => {
  it('lists the open sources we know for a place', () => {
    const ids = (layer: 'homes' | 'income', lat: number, lon: number) => providersFor(layer, lat, lon).map((p) => p.id);
    expect(ids('homes', 47.99555, 7.85065)).toEqual(['de-census-rent']);
    expect(ids('income', 47.99555, 7.85065)).toEqual([]);
    expect(ids('homes', 52.37, 4.895)).toEqual(['nl-cbs-homes']);
    expect(ids('income', 52.37, 4.895)).toEqual(['nl-cbs-income']);
    expect(ids('income', 37.7749, -122.4194)).toEqual(['us-acs-income']);
    expect(ids('homes', 61.2, -149.9)).toEqual(['us-acs-homes']);
    expect(ids('homes', -33.87, 151.2)).toEqual([]);
    // every source either loads in one tap or links to its download
    for (const p of AREA_PROVIDERS) expect(!!p.load || !!p.link).toBe(true);
  });

  it('asks CBS for the square’s box only, in longitude and latitude', () => {
    const p = AREA_PROVIDERS.find((x) => x.id === 'nl-cbs-homes')!;
    const url = new URL(p.load!({ south: 52.36, west: 4.88, north: 52.38, east: 4.91 }));
    expect(url.host).toBe('service.pdok.nl');
    expect(url.searchParams.get('bbox')).toBe('52.36000,4.88000,52.38000,4.91000,urn:ogc:def:crs:EPSG::4326');
    expect(url.searchParams.get('outputFormat')).toBe('application/json');
  });

  it('knows the columns of the files it points to, for each layer', () => {
    expect(profileOf('durchschnMieteQM')?.measure).toBe('rentM2');
    expect(profileOf('GEMIDDELDEWONINGWAARDE')?.scale).toBe(1000);
    expect(profileOf('B19013001')?.layer).toBe('income');
    expect(profileOf('aantalInwoners')).toBeNull();
    const cols = ['aantalInwoners', 'gemiddeldeWoningwaarde', 'gemiddeldInkomenPerInwoner'];
    expect(pickColumn(cols, 'homes')).toBe(1);
    expect(pickColumn(cols, 'income')).toBe(2);
    expect(pickColumn(['aantalInwoners'], 'homes')).toBe(0);
  });

  it('places the square the same way as the rest of the model', async () => {
    // a point 500 m east of the centre lands 500 m east on the model
    const p = makeProjector(CENTRE).toLngLat(500, 0);
    const c: AreaCut = await cut(`lat,lon,v\n${Array.from({ length: 5 }, () => `${p.lat},${p.lon},1`).join('\n')}\n`);
    expect(c.features[0].rings[0][0]).toBeCloseTo(500, 3);
  });
});
