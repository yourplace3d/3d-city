/**
 * Map projections that open data comes in, back to longitude and latitude: the European grid
 * (ETRS89-LAEA, EPSG:3035) that census grids use across Europe, UTM (the national grids of
 * Germany and many other countries, EPSG:258xx / 326xx / 327xx) and Web Mercator (EPSG:3857).
 * Longitude/latitude itself (EPSG:4326, 4258, 4269, CRS84) passes through. Accurate to well
 * under a metre within each projection's area, which is far finer than the data.
 */

export type ToLonLat = (x: number, y: number) => [number, number];

const DEG = Math.PI / 180;

// GRS80 (ETRS89, NAD83); WGS84 differs by 0.1 mm, which doesn't matter here
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);

// ------------------------------------------------------------------ ETRS89-LAEA Europe (EPSG:3035)

const LAEA = (() => {
  const phi0 = 52 * DEG;
  const lam0 = 10 * DEG;
  const q = (phi: number) => {
    const s = Math.sin(phi);
    return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
  };
  const qP = q(Math.PI / 2);
  const beta0 = Math.asin(q(phi0) / qP);
  const Rq = A * Math.sqrt(qP / 2);
  const D = (A * (Math.cos(phi0) / Math.sqrt(1 - E2 * Math.sin(phi0) ** 2))) / (Rq * Math.cos(beta0));
  return { phi0, lam0, q, qP, beta0, Rq, D, FE: 4321000, FN: 3210000 };
})();

/** Longitude, latitude (degrees) to ETRS89-LAEA metres. */
export function laeaForward(lon: number, lat: number): [number, number] {
  const { lam0, q, qP, beta0, Rq, D, FE, FN } = LAEA;
  const beta = Math.asin(Math.max(-1, Math.min(1, q(lat * DEG) / qP)));
  const dl = lon * DEG - lam0;
  const B = Rq * Math.sqrt(2 / (1 + Math.sin(beta0) * Math.sin(beta) + Math.cos(beta0) * Math.cos(beta) * Math.cos(dl)));
  return [FE + B * D * Math.cos(beta) * Math.sin(dl), FN + (B / D) * (Math.cos(beta0) * Math.sin(beta) - Math.sin(beta0) * Math.cos(beta) * Math.cos(dl))];
}

/** ETRS89-LAEA metres to longitude, latitude (degrees). */
export function laeaInverse(x: number, y: number): [number, number] {
  const { lam0, beta0, Rq, D, FE, FN } = LAEA;
  const dx = x - FE;
  const dy = y - FN;
  const rho = Math.hypot(dx / D, D * dy);
  if (rho < 1e-9) return [lam0 / DEG, LAEA.phi0 / DEG];
  const C = 2 * Math.asin(Math.min(1, rho / (2 * Rq)));
  const b = Math.asin(Math.cos(C) * Math.sin(beta0) + (D * dy * Math.sin(C) * Math.cos(beta0)) / rho);
  const lam = lam0 + Math.atan2(dx * Math.sin(C), D * rho * Math.cos(beta0) * Math.cos(C) - D * D * dy * Math.sin(beta0) * Math.sin(C));
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const phi =
    b +
    (E2 / 3 + (31 * e4) / 180 + (517 * e6) / 5040) * Math.sin(2 * b) +
    ((23 * e4) / 360 + (251 * e6) / 3780) * Math.sin(4 * b) +
    ((761 * e6) / 45360) * Math.sin(6 * b);
  return [lam / DEG, phi / DEG];
}

// ------------------------------------------------------------------ UTM

const K0 = 0.9996;
const EP2 = E2 / (1 - E2);

/** Longitude, latitude (degrees) to UTM metres in `zone` (Snyder's series). */
export function utmForward(lon: number, lat: number, zone: number, south = false): [number, number] {
  const phi = lat * DEG;
  const lam0 = ((zone - 1) * 6 - 180 + 3) * DEG;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const N = A / Math.sqrt(1 - E2 * s * s);
  const T = Math.tan(phi) ** 2;
  const C = EP2 * c * c;
  const Aa = (lon * DEG - lam0) * c;
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const M =
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  const y =
    K0 * (M + N * Math.tan(phi) * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720)) +
    (south ? 10000000 : 0);
  return [x, y];
}

/** UTM metres in `zone` to longitude, latitude (degrees). */
export function utmInverse(x: number, y: number, zone: number, south = false): [number, number] {
  const lam0 = ((zone - 1) * 6 - 180 + 3) * DEG;
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const M = (y - (south ? 10000000 : 0)) / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const r = Math.sqrt(1 - E2);
  const e1 = (1 - r) / (1 + r);
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1);
  const c = Math.cos(phi1);
  const C1 = EP2 * c * c;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * s * s);
  const R1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5;
  const D = (x - 500000) / (N1 * K0);
  const phi =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lam = lam0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [lam / DEG, phi / DEG];
}

// ------------------------------------------------------------------ by name

const R_MERC = 6378137;

/** The EPSG code in a CRS name: "EPSG:25832", "urn:ogc:def:crs:EPSG::3035", "…/EPSG/0/4326"; CRS84 is 4326. */
export function epsgOf(name: string): number | null {
  const s = name.trim();
  if (/CRS:?84$/i.test(s)) return 4326;
  const m = /EPSG(?::+|\/\d+\/)(\d+)$/i.exec(s) ?? /^(\d{4,5})$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** How to turn coordinates of an EPSG code into longitude and latitude; null for one we don't know. */
export function toLonLatFor(epsg: number): ToLonLat | null {
  // longitude, latitude already (ETRS89, NAD83, WGS84)
  if (epsg === 4326 || epsg === 4258 || epsg === 4269 || epsg === 4979) return (x, y) => [x, y];
  if (epsg === 3035) return laeaInverse;
  if (epsg === 3857 || epsg === 900913 || epsg === 102100) {
    return (x, y) => [(x / R_MERC) / DEG, (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) / DEG];
  }
  // ETRS89 / UTM zones 28–38
  if (epsg >= 25828 && epsg <= 25838) return (x, y) => utmInverse(x, y, epsg - 25800);
  // ETRS89 / UTM with the zone in front of the easting (Germany: 32xxxxxx, 33xxxxxx)
  if (epsg === 4647) return (x, y) => utmInverse(x - 32000000, y, 32);
  if (epsg === 5650) return (x, y) => utmInverse(x - 33000000, y, 33);
  // WGS84 / UTM north and south
  if (epsg >= 32601 && epsg <= 32660) return (x, y) => utmInverse(x, y, epsg - 32600);
  if (epsg >= 32701 && epsg <= 32760) return (x, y) => utmInverse(x, y, epsg - 32700, true);
  return null;
}
