/**
 * A synthetic recorded run as GPX and TCX, through the synthetic city around Stuttgart:
 * 13.4 km of zigzag, too big for one model, so the app has to pick a stretch.
 */

const CENTER = { lat: 48.7765, lon: 9.1772 };
/** local metres (E, N) from the centre */
export const ROUTE_PATH = [
  [-2000, -1800],
  [1800, -1800],
  [1800, 0],
  [-1800, 0],
  [-1800, 1800],
  [600, 1800],
];

function toLngLat([e, n]) {
  const phi = (CENTER.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return { lat: CENTER.lat + n / mLat, lon: CENTER.lon + e / mLon };
}

/** Points every ~15 m at 5:00 per km, a little GPS wobble, starting 26 April 2026 at 9:00 UTC. */
export function routePoints(path = ROUTE_PATH, stepM = 15) {
  const out = [];
  let t = Date.UTC(2026, 3, 26, 9, 0, 0);
  let k = 0;
  for (let s = 0; s < path.length - 1; s++) {
    const [ax, ay] = path[s];
    const [bx, by] = path[s + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / stepM));
    for (let i = s === 0 ? 0 : 1; i <= n; i++) {
      const wobble = Math.sin(k++ * 1.7) * 1.5;
      const e = ax + ((bx - ax) * i) / n + (ay === by ? 0 : wobble);
      const nn = ay + ((by - ay) * i) / n + (ay === by ? wobble : 0);
      if (out.length) t += (len / n) * 300;
      out.push({ ...toLngLat([e, nn]), time: t, ele: 250 + Math.sin(k / 40) * 10 });
    }
  }
  return out;
}

export function routeGpx(name = 'Test City Half', points = routePoints()) {
  const pts = points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele.toFixed(1)}</ele><time>${new Date(p.time).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
  <trk><name>${name}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

export function routeTcx(points = routePoints()) {
  const pts = points
    .map((p) => `<Trackpoint><Time>${new Date(p.time).toISOString()}</Time><Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(7)}</LongitudeDegrees></Position></Trackpoint>`)
    .join('');
  return `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Id>2026-04-26T09:00:00Z</Id><Lap><Track>${pts}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}
