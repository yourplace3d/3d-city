// Renders the Your Place · Data video from live data, with the app as it looks: Steepness and a run in
// San Francisco, a day of Hamburg's traffic, Freiburg's trams and buses from its timetable, Freiburg's
// rents and Amsterdam's incomes, each with a caption, then an end card. Frames are captured one by one
// (exact timing even with software rendering) and encoded with ffmpeg.
//
//   npm run build && node tools/video/data.mjs              video-out/your-place-data-16x9.mp4
//   node tools/video/data.mjs --preview                     one picture per scene, to check the framing
//   node tools/video/data.mjs --only=traffic,homes          some scenes only (with --preview, say)
//
// Needs the map services, Hamburg's traffic service and Google Fonts (for the captions; it falls back
// without them). The run in San Francisco is made up: laid along the model's own streets, at 5:15 a km.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');
const out = join(root, 'video-out');
mkdirSync(out, { recursive: true });

const args = process.argv.slice(2);
const PREVIEW = args.includes('--preview');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;

const SITE = process.env.SITE ?? 'yourplace3d.github.io/3dcitydata';
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const DIP_S = 0.35; // fade through the background between scenes
const END_S = 3.6;

/** The run: from the bay up Hyde Street, down Lombard's bends, and up Telegraph Hill (lat, lon). */
const RUN_WAYPOINTS = [
  [37.80645, -122.42075],
  [37.8044, -122.4202],
  [37.80205, -122.4187],
  [37.80125, -122.4105],
  [37.80237, -122.40583],
];
const RUN_PACE_S_PER_KM = 315;

const SCENES = [
  {
    key: 'steep',
    hash: 'lat=37.7990&lon=-122.4140&km=2&ex=1.5&dl=steep',
    seconds: 5.6,
    title: 'Where it gets steep',
    sub: 'Every road coloured by its slope, anywhere in the world · San Francisco',
    ready: () => (window.__yourPlace.steep()?.pieces ?? 0) > 0,
    cam: { az: [-24, 6], tilt: [26, 40], dist: [1.02, 0.9] },
  },
  {
    key: 'route',
    hash: 'lat=37.8030&lon=-122.4140&km=2&ex=1.5&dl=steep',
    seconds: 8,
    title: 'Your run, on the real hills',
    sub: 'Your GPX from Strava or Garmin: climbs, height profile, replay. Never uploaded.',
    setup: loadRun,
    ready: () => window.__yourPlace.route()?.shown === true,
    cam: { az: [12, -14], tilt: [32, 42], dist: [1.02, 0.92] },
    drive: (u) => ['routeAt', [Math.min(1, Math.max(0, (u - 0.06) / 0.9))]],
    scroll: '#route-control',
  },
  {
    key: 'traffic',
    hash: 'lat=53.5511&lon=9.9937&km=2&ex=1.5&dl=traffic',
    seconds: 7.6,
    title: 'A day of traffic in Hamburg',
    sub: 'Live counts from the city’s open data. The streets rise with the cars, hour by hour.',
    ready: () => window.__yourPlace.traffic()?.status === 'ready' && window.__yourPlace.traffic()?.shown,
    cam: { az: [-10, 18], tilt: [40, 50], dist: [0.95, 0.82] },
    drive: (u) => ['trafficAt', [u * 23]],
    scroll: '#traffic-control',
  },
  {
    key: 'transit',
    hash: 'lat=47.99555&lon=7.85065&km=2&ex=1.5&dl=transit',
    seconds: 8,
    title: 'Every tram and bus, from the timetable',
    sub: 'Load your city’s GTFS file, or find it in one tap · Freiburg, 7:30 to 8:50',
    setup: async (page) => page.evaluate(() => document.querySelector('#transit-presets .chip').click()),
    ready: () => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.transit()?.shown,
    cam: { az: [20, -8], tilt: [38, 48], dist: [0.82, 0.7] },
    // ten minutes a second, with trails as the app's own fast replay has them
    drive: (u) => ['transitAt', [7.5 * 3600 + u * 80 * 60, 300]],
    scroll: '#transit-control',
  },
  {
    key: 'homes',
    hash: 'lat=47.99555&lon=7.85065&km=2&ex=1.5&dl=homes',
    seconds: 6,
    title: 'What rent costs, square by square',
    sub: 'Germany’s 2022 census: rent per m² in 100 m squares · Freiburg',
    setup: async (page) => page.evaluate(() => document.querySelector('#homes-presets .chip').click()),
    ready: () => window.__yourPlace.areas('homes')?.status === 'ready' && window.__yourPlace.areas('homes')?.tinted,
    cam: { az: [-16, 10], tilt: [30, 44], dist: [1.0, 0.9] },
    scroll: '#homes-control',
  },
  {
    key: 'income',
    hash: 'lat=52.3702&lon=4.8952&km=2&ex=1.5&dl=income',
    seconds: 6,
    title: 'What people earn, by district',
    sub: 'Open data from the Netherlands and the US, or a file of your own · Amsterdam',
    setup: async (page) => page.evaluate(() => document.querySelector('#income-presets .chip').click()),
    ready: () => window.__yourPlace.areas('income')?.status === 'ready' && window.__yourPlace.areas('income')?.tinted,
    cam: { az: [8, -18], tilt: [32, 44], dist: [1.02, 0.92] },
    scroll: '#income-control',
  },
].filter((s) => !ONLY || ONLY.includes(s.key));

// ------------------------------------------------------------------ static server for dist/

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4323, '127.0.0.1', r));
const base = 'http://127.0.0.1:4323/';

// ------------------------------------------------------------------ the run, along the model's streets

/** The shortest way along the streets through the waypoints (metres E, N), as points. */
function along(streets, waypoints) {
  const index = new Map();
  const xy = [];
  const adj = [];
  const node = ([e, n]) => {
    const k = `${Math.round(e * 2)},${Math.round(n * 2)}`;
    let i = index.get(k);
    if (i == null) {
      i = xy.length;
      index.set(k, i);
      xy.push([e, n]);
      adj.push([]);
    }
    return i;
  };
  const link = (a, b) => {
    if (a === b) return;
    const d = Math.hypot(xy[a][0] - xy[b][0], xy[a][1] - xy[b][1]);
    adj[a].push([b, d]);
    adj[b].push([a, d]);
  };
  // the tiles' streets don't share points where they cross: cut every piece where another crosses it
  // or ends within a few metres of it
  const segs = [];
  for (const s of streets) {
    if (s.kind === 'motorway') continue;
    for (let k = 1; k < s.pts.length; k++) segs.push({ a: s.pts[k - 1], b: s.pts[k], cuts: [] });
  }
  const CELL = 25;
  const cells = new Map();
  segs.forEach((g, i) => {
    const [e0, e1] = [Math.min(g.a[0], g.b[0]) - 3, Math.max(g.a[0], g.b[0]) + 3];
    const [n0, n1] = [Math.min(g.a[1], g.b[1]) - 3, Math.max(g.a[1], g.b[1]) + 3];
    for (let x = Math.floor(e0 / CELL); x <= Math.floor(e1 / CELL); x++)
      for (let y = Math.floor(n0 / CELL); y <= Math.floor(n1 / CELL); y++) {
        const k = `${x},${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
  });
  const project = (p, g) => {
    const dx = g.b[0] - g.a[0];
    const dy = g.b[1] - g.a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dy) / l2;
    const q = [g.a[0] + t * dx, g.a[1] + t * dy];
    return { t, q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  };
  const seen = new Set();
  for (const list of cells.values()) {
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x];
        const j = list[y];
        const key = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const g = segs[i];
        const h = segs[j];
        // crossing
        const rx = g.b[0] - g.a[0];
        const ry = g.b[1] - g.a[1];
        const sx = h.b[0] - h.a[0];
        const sy = h.b[1] - h.a[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) > 1e-9) {
          const qx = h.a[0] - g.a[0];
          const qy = h.a[1] - g.a[1];
          const t = (qx * sy - qy * sx) / den;
          const u = (qx * ry - qy * rx) / den;
          if (t > 0 && t < 1 && u > 0 && u < 1) {
            const p = [g.a[0] + t * rx, g.a[1] + t * ry];
            g.cuts.push([t, p]);
            h.cuts.push([u, p]);
          }
        }
        // an end close to the other piece
        for (const [from, to] of [[g, h], [h, g]])
          for (const p of [from.a, from.b]) {
            const m = project(p, to);
            if (m.d < 3 && m.t > 0 && m.t < 1) {
              to.cuts.push([m.t, m.q]);
              link(node(p), node(m.q));
            }
          }
      }
  }
  for (const g of segs) {
    const pts = [[0, g.a], ...g.cuts.sort((p, q) => p[0] - q[0]), [1, g.b]];
    for (let k = 1; k < pts.length; k++) link(node(pts[k - 1][1]), node(pts[k][1]));
  }
  // and ends that nearly meet (streets cut at tile edges)
  const near = new Map();
  xy.forEach(([e, n], i) => {
    const k = `${Math.floor(e / 3)},${Math.floor(n / 3)}`;
    if (!near.has(k)) near.set(k, []);
    near.get(k).push(i);
  });
  const count = xy.length;
  for (let i = 0; i < count; i++) {
    const [e, n] = xy[i];
    const ce = Math.floor(e / 3);
    const cn = Math.floor(n / 3);
    for (let de = -1; de <= 1; de++)
      for (let dn = -1; dn <= 1; dn++)
        for (const j of near.get(`${ce + de},${cn + dn}`) ?? []) {
          if (j > i && Math.hypot(xy[j][0] - e, xy[j][1] - n) < 2.5 && !adj[i].some(([b]) => b === j)) link(i, j);
        }
  }
  const nearest = ([e, n]) => {
    let best = -1;
    let bd = Infinity;
    xy.forEach(([x, y], i) => {
      const d = Math.hypot(x - e, y - n);
      if (d < bd && adj[i].length) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const shortest = (from, to) => {
    const dist = new Float64Array(xy.length).fill(Infinity);
    const prev = new Int32Array(xy.length).fill(-1);
    const heap = [[0, from]];
    dist[from] = 0;
    while (heap.length) {
      // a small binary heap
      const [d, i] = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let k = 0; ; ) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[k], heap[m]] = [heap[m], heap[k]];
          k = m;
        }
      }
      if (d > dist[i]) continue;
      if (i === to) break;
      for (const [j, w] of adj[i]) {
        if (d + w < dist[j]) {
          dist[j] = d + w;
          prev[j] = i;
          heap.push([d + w, j]);
          for (let k = heap.length - 1; k > 0; ) {
            const p = (k - 1) >> 1;
            if (heap[p][0] <= heap[k][0]) break;
            [heap[p], heap[k]] = [heap[k], heap[p]];
            k = p;
          }
        }
      }
    }
    if (!Number.isFinite(dist[to])) throw new Error('no way along the streets between two waypoints');
    const path = [];
    for (let i = to; i !== -1; i = prev[i]) path.push(xy[i]);
    return path.reverse();
  };
  const ids = waypoints.map(nearest);
  const path = [];
  for (let k = 1; k < ids.length; k++) path.push(...shortest(ids[k - 1], ids[k]).slice(k > 1 ? 1 : 0));
  return path;
}

/** A GPX of the run: a point every ~10 m at an even pace. */
function gpx(path, center) {
  const phi = (center.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const pts = [];
  let t = Date.UTC(2026, 9, 4, 14, 0, 0);
  for (let k = 0; k < path.length; k++) {
    const [e0, n0] = path[k];
    const next = path[k + 1];
    const len = next ? Math.hypot(next[0] - e0, next[1] - n0) : 0;
    const steps = Math.max(1, Math.round(len / 10));
    for (let s = 0; s < (next ? steps : 1); s++) {
      const e = next ? e0 + ((next[0] - e0) * s) / steps : e0;
      const n = next ? n0 + ((next[1] - n0) * s) / steps : n0;
      pts.push(`<trkpt lat="${(center.lat + n / mLat).toFixed(7)}" lon="${(center.lon + e / mLon).toFixed(7)}"><time>${new Date(t).toISOString()}</time></trkpt>`);
      t += (((next ? len / steps : 0) / 1000) * RUN_PACE_S_PER_KM) * 1000;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Your Place video" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Two hills</name><trkseg>
${pts.join('\n')}
</trkseg></trk></gpx>
`;
}

async function loadRun(page) {
  const { streets, center } = await page.evaluate(() => ({ streets: window.__yourPlace.streets(), center: window.__yourPlace.state().center }));
  const phi = (center.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const waypoints = RUN_WAYPOINTS.map(([lat, lon]) => [(lon - center.lon) * mLon, (lat - center.lat) * mLat]);
  const path = along(streets, waypoints);
  let km = 0;
  for (let k = 1; k < path.length; k++) km += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]) / 1000;
  console.log(`  the run: ${path.length} points, ${km.toFixed(2)} km along ${streets.length} streets`);
  await page.setInputFiles('#route-file', { name: 'two-hills.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx(path, center)) });
}

// ------------------------------------------------------------------ the captions drawn over the app

const icon = readFileSync(join(root, 'public', 'icon.svg'), 'utf8');
const OVERLAY_CSS = `
  .toast, .notice, .status, .welcome, .mouse-hint { display: none !important; }
  #promo { position: fixed; inset: 0; z-index: 100; pointer-events: none; color: #1e1c19; }
  #promo .caption { position: absolute; top: 34px; left: 400px; right: 110px; display: flex; justify-content: center;
    opacity: var(--cap, 0); transform: translateY(calc((1 - var(--cap, 0)) * -14px)); }
  #promo .card { max-width: 1180px; padding: 20px 36px 22px; border-radius: 18px; text-align: center;
    background: rgba(251, 250, 247, 0.94); box-shadow: 0 10px 34px rgba(60, 50, 35, 0.16), 0 1px 3px rgba(60, 50, 35, 0.12); }
  #promo .kicker { font: 650 17px/1 Inter, system-ui, sans-serif; letter-spacing: 0.18em; text-transform: uppercase; color: #b13a15; }
  #promo .title { margin-top: 12px; font: 500 54px/1.05 Fraunces, Georgia, serif; letter-spacing: -0.015em; }
  #promo .sub { margin-top: 12px; font: 400 24px/1.3 Inter, system-ui, sans-serif; color: #4a453e; }
  #promo .dip { position: absolute; inset: 0; opacity: var(--dip, 1);
    background: radial-gradient(120% 90% at 50% 30%, #f4f1ec 0%, #d9d3c8 100%); }
  #promo .end { position: absolute; inset: 0; opacity: var(--end, 0); display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; text-align: center; background: radial-gradient(120% 90% at 50% 30%, #f4f1ec 0%, #d9d3c8 100%); }
  #promo .end svg { width: 128px; height: 128px; }
  #promo .end h1 { margin: 0; font: 500 112px/1 Fraunces, Georgia, serif; letter-spacing: -0.02em; }
  #promo .end .what { font: 400 42px/1.2 Fraunces, Georgia, serif; color: #3a352f; }
  #promo .end .free { font: 500 28px/1.4 Inter, system-ui, sans-serif; color: #5c564d; }
  #promo .end .url { margin-top: 14px; font: 600 34px/1 Inter, system-ui, sans-serif; color: #b13a15; }
  #promo .end .credits { position: absolute; bottom: 48px; left: 120px; right: 120px; font: 400 18px/1.5 Inter, system-ui, sans-serif; color: #7a7368; }
`;
const OVERLAY_HTML = `
  <div id="promo">
    <div class="caption"><div class="card"><div class="kicker">Your Place · Data</div><div class="title"></div><div class="sub"></div></div></div>
    <div class="dip"></div>
    <div class="end">
      ${icon}
      <h1>Your Place · Data</h1>
      <div class="what">Open data about your city, in 3D</div>
      <div class="free">Free · No sign-up · Your files never leave your browser</div>
      <div class="url">${SITE}</div>
      <div class="credits">Map data © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap · Terrain: Mapzen, AWS Terrain Tiles ·
        Traffic counts: Freie und Hansestadt Hamburg · Timetable: Freiburger Verkehrs AG · Rents: Zensus 2022 (dl-de/by-2-0) · Incomes: CBS (CC BY 4.0)</div>
    </div>
  </div>`;

// ------------------------------------------------------------------ rendering

const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const lerp = ([a, b], t) => a + (b - a) * t;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// reduced motion turns off camera damping, so each frame shows exactly the camera that was set
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
await ctx.addInitScript(() => {
  try {
    for (const k of ['yp:tip-pin', 'yp:hint-mouse', 'yp:own']) localStorage.setItem(k, '1');
  } catch {}
});

const frames = join(out, 'frames-data');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
let n = 0;
const framePath = (i) => join(frames, `${String(i).padStart(5, '0')}.jpg`);
const shot = (page, path) => page.screenshot({ path, type: 'jpeg', quality: 93, timeout: 120000 });

for (const [si, scene] of SCENES.entries()) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${scene.key}] page error: ${e.message}`));
  const t0 = Date.now();
  await page.goto(`${base}#${scene.hash}`);
  const stage = () => page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 240000 }).catch(() => {});
  await stage();
  if (scene.setup) {
    await scene.setup(page);
    await page.waitForTimeout(500);
    await stage();
  }
  const ok = await page.waitForFunction(scene.ready, null, { timeout: 240000 }).then(() => true, () => false);
  const info = await page.evaluate(() => ({ stage: window.__yourPlace.stage, stats: window.__yourPlace.stats(), cam: window.__yourPlace.camera(), notice: window.__yourPlace.notice() }));
  console.log(`${scene.key}: ${ok ? 'ready' : 'NOT READY'}, ${info.stage}, ${info.stats?.buildings} buildings, ${((Date.now() - t0) / 1000).toFixed(0)} s${info.notice ? ` · notice: ${info.notice}` : ''}`);
  if (scene.key === 'route') console.log('  ', JSON.stringify(await page.evaluate(() => ({ marks: window.__yourPlace.route().marks, climbs: window.__yourPlace.route().climbs, profile: window.__yourPlace.route().profile }))));

  await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600;650&display=block' }).catch(() => console.log('  fonts unavailable, using fallbacks'));
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate(({ html, title, sub, scroll }) => {
    document.body.insertAdjacentHTML('beforeend', html);
    const p = document.getElementById('promo');
    p.querySelector('.title').textContent = title;
    p.querySelector('.sub').textContent = sub;
    // the layer's panel in view
    const el = scroll && document.querySelector(scroll);
    if (el) el.scrollIntoView({ block: 'start' });
  }, { html: OVERLAY_HTML, title: scene.title, sub: scene.sub, scroll: scene.scroll });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500); // let the map layers settle

  const d0 = info.cam.distance;
  const total = Math.round(scene.seconds * FPS);
  const picks = PREVIEW ? [Math.round(total * 0.15), Math.round(total * 0.75)] : null;
  for (let i = 0; i < total; i++) {
    if (picks && !picks.includes(i)) continue;
    const s = i / FPS;
    const u = i / (total - 1);
    const t = ease(u);
    const cam = { azimuth: lerp(scene.cam.az, t), tilt: lerp(scene.cam.tilt, t), distance: d0 * lerp(scene.cam.dist, t), targetE: 0, targetN: 0 };
    const dipIn = si === 0 ? 1 - s / (DIP_S * 1.6) : 1 - s / DIP_S;
    const dipOut = (s - (scene.seconds - DIP_S)) / DIP_S;
    const dip = PREVIEW ? 0 : Math.max(0, Math.min(1, Math.max(dipIn, dipOut)));
    const cap = PREVIEW ? 1 : Math.max(0, Math.min(1, Math.min((s - 0.3) / 0.4, (scene.seconds - 0.25 - s) / 0.35)));
    const drive = scene.drive?.(u) ?? null;
    await page.evaluate(({ cam, dip, cap, drive }) => {
      const yp = window.__yourPlace;
      yp.setCamera(cam);
      if (drive) yp[drive[0]](...drive[1]);
      const p = document.getElementById('promo');
      p.style.setProperty('--dip', dip);
      p.style.setProperty('--cap', cap);
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, { cam, dip, cap, drive });
    await shot(page, PREVIEW ? join(out, `preview-${scene.key}-${i}.jpg`) : framePath(n++));
  }

  if (si === SCENES.length - 1) {
    // end card: fade it in, then hold
    const fade = Math.round(0.4 * FPS);
    for (let i = 1; i <= fade; i++) {
      if (PREVIEW && i < fade) continue;
      await page.evaluate((v) => document.getElementById('promo').style.setProperty('--end', v), i / fade);
      await shot(page, PREVIEW ? join(out, 'preview-end.jpg') : framePath(n++));
    }
    if (!PREVIEW) {
      const hold = framePath(n - 1);
      for (let i = 0; i < Math.round(END_S * FPS); i++) copyFileSync(hold, framePath(n++));
    }
  }
  await page.close();
}
await ctx.close();
await browser.close();
server.close();

if (!PREVIEW) {
  const video = join(out, 'your-place-data-16x9.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  // a contact sheet (one frame per second) to check the cut without playing it
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=1,scale=480:-1,tile=6x8', '-frames:v', '1', '-q:v', '3', join(out, 'your-place-data-16x9-sheet.jpg')]);
  console.log(`your-place-data-16x9.mp4: ${n} frames, ${(n / FPS).toFixed(1)} s, ${(statSync(video).size / 1048576).toFixed(1)} MB`);
  rmSync(frames, { recursive: true, force: true });
}
