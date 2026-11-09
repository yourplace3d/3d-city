/**
 * Fixture for the traffic layer: answers Hamburg's SensorThings API (iot.hamburg.de) the way it
 * answers the app, with made-up counting points inside the square asked for and hourly counts
 * that rise to an afternoon peak. Two points stand 6 m apart (both directions of one road), so
 * the app should add them up into one column. Plus a short route through Hamburg's centre.
 */

const HOUR = 3_600_000;

/** The answer to one Datastreams request (the URL the app sent). */
export function trafficAnswer(url, now = Date.now()) {
  const p = new URL(url).searchParams;
  const filter = p.get('$filter') ?? '';
  const bikes = /Fahrraeder/.test(filter);
  const ring = /POLYGON\(\((.+?)\)\)/.exec(filter)?.[1].split(',').map((s) => s.trim().split(/\s+/).map(Number)) ?? [];
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const since = Date.parse(/phenomenonTime ge (\S+?);/.exec(p.get('$expand') ?? '')?.[1] ?? new Date(now - 26 * HOUR).toISOString());
  const last = Math.floor(now / HOUR) * HOUR - HOUR;
  const value = [];
  const n = bikes ? 8 : 14;
  for (let k = 0; k < n; k++) {
    // spread over the middle of the square
    const fx = 0.2 + 0.6 * (((k * 7) % n) / (n - 1));
    const fy = 0.2 + 0.6 * (((k * 3) % n) / (n - 1));
    const lon = west + (east - west) * fx;
    const lat = south + (north - south) * fy;
    const base = (bikes ? 30 : 300) * (1 + (k % 5));
    const points = k === 0 ? [[lon, lat], [lon + 0.00009, lat]] : [[lon, lat]];
    points.forEach(([x, y], j) => {
      const obs = [];
      for (let h = Math.floor(since / HOUR) * HOUR; h <= last; h += HOUR) {
        const hour = new Date(h).getUTCHours();
        const shape = 0.12 + 0.88 * Math.exp(-((hour - 14) ** 2) / 18);
        obs.push({ phenomenonTime: `${new Date(h).toISOString().replace('.000Z', 'Z')}/${new Date(h + HOUR - 1000).toISOString().replace('.000Z', 'Z')}`, result: Math.round(base * shape * (j ? 0.8 : 1)) });
      }
      value.push({
        '@iot.id': 9000 + k * 10 + j,
        name: `${bikes ? 'Fahrrad' : 'Kfz'}-Aufkommen an Verkehrszählstelle 09${k}9${j} im 1-Stunde-Intervall`,
        observedArea: { type: 'Point', coordinates: [x, y] },
        Observations: obs,
      });
    });
  }
  // a retired point, with no counts: left out
  value.push({ '@iot.id': 1, name: 'old', observedArea: { type: 'Point', coordinates: [west + (east - west) / 2, south + (north - south) / 2] }, Observations: [] });
  return { value };
}

/** A 2.4 km run around Hamburg's Binnenalster, no times. */
export function hamburgGpx(name = 'Alster Loop') {
  const pts = [
    [53.5528, 9.9925],
    [53.5562, 9.9905],
    [53.5594, 9.9962],
    [53.5585, 10.0018],
    [53.5551, 10.0035],
    [53.5524, 9.9985],
    [53.5528, 9.9925],
  ];
  const dense = [];
  for (let i = 1; i < pts.length; i++) {
    for (let s = 0; s < 20; s++) {
      const f = s / 20;
      dense.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
    }
  }
  dense.push(pts[pts.length - 1]);
  const trk = dense.map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>8</ele></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name}</name><trkseg>
${trk}
  </trkseg></trk>
</gpx>
`;
}
