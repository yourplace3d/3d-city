// Renders one picture per layer for sharing (e.g. r/dataisbeautiful): the model with a card that
// says what it shows, the layer's own legend and the data's source; no app controls. Live data,
// like the video. Run after `npm run build`:
//
//   node tools/video/stills.mjs                  video-out/stills/*.jpg, 2880 × 1620
//   node tools/video/stills.mjs --only=homes     one of them
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');
const out = join(root, 'video-out', 'stills');
mkdirSync(out, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const SITE = process.env.SITE ?? 'yourplace3d.github.io/3dcitydata';
const OSM = 'Map: © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap · Terrain: Mapzen, AWS Terrain Tiles';

const click = (sel) => async (page) => page.evaluate((s) => document.querySelector(s).click(), sel);

const SCENES = [
  {
    key: 'homes',
    hash: 'lat=47.99555&lon=7.85065&km=2&ex=1.5&dl=homes',
    setup: click('#homes-control [data-act="demo"]'),
    ready: () => window.__yourPlace.areas('homes')?.status === 'ready' && window.__yourPlace.areas('homes')?.tinted,
    kicker: 'Freiburg im Breisgau · 2022 census',
    title: 'Rent per m², by 100 m square',
    text: 'Average rent per m² a month, without heating. Each building takes the value of the 100 m square it stands in; each colour holds a fifth of the squares shown. Grey: no value published.',
    legend: '#homes-control .area-legend',
    source: 'Zensus 2022, Statistische Ämter des Bundes und der Länder (dl-de/by-2-0)',
    cam: { az: -14, tilt: 44, dist: 0.86 },
  },
  {
    key: 'income',
    hash: 'lat=52.3702&lon=4.8952&km=2&ex=1.5&dl=income',
    setup: click('#income-control [data-act="demo"]'),
    ready: () => window.__yourPlace.areas('income')?.status === 'ready' && window.__yourPlace.areas('income')?.tinted,
    kicker: 'Amsterdam · 2023',
    title: 'Average income per resident, by district',
    text: 'Each building takes the value of the district it stands in; each colour holds a fifth of the districts shown.',
    legend: '#income-control .area-legend',
    source: 'CBS, Kerncijfers wijken en buurten 2023, via PDOK (CC BY 4.0)',
    cam: { az: -8, tilt: 44, dist: 0.86 },
  },
  {
    key: 'traffic',
    hash: 'lat=53.5511&lon=9.9937&km=2&ex=1.5&dl=traffic',
    ready: () => window.__yourPlace.traffic()?.status === 'ready' && window.__yourPlace.traffic()?.shown,
    // the busiest hour of the last 24
    prepare: async (page) => {
      await page.evaluate(() => {
        const totals = window.__yourPlace.traffic().totals;
        window.__yourPlace.trafficAt(totals.indexOf(Math.max(...totals)));
      });
      const readout = (await page.textContent('#traffic-readout'))?.trim() ?? '';
      const points = await page.evaluate(() => window.__yourPlace.traffic().columns);
      return { kicker: `Hamburg · ${readout}`, text: `Cars counted in that hour at ${points} counting points (the white dots), each count spread along the streets around its point and fading out over 300 m. The streets rise and redden with the traffic; between the dots it’s an estimate.` };
    },
    kicker: 'Hamburg',
    title: 'Cars per hour, along the streets',
    text: '',
    legend: '#traffic-key .traffic-legend',
    source: 'Traffic counts: Freie und Hansestadt Hamburg, Behörde für Verkehr und Mobilitätswende (dl-de/by-2-0)',
    cam: { az: 6, tilt: 48, dist: 0.84 },
  },
  {
    key: 'transit',
    hash: 'lat=47.99555&lon=7.85065&km=2&ex=1.5&dl=transit',
    setup: click('#transit-demo'),
    ready: () => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.transit()?.shown,
    prepare: async (page) => {
      await page.evaluate(() => window.__yourPlace.transitAt(8.5 * 3600, 300));
      return {};
    },
    kicker: 'Freiburg im Breisgau · a weekday, 8:30',
    title: 'Every tram and bus, from the timetable',
    text: 'Where the timetable puts each vehicle at 8:30, with a trail of its last five minutes. Lines are drawn in the colour of their mode. The plan, not live positions.',
    legend: '#transit-modes',
    source: 'Timetable: Freiburger Verkehrs AG (VAG), GTFS (dl-de/by-2-0)',
    cam: { az: 6, tilt: 46, dist: 0.76 },
  },
  {
    key: 'steep',
    hash: 'lat=37.7990&lon=-122.4140&km=2&ex=1.5&dl=steep',
    ready: () => (window.__yourPlace.steep()?.pieces ?? 0) > 0,
    kicker: 'San Francisco',
    title: 'How steep the streets are',
    text: 'Every road and path coloured by its slope, measured on the terrain over 60 m at a time. Under 3 %: left as it is. Terrain exaggerated 1.5×.',
    legend: '#steep-scale',
    source: 'Slopes from the terrain data',
    cam: { az: -10, tilt: 40, dist: 0.92 },
  },
].filter((s) => !ONLY || ONLY.includes(s.key));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.geojson': 'application/geo+json', '.csv': 'text/csv', '.zip': 'application/zip', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4327, '127.0.0.1', r));
const base = 'http://127.0.0.1:4327/';

const CSS = `
  .topbar, .fabs, .sheet, .attribution, .toast, .notice, .status, .welcome, .mouse-hint { display: none !important; }
  #still { position: fixed; inset: 0; z-index: 100; pointer-events: none; color: #1e1c19; }
  #still .card { position: absolute; left: 56px; top: 56px; width: 470px; padding: 28px 30px 24px; border-radius: 18px;
    background: rgba(251, 250, 247, 0.96); box-shadow: 0 10px 34px rgba(60, 50, 35, 0.16), 0 1px 3px rgba(60, 50, 35, 0.12); }
  #still .kicker { font: 650 14px/1.3 Inter, system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: #b13a15; }
  #still h1 { margin: 10px 0 0; font: 500 40px/1.1 Fraunces, Georgia, serif; letter-spacing: -0.015em; }
  #still .text { margin: 14px 0 0; font: 400 17px/1.45 Inter, system-ui, sans-serif; color: #3d3832; }
  #still .legend { margin-top: 18px; font: 400 16px/1.4 Inter, system-ui, sans-serif; }
  #still .legend ul { margin: 0; }
  #still .source { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(60, 50, 35, 0.14); font: 400 13px/1.45 Inter, system-ui, sans-serif; color: #6b645a; }
  #still .made { margin-top: 6px; font: 500 13px/1.45 Inter, system-ui, sans-serif; color: #6b645a; }
`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
await ctx.addInitScript(() => {
  try {
    for (const k of ['yp:tip-pin', 'yp:hint-mouse', 'yp:own']) localStorage.setItem(k, '1');
  } catch {}
});
const stage = (page) => page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 240000 }).catch(() => {});

for (const scene of SCENES) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${scene.key}] page error: ${e.message}`));
  await page.goto(`${base}#${scene.hash}`);
  await stage(page);
  if (scene.setup) {
    await scene.setup(page);
    await page.waitForTimeout(500);
    await stage(page);
  }
  const ok = await page.waitForFunction(scene.ready, null, { timeout: 240000 }).then(() => true, () => false);
  await page.waitForTimeout(1500);
  const extra = (await scene.prepare?.(page)) ?? {};
  const legend = await page.evaluate((sel) => document.querySelector(sel)?.outerHTML ?? '', scene.legend);
  await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;650&display=block' }).catch(() => console.log('  fonts unavailable'));
  await page.addStyleTag({ content: CSS });
  await page.evaluate(
    ({ s, legend, site, osm }) => {
      const div = document.createElement('div');
      div.id = 'still';
      div.innerHTML = `<div class="card"><div class="kicker"></div><h1></h1><p class="text"></p><div class="legend">${legend}</div>
        <div class="source"></div><div class="made"></div></div>`;
      div.querySelector('.kicker').textContent = s.kicker;
      div.querySelector('h1').textContent = s.title;
      div.querySelector('.text').textContent = s.text;
      div.querySelector('.source').textContent = `Data: ${s.source}. ${osm}`;
      div.querySelector('.made').textContent = `Made with Your Place · Data, free in the browser: ${site}`;
      document.body.append(div);
    },
    { s: { kicker: extra.kicker ?? scene.kicker, title: scene.title, text: extra.text ?? scene.text, source: scene.source }, legend, site: SITE, osm: OSM },
  );
  await page.evaluate(() => document.fonts.ready);
  const d = (await page.evaluate(() => window.__yourPlace.camera())).distance;
  // the model right of the card: move the camera's target to the screen's left
  await page.evaluate(({ c, d }) => {
    const dist = d * c.dist;
    const shift = dist * 0.13;
    const r = (c.az * Math.PI) / 180;
    window.__yourPlace.setCamera({ azimuth: c.az, tilt: c.tilt, distance: dist, targetE: -shift * Math.cos(r), targetN: -shift * Math.sin(r) });
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }, { c: scene.cam, d });
  await page.waitForTimeout(1000);
  const file = join(out, `${scene.key}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 90, timeout: 120000 });
  console.log(`${scene.key}: ${ok ? 'ready' : 'NOT READY'} → video-out/stills/${scene.key}.jpg${extra.kicker ? ` (${extra.kicker})` : ''}`);
  await page.close();
}
await browser.close();
server.close();
