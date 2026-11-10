// Test-only tile encoders (no published types).
declare module 'geojson-vt' {
  interface Index {
    getTile(z: number, x: number, y: number): unknown;
  }
  export default function geojsonvt(data: unknown, options?: Record<string, unknown>): Index;
}
declare module 'vt-pbf' {
  export function fromGeojsonVt(layers: Record<string, unknown>, options?: Record<string, unknown>): Uint8Array;
}
// Node's zlib, used to build test PNGs (the project has no Node type package).
declare module 'node:zlib' {
  export function deflateSync(data: Uint8Array): Uint8Array;
}
// Node's fs, used to read the page's HTML.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
// The made-up timetable shared with the end-to-end test.
declare module '*/fixtures/transit.mjs' {
  export function zipFiles(files: Record<string, string | Uint8Array>, opts?: { deflate?: boolean; folder?: string }): Uint8Array;
  export function gtfsFiles(center: { lat: number; lon: number }, tag?: string): Record<string, string>;
  export function gtfsZip(center: { lat: number; lon: number }, opts?: { deflate?: boolean; folder?: string; tag?: string }): Uint8Array;
  export function catalogCsv(feeds: Array<Record<string, string | number>>): string;
}
// The made-up values per area shared with the end-to-end test.
declare module '*/fixtures/areas.mjs' {
  type C = { lat: number; lon: number };
  export function laea(lon: number, lat: number): [number, number];
  export function rentAt(i: number, j: number, n: number): number;
  export function gridCsv(center: C, opts?: { cellM?: number; halfM?: number }): string;
  export function censusZip(center: C): Uint8Array;
  export const QUARTERS: Array<{ name: string; e: [number, number]; n: [number, number]; value: number; income: number; people: number }>;
  export function areasGeoJson(center: C, opts?: { tag?: string }): { type: string; features: Array<{ type: string; properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][][] } }> };
  export function pointsCsv(center: C): string;
}
