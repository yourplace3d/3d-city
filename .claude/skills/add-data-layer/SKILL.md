---
name: add-data-layer
description: Step-by-step guide to plugging a new data set (a file the user picks, a file we host, or a live API) into Your Place's data-layer engine as an overlay on the 3D model. Use when adding traffic, noise, energy, routes or any other open data on top of the model.
---

# Add a data layer to Your Place

Data layers live in **Your Place · Data** (`data/`), a second app built from the same code as Your Place:
`index.html` and `data/index.html` share their body (`src/app-body.html`, parts marked `only:place` /
`only:data`), and `src/main.ts` knows which app it runs in (`APP`). Your Place itself stays simple and only
links across. The data app shows **one layer at a time**, so each new layer adds one choice, not a panel full
of buttons. A route of the user's own is not a layer: it shows over whichever layer is picked, so a new layer
must look right with a route on top (the route paints at order 10).

The engine lives in `src/data/`. Every overlay goes through the same four parts:

| Part | Folder | Job |
| --- | --- | --- |
| Source | `src/data/sources/` | Read the data into lon/lat (+ time). Pure parsing, no DOM, so Node tests can run it. |
| Match | `src/data/match/` | Place it in the model's local metres (E, N from the square's centre). |
| Time | `src/data/time/` | A position or value per moment, and `Playback` (0 → 1 over a set time). |
| Display | `src/data/display/` | Draw it: a `ModelOverlay` (ground paint and/or 3D objects). |

The contracts are in `src/data/types.ts`. Three worked examples:

- **Route** (data the user brings): `sources/trackFile.ts` (GPX/TCX), `sources/routeLink.ts` (opt-in share
  link), `match/route.ts`, `time/playback.ts`, `display/route.ts`, wired up by `src/ui/route.ts`.
- **Steepness** (derived from what the model already has, no source): `match/slope.ts` (grades along a
  line from the terrain), `display/steepness.ts` (ground paint) and `display/profile.ts` (SVG profile),
  wired up by `src/ui/steepness.ts`.
- **Traffic** (a live open API): `sources/hamburgTraffic.ts` (SensorThings request and parser, coverage,
  attribution), `match/traffic.ts` (the last 24 hours on fixed steps, nearby points merged),
  `match/trafficStreets.ts` (each count spread along the street network around its point, fading out over a
  distance the user sets; shares precomputed, so a moment's values are one pass), `display/traffic.ts` (the
  streets as one raised mesh whose heights and colours change per frame while replaying; counting points as
  discs) and `display/trafficChart.ts` (the bar chart's scale), wired up by `src/ui/traffic.ts`; in the print
  `export/traffic.ts`. The e2e fixture is `e2e/fixtures/traffic.mjs`.

**Point data on streets: spread it, don't spike it.** A count at a point is shown along the streets around
it, fading out, not as a column: columns look like spikes, hide what's behind them and can't be printed.
Walk the street network (not as the crow flies), say plainly that it's an estimate between the points, and
let the user set how far it spreads. Anything that stands up from the model must be printable: keep heights
to a few millimetres at 15 cm and walls at least 0.8 mm thick, and lift a route over it (`setLift` in
`display/route.ts`, `routeOverTraffic` in `export/traffic.ts`) so it's never buried.

## 1. Check the source first

Write down, before any code:

- **Licence and attribution text.** Open data only. Note the exact credit line the licence asks for.
- **Format and size** for one model square (up to 4 × 4 km). Is it one request, or a large file we'd have to cut down?
- **Coverage** (one city, one country, the world) and **update rhythm** (live, daily, yearly).
- **CORS:** can a browser on `yourplace3d.github.io` read it directly? The app has no server. If not, the data has to be
  prepared ahead of time and hosted as a static file (a separate public data repo with a scheduled job; ask first).
- **Cost:** ask before anything that needs an account, a key or money.

The sandbox blocks many hosts. If a source is blocked, say so and test with a fixture; the user can check real data
through a preview build (`npm run build`, then `npx vite preview --host 0.0.0.0 --port 4173 --strictPort`).

## 2. Source adapter (`src/data/sources/<name>.ts`)

- Split **fetching** (takes an `AbortSignal`; `loadPlace` aborts when the user moves on) from **parsing** (a pure function from text/JSON to lon/lat records).
- Parse defensively: skip bad values, cap sizes, throw a typed error with a reason the UI can explain.
- Export an `Attribution` (`src/data/types.ts`) for third-party data. The user's own data has none.
- Coverage: export a `covers(bbox)` check so the UI only offers the layer where it has data.

## 3. Matching (`src/data/match/<name>.ts`)

- Local metres: `makeProjector(center).toLocal(lon, lat)` (`src/geo/projection.ts`) or `toLocal(points, center)` from `match/route.ts`.
- Heights on the model: `ModelSurface.groundY(e, n)` (the `CityModel` implements it), never your own terrain sampling.
- Distances: `distanceM` from `match/route.ts` (WGS84 metres per degree; a sphere is 0.3 % off east–west).
- Drop or clip what falls outside the square (`|e|, |n| <= sizeM / 2`).

## 4. Time (`src/data/time/playback.ts`)

- One `Playback` per layer; drive it from `viewer.onFrame((dt) => playback.advance(dt) && viewer.requestRender())`.
  The viewer only draws frames when asked, so a paused layer costs nothing.
- Never start playing by itself. With `prefers-reduced-motion`, show a still and a control.
- Put values on fixed steps (24 hours, 96 quarter hours) in typed arrays; interpolate between steps when drawing.

## 5. Display (`src/data/display/<name>.ts`)

Implement `ModelOverlay`:

- `paint(ctx, sizeM)`: draws into the ground texture in local metres, north up, after roads/water/green. Glued to the
  terrain at any exaggeration, costs no triangles. **Static only:** repainting the 4096 px texture every frame is too
  slow on phones. Call `model.repaint()` when what it draws changes.
- `object`: 3D things (labels, raised streets, a moving marker), added to the model's group.
- `place(surface)`: stand the 3D objects on the terrain; called when added and whenever the exaggeration changes.
- `order`: painting order among data layers (steepness 0 under the route's 10).
- `dispose()`: free geometries, materials and textures.

For animation, change 3D objects or shader uniforms per frame (e.g. street heights, a texture of all time steps
sampled by a `time` uniform), not the ground canvas. Labels: sprites with `sizeAttenuation: false` keep their
size on screen; see `makeLabel` and `declutter` in `display/route.ts`. Must stay smooth on phones.

## 6. Wire it into the app

- Add the layer's id to `DATA_LAYERS` in `src/state.ts` (links carry it as `dl=`), a radio button in the
  `data-layer-group` of `src/app-body.html`, a card on the data app's start page (`layer-cards`) with one
  sentence on what it shows, and its case in `setDataLayer()` in `src/main.ts`, which shows one layer and hides
  the others.
- A controller in `src/ui/<name>.ts` (see `RouteController`, `SteepController`): owns the layer's state and its
  panel, and puts a fresh display on each new `CityModel`. `src/main.ts` calls it in `loadPlace` right after
  the model is made, and again from `dataLayersChanged()` when the model's roads arrive or its terrain changes
  (buildings can take roof bumps out of it, the sea flattens it). Add a `debug` hook for the e2e test.
- Heights for measuring: `CityModel.elevationAt(e, n)` (real metres, no exaggeration); roads and bridges:
  `CityModel.featureSet`.
- Panel markup in `index.html` with `data-t` keys; every text in **all four** dictionaries (`src/i18n/en.ts`,
  `es.ts`, `pt.ts`, `de.ts`). `tests/i18n.test.ts` fails if one is missing or still in English.
- Credit third-party data in the layer's panel and on the poster (`credit` in `makePoster`, `src/ui/poster.ts`),
  on the About page and in the README.
- Charts in the panel: follow the dataviz rules (one hue for one series, bars ≤ 24 px with 2 px gaps, a
  readout on hover, keyboard steps, a table view). The traffic chart (`#traffic-chart`) is a pattern to copy.
- Share links (`src/state.ts`): only add a parameter when it's safe for anyone to see it.
- Add a sentence to the accessible description (`describe()` in `src/main.ts`).

## 7. Privacy checklist

- The user's own files are read in the browser only: no upload, no storage. Reloading forgets them.
- Don't send positions derived from the user's data to third parties (e.g. no reverse geocoding of a route).
- A live API learns which square is looked at: ask only while the layer is on and only where it has data,
  and say so on the About page (as for Hamburg's traffic counts).
- Nothing personal in share links unless the user turns it on, and then the minimum (the route link has no times
  or name).

## 8. Tests

- Unit tests in `tests/<name>.test.ts` (Vitest, Node): parsing with small inline fixtures, matching, time steps,
  and anything the share link carries. `npm test`.
- End-to-end: answer the source's host from a fixture with `context.route(...)` in `routeAll` (`e2e/smoke.mjs`),
  add checks like `e2e/data-checks.mjs` (against `${base}data/`), and call them from `smoke.mjs`. No real network in tests; fail on
  console errors. `npm run e2e` (it builds first).
- `npm run typecheck` before committing. All existing features must keep passing.
