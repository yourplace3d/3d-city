/**
 * End-to-end checks for the Homes and Income layers of Your Place · Data, run by smoke.mjs: the
 * examples from the start page (Freiburg's census rents, Amsterdam's incomes, the files we host),
 * a place with no source known, CBS's figures in one tap (answered from made-up neighbourhoods),
 * the census's ZIP loaded as it comes in Stuttgart (where the made-up world has buildings), taps
 * on buildings, another file and another column, a file for elsewhere, files it can't use, taking
 * it away. Also checks a file never goes out in a request, and that the panel fits a phone.
 */

import { areasGeoJson, censusZip } from './fixtures/areas.mjs';

const FREIBURG = { lat: 47.99555, lon: 7.85065 };
const AMSTERDAM = { lat: 52.3702, lon: 4.8952 };
/** the made-up world's cities */
const STUTTGART = { lat: 48.7765, lon: 9.1772 };
const HAMBURG = { lat: 53.5511, lon: 9.9937 };

export async function areaChecks({ browser, base, routeAll, expect, watchConsole, waitStage, settle, shot }) {
  const dataBase = base;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await routeAll(ctx);
  // CBS's neighbourhood figures, answered from made-up neighbourhoods around Amsterdam
  const cors = { 'access-control-allow-origin': '*' };
  const pdok = [];
  await ctx.route(/service\.pdok\.nl\/cbs\/wijkenbuurten\//, (route) => {
    pdok.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(areasGeoJson(AMSTERDAM, { tag: ' (CBS)' })) });
  });
  const page = await ctx.newPage();
  watchConsole(page, 'areas');
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), body: r.postData() ?? '' }));
  const areas = (layer) => page.evaluate((l) => window.__yourPlace.areas(l), layer);
  const ready = (layer) =>
    page.waitForFunction((l) => window.__yourPlace?.stage === 'ready' && ['ready', 'outside', 'error'].includes(window.__yourPlace.areas(l)?.status), layer, { timeout: 180000 }).catch(() => undefined);
  const center = () => page.evaluate(() => window.__yourPlace.state().center);
  const near = (c, p, d = 0.01) => Math.abs(c.lat - p.lat) < d && Math.abs(c.lon - p.lon) < d;
  const text = (sel) => page.textContent(sel);
  const pick = async (layer, file) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(`#${layer}-control [data-act="${(await page.isVisible(`#${layer}-control [data-act="another"]`)) ? 'another' : 'load'}"]`)]);
    await fc.setFiles(file);
    await page.waitForFunction((l) => window.__yourPlace.areas(l)?.status !== 'reading', layer, { timeout: 60000 }).catch(() => undefined);
    await ready(layer);
  };
  /** the `skip`+1-th building on screen whose ground (E, N) passes `where`, in the open */
  const buildingAt = async (where, skip = 0) => {
    await page.waitForFunction(() => !window.__yourPlace.moving(), null, { timeout: 20000, polling: 100 }).catch(() => undefined);
    await page.waitForTimeout(200);
    return page.evaluate(([src, skip]) => {
      const ok = new Function('e', 'n', `return ${src};`);
      const seen = [];
      const yp = window.__yourPlace;
      for (let y = 120; y < innerHeight - 80; y += 14)
        for (let x = 420; x < innerWidth - 100; x += 14) {
          if (document.elementFromPoint(x, y)?.id !== 'scene') continue;
          const h = yp.pick(x, y);
          // one per building's spot (100 m apart), so the next is in another square
          if (!h?.building || !ok(h.e, h.n) || seen.some((p) => Math.hypot(p.e - h.e, p.n - h.n) < 100)) continue;
          if ([[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => yp.pick(x + dx, y + dy)?.building)) {
            if (seen.length === skip) return { x, y, e: h.e, n: h.n };
            seen.push(h);
          }
        }
      return null;
    }, [where, skip]);
  };
  /** taps buildings where `where` holds until one has a value; that value */
  const tapValue = async (where) => {
    for (let k = 0; k < 6; k++) {
      const b = await buildingAt(where, k);
      if (!b) return null;
      await page.mouse.click(b.x, b.y);
      await page.waitForTimeout(400);
      const v = (await areas('homes')).atPin;
      if (v !== null) return v;
    }
    return null;
  };

  // ---- the examples: a place searched, the layer, then the panel's example
  await page.goto(dataBase);
  await page.waitForSelector('#card-homes-title', { state: 'visible' });
  expect((await page.isVisible('#card-income-title')) && !(await page.$('.layer-card .chip')), 'the start page has cards for Homes and Income, without example places');
  await page.fill('#search-input', 'Stuttgart');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__yourPlace?.stage === 'ready', null, { timeout: 180000 });
  await page.click('#data-layer-group [data-value="homes"]');
  await page.click('#homes-control [data-act="demo"]');
  await page.waitForFunction((d) => Math.abs((window.__yourPlace.state().center?.lat ?? 0) - d.lat) < 0.001, FREIBURG, { timeout: 60000 }).catch(() => undefined);
  await ready('homes');
  let x = await areas('homes');
  let c = await center();
  expect(
    x.status === 'ready' && x.source.demo && x.column === 'durchschnMieteQM' && x.geometry === 'cells' && x.areas > 300 && near(c, FREIBURG, 0.001) && /dl=homes/.test(await page.evaluate(() => location.hash)),
    `“Freiburg im Breisgau” opens its centre with the 2022 census’s rents (${x.areas} squares of 100 m)`,
  );
  expect(x.breaks.length === 4 && (await page.locator('#homes-control .area-legend li').count()) === 6, `five colours split the squares into fifths, with a key and “No value” (${x.breaks.join(' / ')})`);
  const credit = await text('#homes-control .traffic-credit');
  expect(/Zensus 2022/.test(credit) && /dl-de\/by-2-0/.test(credit), 'the census is credited with its licence');
  expect(x.atPin !== null && /At the pin: €\d/.test(await text('#homes-control .area-pin')) && /Average rent per m²/.test(await text('#describe')), `the panel says the rent where the pin is (€${x.atPin}), and so does the model’s description`);
  await settle(page, 800);
  await shot(page, 'q1-homes-freiburg');

  // ---- Income in Freiburg: no open source known
  await page.click('#data-layer-group [data-value="income"]');
  x = await areas('income');
  expect(
    x.on && x.status === 'empty' && x.providers.length === 0 && (await page.isVisible('#income-control [data-act="load"]')) && /don’t know an open source of incomes/.test(await text('#income-control')),
    'Income in Freiburg: the panel says no open source is known for it, and that a file of one’s own works',
  );
  expect(!(await areas('homes')).tinted && (await page.isHidden('#homes-control')), 'switching to another layer takes the colours and the panel away');

  // ---- the Income example: Amsterdam
  await page.click('#income-control [data-act="demo"]');
  await page.waitForFunction(() => Math.abs(window.__yourPlace.state().center?.lat - 52.3702) < 0.01, null, { timeout: 60000 }).catch(() => undefined);
  await ready('income');
  x = await areas('income');
  c = await center();
  expect(x.status === 'ready' && x.column === 'gemiddeldInkomenPerInwoner' && x.geometry === 'shapes' && x.areas > 5 && near(c, AMSTERDAM), `its example opens Amsterdam with CBS’s incomes per district (${x.areas} districts)`);
  const options = await page.locator('#income-column option').allTextContents();
  expect(options[0] === 'Average income per resident, a year' && options.includes('Average income per earner, a year'), 'the other measure in the file can be picked');
  expect(x.providers.join() === 'nl-cbs-income', 'in Amsterdam the panel knows CBS’s figures');
  await settle(page, 800);
  await shot(page, 'q2-income-amsterdam');

  // ---- CBS's home values, in one tap
  await page.click('#data-layer-group [data-value="homes"]');
  await ready('homes');
  x = await areas('homes');
  // the Freiburg example is still loaded, but has nothing here
  expect(x.status === 'outside' && x.providers.join() === 'nl-cbs-homes' && (await page.isVisible('#homes-control [data-act="provider"]')), 'Homes in Amsterdam: Freiburg’s rents have nothing here, and CBS’s home values can be loaded in one tap');
  pdok.length = 0;
  await page.click('#homes-control [data-act="provider"]');
  await page.waitForFunction(() => window.__yourPlace.areas('homes')?.source?.provider === 'nl-cbs-homes', null, { timeout: 30000 }).catch(() => undefined);
  await ready('homes');
  x = await areas('homes');
  const asked = pdok[0] ? new URL(pdok[0]) : null;
  const box = asked?.searchParams.get('bbox')?.split(',').slice(0, 4).map(Number) ?? [];
  expect(
    x.status === 'ready' && x.column === 'gemiddeldeWoningwaarde' && x.areas === 4 && box[0] < AMSTERDAM.lat && box[2] > AMSTERDAM.lat && box[2] - box[0] < 0.03 && /\/2024\//.test(pdok[0]),
    `“Load for this square” gets CBS’s home values for the square’s box only (${box.map((v) => v.toFixed(3)).join(', ')})`,
  );
  expect(/CBS/.test(await text('#homes-control .traffic-credit')) && /CC BY 4\.0/.test(await text('#homes-control .traffic-credit')), 'CBS is credited with its licence');

  // ---- the census's ZIP, as it comes, in Stuttgart
  await page.goto('about:blank');
  await page.goto(`${dataBase}#lat=${STUTTGART.lat}&lon=${STUTTGART.lon}&km=2&ex=1.5&dl=homes`);
  await waitStage(page, ['ready', 'error']);
  x = await areas('homes');
  const link = page.locator('#homes-control .area-provider a');
  expect(
    x.status === 'empty' && x.providers.join() === 'de-census-rent' && /destatis\.de\/.+Zensus2022_Durchschn_Nettokaltmiete\.zip$/.test((await link.getAttribute('href')) ?? '') && (await link.getAttribute('target')) === '_blank' && /9 MB/.test(await link.textContent()),
    'in Stuttgart the panel points to the census’s rent file (9 MB), to download and load as it is',
  );
  requests.length = 0;
  await pick('homes', { name: 'Zensus2022_Durchschn_Nettokaltmiete.zip', mimeType: 'application/zip', buffer: Buffer.from(censusZip(STUTTGART)) });
  x = await areas('homes');
  expect(x.status === 'ready' && x.column === 'durchschnMieteQM' && x.geometry === 'cells' && x.areas > 300 && x.tinted, `the census’s ZIP loads as it comes, from its 100 m grid (${x.areas} squares), and colours the buildings`);
  expect(/very few homes/.test(await text('#homes-control')), 'uncertain values are explained');
  expect(!requests.some((r) => /durchschnMieteQM|GITTER_ID|PK\u0003\u0004/.test(r.body) || /\.(zip|csv|geojson)$/i.test(new URL(r.url).pathname)), 'the file never leaves the device: no request carries it');
  expect(!/Zensus|zip/i.test(await page.evaluate(() => location.hash)), 'the share link carries the layer, not the file');
  // the data app speaks of data: its share dialog
  await page.click('#share-btn');
  expect(
    (await text('#share-title')) === 'Share this view' && (await text('#poster-btn')) === 'Download image (PNG)' && /Rent per m²/.test((await page.getAttribute('#image-subtitle', 'placeholder')) ?? '') && !(await page.$('#stl-btn, #print-details')),
    'its share dialog offers the link and an image, and nothing to print',
  );
  await page.keyboard.press('Escape');
  await settle(page, 1000);
  await shot(page, 'q3-homes-own-file');

  // taps on buildings: dearer to the north-east
  const dear = await tapValue('e > 250 && n > 250');
  const cheap = await tapValue('e < -250 && n < -250');
  expect(dear !== null && cheap !== null && dear > cheap + 2 && /At the pin/.test(await text('#homes-control .area-pin')), `a tap on a building tells its square’s rent: €${dear} in the north-east, €${cheap} in the south-west`);

  // neighbourhoods from a GeoJSON file, and another of its columns
  await pick('homes', { name: 'buurten.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(areasGeoJson(STUTTGART))) });
  x = await areas('homes');
  expect(x.status === 'ready' && x.column === 'gemiddeldeWoningwaarde' && x.areas === 4 && x.columns.join() === 'aantalInwoners,gemiddeldeWoningwaarde,gemiddeldInkomenPerInwoner', `another file, of neighbourhoods: its home values first (${x.columns.join(', ')})`);
  await page.selectOption('#homes-column', { label: 'aantalInwoners' });
  await page.waitForFunction(() => window.__yourPlace.areas('homes')?.column === 'aantalInwoners', null, { timeout: 5000 }).catch(() => undefined);
  x = await areas('homes');
  expect(x.column === 'aantalInwoners' && x.status === 'ready' && /4 areas in this square/.test(await text('#homes-control .area-measure')), 'any column with numbers can be picked');
  await settle(page, 600);
  await shot(page, 'q4-homes-neighbourhoods');

  // a file for somewhere else: it says so, and goes there
  await pick('homes', { name: 'hamburg.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(areasGeoJson(HAMBURG))) });
  x = await areas('homes');
  expect(x.status === 'outside' && (await page.isVisible('#homes-control [data-act="go"]')), 'a file with nothing in the square says so, and offers to go where its data is');
  await page.click('#homes-control [data-act="go"]');
  await page.waitForFunction(() => Math.abs(window.__yourPlace.state().center?.lat - 53.5511) < 0.01, null, { timeout: 60000 }).catch(() => undefined);
  await ready('homes');
  x = await areas('homes');
  expect(x.status === 'ready' && x.areas === 4 && near(await center(), HAMBURG), 'and there it is shown');

  // take it away
  await page.click('#homes-control [data-act="remove"]');
  x = await areas('homes');
  expect(x.status === 'empty' && !x.tinted && (await page.isVisible('#homes-control [data-act="load"]')), 'the data can be taken away');

  // files it can't use
  await pick('homes', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just some notes\nnothing more\n') });
  x = await areas('homes');
  expect(x.status === 'error' && x.problem === 'noPlace' && /no places/.test(await text('#homes-control .traffic-status')), 'a file without places gets a plain explanation');
  await pick('homes', { name: 'Filosofi2019_carreaux_200m_csv.7z', mimeType: 'application/x-7z-compressed', buffer: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 1, 2, 3]) });
  x = await areas('homes');
  expect(x.status === 'error' && x.problem === 'sevenZip' && /7z/.test(await text('#homes-control .traffic-status')) && (await page.isVisible('#homes-control [data-act="load"]')), 'a 7z file gets told to unpack it first, and another can be picked');
  await ctx.close();

  // ---- someone opening a shared view, for the first time: invited to look at their own city
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await routeAll(fresh);
  const fp = await fresh.newPage();
  watchConsole(fp, 'areas-shared');
  await fp.goto(`${dataBase}#lat=${STUTTGART.lat}&lon=${STUTTGART.lon}&km=2&ex=1.5&dl=homes`);
  await waitStage(fp, ['ready', 'error']);
  await fp.waitForFunction(() => /See your own city/.test(window.__yourPlace.notice() ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  expect(
    /See your own city/.test((await fp.evaluate(() => window.__yourPlace.notice())) ?? '') && (await fp.textContent('#notice-actions')).includes('Search a place'),
    'a shared view invites to look at one’s own city, not to make a keepsake',
  );
  await fresh.close();

  // ---- a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await routeAll(phone);
  const pp = await phone.newPage();
  watchConsole(pp, 'areas-phone');
  await pp.goto(`${dataBase}#lat=${STUTTGART.lat}&lon=${STUTTGART.lon}&km=2&ex=1.5&dl=homes`);
  await pp.waitForFunction(() => window.__yourPlace?.stage === 'ready', null, { timeout: 180000 }).catch(() => undefined);
  await pp.tap('#sheet-toggle');
  await pp.locator('#homes-control [data-act="demo"]').scrollIntoViewIfNeeded();
  await pp.tap('#homes-control [data-act="demo"]');
  await pp.waitForFunction(() => window.__yourPlace?.stage === 'ready' && window.__yourPlace.areas('homes')?.status === 'ready', null, { timeout: 180000 }).catch(() => undefined);
  if ((await pp.getAttribute('#sheet', 'data-open')) !== 'true') await pp.tap('#sheet-toggle');
  await pp.locator('#homes-control .area-legend').scrollIntoViewIfNeeded();
  await settle(pp, 400);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow <= 0 && (await pp.isVisible('#homes-control .area-legend')) && (await pp.isVisible('#data-layer-group [data-value="income"]')), 'the Homes panel and all five layers fit a phone');
  await shot(pp, 'q5-homes-phone');
  await phone.close();
}
