/**
 * How well is each city mapped? For a square around each city centre, counts the buildings in the
 * same vector tiles the app uses, and how many have a real height (OpenMapTiles gives buildings
 * without one a placeholder of 5 m). Prints a ranked table and writes survey-out/survey.{json,md}.
 *
 *   node tools/survey/survey.mjs            # every city below, 2 km squares
 *   SURVEY_KM=1 node tools/survey/survey.mjs
 *
 * Counts are approximate: a building cut by a tile edge counts once per tile it reaches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const Z = 14;
const SIZE_M = Number(process.env.SURVEY_KM || 2) * 1000;

/** [name, country, lat, lon]: a central point of each city. */
export const CITIES = [
  // Europe
  ['Berlin Mitte', 'DE', 52.5200, 13.4050],
  ['Munich', 'DE', 48.1374, 11.5755],
  ['Hamburg', 'DE', 53.5503, 9.9930],
  ['Stuttgart', 'DE', 48.7765, 9.1772],
  ['Cologne', 'DE', 50.9384, 6.9583],
  ['Vienna', 'AT', 48.2082, 16.3719],
  ['Zurich', 'CH', 47.3729, 8.5410],
  ['Paris', 'FR', 48.8566, 2.3522],
  ['Lyon', 'FR', 45.7578, 4.8320],
  ['Amsterdam', 'NL', 52.3728, 4.8936],
  ['Rotterdam', 'NL', 51.9225, 4.4792],
  ['Brussels', 'BE', 50.8467, 4.3525],
  ['London', 'GB', 51.5115, -0.1160],
  ['Manchester', 'GB', 53.4808, -2.2426],
  ['Edinburgh', 'GB', 55.9496, -3.1835],
  ['Dublin', 'IE', 53.3498, -6.2603],
  ['Madrid', 'ES', 40.4168, -3.7038],
  ['Barcelona', 'ES', 41.3874, 2.1686],
  ['Lisbon', 'PT', 38.7139, -9.1365],
  ['Porto', 'PT', 41.1496, -8.6109],
  ['Rome', 'IT', 41.8986, 12.4769],
  ['Milan', 'IT', 45.4642, 9.1900],
  ['Naples', 'IT', 40.8518, 14.2681],
  ['Warsaw', 'PL', 52.2297, 21.0122],
  ['Kraków', 'PL', 50.0614, 19.9372],
  ['Prague', 'CZ', 50.0875, 14.4213],
  ['Budapest', 'HU', 47.4979, 19.0402],
  ['Copenhagen', 'DK', 55.6761, 12.5683],
  ['Stockholm', 'SE', 59.3293, 18.0686],
  ['Oslo', 'NO', 59.9139, 10.7522],
  ['Helsinki', 'FI', 60.1699, 24.9384],
  ['Athens', 'GR', 37.9755, 23.7348],
  ['Istanbul', 'TR', 41.0082, 28.9784],
  // the Americas
  ['New York Midtown', 'US', 40.7549, -73.9840],
  ['Chicago Loop', 'US', 41.8826, -87.6278],
  ['San Francisco', 'US', 37.7935, -122.4075],
  ['Los Angeles Downtown', 'US', 34.0480, -118.2510],
  ['Seattle', 'US', 47.6062, -122.3321],
  ['Boston', 'US', 42.3581, -71.0601],
  ['Toronto', 'CA', 43.6510, -79.3820],
  ['Vancouver', 'CA', 49.2827, -123.1207],
  ['Montreal', 'CA', 45.5048, -73.5772],
  ['Mexico City Centro', 'MX', 19.4337, -99.1385],
  ['Mexico City Reforma', 'MX', 19.4240, -99.1740],
  ['Guadalajara', 'MX', 20.6767, -103.3475],
  ['Monterrey', 'MX', 25.6714, -100.3090],
  ['Bogotá', 'CO', 4.6097, -74.0817],
  ['Medellín', 'CO', 6.2476, -75.5658],
  ['Lima', 'PE', -12.0464, -77.0428],
  ['Santiago', 'CL', -33.4378, -70.6505],
  ['Buenos Aires', 'AR', -34.6037, -58.3816],
  ['São Paulo Paulista', 'BR', -23.5614, -46.6559],
  ['São Paulo Centro', 'BR', -23.5455, -46.6380],
  ['Rio de Janeiro Copacabana', 'BR', -22.9711, -43.1822],
  ['Belo Horizonte', 'BR', -19.9191, -43.9386],
  ['Porto Alegre', 'BR', -30.0277, -51.2287],
  ['Curitiba', 'BR', -25.4284, -49.2733],
  // Asia and the Middle East
  ['Tokyo Shibuya', 'JP', 35.6595, 139.7005],
  ['Osaka', 'JP', 34.7025, 135.4959],
  ['Seoul', 'KR', 37.5665, 126.9780],
  ['Taipei', 'TW', 25.0330, 121.5654],
  ['Hong Kong Central', 'HK', 22.2830, 114.1590],
  ['Hong Kong Mong Kok', 'HK', 22.3190, 114.1700],
  ['Singapore', 'SG', 1.2834, 103.8510],
  ['Bangkok', 'TH', 13.7466, 100.5393],
  ['Kuala Lumpur', 'MY', 3.1529, 101.7116],
  ['Manila Makati', 'PH', 14.5547, 121.0244],
  ['Jakarta', 'ID', -6.2000, 106.8167],
  ['Mumbai', 'IN', 18.9388, 72.8354],
  ['Dubai', 'AE', 25.1972, 55.2744],
  ['Tel Aviv', 'IL', 32.0853, 34.7818],
  // Oceania and Africa
  ['Sydney', 'AU', -33.8688, 151.2093],
  ['Melbourne', 'AU', -37.8136, 144.9631],
  ['Auckland', 'NZ', -36.8485, 174.7633],
  ['Cape Town', 'ZA', -33.9249, 18.4241],
  ['Johannesburg', 'ZA', -26.2041, 28.0473],
  ['Nairobi', 'KE', -1.2864, 36.8172],
  ['Cairo', 'EG', 30.0444, 31.2357],
  ['Lagos', 'NG', 6.4541, 3.3947],
];

const tileOf = (lon, lat) => {
  const n = 2 ** Z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
};
const lonLatOf = (x, y) => {
  const n = 2 ** Z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
};

/** The square around a centre, in degrees (small enough to treat as flat). */
export function squareBounds(lat, lon, sizeM) {
  const h = sizeM / 2;
  const dLat = h / 111320;
  const dLon = h / (111320 * Math.cos((lat * Math.PI) / 180));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

/**
 * Buildings in the square from decoded tiles: the count, how many have a real height (the tiles
 * give a placeholder of 5 m where OpenStreetMap has none), and the tallest. A building counts where
 * its first corner is, and only from the tile that holds that corner.
 */
export function countBuildings(tiles, b) {
  let count = 0;
  let known = 0;
  let tallest = 0;
  for (const { x, y, tile } of tiles) {
    const layer = tile.layers.building;
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3 || f.properties.hide_3d) continue;
      const ring = f.loadGeometry()[0];
      if (!ring?.length) continue;
      const { x: px, y: py } = ring[0];
      if (px < 0 || py < 0 || px >= f.extent || py >= f.extent) continue; // in the neighbour's buffer
      const [lon, lat] = lonLatOf(x + px / f.extent, y + py / f.extent);
      if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) continue;
      count++;
      const h = Number(f.properties.render_height);
      if (Number.isFinite(h) && h !== 5) known++;
      if (Number.isFinite(h)) tallest = Math.max(tallest, h);
    }
  }
  return { count, known, tallest };
}

async function tileTemplate() {
  const res = await fetch(TILEJSON_URL);
  if (!res.ok) throw new Error(`TileJSON: HTTP ${res.status}`);
  return (await res.json()).tiles[0];
}

async function fetchTile(template, x, y) {
  const url = template.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 204 || res.status === 404) return new VectorTile(new Pbf(new Uint8Array(0)));
    if (res.ok) return new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`tile ${Z}/${x}/${y} failed`);
}

async function survey(template, [name, country, lat, lon]) {
  const b = squareBounds(lat, lon, SIZE_M);
  const [x0, y0] = tileOf(b.west, b.north).map(Math.floor);
  const [x1, y1] = tileOf(b.east, b.south).map(Math.floor);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, tile: await fetchTile(template, x, y) });
  const { count, known, tallest } = countBuildings(tiles, b);
  const km2 = (SIZE_M / 1000) ** 2;
  return { name, country, lat, lon, buildings: count, perKm2: Math.round(count / km2), withHeight: count ? known / count : 0, tallest: Math.round(tallest) };
}

async function main() {
  const template = await tileTemplate();
  const rows = [];
  for (const city of CITIES) {
    try {
      const r = await survey(template, city);
      rows.push(r);
      console.log(`${r.name.padEnd(28)} ${String(r.buildings).padStart(6)} buildings  ${(r.withHeight * 100).toFixed(0).padStart(3)}% with a height  tallest ${r.tallest} m`);
    } catch (err) {
      console.log(`${city[0].padEnd(28)} failed: ${err.message}`);
    }
  }
  // well mapped first: plenty of buildings, most of them with a real height
  const score = (r) => Math.min(r.perKm2, 1500) / 1500 + r.withHeight;
  rows.sort((a, b) => score(b) - score(a));
  const md = [
    `# How well each city is mapped (${SIZE_M / 1000} km squares, ${new Date().toISOString().slice(0, 10)})`,
    '',
    'Buildings in the square from the OpenFreeMap tiles the app uses; "with a height" means OpenStreetMap has a height or floor count, not the 5 m placeholder.',
    '',
    '| # | City | Country | Buildings | per km² | With a height | Tallest |',
    '| --: | --- | --- | --: | --: | --: | --: |',
    ...rows.map((r, i) => `| ${i + 1} | ${r.name} | ${r.country} | ${r.buildings} | ${r.perKm2} | ${(r.withHeight * 100).toFixed(0)}% | ${r.tallest} m |`),
  ].join('\n');
  mkdirSync('survey-out', { recursive: true });
  writeFileSync('survey-out/survey.json', JSON.stringify(rows, null, 1));
  writeFileSync('survey-out/survey.md', `${md}\n`);
  console.log(`\n${md}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
