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
  export function gtfsFiles(center: { lat: number; lon: number }): Record<string, string>;
  export function gtfsZip(center: { lat: number; lon: number }, opts?: { deflate?: boolean; folder?: string }): Uint8Array;
}
