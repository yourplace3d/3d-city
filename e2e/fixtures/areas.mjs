/**
 * Made-up values per area around any centre, in the shapes statistics offices publish them, for
 * the unit tests and the end-to-end test of the Homes and Income layers. Metres E, N of the centre;
 * the model's square is 2 × 2 km (±1000 m).
 *
 *   gridCsv     the 2022 census's grid (semicolons, decimal commas, KLAMMERN for uncertain cells),
 *               100 m squares over ±1200 m: rents rising from south-west (about €6) to north-east
 *   censusZip   its ZIP: the 100 m and 1 km grids and a description, as the census ships them
 *   areasGeoJson four neighbourhoods, one per quarter, the way CBS's service gives them (one with a
 *               park cut out of it; one with its income kept secret)
 *   pointsCsv   single sales with latitude and longitude: three squares with enough of them, one without
 */

import { zipFiles } from './transit.mjs';

// ETRS89-LAEA Europe (EPSG:3035), forward: the census's grid
const DEG = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);
const q = (phi) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const qP = q(Math.PI / 2);
const beta0 = Math.asin(q(52 * DEG) / qP);
const Rq = A * Math.sqrt(qP / 2);
const D = (A * (Math.cos(52 * DEG) / Math.sqrt(1 - E2 * Math.sin(52 * DEG) ** 2))) / (Rq * Math.cos(beta0));

export function laea(lon, lat) {
  const beta = Math.asin(q(lat * DEG) / qP);
  const dl = lon * DEG - 10 * DEG;
  const B = Rq * Math.sqrt(2 / (1 + Math.sin(beta0) * Math.sin(beta) + Math.cos(beta0) * Math.cos(beta) * Math.cos(dl)));
  return [4321000 + B * D * Math.cos(beta) * Math.sin(dl), 3210000 + (B / D) * (Math.cos(beta0) * Math.sin(beta) - Math.sin(beta0) * Math.cos(beta) * Math.cos(dl))];
}

function toLatLon(center) {
  const phi = center.lat * DEG;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return (e, n) => [+(center.lat + n / mLat).toFixed(7), +(center.lon + e / mLon).toFixed(7)];
}

/** The rent of a cell, from its offset (cells) from the one at the centre: about €6 in the south-west to €18 in the north-east. */
export const rentAt = (i, j, n) => Math.round((12 + ((i + j) / (2 * n)) * 6) * 100) / 100;

/** The census's rent grid around `center`, as its CSV text. */
export function gridCsv(center, { cellM = 100, halfM = 1200 } = {}) {
  const [cx, cy] = laea(center.lon, center.lat);
  const x0 = Math.floor(cx / cellM) * cellM;
  const y0 = Math.floor(cy / cellM) * cellM;
  const n = Math.ceil(halfM / cellM);
  const res = cellM >= 1000 ? `${cellM / 1000}km` : `${cellM}m`;
  const rows = [`GITTER_ID_${res};x_mp_${res};y_mp_${res};durchschnMieteQM;werterlaeuternde_Zeichen`];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      // some squares have no rented homes
      if ((i * 7 + j * 3) % 11 === 0 && i !== 0) continue;
      const x = x0 + i * cellM;
      const y = y0 + j * cellM;
      const flag = (i * 5 + j) % 13 === 0 ? 'KLAMMERN' : '';
      rows.push(`CRS3035RES${cellM}mN${y}E${x};${x + cellM / 2};${y + cellM / 2};${rentAt(i, j, n).toFixed(2).replace('.', ',')};${flag}`);
    }
  }
  return rows.join('\n') + '\n';
}

/** The census's ZIP: 100 m and 1 km grids, and the description (here a stand-in). */
export function censusZip(center) {
  return zipFiles({
    'Datensatzbeschreibung_Durchschn_Nettokaltmiete_Gitterzellen.xlsx': 'not a spreadsheet',
    'Zensus2022_Durchschn_Nettokaltmiete_100m-Gitter.csv': gridCsv(center),
    'Zensus2022_Durchschn_Nettokaltmiete_1km-Gitter.csv': gridCsv(center, { cellM: 1000, halfM: 4000 }),
  });
}

/** The four quarters' figures: home value (€1,000s), income per resident (€1,000s; −99997 = secret), people. */
export const QUARTERS = [
  { name: 'North-east', e: [0, 1200], n: [0, 1200], value: 700, income: 45, people: 1200 },
  { name: 'North-west', e: [-1200, 0], n: [0, 1200], value: 500, income: 35, people: 800 },
  { name: 'South-west', e: [-1200, 0], n: [-1200, 0], value: 600, income: 30, people: 400 },
  { name: 'South-east', e: [0, 1200], n: [-1200, 0], value: 400, income: -99997, people: 950 },
];

/** Four neighbourhoods around `center` as GeoJSON (an object); `tag` ends their names. */
export function areasGeoJson(center, { tag = '' } = {}) {
  const ll = toLatLon(center);
  const ring = (e0, n0, e1, n1, ccw = true) => {
    const pts = [[e0, n0], [e1, n0], [e1, n1], [e0, n1], [e0, n0]];
    return (ccw ? pts : pts.reverse()).map(([e, n]) => ll(e, n).reverse());
  };
  return {
    type: 'FeatureCollection',
    features: QUARTERS.map((qr, k) => ({
      type: 'Feature',
      id: `buurten.${k}`,
      properties: {
        buurtcode: `BU0363${k}`,
        buurtnaam: `${qr.name}${tag}`,
        water: 'NEE',
        meestVoorkomendePostcode: `101${k}`,
        aantalInwoners: qr.people,
        gemiddeldeWoningwaarde: qr.value,
        gemiddeldInkomenPerInwoner: qr.income,
        jaarStatcode: 2024,
      },
      // the north-east has a park in it
      geometry: {
        type: 'Polygon',
        coordinates: k === 0 ? [ring(qr.e[0], qr.n[0], qr.e[1], qr.n[1]), ring(200, 200, 500, 500, false)] : [ring(qr.e[0], qr.n[0], qr.e[1], qr.n[1])],
      },
    })),
  };
}

/** Single sales (price per m²) with latitude and longitude, as a CSV: squares of 100 m with 6, 6, 7 and 3 sales. */
export function pointsCsv(center) {
  const ll = toLatLon(center);
  const rows = ['id,latitude,longitude,prix_m2,commune'];
  const square = (e0, n0, prices) => prices.forEach((p, k) => {
    const [lat, lon] = ll(e0 + 10 + k * 12, n0 + 20 + (k % 3) * 25);
    rows.push(`${rows.length},${lat},${lon},${p},"Testville"`);
  });
  square(100, 100, [3000, 3200, 3100, 2900, 5000, 3050]);
  square(-300, 200, [4000, 4100, 3900, 4200, 4050, 3950]);
  square(-500, -500, [2000, 2100, 2200, 1900, 2050, 2150, 1800]);
  // too few to show
  square(600, -700, [9000, 9100, 8900]);
  return rows.join('\n') + '\n';
}
