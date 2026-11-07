# Plan: a photo geo-guessing game on Your Place

Status: plan only, no code. Working name below is "Spot" (placeholder; pick any).
Nothing here changes the live app or `main`.

## 1. Product

**Loop.** A round shows one real photo and names the city and a square of 1–2 km.
The player moves through the 3D model (search, pin, double-tap already exist), drops
a pin where the camera stood, and turns a heading arrow to where it looked. On submit
the model renders from the true camera, the photo fades in over it (slider), and the
score shows. Five rounds make a game; one shared game per day is the daily puzzle,
with a Wordle-style result string to copy.

**Scoring per round (1,000 max).**

| Part | Points | Rule |
| --- | --- | --- |
| Distance | 0–600 | full within 10 m, down to 0 at 1 km |
| Right building or square | 200 | pin on the same OSM footprint / square |
| Heading | 100 | within 20° |
| Floor | 100 | only for non-residential buildings, once the floor camera exists |

No time bonus at first; it rewards clicking, not looking.

**What is different.**

- GeoGuessr asks "which country"; this asks "which doorway". City scale, exact building.
- The search space is our own 3D model, not Street View. It works where Street View
  has gaps and costs nothing to license.
- Every solved round yields a camera pose for a photo. That pose is useful: it ties a
  real photo to a building, from which heights, floor counts and missing buildings follow.
  GeoGuessr produces nothing; Mapillary collects photos but has no game and no model.
- Open data in, open data out (see rights).

## 2. Privacy and safety first

The structural rule: **the game never locates an unknown photo.** The uploader must
supply the answer. Nobody can post "where is this?" and have a crowd find it.

Rules enforced at upload, by review, and by code:

- **Public places only.** Streets, squares, landmarks, public and commercial buildings,
  viewpoints. No interiors, gardens, windows, balconies, or anything shot from private ground.
- **No private homes as targets.** If the pinned building is tagged house, detached,
  terrace, residential or apartments in OSM, the upload is refused. Floor matching is
  allowed only for buildings tagged office, public, hotel, tower and similar.
- **No people.** A browser-side face and licence-plate detector runs before upload.
  At first any detected face rejects the photo; blurring can come later. No children, ever.
- **Metadata stripped in the browser** before the file leaves the device: EXIF, XMP,
  IPTC, GPS, serial numbers. The photo is re-encoded and resized (max 2,048 px).
  EXIF GPS may prefill the uploader's own pin, then is discarded. We keep only
  focal length (for the overlay) and a month of capture, both optional.
- **Delay and coarse dates.** A photo goes live at least 7 days after upload and shows
  no exact date, so it cannot track where someone is now.
- **Uploads need an account**, age 18+, and the uploader confirms: I took this photo,
  in a public place, nobody is identifiable. New accounts get a few uploads until reviewed.
- **Every photo is reviewed by a person before it is playable.** Cheap at small scale.
- **Report button** on every photo and every reveal. Takedown within 24 h, no questions.
- **Exclusion list** of coordinates (shelters, schools, places of worship, anyone who
  asks for their building to be excluded), checked at upload and on existing photos.
- **Data minimisation.** EU hosting, no analytics in the game beyond a counter,
  deleting the account deletes its photos. Anything fed back to the map is an
  aggregate fact ("this building has 6 floors"), never "someone photographed this".

## 3. Rights

- **Uploaders keep copyright.** By uploading they publish the photo under CC BY 4.0
  (CC0 selectable) and grant us a non-exclusive licence to show, resize and overlay it in
  the game and in screenshots of the game. Attribution is by username. This mirrors what
  Mapillary and Wikimedia Commons do and makes the data-improvement goal legal.
- **OpenStreetMap, ODbL.** The rendered model is a produced work: attribution required
  and already shown. Camera poses tied to OSM building IDs and any heights, floor counts
  or outlines we derive are a derivative database: publish them under ODbL and feed them
  back through normal OSM editing. Scores, accounts and photos are not derived from OSM
  and stay separate.
- **Never Google.** No Street View, Google Maps or Apple Look Around imagery, neither
  as puzzle photos nor as reference when deriving map data. Bing and other proprietary
  imagery likewise. Allowed sources: our own photos, uploads under the licence above,
  Wikimedia Commons and Mapillary photos under CC BY-SA (check Mapillary's API terms).
- **Code licence.** The app is MIT. Decide before any paid tier whether the game code
  stays MIT (recommended; the moat is the community and the data, not the code).
- **Terms and privacy policy** are needed on the day uploads open, not before.

## 4. MVP without uploads

**Stage A, render puzzle (zero backend).** The daily photo is a render of our own
model from a street-level camera chosen by a seeded random from the date. The player
finds the view. Fully static, no photo rights, no server. Tests the core: is finding a
spot in the model fun?

**Stage B, curated real photos (still static).** 50–100 hand-checked puzzles in a JSON
file: own photos plus Commons and Mapillary photos with known position and heading,
all CC BY-SA, faces already absent. Adds the real-photo overlay reveal and the share
string. This is the version to post on Reddit.

**Stage C, uploads.** Only after Stage B shows people come back. Needs the backend below.

Where it lives: a separate repo or a separate GitHub Pages site, so the live app and
`main` stay untouched. The viewer modules in `src/scene` and `src/geo` become a small
package the game imports; that refactor is the only change this repo needs, on a branch.

## 5. Architecture and costs

Stages A and B: static site on GitHub Pages, $0. Map and terrain tiles come from the
same free services; the puzzle file can embed the squares it needs to spare them.

Stage C adds the smallest possible backend:

| Need | Choice | Monthly at small scale (≈1k players, 5k photos) |
| --- | --- | --- |
| Accounts, database, row-level security | Supabase (free tier, then Pro) | $0–25 |
| Photo storage and delivery | Cloudflare R2 (no egress fees) or Supabase Storage | $0–5 |
| Metadata strip, resize, face check | in the browser; one edge function re-encodes server-side as a safeguard | ≈$0 |
| Moderation queue | a table plus one admin page | $0 |
| Email (magic links) | Resend or similar free tier | $0 |
| Domain | | ≈$1 |
| Privacy-friendly counter | Cloudflare Web Analytics or GoatCounter | $0–5 |

Total: $0 to about $40 a month. If traffic outgrows the community tile and geocoder
services, self-hosted vector tiles on R2 add $5–20.

Camera pose: the uploader sets it by hand (pin, heading, nudge until the overlay fits).
Automatic photo-to-model matching is research, not MVP.

Standalone app: a PWA first (installable, offline daily puzzle); app stores only if
there is paying demand.

## 6. Money

- **Free forever:** the daily puzzle and playing anyone's public photos. This is what
  drives uploads, and uploads are the whole point.
- **No ads.** They clash with the privacy posture and pay almost nothing at small scale.
- **Paid, if at all, €3–5 a month or a one-off pack:** unlimited rounds, private games
  for friends and events (a wedding city, a school trip, a team offsite), own-photo games,
  stats and leagues. People pay to play with specific people and about their own places,
  not for more random rounds.
- **B2B is the more plausible revenue:** tourism boards, city marketing, architecture and
  real-estate firms, teachers, paying for a branded game or a city pack.
- Plain view: this is a niche. Expect donations and small subscriptions first. The
  larger value is better open map data and the reputation that brings.

## 7. Testing demand cheaply

Already started: posts on r/guessthecity. Add, in order:

1. Stage A or B link in the posts, with a privacy-friendly counter on the game page only.
2. Watch four numbers over 2–4 weeks: visits, rounds finished per visit, players who
   return on 3+ days, result strings shared. Comments asking "can I add my photos" count too.
3. Concierge uploads: invite a few redditors to send photos (with the rules above),
   add them by hand. This tests the upload idea before building it.
4. Also post to r/openstreetmap, r/geoguessr, Show HN, and the OSM community on Mastodon.
5. Decision rule, for example: 100+ daily players returning 3+ days means build uploads;
   under 20 means park it and keep the daily puzzle as a feature of the app.

## 8. Roadmap

1. **Now:** agree on these rules, the name, and where the game lives (separate repo).
2. **Weeks 1–2:** Stage A render puzzle, on a branch deployed to a preview site.
   Factor the viewer into an importable package.
3. **Weeks 3–4:** Stage B curated photos, overlay reveal, share string. Post to Reddit
   and the other communities. Counter on.
4. **Weeks 5–8:** collect numbers, fix what players stumble on, go or no-go.
5. **Months 3–4 (if go):** backend, accounts, upload with browser-side stripping and
   face check, OSM-tag refusal of homes, manual review, reporting, exclusion list,
   terms and privacy policy.
6. **Months 5–6:** floor matching once the floor camera is on `main` (no floor-view branch
   is on the remote today, so this is an assumption), leaderboards, private games,
   first paid experiment.
7. **Later:** feed heights, floor counts and missing buildings back to OSM under ODbL;
   automatic pose matching; PWA and, if it pays, store apps.
