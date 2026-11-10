// Renders a video of the Trams & buses layer only: Hamburg and Berlin on a weekday morning, each
// timetable found and loaded the way the app does it (the Mobility Database's list, one tap), then
// an end card. Frames are captured one by one and encoded with ffmpeg, like tools/video/data.mjs.
//
//   npm run build && node tools/video/transit.mjs           video-out/your-place-data-transit.mp4
//   node tools/video/transit.mjs --preview                  two pictures per scene, to check the framing
//   node tools/video/transit.mjs --only=berlin              one city
//
// Needs the map services, the Mobility Database (the list and the two timetables, 40 and 85 MB) and
// Google Fonts (for the captions; it falls back without them).
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
const DIP_S = 0.35;
const END_S = 3.6;
/** the morning shown: 7:00 to 9:00, ten minutes a second */
const FROM_S = 7 * 3600;
const TO_S = 9 * 3600;

const SCENES = [
  {
    key: 'hamburg',
    hash: 'lat=53.5490&lon=9.9900&km=3&ex=1.5&dl=transit',
    feed: 'mdb-3362',
    seconds: 12,
    title: 'Hamburg’s morning, from the timetable',
    sub: (day) => `Every U-Bahn, S-Bahn, bus and ferry · ${day}, 7:00 to 9:00`,
    cam: { az: [-22, 12], tilt: [40, 50], dist: [0.86, 0.74] },
  },
  {
    key: 'berlin',
    hash: 'lat=52.5205&lon=13.4000&km=3&ex=1.5&dl=transit',
    feed: 'mdb-782',
    seconds: 12,
    title: 'Berlin’s morning, from the timetable',
    sub: (day) => `Every tram, U-Bahn, S-Bahn and bus · ${day}, 7:00 to 9:00`,
    cam: { az: [18, -14], tilt: [40, 50], dist: [0.86, 0.74] },
  },
].filter((s) => !ONLY || ONLY.includes(s.key));

// ------------------------------------------------------------------ static server for dist/

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
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
await new Promise((r) => server.listen(4328, '127.0.0.1', r));
const base = 'http://127.0.0.1:4328/';

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
      <div class="what">Trams and buses of your city, in 3D</div>
      <div class="free">Free · No sign-up · Find your city’s timetable in one tap</div>
      <div class="url">${SITE}</div>
      <div class="credits">Map data © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap · Terrain: Mapzen, AWS Terrain Tiles ·
        Timetables: Hamburger Verkehrsverbund (HVV, dl-de/by-2-0), Verkehrsverbund Berlin-Brandenburg (VBB, CC BY 4.0), via the Mobility Database</div>
    </div>
  </div>`;

// ------------------------------------------------------------------ rendering

const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const lerp = ([a, b], t) => a + (b - a) * t;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
await ctx.addInitScript(() => {
  try {
    for (const k of ['yp:tip-pin', 'yp:hint-mouse', 'yp:own']) localStorage.setItem(k, '1');
  } catch {}
});

const frames = join(out, 'frames-transit');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
let n = 0;
const framePath = (i) => join(frames, `${String(i).padStart(5, '0')}.jpg`);
const shot = (page, path) => page.screenshot({ path, type: 'jpeg', quality: 93, timeout: 120000 });

/** The weekday shown: today where the timetable runs if it's a weekday it has, else the nearest such day. */
async function pickWeekday(page) {
  const info = await page.evaluate(() => {
    const input = document.getElementById('transit-date');
    return { day: window.__yourPlace.transit().day, min: input.min, max: input.max };
  });
  const d = new Date(`${info.day}T12:00:00Z`);
  const dow = d.getUTCDay();
  if (dow >= 1 && dow <= 5) return info.day;
  // Saturday → Friday, Sunday → Monday, staying within the timetable
  const step = dow === 6 ? -1 : 1;
  const want = new Date(d.getTime() + step * 86400000).toISOString().slice(0, 10);
  if ((info.min && want < info.min) || (info.max && want > info.max)) return info.day;
  await page.evaluate((v) => {
    const input = document.getElementById('transit-date');
    input.value = v;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, want);
  await page.waitForFunction((v) => window.__yourPlace.transit().day === v && window.__yourPlace.transit().shown, want, { timeout: 120000 });
  return want;
}

for (const [si, scene] of SCENES.entries()) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${scene.key}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'warning' && console.log(`  [${scene.key}] ${m.text()}`));
  const t0 = Date.now();
  await page.goto(`${base}#${scene.hash}`);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 240000 }).catch(() => {});

  // find the place's timetables and load the one for the city, as a person would
  await page.evaluate(() => document.getElementById('transit-find-btn').click());
  await page.waitForFunction(() => window.__yourPlace.transit().found, null, { timeout: 120000 });
  const found = await page.evaluate(() => window.__yourPlace.transit().found);
  const at = found.indexOf(scene.feed);
  if (at < 0) throw new Error(`${scene.key}: ${scene.feed} isn't among the timetables found (${found.join(', ')})`);
  await page.evaluate((k) => document.querySelectorAll('#transit-feeds li button')[k].click(), at);
  const ok = await page
    .waitForFunction(() => window.__yourPlace.transit().status === 'ready' && window.__yourPlace.transit().shown, null, { timeout: 900000, polling: 1000 })
    .then(() => true, () => false);
  const day = ok ? await pickWeekday(page) : null;
  const info = await page.evaluate(() => {
    const t = window.__yourPlace.transit();
    return { stage: window.__yourPlace.stage, buildings: window.__yourPlace.stats()?.buildings, cam: window.__yourPlace.camera(), status: t.status, problem: t.problem, day: t.day, dayRuns: t.dayRuns, lines: t.lines.length, modes: [...new Set(t.lines.map((l) => l.split(':')[0]))] };
  });
  console.log(`${scene.key}: ${ok ? 'ready' : 'NOT READY'}, ${info.buildings} buildings, ${info.day}, ${info.dayRuns} runs on ${info.lines} lines (${info.modes.join(', ')}), ${((Date.now() - t0) / 1000).toFixed(0)} s${info.problem ? ` · problem: ${info.problem}` : ''}`);
  if (!ok) throw new Error(`${scene.key}: the timetable didn't load`);
  const dayText = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600;650&display=block' }).catch(() => console.log('  fonts unavailable, using fallbacks'));
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate(({ html, title, sub }) => {
    document.body.insertAdjacentHTML('beforeend', html);
    const p = document.getElementById('promo');
    p.querySelector('.title').textContent = title;
    p.querySelector('.sub').textContent = sub;
    document.getElementById('transit-control')?.scrollIntoView({ block: 'start' });
  }, { html: OVERLAY_HTML, title: scene.title, sub: scene.sub(dayText) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);

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
    // trails of five minutes, as the app's own fast replay has them
    const time = FROM_S + u * (TO_S - FROM_S);
    await page.evaluate(({ cam, dip, cap, time }) => {
      const yp = window.__yourPlace;
      yp.setCamera(cam);
      yp.transitAt(time, 300);
      const p = document.getElementById('promo');
      p.style.setProperty('--dip', dip);
      p.style.setProperty('--cap', cap);
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, { cam, dip, cap, time });
    await shot(page, PREVIEW ? join(out, `preview-transit-${scene.key}-${i}.jpg`) : framePath(n++));
  }

  if (si === SCENES.length - 1) {
    const fade = Math.round(0.4 * FPS);
    for (let i = 1; i <= fade; i++) {
      if (PREVIEW && i < fade) continue;
      await page.evaluate((v) => document.getElementById('promo').style.setProperty('--end', v), i / fade);
      await shot(page, PREVIEW ? join(out, 'preview-transit-end.jpg') : framePath(n++));
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
  const video = join(out, 'your-place-data-transit.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=1,scale=480:-1,tile=6x5', '-frames:v', '1', '-q:v', '3', join(out, 'your-place-data-transit-sheet.jpg')]);
  console.log(`your-place-data-transit.mp4: ${n} frames, ${(n / FPS).toFixed(1)} s, ${(statSync(video).size / 1048576).toFixed(1)} MB`);
  rmSync(frames, { recursive: true, force: true });
}
