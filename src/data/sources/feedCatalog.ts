/**
 * Source: where to find a place's timetables. The Mobility Database (by MobilityData) is an open
 * list of transit timetables worldwide, about 3,000 GTFS files in use, each with the area it
 * covers and a copy of its latest version that a browser may download. The app reads the whole
 * list (the same file for everyone, so it says nothing about the place looked at) and picks the
 * timetables for the square on the device; loading one downloads its copy.
 */

import type { LngLat } from '../../geo/projection';
import { splitCsv } from './gtfs';

export const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';
export const CATALOG_CREDIT = 'Mobility Database (MobilityData)';
export const CATALOG_SITE = 'https://mobilitydatabase.org/';

/** Timetables covering more than this (km²) are a country's or a continent's: too big for a browser, and often a wrong area. */
const MAX_AREA_KM2 = 200_000;

export interface CatalogFeed {
  id: string;
  provider: string;
  /** what the feed is called, when it isn't just the provider */
  name: string;
  /** the town or region it is listed under, if any */
  place: string;
  country: string;
  south: number;
  west: number;
  north: number;
  east: number;
  /** the copy to download */
  url: string;
  /** where its licence is, or '' */
  licence: string;
  official: boolean;
}

/** The feeds of the list that a browser can load: GTFS, in use, with no key needed, a copy to download and an area. */
export function parseCatalog(text: string): CatalogFeed[] {
  const lines = text.split(/\r?\n/);
  const fields: string[] = [];
  const head = lines[0].replace(/^﻿/, '');
  const n0 = splitCsv(head, fields);
  const names = fields.slice(0, n0).map((f) => f.trim());
  const col = (name: string) => names.indexOf(name);
  const c = {
    id: col('id'),
    type: col('data_type'),
    country: col('location.country_code'),
    region: col('location.subdivision_name'),
    town: col('location.municipality'),
    provider: col('provider'),
    official: col('is_official'),
    name: col('name'),
    auth: col('urls.authentication_type'),
    latest: col('urls.latest'),
    licence: col('urls.license'),
    south: col('location.bounding_box.minimum_latitude'),
    north: col('location.bounding_box.maximum_latitude'),
    west: col('location.bounding_box.minimum_longitude'),
    east: col('location.bounding_box.maximum_longitude'),
    status: col('status'),
  };
  if (c.id < 0 || c.latest < 0 || c.south < 0) return [];
  const out: CatalogFeed[] = [];
  let pending = '';
  for (let i = 1; i < lines.length; i++) {
    let line = pending ? `${pending}\n${lines[i]}` : lines[i];
    // a quoted field with a line break in it (notes, names)
    if ((line.match(/"/g)?.length ?? 0) % 2 === 1) {
      pending = line;
      continue;
    }
    pending = '';
    if (!line.trim()) continue;
    const n = splitCsv(line, fields);
    const get = (k: number) => (k >= 0 && k < n ? fields[k].trim() : '');
    line = '';
    if (get(c.type) !== 'gtfs') continue;
    const status = get(c.status);
    if (status && status !== 'active') continue;
    const auth = get(c.auth);
    if (auth && auth !== '0') continue;
    const url = get(c.latest);
    const box = [get(c.south), get(c.west), get(c.north), get(c.east)].map(Number);
    if (!/^https:\/\//.test(url) || box.some((v, k) => !Number.isFinite(v) || get([c.south, c.west, c.north, c.east][k]) === '')) continue;
    const provider = get(c.provider);
    const name = get(c.name);
    out.push({
      id: get(c.id),
      provider,
      name: name && !provider.includes(name) ? name : '',
      place: get(c.town) || get(c.region),
      country: get(c.country),
      south: box[0],
      west: box[1],
      north: box[2],
      east: box[3],
      url,
      licence: /^https?:\/\//.test(get(c.licence)) ? get(c.licence) : '',
      official: get(c.official).toLowerCase() === 'true',
    });
  }
  return out;
}

/** The area a feed covers (km²). */
export function feedAreaKm2(f: CatalogFeed): number {
  const lat = ((f.south + f.north) / 2) * (Math.PI / 180);
  return (f.north - f.south) * 111.2 * ((f.east - f.west) * 111.2 * Math.cos(lat));
}

/** The feeds whose area holds a point, the most local first (a city's before its region's); at most `max`. */
export function feedsFor(feeds: CatalogFeed[], at: LngLat, max = 10): CatalogFeed[] {
  const seen = new Set<string>();
  return feeds
    .filter((f) => at.lat >= f.south && at.lat <= f.north && at.lon >= f.west && at.lon <= f.east && feedAreaKm2(f) <= MAX_AREA_KM2)
    .sort((a, b) => feedAreaKm2(a) - feedAreaKm2(b) || Number(b.official) - Number(a.official))
    .filter((f) => !seen.has(f.url) && !!seen.add(f.url))
    .slice(0, max);
}

/** A licence's short name from its link, or null. */
export function licenceName(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes('dl-de/by-2-0') || u.includes('dl-de-by-2.0')) return 'dl-de/by-2-0';
  if (u.includes('dl-de/zero-2-0')) return 'dl-de/zero-2-0';
  if (u.includes('publicdomain/zero')) return 'CC0';
  const cc = /creativecommons\.org\/licenses\/(by(?:-sa|-nd|-nc)*)\/(\d\.\d)/.exec(u);
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  if (u.includes('odbl')) return 'ODbL';
  if (u.includes('etalab')) return 'Licence Ouverte';
  if (u.includes('opendatacommons.org/licenses/by')) return 'ODC-By';
  return null;
}

let cached: Promise<CatalogFeed[]> | null = null;

/** The list, read once per visit. */
export function loadCatalog(): Promise<CatalogFeed[]> {
  cached ??= fetch(CATALOG_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then(parseCatalog)
    .catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}

/** How big a feed's copy is (bytes), or null when the server doesn't say. */
export async function feedSize(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal });
    const n = Number(res.headers.get('content-length'));
    return res.ok && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Downloads a feed's copy, saying how far it got (0 … 1, or NaN when the size isn't known). */
export async function downloadFeed(url: string, onProgress: (share: number) => void, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(total ? got / total : NaN);
  }
  return new Blob(parts as BlobPart[], { type: 'application/zip' });
}
