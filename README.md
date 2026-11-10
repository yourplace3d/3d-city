# Your Place · Data

**Open data about your city on a 3D model: how steep its streets are, how busy, how its trams and buses
run, what homes cost and what people earn. Search any place, pick a layer. Free, no account, works on
your phone.**

**[Open Your Place · Data →](https://yourplace3d.github.io/3dcitydata/)** · [How it works](https://yourplace3d.github.io/3dcitydata/about/) · [Changelog](CHANGELOG.md)

<p>
  <img src="public/screenshot.jpg" alt="Freiburg as a 3D model, its buildings coloured by the rent per m² of the 100 m square they stand in, with the panel showing the legend" width="100%" />
</p>

A standalone app on this branch (`v2`). The `main` branch of this repository is a different app,
[Your Place](https://yourplace3d.github.io/3d-city/) (a 3D model of any address, as a poster or a 3D
print), and stays as it is: `v2` is never merged into it. Your Place · Data has no 3D print.

## The layers

One layer at a time, so the model doesn't get crowded. A route of your own isn't one of the layers: it
shows over whichever layer you pick.

- **Steepness:** roads and paths coloured by how steep they are, from golden yellow (3–6 %) to dark red
  (over 15 %), anywhere, from the terrain the model already has. Planning a run, a ride, a hike or a
  stroll? This is where it climbs. No green: on this map green is parks and woods, and red–green is what
  colour-blind people can't tell apart; each step is darker than the last, so the order reads without colour.
- **Traffic (Hamburg):** how many cars or bikes the City of Hamburg's counting points counted in each of the
  last 24 hours, live from its open SensorThings API, as red streets that rise with the traffic, and a bar
  chart of the day in the panel. Each count spreads along the streets around its counting point and fades
  out over a distance you set (100–500 m, 300 m to start); it follows the street network, and into smaller
  streets it fades four times as fast, so a quiet street next to a busy one stays quiet. Where counts meet,
  as at a crossing counted on every side, they add up, so the whole crossing rises. Only the white dots are
  counted; in between it's an estimate, and the panel says so. Pick an hour in the chart, or replay the day,
  and the streets rise and fall; tap a dot for that point's day. The chart is also a table. Only Hamburg so
  far; elsewhere the panel says so and offers Hamburg.
- **Public transport, from your city's timetable:** "Find timetables for this place" lists the open
  timetables the [Mobility Database](https://mobilitydatabase.org/) has for the square shown (about 2,600
  in use, worldwide), most local first, with their size; one tap loads one, and more can be added (a city's
  buses and its trains often come separately). Or load a timetable file (GTFS, a ZIP) yourself. Trams,
  buses, trains, U-Bahn and ferries move through the square as the timetable has them: a bar chart of the
  trips into the square per hour, a clock, a replay at 1 minute, 10 minutes or 1 hour a second, and the
  lines as chips. Tap a vehicle or a chip to see one line; pick any day the timetable has. The file is read
  in the browser, in a background worker, and never uploaded: a city's or a region's file works (Hamburg's
  39 MB file opens in about 10 seconds), a whole country's is too big. If the square shown has none of its
  lines, the app goes to where it is busiest. "Try Freiburg's timetable" loads Freiburg's, which we host.
  Lines are painted in their mode's colour (trains green, U-Bahn blue and dashed, trams red, buses grey,
  ferries dark yellow); replays at 10 minutes or an hour a second leave fading trails. It's the plan, not
  live, so delays don't show.
- **Homes and Income:** the buildings coloured by what homes cost, or what people earn, in the area they
  stand in, from open data you load. The panel lists the open sources we know for the place: Germany's
  2022 census (average rent per m² in 100 m squares: download the 9 MB ZIP and load it as it is), CBS for
  the Netherlands (home values per neighbourhood, incomes per district, loaded in one tap for the square),
  and Census Reporter for the US (median home value and household income per block group: download your
  county as GeoJSON). Any GeoJSON or CSV with values per area works too: grid squares (the INSPIRE codes
  the census uses), polygons in longitude/latitude, UTM or Web Mercator, or single points such as sales,
  which only show as the median of each 100 m square with at least five. Five blues, light to dark, each
  hold a fifth of the areas in the square; buildings without a value turn grey. The pin's area is outlined
  and its value shown, with how it compares. "Try" loads Freiburg's rents or Amsterdam's incomes, which we
  host. Germany publishes incomes only per town, so the Income layer has no source there yet.
- **Your route:** load a GPX or TCX file (Strava, Garmin, a race website) and pick the stretch to show; the
  model follows it, over any layer. On Steepness the line takes the steepness colours (and only the route is
  coloured), with start, finish, km markers and the steepest climbs labelled, a replay at the recorded pace,
  and a height profile. The file is read in your browser and never uploaded.
- More layers are planned: water, energy.

## The model under the data

- **Search anything:** an address, a street, a village, a postcode or `lat, lon`, a map link, or your location.
  Postcode and county results land on their village, not in a field.
- **Any square from 300 m to 4 km**, in 100 m steps, with terrain you can exaggerate (1×–5×) and contour lines.
  Buildings stand at their mapped height; where none is mapped the app estimates it and says how many.
- **Tap a building** to pin it and see its area's value; double-tap / double-click a spot to load the area there.
- **In your language:** English, Spanish, Portuguese (Brazil) or German, from the browser's language or the picker in
  the settings. Share links carry no language, so each visitor sees their own.
- **Share it:** the link opens the same view, layer and pin. It holds coordinates only, never the address you
  typed or a file you loaded. Or download it as an image (PNG) with your own title and the data's credits.

## Controls

| | Touch | Mouse | Keyboard (model focused) |
| --- | --- | --- | --- |
| Turn and tilt | one finger | drag | arrow keys |
| Slide | two fingers | right-drag or Shift-drag | Shift + arrow keys |
| Zoom | pinch | wheel | + / − |
| Move the pin | tap a building or the ground | click | — |
| Load the area there | double-tap | double-click | — |
| North up / reset | compass / reset buttons | | N / 0 |

## Run it yourself

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host it anywhere (relative paths)
npm test           # unit tests (vitest)
npm run e2e        # build + headless-browser test (needs Playwright), screenshots in e2e/out/
```

It is a static TypeScript app on three.js with no server and no API keys: the browser fetches map
tiles, terrain and address search straight from free public services.

**Where it's published.** The built files (`dist/`) go to the `main` branch of
[yourplace3d/3dcitydata](https://github.com/yourplace3d/3dcitydata), whose GitHub Pages serve them at
`https://yourplace3d.github.io/3dcitydata/`. That address is `SITE_URL` in `vite.config.ts` (or the
`SITE_URL` environment variable in the build), so canonical links, preview images and the sitemap use it;
change it when the app moves. `tools/og/render.mjs` renders the link preview (`public/og.jpg`) and the
about page's screenshot from the build, `tools/video/data.mjs` a video of the layers.

## How it works

```
search ─▶ geocode (Photon / Nominatim)
            │
            ▼
   ┌── terrain tiles (Terrarium PNG, AWS) ──▶ N×N height grid ──▶ terrain mesh + plinth     ─┐
   ├── vector tiles (OpenFreeMap): buildings with heights ──▶ one merged extruded mesh      ├─▶ three.js scene
   └── vector tiles: roads/water/green/sea ──▶ canvas texture draped on the terrain         ─┘
                                           └▶ sea polygons → flatten to 0 m
       (Overpass API only when the tiles fail: raw OSM, height rule, coastline flood fill)
```

- `src/geo/` — data: projection, polygon utilities, terrain tiles, Overpass queries and parsing,
  the height rule, coastline sea fill, geocoding, an IndexedDB cache for Overpass responses.
- `src/scene/` — rendering: terrain + plinth, merged building mesh, the draped map-layer texture,
  shader patches (contour lines, contact darkening), the viewer (camera, lights, controls).
- `src/data/` — the data-layer engine for overlays on the model: sources (files, links, live APIs),
  matching to the model's local metres, time and playback, and displays (ground paint, raised streets,
  moving vehicles, tinted buildings, 3D labels).
- `src/ui/` — search combobox, loading status, the image download, and a panel per layer. `src/main.ts`
  wires it together.
- Two pages: the app (`index.html`) and “How it works” (`about/index.html`).

Design notes:

- **Exaggeration applies to terrain only.** Each building vertex keeps its ground elevation and its
  height above ground, so moving the slider re-evaluates `y = (ground − ref) × ex + height` without
  rebuilding geometry; contour lines are computed per fragment from the real elevation.
- **Steepness is measured over 60 m, not between neighbouring points.** The terrain data has points 10–30 m
  apart; grades between neighbours would turn every wobble into a ramp. Runs shorter than 25 m join their
  neighbours, bridges are left out (the terrain under them is the valley), and a route runs straight across
  bridges. Steepness uses the real heights, whatever the exaggeration on screen.
- **Map layers are a texture, not geometry.** Rasterising roads/water/green into one canvas keeps
  them glued to the terrain at any exaggeration and costs no triangles; toggling a layer is a redraw.
- **The sea comes from coastlines, not elevation.** Terrain tiles report harbour water as ~0 m while
  polders sit below sea level, so elevation can't tell them apart. OSM coastlines (land on the left)
  are rasterised and the sea side flood-filled, then checked against the terrain before use.
- **Rural searches land on the village, not in a field.** Geocoders place a postcode or
  administrative area at the middle of its area — for rural postcodes that is open country between
  villages. Such results are resolved to the settlement the geocoder names for them, and a square
  with fewer than 10 buildings offers the nearest village or town outside it ("Kleinfelde is 2.0 km
  north-east — Go to Kleinfelde").
- **Renders on demand.** Frames are drawn only while the camera moves or something changes.

## Technical choices

- **Renderer:** three.js, not MapLibre — the physical-model look (plinth walls, contact shadow,
  raised traffic streets, moving vehicles, tinted buildings) needs full control of the geometry.
- **No server:** the browser fetches public services directly, behind small interfaces
  (`loadHeightGrid`, the tile loader, `overpass`, `suggest`) that an own tile server or geocoder could
  replace if traffic outgrows the free services.
- **Elevation:** Mapzen/AWS Terrarium tiles (worldwide, CORS, no key; ~10–30 m sources incl.
  SRTM, EU-DEM, 3DEP) instead of Copernicus GLO-30 GeoTIFFs, which need server-side processing.
- **Search engines:** the app page and a static “How it works” page (`about/`) carry titles,
  descriptions, canonical links, Open Graph images and structured data; the build writes
  `sitemap.xml` and `robots.txt` from `SITE_URL`.

## Data and licences

- Map data © OpenStreetMap contributors, ODbL. Attribution is shown in the app and on downloaded
  images; please keep “© OpenStreetMap contributors” next to anything you share.
- Vector tiles: [OpenFreeMap](https://openfreemap.org), schema © [OpenMapTiles](https://openmaptiles.org).
  Fallback map data: the [Overpass API](https://overpass-api.de).
- Terrain: Mapzen terrain tiles on AWS Open Data — see the
  [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Address search: [Photon](https://photon.komoot.io) by komoot (suggestions, place names for shared
  links) and [Nominatim](https://nominatim.org) (only when you press Enter before suggestions arrive,
  per its usage policy).
- Traffic counts: Freie und Hansestadt Hamburg, Behörde für Verkehr und
  Mobilitätswende, [Datenlizenz Deutschland – Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0),
  from the city's open [SensorThings API](https://iot.hamburg.de/). Credited in the panel and on images.
- Timetables found for a place: the [Mobility Database](https://mobilitydatabase.org/) by MobilityData,
  its list and its copies of each operator's file. Each timetable is credited in the panel with its
  operator and licence, as the list gives them.
- Freiburg's timetable (the public transport demo, `public/timetables/`): Freiburger Verkehrs AG (VAG),
  [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0), cut down to the files and columns the app reads.
  It runs until 12 December 2026; replace it with the next year's file. A timetable of your own is
  credited with the operators named in it.
- Homes and Income sources, each credited in the panel and on images: Zensus 2022, Statistische Ämter
  des Bundes und der Länder ([dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0)); CBS, Kerncijfers wijken
  en buurten, via PDOK ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); U.S. Census Bureau,
  American Community Survey 5-year estimates, via [Census Reporter](https://censusreporter.org/). The
  examples in `public/areas/` (Freiburg's rents, Amsterdam's incomes) are cut from the first two; see the
  README there.
- Photon, Nominatim and Overpass are shared community services with fair-use limits. If the app gets
  very popular, the address search should move to an own or paid geocoder.

## Privacy

No account, no cookies, no analytics, no server of its own. What you type in the search box goes from
your browser to Photon or Nominatim; share links hold only coordinates and the view; map data you
loaded is cached on your device. A route file is read in your browser and never uploaded or stored, and
no search service is asked where it runs; a share link includes the route only if you tick that, and then
only the stretch shown, without times or a name. With the traffic layer on in Hamburg, the corners of the
square shown go to the City of Hamburg's traffic server to fetch its counts. A timetable file (GTFS) is
read in your browser and never uploaded or stored; reloading the page forgets it. "Find timetables for
this place" downloads the Mobility Database's whole list (the same for everyone) and picks from it on your
device; loading one downloads it from the Mobility Database, which so learns which timetable, not where.
A file of values for Homes or Income is read in your browser and never uploaded or stored; share links
carry the layer, not the file. "Load for this square" (CBS) asks PDOK's server for the square's
corners, as the traffic layer does; the other sources are links you open yourself.

## Known limitations

- No LiDAR surface model yet, so many heights are estimates (the app says how many).
- Building parts follow Simple 3D Buildings only partly: roofs are flat, outlines hosting
  `building:part`s are dropped.
- Terrain sea-floor values are clamped at −30 m until coastlines arrive; places far below sea level
  (Dead Sea, Death Valley) are flattened by that clamp.
- No level of detail yet; the 4 km area at full density can be heavy on older phones.

## Ideas for later

- **Colour the blocks.** The OpenMapTiles building layer has a `colour` field (from OSM
  `building:colour` / `building:material`) where mappers recorded one, so a "real colours" style is
  cheap. Letting people paint their own house builds on the pin, which already marks one building.
- **More layers:** water, energy, noise; and suggestions of open sources from users, stored as links and
  checked before they're listed.
- **Photos on the buildings.** Aerial imagery on roofs and ground is the realistic first step —
  the hard part is an imagery licence that allows it. Street-level photos on façades are a much
  bigger job (coverage, licensing, matching photos to walls).

## Testing

`npm test` covers projection, terrain decoding/resampling, polygon clipping and ring assembly,
OSM parsing (multipolygons, courtyards, building parts, clipping), the height rule, the sea fill,
building-mesh winding and exaggeration, URL state, the page (no print, no link to another app), routes (GPX and TCX parsing, distances, the stretch that fits
the model, hiding the ends, the replay clock, the share-link code), steepness (grades over a window,
classes, bridges, climbs, height totals, the profile), and traffic counts (the request, parsing, the last
24 hours, adding up both directions of a road, the chart's scale), and timetables (ZIP reading, CSV with
quotes, times past midnight, days and exceptions, route types, the cut to the square for trips that stop
in it, run through it on a shape or cross it straight, positions between stops, the evening before after
midnight), and values per area (map projections, numbers as statistics offices write
them, grid codes, the census's ZIP, GeoJSON in a projection or none named, Census Reporter's download,
points as medians, holes, the classes, the sources for a place).

`npm run e2e` serves the build, answers Overpass and geocoding from a deterministic synthetic city
(`e2e/fixtures/synthetic-city.mjs`), uses real terrain tiles, and drives search, every control,
keyboard camera, pinning a building (click, drag, share-link round-trip, "Centre here"),
Shift-arrow and two-finger sliding, share link round-trip, the image download with your own title, an
Overpass outage with retry, a phone
viewport, and dark mode with reduced motion. Routes: a GPX from the start page, the stretch picker,
replay, the height profile, steepness on roads and on the route, hiding the ends, the opt-in route link and
opening it, a dropped TCX file, a FIT file, a phone, and that the file never leaves the browser. Traffic
(Hamburg's API answered from `e2e/fixtures/traffic.mjs`): outside Hamburg, a failed answer and retry, the
traffic streets, the spread slider and its link, the chart by pointer and keyboard, a counting point of its
own, the table, replay, bikes, and a route riding on them. Public
transport (a made-up timetable, `e2e/fixtures/transit.mjs`): the Freiburg demo, the day, the chart by
pointer and keyboard, a vehicle tapped, a line's chip, replay and its speed, the table, a
file of your own that opens where it runs, a square it doesn't reach, a file that isn't one, a phone, and
that the file never leaves the browser. Homes and Income (`e2e/fixtures/areas.mjs`): both examples, a
place with no source known, CBS in one tap for the square's box, the census's ZIP as it comes, taps on
buildings, another file and column, a file for elsewhere, files it can't use, a phone, and that the file
never leaves the browser. It fails on any console error.

## Licence

The code is released under the [MIT Licence](LICENSE). Map data and terrain shown by the app keep
their own licences (see “Data and licences” above).
