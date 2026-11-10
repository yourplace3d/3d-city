/**
 * End-to-end checks for Your Place · Data, run by smoke.mjs: its own page and start page, the steepness layer from a preset, a route of your own over it (GPX, TCX) with the
 * stretch picker, replay, height profile, hiding the ends, the opt-in share link and opening it,
 * removing the route, a TCX file dropped on the page, a FIT file; the traffic layer (Hamburg's
 * counts from a fixture) with its bar chart, columns, replay, cars and bikes, and a route over
 * it; and a phone. Also checks privacy: the file never goes out in a request, no place-name
 * lookup is made for it, and links carry no route unless the user turns that on.
 */

import { routeGpx, routeTcx } from './fixtures/route.mjs';
import { hamburgGpx } from './fixtures/traffic.mjs';

export async function dataAppChecks({ browser, base, routeAll, expect, watchConsole, waitStage, settle, shot }) {
  const dataBase = base;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  await routeAll(ctx);
  const page = await ctx.newPage();
  watchConsole(page, 'data');
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), body: r.postData() ?? '' }));
  const route = () => page.evaluate(() => window.__yourPlace.route());
  const steep = () => page.evaluate(() => window.__yourPlace.steep());
  const traffic = () => page.evaluate(() => {
    const t = window.__yourPlace.traffic();
    return t && { ...t, columnPoint: undefined, columnAt: undefined };
  });
  const reload = async (before) => {
    await page.waitForFunction((c) => JSON.stringify(window.__yourPlace.state().center) !== c, JSON.stringify(before), { timeout: 10000 }).catch(() => undefined);
    await waitStage(page, ['ready', 'error']);
  };

  // ---- its own page, standing on its own
  await page.goto(dataBase);
  await page.waitForSelector('#route-landing-btn', { state: 'visible' });
  const head = await page.evaluate(async () => ({
    title: document.title,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
    manifest: await fetch(document.querySelector('link[rel="manifest"]').href).then((r) => r.json()),
    icon: await fetch(document.querySelector('link[rel="icon"]').href).then((r) => r.ok),
    cards: document.querySelectorAll('.layer-card').length,
    examples: document.querySelectorAll('.layer-card .chip, .card-presets').length,
    print: !!document.getElementById('stl-btn'),
    other: !!document.querySelector('#other-app, a[href^="../"]'),
  }));
  expect(/^Your Place · Data/.test(head.title) && head.title.length <= 60 && /^https:\/\/.+\/$/.test(head.canonical) && !/\/data\/$/.test(head.canonical), `the data app has its own page at its own address (“${head.title}”, ${head.canonical})`);
  expect(head.manifest.name === 'Your Place · Data' && head.icon, 'it installs as its own app, with its own icon');
  expect(head.cards === 6 && head.examples === 0 && !head.print && !head.other, 'its start page shows the layers as cards, without example places, and your route on its own; nothing to print, no way to another app');
  await shot(page, 'd0-data-landing');

  // ---- steepness, the first layer, for a place searched
  await page.fill('#search-input', 'Stuttgart');
  await page.keyboard.press('Enter');
  await waitStage(page, ['ready', 'error']);
  await page.waitForFunction(() => window.__yourPlace.steep().shown, null, { timeout: 15000 }).catch(() => undefined);
  let s = await steep();
  expect(s.on && s.shown && s.pieces > 20 && s.lengths[2] + s.lengths[3] + s.lengths[4] > 0, `steepness colours the roads and paths (${s.pieces} pieces; m per class ${s.lengths.join(', ')})`);
  expect((await page.isVisible('#steep-legend')) && (await page.locator('#steep-scale li').count()) === 4 && (await page.isHidden('#traffic-control')), 'a legend shows the four classes');
  expect((await page.isVisible('#route-load-btn')) && (await page.locator('#data-layer-group [role="radio"]').count()) === 5, 'your route has its own place under the layer switch, not one of the layers');
  expect(/dl=steep/.test(await page.evaluate(() => location.hash)) && /^Stuttgart · Your Place Data$/.test(await page.title()), 'the link and the tab name the layer and the place');
  expect(/steeper than 6%: [\d.]+ km/.test(await page.textContent('#describe')), 'the description says how much is steep');
  await settle(page, 1500);
  await shot(page, 'd1-steepness');

  // ---- your route, over steepness
  expect(!requests.some((q) => /iot\.hamburg\.de/.test(q.url)), 'no traffic counts are asked for while the traffic layer is off');
  // from here on, only what loading the route asks for (the place above was searched for by name)
  requests.length = 0;
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#route-load-btn')]);
  await chooser.setFiles({ name: 'test-city-half.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(routeGpx()) });
  await page.waitForFunction(() => window.__yourPlace.route()?.shown && window.__yourPlace.route()?.name === 'Test City Half', null, { timeout: 60000 });
  const t = await waitStage(page, ['ready', 'error']);
  expect(t.stage === 'ready', 'a GPX file builds a model around the route');
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
  // paused for the picture (the runner stays where it was)
  await page.click('#route-play');
  expect(!(await route()).playing, 'replay pauses');
  await shot(page, 'r2-route-replay');

  // the height profile, and where it gets steep
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
  s = await steep();
  r = await route();
  expect(!s.shown && r.steep && r.climbs.length > 0 && /dl=steep/.test(await page.evaluate(() => location.hash)), `with a route on steepness, only the route shows where it gets steep (climbs: ${r.climbs.join(', ')})`);
  await settle(page, 600);
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
  expect(r.steep && r.shown, 'the new stretch is measured for steepness too');
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
  expect(shared.steep && (await other.isVisible('#route-profile')) && /dl=steep/.test(link), 'the link opens the route over steepness, with the profile');
  await settle(other, 1500);
  await shot(other, 'r5-shared-route');
  await other.close();

  // switch layers: the route stays, and wears steepness colours only on steepness
  await page.click('#data-layer-group [data-value="traffic"]');
  await page.waitForFunction(() => window.__yourPlace.traffic().status === 'outside', null, { timeout: 15000 }).catch(() => undefined);
  r = await route();
  let tr = await traffic();
  expect(r.shown && !r.steep && r.name === 'Test City Half' && (await page.isVisible('#route-load-btn')) === false && (await page.isVisible('#route-remove')), 'on another layer the route stays, in its own colour');
  expect(tr.on && tr.status === 'outside' && (await page.isVisible('#traffic-hamburg')) && /only available for Hamburg/.test(await page.textContent('#traffic-status')), 'outside Hamburg the traffic layer says so and offers Hamburg');
  expect(!requests.some((q) => /iot\.hamburg\.de/.test(q.url)), 'and asks for no counts there');
  await page.click('#data-layer-group [data-value="steep"]');
  r = await route();
  s = await steep();
  expect(r.shown && r.steep && !s.shown, 'back on steepness the route takes its colours again');

  // remove the route
  await page.click('#route-remove');
  expect((await route()) === null && (await page.isVisible('#route-load-btn')) && !(await page.isVisible('#route-profile')), 'the route can be removed');
  expect(!/rt=/.test(await page.evaluate(() => location.hash)) && (await page.evaluate(() => window.__yourPlace.pin().visible)), 'removing it clears the link and shows the pin again');
  await page.waitForFunction(() => window.__yourPlace.steep().shown, null, { timeout: 15000 }).catch(() => undefined);
  expect((await steep()).shown, 'without a route, steepness colours the roads again');

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
  await page.click('#route-remove');

  // ---- traffic: Hamburg's hourly counts as red streets that rise with the traffic, and a bar chart of the day
  await page.click('#data-layer-group [data-value="traffic"]');
  await page.waitForSelector('#traffic-hamburg', { state: 'visible' });
  // the first answer is unusable: a clear message and a way to try again (a failed request
  // would also log a console error, which fails this test)
  const failOnce = (rt) => rt.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"down"}' });
  await ctx.route(/iot\.hamburg\.de/, failOnce);
  const leaving = await page.evaluate(() => window.__yourPlace.state().center);
  await page.click('#traffic-hamburg');
  await reload(leaving);
  await page.waitForFunction(() => window.__yourPlace.traffic().status === 'error', null, { timeout: 20000 }).catch(() => undefined);
  expect((await traffic()).status === 'error' && (await page.isVisible('#traffic-retry')) && /couldn’t be loaded/.test(await page.textContent('#traffic-status')), 'when the counts can’t be loaded the panel says so and offers to try again');
  await ctx.unroute(/iot\.hamburg\.de/, failOnce);
  await page.click('#traffic-retry');
  await page.waitForFunction(() => window.__yourPlace.traffic().status === 'ready', null, { timeout: 20000 }).catch(() => undefined);
  tr = await traffic();
  const hh = await page.evaluate(() => ({ title: document.title, hash: location.hash }));
  expect(tr.status === 'ready' && tr.shown && tr.points === 15 && tr.columns === 14, `the counting points in the square are on the model, the two directions of a road as one (${tr.points} points, ${tr.columns} on the model)`);
  expect(tr.onStreet === 14 && tr.streets.samples > 200 && tr.streets.runs > 10 && tr.streets.highest > 0.5 && tr.spread === 300, `each count spreads 300 m along the streets around it (${tr.streets.samples} street points in ${tr.streets.runs} stretches, the highest at ${Math.round(tr.streets.highest * 100)} % of the day’s top)`);
  expect((await page.isVisible('.traffic-ramp')) && /Less traffic/.test(await page.textContent('.traffic-legend')) && (await page.inputValue('#traffic-spread')) === '300', 'a legend shows the reds, and a slider the spread');
  expect(/Hamburg city centre/.test(hh.title) && /dl=traffic/.test(hh.hash) && !/tk=/.test(hh.hash), 'Show Hamburg opens Hamburg’s centre on the traffic layer, counting cars');
  const busiest = tr.totals.indexOf(Math.max(...tr.totals));
  expect(tr.hour === busiest && tr.labels >= 1, `it opens on the busiest hour, with counts on the busiest counting points (hour ${tr.hour}, ${tr.labels} labels)`);
  expect((await page.locator('#traffic-bars .tbar').count()) === 24 && (await page.locator('#traffic-bars .tbar.on').count()) === 1, 'the bar chart has a bar per hour, the hour shown marked');
  const tread = await page.textContent('#traffic-readout');
  expect(/^\w{3} \d\d:00–\d\d:00: [\d,]+ cars$/.test(tread) && /at 14 counting points, added up/.test(await page.textContent('#traffic-sub')), `the readout says when and how many (“${tread}”)`);
  expect(/Traffic: [\d,]+ cars at \d+ counting points in the busiest hour/.test(await page.textContent('#describe')) && /Freie und Hansestadt Hamburg/.test(await page.textContent('.traffic-credit')), 'the description sums it up, and the city is credited');
  await settle(page, 1500);
  await shot(page, 't1-traffic');

  // pick an hour in the chart, by pointer and by keyboard
  await page.locator('#traffic-chart').scrollIntoViewIfNeeded();
  const tc = await page.locator('#traffic-chart').boundingBox();
  await page.mouse.click(tc.x + 32, tc.y + tc.height / 2);
  tr = await traffic();
  expect(tr.hour === 0, `clicking the chart picks that hour (${tr.hour})`);
  await page.keyboard.press('ArrowRight');
  tr = await traffic();
  expect(tr.hour === 1 && (await page.getAttribute('#traffic-chart', 'aria-valuenow')) === '1', 'arrow keys step through the hours');
  await page.keyboard.press('End');

  // a counting point of its own
  const cp = await page.evaluate(() => {
    const t = window.__yourPlace.traffic();
    return t.columnPoint(t.busiest);
  });
  await page.mouse.click(cp.x, cp.y);
  tr = await traffic();
  expect(tr.column === tr.busiest && (await page.isVisible('#traffic-all')) && /the counting point you picked/.test(await page.textContent('#traffic-sub')), 'tapping a counting point shows its day');
  expect(!(await page.evaluate(() => window.__yourPlace.pin().marked)), 'and doesn’t move the pin');
  await settle(page, 600);
  await shot(page, 't2-traffic-column');
  await page.click('#traffic-all');
  expect((await traffic()).column === null, 'All points goes back to the whole square');

  // the spread: further, and into the link
  const narrower = (await traffic()).streets.samples;
  await page.locator('#traffic-spread').fill('500');
  // the streets are built again on the next frame: wait for them, not only for the setting
  await page.waitForFunction((n) => window.__yourPlace.traffic().spread === 500 && window.__yourPlace.traffic().streets?.samples > n, narrower, { timeout: 15000 }).catch(() => undefined);
  tr = await traffic();
  expect(tr.spread === 500 && tr.streets.samples > narrower && /sp=500/.test(await page.evaluate(() => location.hash)) && (await page.textContent('#traffic-spread-out')) === '500 m', `a wider spread reaches more of the streets (${narrower} → ${tr.streets.samples} street points) and goes into the link`);
  await page.locator('#traffic-spread').fill('300');
  await page.waitForFunction(() => window.__yourPlace.traffic().spread === 300, null, { timeout: 5000 }).catch(() => undefined);
  expect(!/sp=/.test(await page.evaluate(() => location.hash)), 'back at 300 m the link leaves it out');

  // the table view
  await page.click('.ttable summary');
  expect((await page.locator('#traffic-table tr').count()) === 25, 'the day is also there as a table');

  // replay the day
  await page.click('#traffic-play');
  await page.waitForFunction(() => window.__yourPlace.traffic().playing, null, { timeout: 5000 }).catch(() => undefined);
  tr = await traffic();
  expect(tr.playing && tr.labels === 0 && (await page.textContent('#traffic-play')) === 'Pause', 'replay runs through the day, without labels');
  await page.click('#traffic-play');
  expect(!(await traffic()).playing && (await traffic()).labels > 0, 'pausing brings the labels back');

  // bikes
  await page.click('#traffic-kind-group [data-value="bikes"]');
  await page.waitForFunction(() => window.__yourPlace.traffic().kind === 'bikes' && window.__yourPlace.traffic().status === 'ready', null, { timeout: 20000 }).catch(() => undefined);
  tr = await traffic();
  expect(tr.kind === 'bikes' && tr.columns === 8 && /tk=bikes/.test(await page.evaluate(() => location.hash)) && /bikes$/.test(await page.textContent('#traffic-readout')), `bikes have their own counting points (${tr.columns}) and go into the link`);
  await page.click('#traffic-kind-group [data-value="cars"]');

  // your route over the traffic layer
  const [hc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#route-load-btn')]);
  await hc.setFiles({ name: 'alster.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(hamburgGpx()) });
  await page.waitForFunction(() => window.__yourPlace.route()?.shown && window.__yourPlace.route()?.name === 'Alster Loop', null, { timeout: 60000 });
  await waitStage(page, ['ready', 'error']);
  await page.waitForFunction(() => window.__yourPlace.traffic().status === 'ready', null, { timeout: 20000 }).catch(() => undefined);
  r = await route();
  tr = await traffic();
  expect(r.shown && !r.steep && r.lifted && tr.shown && tr.columns > 0 && /dl=traffic/.test(await page.evaluate(() => location.hash)), `a route rides on the traffic streets, never under them (${tr.columns} counting points)`);
  await settle(page, 1500);
  await shot(page, 't3-traffic-route');
  await ctx.close();

  // a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await routeAll(phone);
  const pp = await phone.newPage();
  watchConsole(pp, 'data-phone');
  await pp.goto(dataBase);
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
