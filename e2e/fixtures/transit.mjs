/**
 * A small made-up timetable (GTFS) around any centre, packed as a ZIP the way operators ship
 * them, for the unit tests and the end-to-end test of the Public transport layer. Metres E, N
 * of the centre; the model's square is 2 × 2 km (±1000 m).
 *
 *   T1  tram, east–west through the centre, every 10 min 05:00–00:30 (the last ones after midnight)
 *   B2  bus, north–south at E 200, no shape (straight from stop to stop), every 20 min
 *   S3  suburban train, diagonal, stops far outside the square only: it runs through without stopping
 *   U4  U-Bahn, one trip run every 10 minutes 06:00–09:00 (frequencies.txt)
 *   R9  bus far away (8 km east), never near the square
 *
 * The files have what real ones have: a byte-order mark, quoted fields, Windows line ends, a
 * column the app doesn't read, and stop times not in sequence order.
 */

import { deflateRawSync } from 'node:zlib';

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of text files: deflated (as operators ship them) or stored, optionally in a folder. */
export function zipFiles(files, { deflate = true, folder = '' } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [fileName, text] of Object.entries(files)) {
    const name = enc.encode(folder + fileName);
    const raw = typeof text === 'string' ? enc.encode(text) : text;
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, deflate ? 8 : 0, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const dirSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toLatLon(center) {
  const phi = (center.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return (e, n) => [+(center.lat + n / mLat).toFixed(7), +(center.lon + e / mLon).toFixed(7)];
}

const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/**
 * The timetable's files (name → text) around `center`. Weekday service `WD`, weekend `WE`. A `tag`
 * makes it another operator's: its name and its lines' names end in it.
 */
export function gtfsFiles(center, tag = '') {
  const ll = toLatLon(center);
  const stops = [];
  const stop = (id, name, e, n) => {
    const [lat, lon] = ll(e, n);
    stops.push(`"${id}","${name}",${lat},${lon},""`);
  };
  // T1, east–west
  [-1500, -900, -300, 300, 900, 1500].forEach((e, i) => stop(`t${i}`, `Tram stop ${i + 1}`, e, 0));
  // B2, north–south at E 200
  [-1400, -700, 0, 700, 1400].forEach((n, i) => stop(`b${i}`, `Bus stop ${i + 1}`, 200, n));
  // S3: far outside, both ends
  stop('s0', 'Station West', -3000, -3000);
  stop('s1', 'Station East', 3000, 3000);
  // U4
  [-1200, 0, 1200].forEach((e, i) => stop(`u${i}`, `U-Bahn ${i + 1}`, e, 300));
  // R9, far away
  stop('r0', 'Far 1', 8000, 0);
  stop('r1', 'Far 2', 8600, 0);

  const shapes = [];
  const shape = (id, pts) => pts.forEach(([e, n], i) => {
    const [lat, lon] = ll(e, n);
    shapes.push(`${id},${lat},${lon},${i}`);
  });
  // the tram's shape bends a little between stops, like a street
  shape('T1-east', [[-1500, 0], [-1200, 20], [-900, 0], [-600, -20], [-300, 0], [0, 15], [300, 0], [600, 0], [900, 0], [1200, 0], [1500, 0]]);
  shape('T1-west', [[1500, 0], [1200, 0], [900, 0], [600, 0], [300, 0], [0, 15], [-300, 0], [-600, -20], [-900, 0], [-1200, 20], [-1500, 0]]);
  shape('S3', [[-3000, -3000], [-1500, -1500], [0, 0], [1500, 1500], [3000, 3000]]);
  shape('U4', [[-1200, 300], [0, 300], [1200, 300]]);

  const trips = [];
  const times = [];
  const add = (trip, route, service, shapeId, headsign, rows) => {
    trips.push(`${route},${service},${trip},${shapeId},"${headsign}",0`);
    rows.forEach(([stopId, t], i) => times.push(`${trip},${hms(t)},${hms(t)},${stopId},${i + 1},0`));
  };
  // T1: 05:00 to 00:30 every 10 minutes, both ways, 2 minutes between stops
  for (let t = 5 * 3600; t <= 24.5 * 3600; t += 600) {
    for (const service of ['WD', 'WE']) {
      if (service === 'WE' && t % 1200) continue; // every 20 minutes at weekends
      add(`T1e-${service}-${t}`, 'T1', service, 'T1-east', 'East', [0, 1, 2, 3, 4, 5].map((i) => [`t${i}`, t + i * 120]));
      add(`T1w-${service}-${t}`, 'T1', service, 'T1-west', 'West', [5, 4, 3, 2, 1, 0].map((i, k) => [`t${i}`, t + 300 + k * 120]));
    }
  }
  // B2: no shape, every 20 minutes 06:00–22:00, weekdays
  for (let t = 6 * 3600; t <= 22 * 3600; t += 1200) add(`B2-${t}`, 'B2', 'WD', '', 'North', [0, 1, 2, 3, 4].map((i) => [`b${i}`, t + i * 180]));
  // S3: through without stopping, every 30 minutes
  for (let t = 5 * 3600; t <= 23 * 3600; t += 1800) add(`S3-${t}`, 'S3', 'WD', 'S3', 'East', [['s0', t], ['s1', t + 600]]);
  // U4: one trip, run every 10 minutes by frequencies.txt
  add('U4-f', 'U4', 'WD', 'U4', 'East', [['u0', 6 * 3600], ['u1', 6 * 3600 + 120], ['u2', 6 * 3600 + 240]]);
  // R9: far away, busy: the busiest stops are near the square's centre all the same (the tram)
  for (let t = 6 * 3600; t <= 20 * 3600; t += 3600) add(`R9-${t}`, 'R9', 'WD', '', 'Far', [['r0', t], ['r1', t + 300]]);

  // stop times not in sequence order within one trip, as some files have them
  const swapAt = times.findIndex((l) => l.startsWith('B2-21600,'));
  [times[swapAt], times[swapAt + 1]] = [times[swapAt + 1], times[swapAt]];

  return {
    'agency.txt': `\uFEFFagency_id,agency_name,agency_url,agency_timezone\n1,"Test Transit${tag}",https://example.org,Europe/Berlin\n`,
    'routes.txt': [
      'route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_desc',
      `T1,1,"T1${tag}","Tram East–West",0,E34948,""`,
      `B2,1,"B2${tag}","Bus North–South",3,,""`,
      `S3,1,"S3${tag}","Suburban, diagonal",109,008300,""`,
      `U4,1,"U4${tag}","Underground",1,2A78D6,""`,
      `R9,1,"R9${tag}","Far away",3,,""`,
    ].join('\r\n') + '\r\n',
    'stops.txt': '﻿"stop_id","stop_name","stop_lat","stop_lon","parent_station"\n' + stops.join('\n') + '\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260101,20271231\nWE,0,0,0,0,0,1,1,20260101,20271231\n',
    // Christmas Day runs the weekend timetable
    'calendar_dates.txt': 'service_id,date,exception_type\nWD,20261225,2\nWE,20261225,1\n',
    'trips.txt': 'route_id,service_id,trip_id,shape_id,trip_headsign,direction_id\n' + trips.join('\n') + '\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type\n' + times.join('\n') + '\n',
    'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' + shapes.join('\n') + '\n',
    'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nU4-f,06:00:00,09:00:00,600\n',
  };
}

/** The timetable around `center` as a ZIP file's bytes. */
export function gtfsZip(center, opts = {}) {
  return zipFiles(gtfsFiles(center, opts.tag ?? ''), opts);
}

/**
 * The Mobility Database's list of timetables (feeds_v2.csv) with these feeds: { id, provider, name,
 * place, south, west, north, east, url, licence, status, auth, type }, the columns it really has.
 */
export function catalogCsv(feeds) {
  const head = 'id,data_type,entity_type,location.country_code,location.subdivision_name,location.municipality,provider,is_official,name,note,feed_contact_email,static_reference,urls.direct_download,urls.authentication_type,urls.authentication_info,urls.api_key_parameter_name,urls.latest,urls.license,location.bounding_box.minimum_latitude,location.bounding_box.maximum_latitude,location.bounding_box.minimum_longitude,location.bounding_box.maximum_longitude,location.bounding_box.extracted_on,status,features,redirect.id,redirect.comment';
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = feeds.map((f) =>
    [f.id, f.type ?? 'gtfs', '', 'DE', 'Hamburg', f.place ?? '', f.provider, 'True', f.name ?? '', 'a note,\nover two lines', '', '', `https://example.org/${f.id}.zip`, f.auth ?? '0', '', '', f.url, f.licence ?? '', f.south, f.north, f.west, f.east, '2026-11-01 00:00:00+00:00', f.status ?? 'active', 'Shapes', '', '']
      .map(q)
      .join(','),
  );
  return `${head}\n${rows.join('\n')}\n`;
}
