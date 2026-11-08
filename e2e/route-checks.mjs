/**
 * End-to-end checks for routes (GPX, TCX), run by smoke.mjs: load a file from the landing page,
 * the stretch picker, replay, hiding the ends, the opt-in share link and opening it, removing
 * the route, a TCX file dropped on the page, a FIT file, and a phone. Also checks privacy: the
 * file never goes out in a request, no place-name lookup is made for it, and links carry no
 * route unless the user turns that on.
 */

import { routeGpx, routeTcx } from './fixtures/route.mjs';

export async function routeChecks({ browser, base, routeAll, expect, watchConsole, waitStage, settle, shot }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await routeAll(ctx);
  const page = await ctx.newPage();
  watchConsole(page, 'route');
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), body: r.postData() ?? '' }));
  const route = () => page.evaluate(() => window.__yourPlace.route());
  const reload = async (before) => {
    await page.waitForFunction((c) => JSON.stringify(window.__yourPlace.state().center) !== c, JSON.stringify(before), { timeout: 10000 }).catch(() => undefined);
    await waitStage(page, ['ready', 'error']);
  };

  await page.goto(base);
  await page.waitForSelector('#route-landing-btn', { state: 'visible' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#route-landing-btn')]);
  await chooser.setFiles({ name: 'test-city-half.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(routeGpx()) });
  await page.waitForFunction(() => window.__yourPlace.route()?.shown, null, { timeout: 60000 });
  const t = await waitStage(page, ['ready', 'error']);
  expect(t.stage === 'ready', 'a GPX file from the landing page builds a model');
  let r = await route();
  const st = await page.evaluate(() => window.__yourPlace.state());
  expect(r.name === 'Test City Half' && (await page.textContent('#place-title')) === 'Test City Half', `the model is named after the route (“${r.name}”)`);
  expect(r.endM > 13000 && r.toM === r.endM && r.fromM > 4000 && st.size === 4000, `a route too big for one model shows its finish stretch (km ${(r.fromM / 1000).toFixed(1)}–${(r.toM / 1000).toFixed(1)} of ${(r.endM / 1000).toFixed(1)}, ${st.size} m)`);
  expect(r.marks.includes('Finish') && !r.marks.includes('Start') && r.marks.some((m) => /^\d+ km$/.test(m)), `the finish and km markers are labelled (${r.marks.join(', ')})`);
  expect(!(await page.evaluate(() => window.__yourPlace.pin().visible)), 'the pin stays hidden on a route’s square');
  expect(/The route “Test City Half” crosses the model/.test(await page.textContent('#describe')), 'the description mentions the route');
  expect(!/rt=/.test(await page.evaluate(() => location.hash)), 'the address bar holds no route');
  expect(!requests.some((q) => /trkpt|<gpx/i.test(q.url + q.body)), 'the route file never leaves the browser');
  expect(!requests.some((q) => /photon\.komoot\.io\/reverse|nominatim/.test(q.url)), 'no place-name lookup is made for a route');
  await settle(page, 2200);
  await shot(page, 'r1-route-desktop');

  // replay
  await page.click('#route-play');
  await page.waitForFunction(() => window.__yourPlace.route().position > 0.01, null, { timeout: 20000 }).catch(() => undefined);
  r = await route();
  const clock = await page.textContent('#route-clock');
  expect(r.playing && r.runner && /^\d+(\.\d)? km · \d+:\d\d(:\d\d)?$/.test(clock), `replay moves a runner along the stretch with the race clock (“${clock}”)`);
  expect((await page.textContent('#route-play')) === 'Pause', 'the replay button turns into Pause');
  await settle(page, 600);
  await shot(page, 'r2-route-replay');
  await page.click('#route-play');
  expect(!(await route()).playing, 'replay pauses');

  // the height profile, and where it gets steep
  const steep = () => page.evaluate(() => window.__yourPlace.steep());
  const summary = await page.textContent('#profile-summary');
  expect((await page.isVisible('#route-profile')) && /^\d[\d,]* m up, \d[\d,]* m down/.test(summary), `the route has a height profile (“${summary}”)`);
  await page.locator('#profile-chart').scrollIntoViewIfNeeded();
  const chart = await page.locator('#profile-chart').boundingBox();
  await page.mouse.move(chart.x + chart.width * 0.4, chart.y + chart.height / 2);
  const readout = await page.textContent('#profile-readout');
  expect(/^km \d+(\.\d)? · [\d,]+ m · [+−]?\d+%$/.test(readout) && (await page.isVisible('#profile-cross')), `pointing at the profile shows km, height and grade (“${readout}”)`);
  await shot(page, 'r2a-route-profile');
  await page.mouse.move(chart.x + chart.width / 2, chart.y - 40);
  expect((await page.textContent('#profile-readout')) === '', 'the readout clears when the pointer leaves');
  await page.click('[data-layer="steep"]');
  await page.waitForFunction(() => window.__yourPlace.route().steep, null, { timeout: 15000 }).catch(() => undefined);
  let s = await steep();
  r = await route();
  expect(s.on && s.routeOnly && !s.shown && r.steep, `with a route, steepness colours only the route (climbs: ${r.climbs.join(', ') || 'none'})`);
  expect((await page.isVisible('#steep-legend')) && (await page.locator('#steep-scale li').count()) === 4 && (await page.isVisible('#steep-route-note')), 'a legend shows the four classes, and says only the route is coloured');
  expect(/ly=rwgs/.test(await page.evaluate(() => location.hash)), 'the link keeps steepness on');
  await settle(page, 1500);
  await shot(page, 'r2b-route-steepness');

  // the stretch: from the start; the end is pulled in so it fits
  const before = st.center;
  await page.$eval('#route-from', (el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await reload(before);
  r = await route();
  expect(r.fromM === 0 && r.toM < r.endM && r.marks.includes('Start') && !r.marks.includes('Finish'), `moving the start builds the model around the new stretch (km 0–${(r.toM / 1000).toFixed(1)}, ${r.marks.join(', ')})`);
  expect(!(await steep()).shown && r.steep, 'the new stretch is measured for steepness too');
  expect(/^0(\.0)?$/.test(await page.textContent('#route-from-out')), 'the stretch readout follows');
  await settle(page, 1500);
  await shot(page, 'r3-route-start');

  // hide the ends
  await page.check('#route-trim');
  r = await route();
  expect(r.trim && r.fromM >= 499 && !r.marks.includes('Start'), `hiding the ends drops the first 500 m and the start label (from ${Math.round(r.fromM)} m)`);

  // share: off by default, then on
  await page.click('#share-btn');
  await page.waitForSelector('#share-dialog[open]');
  expect((await page.isVisible('#share-route-row')) && !(await page.isChecked('#share-route')), 'the share dialog offers the route, unticked');
  expect(!(await page.inputValue('#share-url')).includes('rt='), 'share links carry no route by default');
  await page.check('#share-route');
  const link = await page.inputValue('#share-url');
  const code = /[#&]rt=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? '';
  expect(code.length > 20 && code.length < 6000, `ticking it puts the stretch in the link (${code.length} characters)`);
  await shot(page, 'r4-share-route');
  await page.keyboard.press('Escape');

  // the link opens the same stretch elsewhere, without the file
  const other = await ctx.newPage();
  watchConsole(other, 'route-link');
  await other.goto(link);
  await other.waitForFunction(() => window.__yourPlace?.route?.()?.shown, null, { timeout: 60000 });
  await waitStage(other, ['ready', 'error']);
  const shared = await other.evaluate(() => window.__yourPlace.route());
  expect(shared.shared && Math.abs(shared.fromM - r.fromM) < 2 && Math.abs(shared.toM - r.toM) < 40 && !shared.hasTime, `a shared link shows the stretch with its km numbers, no times (km ${(shared.fromM / 1000).toFixed(1)}–${(shared.toM / 1000).toFixed(1)})`);
  expect(!shared.marks.includes('Start') && (await other.isHidden('#route-stretch')) && (await other.textContent('#route-name')) === 'Shared route', 'the hidden start stays hidden, and the shared route can’t be stretched');
  expect(!(await other.evaluate(() => window.__yourPlace.pin().visible)), 'the pin stays hidden on a shared route');
  await other.waitForFunction(() => window.__yourPlace.route().steep, null, { timeout: 15000 }).catch(() => undefined);
  expect((await other.evaluate(() => window.__yourPlace.steep().on)) && (await other.isVisible('#route-profile')), 'the link opens with steepness on and the profile shown');
  await settle(other, 1500);
  await shot(other, 'r5-shared-route');
  await other.close();

  // remove the route: with steepness still on, all roads take the colours back
  await page.click('#route-remove');
  expect((await route()) === null && (await page.isVisible('#route-load-btn')) && !(await page.isVisible('#route-profile')), 'the route can be removed');
  expect(!/rt=/.test(await page.evaluate(() => location.hash)) && (await page.evaluate(() => window.__yourPlace.pin().visible)), 'removing it clears the link and shows the pin again');
  await page.waitForFunction(() => window.__yourPlace.steep().shown, null, { timeout: 15000 }).catch(() => undefined);
  s = await steep();
  expect(s.on && !s.routeOnly && s.shown && s.pieces > 20 && s.lengths[2] + s.lengths[3] + s.lengths[4] > 0 && !(await page.isVisible('#steep-route-note')), `without a route, steepness colours all roads and paths (${s.pieces} pieces; m per class ${s.lengths.join(', ')})`);
  expect(/steeper than 6%: [\d.]+ km/.test(await page.textContent('#describe')), 'the description says how much is steep');
  await settle(page, 1500);
  await shot(page, 'r5b-steepness-roads');
  await page.click('[data-layer="steep"]');
  s = await steep();
  expect(!s.on && !s.shown && !(await page.isVisible('#steep-legend')), 'steepness turns off');

  // a TCX file dropped on the page, named after the file
  const drop = (name, text) =>
    page.evaluate(
      ([n, s]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([s], n));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [name, text],
    );
  const centre = await page.evaluate(() => window.__yourPlace.state().center);
  await drop('Lunch_Run.tcx', routeTcx());
  await page.waitForFunction(() => window.__yourPlace.route()?.name === 'Lunch Run', null, { timeout: 10000 }).catch(() => undefined);
  await reload(centre);
  r = await route();
  expect(r?.name === 'Lunch Run' && r.hasTime && r.shown, 'a TCX file dropped on the page loads, named after the file');

  // a FIT file: a clear message, the route stays
  await drop('activity.fit', '\x0e\x10\x00\x00\x00\x00\x00\x00.FIT\x00\x00');
  await page.waitForFunction(() => /FIT files/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }).catch(() => undefined);
  expect(/^FIT files can’t be read yet/.test(await page.textContent('#toast')) && (await route())?.name === 'Lunch Run', 'a FIT file gets a clear message and changes nothing');
  await ctx.close();

  // a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await routeAll(phone);
  const pp = await phone.newPage();
  watchConsole(pp, 'route-phone');
  await pp.goto(base);
  await pp.waitForSelector('#route-landing-btn', { state: 'visible' });
  const [pc] = await Promise.all([pp.waitForEvent('filechooser'), pp.tap('#route-landing-btn')]);
  await pc.setFiles({ name: 'run.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(routeGpx('Phone Run')) });
  await pp.waitForFunction(() => window.__yourPlace.route()?.shown, null, { timeout: 60000 });
  await waitStage(pp, ['ready', 'error']);
  await settle(pp, 1500);
  await shot(pp, 'r6-route-phone');
  await pp.tap('#sheet-toggle');
  await pp.locator('#route-play').scrollIntoViewIfNeeded();
  await settle(pp, 400);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow <= 0 && (await pp.isVisible('#route-play')), 'the route panel fits a phone');
  await shot(pp, 'r7-route-phone-panel');
  await phone.close();
}
