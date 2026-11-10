/**
 * End-to-end checks for the Public transport layer of Your Place · Data, run by smoke.mjs: the
 * demo from the start page (Freiburg's timetable, answered from a made-up one), the day, the
 * chart, a vehicle tapped, a line picked, replay and its speed, the table, the description and
 * the link, the 3D print; then a timetable of your own picked while looking at another place
 * (the app goes where it runs), a file that isn't one, and taking it away. Also checks the file
 * never goes out in a request, and that the panel fits a phone.
 */

import { catalogCsv, gtfsZip } from './fixtures/transit.mjs';

/** Freiburg's centre, where the demo opens (src/ui/transit.ts). */
const DEMO = { lat: 47.99555, lon: 7.85065 };
/** The Hamburg of the made-up world, and a timetable 5 km north of it. */
const HAMBURG = { lat: 53.5511, lon: 9.9937 };
const ELSEWHERE = { lat: 53.5961, lon: 9.9937 };

export async function transitChecks({ browser, base, routeAll, expect, watchConsole, waitStage, settle, shot }) {
  const dataBase = `${base}data/`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  await routeAll(ctx);
  await ctx.route(/timetables\/freiburg-2026\.zip$/, (route) => route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from(gtfsZip(DEMO)) }));
  // the Mobility Database: its list, and two timetables for the made-up Hamburg
  const box = (c, d) => ({ south: c.lat - d, north: c.lat + d, west: c.lon - d * 1.6, east: c.lon + d * 1.6 });
  const catalog = catalogCsv([
    { id: 'test-city', provider: 'Test Transit', place: 'Hamburg', ...box(HAMBURG, 0.05), url: 'https://files.mobilitydatabase.org/test-city/latest.zip', licence: 'https://creativecommons.org/licenses/by/4.0/' },
    { id: 'test-other', provider: 'Other Lines', name: 'Buses and trains', ...box(HAMBURG, 0.3), url: 'https://files.mobilitydatabase.org/test-other/latest.zip', licence: 'https://www.govdata.de/dl-de/by-2-0' },
    { id: 'test-far', provider: 'Far Away', ...box(DEMO, 0.05), url: 'https://files.mobilitydatabase.org/test-far/latest.zip' },
  ]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' };
  await ctx.route(/files\.mobilitydatabase\.org\/feeds_v2\.csv/, (route) => route.fulfill({ status: 200, contentType: 'text/csv', headers: cors, body: catalog }));
  await ctx.route(/files\.mobilitydatabase\.org\/test-(city|other)\/latest\.zip/, (route) => {
    const tag = /test-other/.test(route.request().url()) ? 'x' : '';
    route.fulfill({ status: 200, contentType: 'application/zip', headers: cors, body: Buffer.from(gtfsZip(HAMBURG, { tag })) });
  });
  const page = await ctx.newPage();
  watchConsole(page, 'transit');
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), body: r.postData() ?? '' }));
  const transit = () => page.evaluate(() => {
    const x = window.__yourPlace.transit();
    return x && { ...x, vehicleAt: undefined };
  });
  const ready = () => page.waitForFunction(() => window.__yourPlace?.stage === 'ready' && ['ready', 'outside', 'error'].includes(window.__yourPlace.transit()?.status), null, { timeout: 180000 });
  const sum = (a) => a.reduce((s, v) => s + v, 0);

  // ---- the demo, from the start page
  await page.goto(dataBase);
  await page.waitForSelector('#transit-presets .chip', { state: 'visible' });
  expect((await page.isVisible('#transit-landing-btn')) && (await page.locator('#transit-presets .chip').count()) === 1, 'the start page has a card for public transport: load a timetable, or try Freiburg’s');
  await page.click('#transit-presets .chip');
  await ready();
  // a known Monday, so the lines don't depend on the day the test runs
  await page.fill('#transit-date', '2026-11-09');
  await page.dispatchEvent('#transit-date', 'change');
  await page.waitForFunction(() => window.__yourPlace.transit().day === '2026-11-09', null, { timeout: 10000 }).catch(() => undefined);
  let x = await transit();
  const center = await page.evaluate(() => window.__yourPlace.state().center);
  expect(x.status === 'ready' && x.demo && x.shown && Math.abs(center.lat - DEMO.lat) < 0.001 && /dl=transit/.test(await page.evaluate(() => location.hash)), `“Freiburg” opens its centre with the timetable on (${x.dayRuns} trips through the square)`);
  expect(x.lines.join(' ') === 'rail:S3 subway:U4 tram:T1 bus:B2', `its lines are listed by mode: trains, U-Bahn, trams, buses (${x.lines.join(' ')})`);
  expect(sum(x.perHour) === x.dayRuns && x.perHour[3] === 0 && x.perHour[8] > 0, 'the chart counts every trip into the square once, by hour');
  expect((await page.locator('#transit-bars .tbar').count()) === 24 && (await page.locator('#transit-bars .tbar.on').count()) === 1 && (await page.locator('#transit-lines .chip').count()) === 4, 'the chart has a bar per hour, the hour shown marked, and a chip per line');
  expect(/Freiburger Verkehrs AG/.test(await page.textContent('#transit-credit')) && /dl-de\/by-2-0/.test(await page.textContent('#transit-credit')), 'Freiburg’s timetable is credited with its licence');

  // 08:00 on the chart
  const bars = await page.locator('#transit-bars').boundingBox();
  await page.mouse.click(bars.x + (bars.width * 8.05) / 24, bars.y + bars.height / 2);
  await page.waitForFunction(() => window.__yourPlace.transit().vehicles > 0, null, { timeout: 5000 }).catch(() => undefined);
  x = await transit();
  expect(Math.abs(x.time - 8.05 * 3600) < 120 && x.vehicles > 0 && x.labels > 0 && /08:0\d/.test(await page.textContent('#transit-readout')), `a click on the chart picks the time: ${x.vehicles} vehicles at 08:0x, with their lines’ names`);
  await settle(page, 1200);
  await shot(page, 'p1-transit-demo');

  // keyboard on the chart
  await page.focus('#transit-chart');
  const before = x.time;
  await page.keyboard.press('ArrowRight');
  x = await transit();
  expect(x.time === before + 900 && Number(await page.getAttribute('#transit-chart', 'aria-valuenow')) === Math.floor(x.time / 60), 'the chart is a slider: arrow keys step 15 minutes');

  // tap a vehicle: its line on its own
  // one in the open, not under the panel
  const at = await page.evaluate(() => {
    const t = window.__yourPlace.transit();
    for (let i = 0; i < t.vehicles; i++) {
      const p = t.vehicleAt(i);
      if (p && p.x > 420 && p.x < innerWidth - 80 && p.y > 80 && p.y < innerHeight - 60) return p;
    }
    return null;
  });
  if (at) await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => window.__yourPlace.transit().picked != null, null, { timeout: 5000 }).catch(() => undefined);
  x = await transit();
  const all = await page.evaluate(() => window.__yourPlace.transit().dayRuns);
  expect(x.picked != null && sum(x.perHour) < all && (await page.locator('#transit-lines .chip[aria-pressed="true"]').count()) === 1 && (await page.isVisible('#transit-all')), `a tap on a vehicle shows its line on its own (${x.picked}: ${sum(x.perHour)} of ${all} trips)`);
  await settle(page, 800);
  await shot(page, 'p2-transit-line');
  await page.click('#transit-all');
  // a chip: the U-Bahn, which runs 06:00–09:00
  await page.click('#transit-lines .chip:has-text("U4")');
  x = await transit();
  expect(x.picked === 'subway|U4' && sum(x.perHour) === 18 && x.perHour.every((v, h) => (h >= 6 && h <= 8) === v > 0), 'a line’s chip shows that line: the U-Bahn run every 10 minutes from 06:00 to 09:00');
  await page.click('#transit-lines .chip:has-text("U4")');
  x = await transit();
  expect(x.picked === null && sum(x.perHour) === x.dayRuns, 'tapping it again shows all lines');

  // replay, and its speed
  await page.click('#transit-speed [role="radio"]:nth-child(2)');
  const t0 = (await transit()).time;
  await page.click('#transit-play');
  await page.waitForTimeout(1200);
  x = await transit();
  expect(x.playing && x.speed === 600 && x.time > t0 + 300 && x.labels === 0, `replay runs the timetable at 10 minutes a second (${Math.round((x.time - t0) / 60)} min in 1.2 s), without labels`);
  await page.click('#transit-play');
  x = await transit();
  expect(!x.playing && x.labels > 0, 'pausing stops it and the lines’ names come back');

  // table, description, a weekend day
  await page.click('#transit-figure .ttable summary');
  expect((await page.locator('#transit-table tr').count()) === 25, 'the day is also there as a table');
  expect(/Public transport: [\d,]+ trips through the square on Mon 9 Nov/.test(await page.textContent('#describe')), 'the model’s description says how many trips run through it');
  await page.fill('#transit-date', '2026-11-14');
  await page.dispatchEvent('#transit-date', 'change');
  await page.waitForFunction(() => window.__yourPlace.transit().day === '2026-11-14', null, { timeout: 10000 }).catch(() => undefined);
  x = await transit();
  expect(x.lines.join(' ') === 'tram:T1' && x.dayRuns > 0, 'on a Saturday only the weekend lines run');
  await page.fill('#transit-date', '2026-11-09');
  await page.dispatchEvent('#transit-date', 'change');

  // the lines in the 3D print
  await page.click('#share-btn');
  expect((await page.isVisible('#print-transit-row')) && (await page.isChecked('#print-transit')) && (await page.isHidden('#print-traffic-row')), 'the 3D print offers the transit lines raised, ticked');
  await page.click('#print-size-group [data-value="150"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#stl-btn')]);
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('share-msg').textContent), null, { timeout: 120000 });
  const msg = await page.textContent('#share-msg');
  expect(/\.stl$/.test(dl.suggestedFilename()) && / Transit lines raised 0\.4–1\.2 mm\./.test(msg), `the STL has the lines raised by their trips (“${msg.slice(0, 90)}…”)`);
  await page.keyboard.press('Escape');

  // ---- timetables for this place, from the Mobility Database: load one, add another
  const monday = async () => {
    await page.fill('#transit-date', '2026-11-09');
    await page.dispatchEvent('#transit-date', 'change');
    await page.waitForFunction(() => window.__yourPlace.transit().day === '2026-11-09', null, { timeout: 10000 }).catch(() => undefined);
  };
  await page.goto('about:blank');
  await page.goto(`${dataBase}#lat=${HAMBURG.lat}&lon=${HAMBURG.lon}&km=2&ex=1.5&dl=transit`);
  await waitStage(page, ['ready', 'error']);
  expect(await page.isVisible('#transit-find-btn'), 'the panel offers to find the timetables for the place shown');
  requests.length = 0;
  await page.click('#transit-find-btn');
  await page.waitForSelector('#transit-feeds li', { timeout: 20000 }).catch(() => undefined);
  await page.waitForFunction(() => /MB/.test(document.querySelector('#transit-feeds li small')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  x = await transit();
  const listed = await page.locator('#transit-feeds li').allTextContents();
  expect(x.found?.join(' ') === 'test-city test-other' && /Test Transit/.test(listed[0]) && /MB/.test(listed[0]), `it lists the Mobility Database’s timetables for the place, the most local first, with their size (${listed.map((l) => l.slice(0, 40)).join(' | ')})`);
  const asked = requests.filter((r) => /mobilitydatabase/.test(r.url));
  expect(asked.length > 0 && asked.every((r) => !new URL(r.url).search && !r.body), 'looking sends nothing about the place: the whole list is read and picked from on the device');
  await shot(page, 'p5-transit-find');
  await page.click('#transit-feeds li:nth-child(1) button');
  await page.waitForFunction(() => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.transit().sources.length === 1, null, { timeout: 60000 }).catch(() => undefined);
  await monday();
  x = await transit();
  const credit = await page.textContent('#transit-credit');
  expect(x.sources.join() === 'test-city' && x.lines.join(' ') === 'rail:S3 subway:U4 tram:T1 bus:B2' && (await page.textContent('#transit-feeds li:nth-child(1) button')) === 'Shown', `“Load” downloads it and shows it in one tap (${x.lines.length} lines)`);
  expect(/Test Transit \(CC BY 4\.0\)/.test(credit) && /Mobility Database/.test(credit), `it is credited with its licence (“${credit}”)`);
  expect((await page.textContent('#transit-feeds li:nth-child(2) button')) === 'Add', 'the others can be added to it');
  await page.click('#transit-feeds li:nth-child(2) button');
  await page.waitForFunction(() => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.transit().sources.length === 2, null, { timeout: 60000 }).catch(() => undefined);
  await monday();
  x = await transit();
  expect(x.sources.join() === 'test-city,test-other' && x.lines.join(' ') === 'rail:S3 rail:S3x subway:U4 subway:U4x tram:T1 tram:T1x bus:B2 bus:B2x' && (await page.locator('#transit-sources li').count()) === 2, `two timetables show together (${x.lines.join(' ')})`);
  expect(/Test Transit \(CC BY 4\.0\); Other Lines \(dl-de\/by-2-0\)/.test(await page.textContent('#transit-credit')) && (await page.textContent('#transit-remove')) === 'Remove all timetables', 'both are credited');
  await settle(page, 1000);
  await shot(page, 'p6-transit-two');
  await page.click('#transit-sources li:nth-child(2) .feed-remove');
  await page.waitForFunction(() => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.transit().sources.length === 1, null, { timeout: 60000 }).catch(() => undefined);
  x = await transit();
  expect(x.sources.join() === 'test-city' && x.lines.length === 4, 'one of them can be taken away, the other stays');

  // ---- a timetable of your own, picked while looking at another place: the app goes where it runs
  await page.goto('about:blank');
  await page.goto(`${dataBase}#lat=${HAMBURG.lat}&lon=${HAMBURG.lon}&km=2&ex=1.5&dl=transit`);
  await waitStage(page, ['ready', 'error']);
  expect((await page.isVisible('#transit-load-btn')) && (await page.isVisible('#transit-demo')), 'without a timetable, the panel offers to load one or try Freiburg’s');
  requests.length = 0;
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#transit-load-btn')]);
  await fc.setFiles({ name: 'my-city-gtfs.zip', mimeType: 'application/zip', buffer: Buffer.from(gtfsZip(ELSEWHERE)) });
  await page.waitForFunction(() => window.__yourPlace.transit()?.status === 'ready' && window.__yourPlace.stage === 'ready', null, { timeout: 180000 }).catch(() => undefined);
  x = await transit();
  const moved = await page.evaluate(() => window.__yourPlace.state().center);
  expect(x.status === 'ready' && !x.demo && Math.abs(moved.lat - ELSEWHERE.lat) < 0.01 && x.runs > 0, `a timetable with no lines in the square opens where it runs (${moved.lat.toFixed(3)}, ${moved.lon.toFixed(3)})`);
  expect(/Test Transit/.test(await page.textContent('#transit-credit')) && /your file/.test(await page.textContent('#transit-credit')), 'its credit names the operator in the file');
  expect(!requests.some((r) => /Test Transit|stop_times|PK\u0003\u0004/.test(r.body) || /\.zip$/i.test(new URL(r.url).pathname)), 'the timetable never leaves the device: no request carries it');
  await settle(page, 1200);
  await shot(page, 'p3-transit-own');

  // back to a square without its lines: it says so and offers the way
  await page.goto(`${dataBase}#lat=${HAMBURG.lat - 0.1}&lon=${HAMBURG.lon}&km=2&ex=1.5&dl=transit`);
  await waitStage(page, ['ready', 'error']);
  await page.waitForFunction(() => ['outside', 'ready'].includes(window.__yourPlace.transit()?.status), null, { timeout: 60000 }).catch(() => undefined);
  x = await transit();
  expect(x.status === 'outside' && (await page.isVisible('#transit-go')), 'in a square it doesn’t reach, the panel says so and offers to go where it runs');

  // take it away
  await page.click('#transit-remove');
  x = await transit();
  expect(x.status === 'empty' && !x.shown && (await page.isVisible('#transit-load-btn')), 'the timetable can be taken away');

  // a file that isn't a timetable
  const [bad] = await Promise.all([page.waitForEvent('filechooser'), page.click('#transit-load-btn')]);
  await bad.setFiles({ name: 'photos.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip at all') });
  await page.waitForFunction(() => window.__yourPlace.transit()?.status === 'error', null, { timeout: 30000 }).catch(() => undefined);
  x = await transit();
  expect(x.status === 'error' && x.problem === 'notZip' && /isn’t a ZIP file/.test(await page.textContent('#transit-status')) && (await page.isVisible('#transit-load-btn')), 'a file that isn’t a ZIP gets a plain explanation, and another can be picked');
  await ctx.close();

  // ---- a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await routeAll(phone);
  await phone.route(/timetables\/freiburg-2026\.zip$/, (route) => route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from(gtfsZip(DEMO)) }));
  const pp = await phone.newPage();
  watchConsole(pp, 'transit-phone');
  await pp.goto(dataBase);
  await pp.waitForSelector('#transit-presets .chip', { state: 'visible' });
  await pp.tap('#transit-presets .chip');
  await pp.waitForFunction(() => window.__yourPlace?.stage === 'ready' && window.__yourPlace.transit()?.status === 'ready', null, { timeout: 180000 }).catch(() => undefined);
  await pp.tap('#sheet-toggle');
  await pp.locator('#transit-play').scrollIntoViewIfNeeded();
  await settle(pp, 400);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow <= 0 && (await pp.isVisible('#transit-play')), 'the public transport panel fits a phone');
  await shot(pp, 'p4-transit-phone');
  await phone.close();
}
