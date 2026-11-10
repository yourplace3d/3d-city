// Renders the link preview (public/og.jpg, 1200 × 630) and the about page's screenshot
// (public/screenshot.jpg, 1600 × 1000) from the built app with live data: Freiburg's rents, the
// example the app hosts. Run after `npm run build`:
//
//   node tools/og/render.mjs                    SITE=yourplace3d.github.io/3dcitydata by default
//
// Needs the map services and Google Fonts (for the preview's text; it falls back without them).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');
const SITE = process.env.SITE ?? 'yourplace3d.github.io/3dcitydata';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.geojson': 'application/geo+json', '.csv': 'text/csv', '.zip': 'application/zip', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4324, '127.0.0.1', r));
const base = 'http://127.0.0.1:4324/';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** Freiburg with its rents, ready; `width` × `height`, light. */
async function freiburg(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
  await ctx.addInitScript(() => {
    try {
      for (const k of ['yp:tip-pin', 'yp:hint-mouse', 'yp:own']) localStorage.setItem(k, '1');
    } catch {}
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
  await page.goto(`${base}#lat=47.99555&lon=7.85065&km=2&ex=1.5&dl=homes`);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 240000 });
  await page.evaluate(() => document.querySelector('#homes-presets .chip').click());
  await page.waitForFunction(() => window.__yourPlace.areas('homes')?.tinted && window.__yourPlace.stage === 'ready', null, { timeout: 240000 });
  await page.addStyleTag({ content: '.toast, .notice, .status, .mouse-hint { display: none !important; }' });
  await page.waitForTimeout(1500);
  return { ctx, page };
}
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// ---- the about page's screenshot: the app as it is, panel open
{
  const { ctx, page } = await freiburg(1600, 1000);
  const d = (await page.evaluate(() => window.__yourPlace.camera())).distance;
  await page.evaluate((d) => window.__yourPlace.setCamera({ azimuth: -14, tilt: 42, distance: d * 0.9, targetE: 0, targetN: 0 }), d);
  await frame(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(root, 'public', 'screenshot.jpg'), type: 'jpeg', quality: 86 });
  console.log('public/screenshot.jpg');
  await ctx.close();
}

// ---- the link preview: the model on the right, what the app is on the left
{
  const { ctx, page } = await freiburg(1200, 630);
  await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;650&display=block' }).catch(() => console.log('fonts unavailable, using fallbacks'));
  await page.addStyleTag({
    content: `
      .topbar, .fabs, .sheet, .attribution, .welcome { display: none !important; }
      #og { position: fixed; inset: 0; z-index: 100; pointer-events: none; color: #1e1c19; }
      #og .scrim { position: absolute; top: 0; bottom: 0; left: 0; width: 640px;
        background: linear-gradient(90deg, rgba(240,237,231,0.98) 0%, rgba(240,237,231,0.94) 62%, rgba(240,237,231,0) 100%); }
      #og .kicker { position: absolute; top: 180px; left: 64px; font: 650 15px/1 Inter, system-ui, sans-serif; letter-spacing: 0.16em; text-transform: uppercase; color: #b13a15; }
      #og h1 { position: absolute; top: 212px; left: 64px; width: 470px; margin: 0; font: 400 50px/1.1 Fraunces, Georgia, serif; letter-spacing: -0.015em; }
      #og p { position: absolute; top: 368px; left: 64px; width: 400px; margin: 0; font: 400 20px/1.45 Inter, system-ui, sans-serif; color: #4a453e; }
      #og .url { position: absolute; bottom: 38px; left: 64px; font: 400 17px/1 Inter, system-ui, sans-serif; color: #7a7368; }
    `,
  });
  await page.evaluate((site) => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="og"><div class="scrim"></div><div class="kicker">Your Place · Data</div><h1>Your city, through open data</h1>
       <p>Steep streets, traffic, trams and buses, rents and incomes, on a 3D model of any place. Free, in your browser.</p>
       <div class="url">${site}</div></div>`,
    );
  }, SITE);
  await page.evaluate(() => document.fonts.ready);
  const d = (await page.evaluate(() => window.__yourPlace.camera())).distance;
  // the model right of the text: move the camera's target to the screen's left
  await page.evaluate((d) => {
    const az = -20;
    const shift = d * 0.62 * 0.28;
    const r = (az * Math.PI) / 180;
    window.__yourPlace.setCamera({ azimuth: az, tilt: 48, distance: d * 0.62, targetE: -shift * Math.cos(r), targetN: -shift * Math.sin(r) });
  }, d);
  await frame(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(root, 'public', 'og.jpg'), type: 'jpeg', quality: 86 });
  console.log('public/og.jpg');
  await ctx.close();
}

await browser.close();
server.close();
