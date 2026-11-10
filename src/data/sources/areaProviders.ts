/**
 * Where to get values per area for a place, and how to read the ones we know.
 *
 * There is no worldwide list of these (as there is for timetables), so this is a short list of
 * open sources we checked, each with the area it covers. Some can be loaded in one tap: their
 * servers let a browser read them and cut them to the square (`load`). For the others the panel
 * links to the download, and the user loads the file (`link`). Nothing here is fetched until the
 * user taps.
 *
 * Profiles say what a column of a known file holds, so the right one is picked and its values
 * read with a unit. Any other column of any file works too, shown with its own name.
 */

import type { BBox } from '../../geo/projection';
import type { Attribution } from '../types';

/** The two layers: what homes cost, and what people earn. */
export type AreaLayer = 'homes' | 'income';
export const AREA_LAYERS: readonly AreaLayer[] = ['homes', 'income'];

/** A measure we know, by its message key (`areaMeasures` in the dictionaries). */
export type AreaMeasure = 'rentM2' | 'homeValueAvg' | 'homeValueMedian' | 'incomePerResident' | 'incomePerEarner' | 'incomeHouseholdMedian';

export interface AreaProfile {
  /** column names it goes by (lower case) */
  keys: readonly string[];
  layer: AreaLayer;
  measure: AreaMeasure;
  currency: 'EUR' | 'USD';
  /** the file's values are in this many (CBS gives €1,000s) */
  scale: number;
  /** a rent per m² has cents; prices and incomes don't need them */
  decimals: number;
  /** a per-area note: "a month" for rents, "a year" for incomes */
  per: 'month' | 'year' | '';
  credit: Attribution;
}

const CENSUS_DE: Attribution = { text: 'Zensus 2022, Statistische Ämter des Bundes und der Länder', licence: 'dl-de/by-2-0', url: 'https://www.destatis.de/zensus2022' };
const CBS: Attribution = { text: 'CBS, Kerncijfers wijken en buurten, via PDOK', licence: 'CC BY 4.0', url: 'https://www.cbs.nl/' };
const ACS: Attribution = { text: 'U.S. Census Bureau, American Community Survey 5-year estimates, via Census Reporter', url: 'https://censusreporter.org/' };

export const AREA_PROFILES: readonly AreaProfile[] = [
  { keys: ['durchschnmieteqm'], layer: 'homes', measure: 'rentM2', currency: 'EUR', scale: 1, decimals: 2, per: 'month', credit: CENSUS_DE },
  { keys: ['gemiddeldewoningwaarde'], layer: 'homes', measure: 'homeValueAvg', currency: 'EUR', scale: 1000, decimals: 0, per: '', credit: CBS },
  { keys: ['b25077001', 'b25077_001e'], layer: 'homes', measure: 'homeValueMedian', currency: 'USD', scale: 1, decimals: 0, per: '', credit: ACS },
  { keys: ['gemiddeldinkomenperinwoner'], layer: 'income', measure: 'incomePerResident', currency: 'EUR', scale: 1000, decimals: 0, per: 'year', credit: CBS },
  { keys: ['gemiddeldinkomenperinkomensontvanger'], layer: 'income', measure: 'incomePerEarner', currency: 'EUR', scale: 1000, decimals: 0, per: 'year', credit: CBS },
  { keys: ['b19013001', 'b19013_001e'], layer: 'income', measure: 'incomeHouseholdMedian', currency: 'USD', scale: 1, decimals: 0, per: 'year', credit: ACS },
];

export function profileOf(column: string): AreaProfile | null {
  const key = column.toLowerCase();
  return AREA_PROFILES.find((p) => p.keys.includes(key)) ?? null;
}

/** The column to show first on a layer: one we know for it, else one we know for the other, else the first. */
export function pickColumn(columns: readonly string[], layer: AreaLayer): number {
  const known = columns.map(profileOf);
  const own = known.findIndex((p) => p?.layer === layer);
  if (own >= 0) return own;
  const any = known.findIndex(Boolean);
  return any >= 0 ? any : 0;
}

// ------------------------------------------------------------------ providers

/** South, west, north, east (degrees). */
type Box = readonly [number, number, number, number];

export type AreaProviderInfo = 'censusRent' | 'cbsHomes' | 'cbsIncome' | 'acsHomes' | 'acsIncome';

export interface AreaProvider {
  id: string;
  layer: AreaLayer;
  /** where it has data (rough boxes; the panel says which country) */
  boxes: readonly Box[];
  /** who publishes it, as they name themselves */
  name: string;
  /** what it has and how to get it (`areaProviderInfo` in the dictionaries) */
  info: AreaProviderInfo;
  /** a download a browser may read, for the square's box: loaded in one tap */
  load?: (b: BBox) => string;
  /** a page or file to get it from, opened in a new tab */
  link?: string;
  /** the download's size, when it's a file */
  size?: string;
}

const GERMANY: Box = [47.27, 5.86, 55.06, 15.05];
const NETHERLANDS: Box = [50.75, 3.35, 53.56, 7.23];
const USA: readonly Box[] = [
  [24.4, -125.0, 49.4, -66.9],
  [51.2, -180, 71.4, -129.9],
  [18.9, -160.3, 22.3, -154.7],
  [17.9, -67.3, 18.6, -65.2],
];

/** PDOK's service for CBS's neighbourhood figures, as GeoJSON for a box (it lets browsers read it). */
function pdok(year: number, level: 'buurten' | 'wijken'): (b: BBox) => string {
  return (b) =>
    `https://service.pdok.nl/cbs/wijkenbuurten/${year}/wfs/v1_0?service=WFS&version=2.0.0&request=GetFeature&typeNames=wijkenbuurten:${level}` +
    `&outputFormat=application/json&srsName=EPSG:4326&bbox=${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)},urn:ogc:def:crs:EPSG::4326`;
}

export const AREA_PROVIDERS: readonly AreaProvider[] = [
  {
    id: 'de-census-rent',
    layer: 'homes',
    boxes: [GERMANY],
    name: 'Zensus 2022 (Destatis)',
    info: 'censusRent',
    link: 'https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Durchschn_Nettokaltmiete.zip',
    size: '9 MB',
  },
  // the newest year with home values; incomes come two years later, and per district, as many
  // neighbourhoods are too small for CBS to publish them
  { id: 'nl-cbs-homes', layer: 'homes', boxes: [NETHERLANDS], name: 'CBS', info: 'cbsHomes', load: pdok(2024, 'buurten') },
  { id: 'nl-cbs-income', layer: 'income', boxes: [NETHERLANDS], name: 'CBS', info: 'cbsIncome', load: pdok(2023, 'wijken') },
  { id: 'us-acs-homes', layer: 'homes', boxes: USA, name: 'Census Reporter', info: 'acsHomes', link: 'https://censusreporter.org/data/map/?table=B25077' },
  { id: 'us-acs-income', layer: 'income', boxes: USA, name: 'Census Reporter', info: 'acsIncome', link: 'https://censusreporter.org/data/map/?table=B19013' },
];

/** The providers with data for a point, on a layer. */
export function providersFor(layer: AreaLayer, lat: number, lon: number): AreaProvider[] {
  return AREA_PROVIDERS.filter((p) => p.layer === layer && p.boxes.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e));
}
