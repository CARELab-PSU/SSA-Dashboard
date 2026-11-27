# Dashboard commands

The dashboard has a fixed list of named commands that another program can call
to drive it and read back the numbers it shows. Claire is the main user, but a
script or a test can use them the same way. The buttons on the page and these
commands call the same code, so what Claire reports always matches the screen.

The command list lives in `js/07-api.js`. This file and `docs/tools.json` are
generated from it with `node tools/gendocs.js .` so they never drift from the code.

## Calling a command

Every command takes a name and an object of options, and returns an object.

```js
const r = await SSA.run('lists.show', {tab: 'inview', type: 'debris'});
// r = {ok: true, command: 'lists.show', result: {...}}
// or  {ok: false, command: 'lists.show', error: 'plain-language reason', details: {...}}
```

`SSA.run` never throws. When an object name is ambiguous, the error says so and
`details.matches` lists the candidates, so Claire can ask which one you meant.
Option values are forgiving: `"overhead"` works for the in-view list, `"junk"`
for debris, `"farther"` for zooming out. Each command's accepted words are in
the reference below.

Times in results come in three forms: UTC, local wall time at the observer
site, and minutes from the dashboard clock (`in_min`, negative means in the past).

Other entry points on the same object:

| Call | Returns |
| --- | --- |
| `SSA.describe()` | Every command with its options, accepted words and example requests |
| `SSA.tools()` | The same list as language-model tool definitions (name, description, input_schema). Dots in names become underscores, and `SSA.run` accepts either form |
| `SSA.state()` | What the dashboard is showing right now |
| `SSA.batch([[name, options], ...])` | Several commands in order, stopping at the first failure |
| `SSA.link()` | A web address that reopens the current view |
| `SSA.on(fn)` | Calls `fn(event)` for every event (see below); returns a function that unsubscribes |
| `SSA.console()` | Opens the typed command console on the page |

## Four ways in

1. **Claire opens the dashboard in her own window** (recommended). With
   pywebview or Playwright, Python can run JavaScript in the page directly.
   See `docs/claire_example.py`.
2. **A WebSocket to a program on this computer.** Open the dashboard with
   `?claire=ws://localhost:8765`. The page connects to that address, says hello,
   and answers messages of the form `{"id": 1, "command": "lists.get", "args": {...}}`
   with `{"type": "result", "id": 1, "ok": true, "result": {...}}`. It also
   answers `{"type": "describe"}` and `{"type": "state"}`, forwards events, and
   reconnects every 5 seconds if the connection drops. Chrome and Firefox allow
   a secure page to reach `localhost` this way; Safari may not.
3. **window.postMessage**, when the dashboard sits in an iframe or was opened
   by another page. Add `?claire=1` to turn it on, then post
   `{ssa: 'run', id, command, args}`. Replies come back as `{ssa: 'result', id, ...}`.
4. **A link that sets up the view** (no program needed). For example
   `index.html?view=observer&list=inview&type=debris&site=40.7945,-77.8616`.

| Link option | Meaning |
| --- | --- |
| `site=lat,lon[,alt_m]` | Observer site |
| `group=` | TLE group in the observer sidebar, e.g. `starlink` |
| `track=25544,20580` | Objects to track (names or NORAD numbers) |
| `list=tracked\|passes\|inview\|geo` | Which site list to show |
| `type=all\|payload\|rb\|debris` | Object type filter for the lists |
| `name=` | Name filter for the lists |
| `hours=1\|2\|4\|6`, `minel=0..60`, `visible=1`, `daytime=0` | Passes list filters |
| `plot=sky\|groundtrack`, `frame=inertial\|earthfixed`, `horizon=6..24` | Observer display |
| `catfilter=` | 3-D catalog type filter |
| `target=` | Plot a JPL Horizons target, e.g. `Maruthiakella` |
| `time=` (ISO UTC), `rate=` | Dashboard clock |
| `view=observer\|catalog\|ephemeris\|conjunctions` | Tab to show last |
| `console=1` | Open the typed command console |
| `claire=1` or `claire=ws://...` | Turn on the postMessage or WebSocket bridge |

## Events

Events arrive through `SSA.on`, as a `ssa` event on `window`, over the bridge
when one is on, and over the WebSocket. Each has a `type`:

- `ready` once the page has started (before that, `SSA.run('app.ready')` waits for it);
- `command` after every command, with `ok` and any `error`;
- `change` when something finishes or moves, with `what` set to one of
  `view`, `fullCatalog`, `catalogObjects`, `passScan`, `plotted`, `tracked`,
  `site` or `conj`, and the new `value`.

Commands that depend on slow work (the full catalog, a pass scan, a JPL query)
already wait for it before returning, so events are optional.

## The typed console

Open the dashboard with `?console=1` (or call `SSA.console()`) and type a
command name followed by its options as JSON, e.g.
`lists.get {"tab":"passes","visible_only":true,"limit":5}`. The answer appears
underneath. This is the quickest way to check what Claire will see.

## Button tags

Every button that has a command equivalent carries a `data-cmd` attribute, e.g.
`data-cmd="observer.plot:plot=sky"`. Commands are the supported route; the tags
are a fallback for anything that drives the page by clicking.

## Keeping it stable

Command names and options are meant to stay fixed so Claire can change without
the dashboard changing. New commands and new options can be added; existing ones
should not be renamed or removed. `SSA.version` is `1.0.0` and should change
its first number only if that promise is ever broken.

## Reference

### About

#### `help`

List the commands (optionally only those whose name starts with a prefix).

| Option | Type | Notes |
| --- | --- | --- |
| `prefix` | string | Only commands starting with this, e.g. "lists" |

Example requests: "what can you do on the dashboard", "list dashboard commands"

#### `state`

What the dashboard is showing right now: view, clock, site, tracked objects, filters, loaded data.

No options.

Example requests: "what is on the screen", "where are we", "current settings"

#### `app.ready`

Wait until the dashboard has started (and optionally until the full catalog has loaded).

| Option | Type | Notes |
| --- | --- | --- |
| `full_catalog` | boolean | Also wait for the full public catalog. default `false` |
| `timeout_s` | number | range 1 to 300. default `60` |


### Views

#### `view.show`

Switch the main tab.

| Option | Type | Notes |
| --- | --- | --- |
| `view` | observer \| catalog \| ephemeris \| conjunctions | **required**. also accepts *observer*: tracker, tracking, passes, sky, home, main; *catalog*: 3d, 3-d, globe, earth, catalogue, all objects; *ephemeris*: jpl, horizons, eph, deep space, solar system, planets, asteroids; *conjunctions*: conjunction, close approach, close approaches, socrates, collisions, ca |

Example requests: "go to the catalog", "open the JPL tab", "show conjunctions", "back to the observer"


### Time

#### `time.get`

The dashboard clock: simulated time, speed, and offset from real time.

No options.

Example requests: "what time is it on the dashboard"

#### `time.live`

Return to real time at normal speed.

No options.

Example requests: "go live", "back to now", "reset time"

#### `time.pause`

Freeze the clock.

No options.

Example requests: "pause", "stop the animation", "freeze"

#### `time.play`

Run the clock (resume after a pause), optionally at a new speed.

| Option | Type | Notes |
| --- | --- | --- |
| `rate` | number | Simulated seconds per real second (1 = real time, 60, 1000…). range -10000000 to 10000000 |

Example requests: "play", "play the animation", "resume", "animate"

#### `time.rate`

Set clock speed in simulated seconds per real second. 0 pauses; negative runs backward.

| Option | Type | Notes |
| --- | --- | --- |
| `rate` | number | **required**. range -10000000 to 10000000 |

Example requests: "speed up", "fast forward", "60 times speed", "slow down", "run backward"

#### `time.set`

Jump the clock to a date and time. ISO 8601; without an offset it is read as UTC, or as site local time with local=true.

| Option | Type | Notes |
| --- | --- | --- |
| `time` | string | **required**. e.g. "2026-12-01T03:00:00Z", "2026-12-01 21:30", or "now" |
| `local` | boolean | Read a time without offset as site local time. default `false` |

Example requests: "set the time to 9 pm", "jump to tomorrow at 6", "go to 2026-12-01 03:00 UTC"

#### `time.shift`

Move the clock forward (positive) or back (negative).

| Option | Type | Notes |
| --- | --- | --- |
| `days` | number | default `0` |
| `hours` | number | default `0` |
| `minutes` | number | default `0` |

Example requests: "go forward two hours", "back 30 minutes", "skip ahead a day"


### Site

#### `site.get`

The observer site (latitude, longitude, altitude, time zone).

No options.

Example requests: "where is my site", "what site are we using"

#### `site.set`

Move the observer site. Every pass, list and ephemeris is recomputed for it.

| Option | Type | Notes |
| --- | --- | --- |
| `lat` | number | **required**. Degrees north. range -90 to 90 |
| `lon` | number | **required**. Degrees east (west is negative). range -180 to 360 |
| `alt_m` | number | Metres above sea level (kept if omitted). range -500 to 9000 |

Example requests: "set my site to", "observe from", "change location to"

#### `site.preset`

Use one of the built-in observatory sites.

| Option | Type | Notes |
| --- | --- | --- |
| `name` | penn state \| mauna kea \| paranal \| kitt peak \| greenwich \| siding spring | **required**. also accepts *penn state*: state college, psu, home, university park, penn state state college; *paranal*: cerro paranal, vlt, chile; *greenwich*: royal greenwich, london; *mauna kea*: hawaii, maunakea |

Example requests: "observe from Mauna Kea", "use the Penn State site"

#### `site.locate`

Set the site from this computer's location (the browser may ask for permission).

No options.

Example requests: "use my location", "locate me", "where am I"


### Observer

#### `observer.groups`

The TLE groups the observer sidebar can load.

No options.

#### `observer.group`

Load a TLE group into the observer sidebar (Space Stations, Starlink, GPS …).

| Option | Type | Notes |
| --- | --- | --- |
| `group` | string | **required**. Group id or label, e.g. "starlink", "gps-ops", "Space Stations". See observer.groups |

Example requests: "load starlink", "show the weather satellites", "list GPS satellites"

#### `observer.horizon`

Forecast horizon for tracked objects (how far ahead orbits and passes are drawn).

| Option | Type | Notes |
| --- | --- | --- |
| `hours` | 6 \| 12 \| 18 \| 24 | **required** |

Example requests: "show the next 6 hours", "forecast 24 hours"

#### `observer.plot`

Right-hand plot: sky plot (alt/az dome) or ground track (map).

| Option | Type | Notes |
| --- | --- | --- |
| `plot` | sky \| groundtrack | **required**. also accepts *sky*: skyplot, sky plot, dome, polar, alt az, altaz; *groundtrack*: ground track, map, gt, track, world map |

Example requests: "show the sky plot", "switch to the map", "show ground track"

#### `observer.frame`

3-D orbit view frame: inertial (ECI) or Earth-fixed (ECEF).

| Option | Type | Notes |
| --- | --- | --- |
| `frame` | inertial \| earthfixed | **required**. also accepts *inertial*: eci, teme, j2000, space fixed; *earthfixed*: ecef, earth fixed, rotating, itrf, wgs84 |

Example requests: "show inertial frame", "switch to earth fixed"

#### `skyplot.options`

Sky plot options: draw every pass in the horizon (not just the next) and/or only naked-eye-visible segments.

| Option | Type | Notes |
| --- | --- | --- |
| `all_passes` | boolean |  |
| `visible_only` | boolean |  |

Example requests: "show all passes on the sky plot", "only visible passes"

#### `observer.conditions`

Observing weather at the site for the coming hours (cloud cover, wind, rain chance, temperature); can open or refresh the panel.

| Option | Type | Notes |
| --- | --- | --- |
| `open` | boolean | Open (true) or close (false) the conditions panel |
| `refresh` | boolean | default `false` |
| `hours` | number | range 1 to 48. default `12` |

Example requests: "is it cloudy tonight", "what is the weather for observing", "show observing conditions"

#### `observer.export_csv`

Download the primary object's pass table as CSV.

No options.


### Objects

#### `objects.find`

Search Earth-orbiting objects by name or NORAD number across the loaded group, the full catalog and CelesTrak.

| Option | Type | Notes |
| --- | --- | --- |
| `query` | string | **required** |
| `limit` | number | range 1 to 100. default `10` |

Example requests: "find Hubble", "is there a satellite called", "search for Starlink 1000"

#### `objects.track`

Track an object in the observer tab (orbit, ground track, sky plot, passes). Up to 5 at once; the newest becomes primary.

| Option | Type | Notes |
| --- | --- | --- |
| `object` | name or NORAD | **required**. Object name (e.g. "ISS", "Hubble") or NORAD catalog number (e.g. 25544) |
| `replace` | boolean | Stop tracking everything else first. default `false` |

Example requests: "track the ISS", "show me Hubble", "follow NORAD 25544", "plot Tiangong"

#### `objects.untrack`

Stop tracking one object, or all of them.

| Option | Type | Notes |
| --- | --- | --- |
| `object` | name or NORAD | **required**. Name, NORAD number, or "all" |

Example requests: "stop tracking", "remove the ISS", "clear tracked objects"

#### `objects.primary`

Make a tracked object the primary one (data panel, sky plot focus).

| Option | Type | Notes |
| --- | --- | --- |
| `object` | name or NORAD | **required**. Object name (e.g. "ISS", "Hubble") or NORAD catalog number (e.g. 25544) |

#### `objects.tracked`

The tracked objects with where they are now, the current or next pass, and the next naked-eye pass.

No options.

Example requests: "when does it rise", "is the ISS up", "what am I tracking"

#### `objects.info`

Everything about one Earth-orbiting object without changing the screen: orbital elements, position and pointing now (J2000 RA/Dec), and its passes over the site.

| Option | Type | Notes |
| --- | --- | --- |
| `object` | name or NORAD | **required**. Object name (e.g. "ISS", "Hubble") or NORAD catalog number (e.g. 25544) |
| `hours` | number | How far ahead to list passes. range 1 to 72. default `24` |

Example requests: "tell me about Hubble", "is the ISS visible tonight", "when is the next Tiangong pass", "where is NORAD 20580"

#### `objects.download_tle`

Download the primary tracked object's element set as a .txt file.

No options.


### Lists

#### `lists.show`

Show one of the site lists under the observer tab, optionally setting filters. Passes, in-view and GEO lists cover the whole public catalog.

| Option | Type | Notes |
| --- | --- | --- |
| `tab` | tracked \| passes \| inview \| geo | **required**. also accepts *tracked*: selected, my objects, tracked objects; *passes*: upcoming, current and upcoming, next passes, rising, pass list; *inview*: in view, overhead, above, up now, visible now, in the sky, above me, in view now; *geo*: always in view, geostationary, geosynchronous, geo belt, stationary |
| `type` | all \| payload \| rb \| debris | Object type to show. also accepts *all*: everything, all objects, any; *payload*: payloads, satellite, satellites, active, spacecraft; *rb*: rocket body, rocket bodies, r/b, rockets, stages, upper stage; *debris*: junk, fragments, deb |
| `name` | string | Only names or NORAD numbers containing this text ("" clears) |
| `hours` | 1 \| 2 \| 4 \| 6 | Passes list: how many hours ahead |
| `min_elevation` | 0 \| 10 \| 20 \| 30 \| 45 \| 60 | Passes list: only passes whose peak is above this many degrees |
| `visible_only` | boolean | Passes list: only naked-eye-visible passes (sunlit object, dark sky) |
| `exclude_daytime` | boolean | Passes list: hide passes that peak in daylight |

Example requests: "show debris overhead", "what is above me", "show upcoming passes", "show geostationary satellites I can see"

#### `lists.filter`

Change filters on the site lists without switching list.

| Option | Type | Notes |
| --- | --- | --- |
| `type` | all \| payload \| rb \| debris | Object type to show. also accepts *all*: everything, all objects, any; *payload*: payloads, satellite, satellites, active, spacecraft; *rb*: rocket body, rocket bodies, r/b, rockets, stages, upper stage; *debris*: junk, fragments, deb |
| `name` | string | Only names or NORAD numbers containing this text ("" clears) |
| `hours` | 1 \| 2 \| 4 \| 6 | Passes list: how many hours ahead |
| `min_elevation` | 0 \| 10 \| 20 \| 30 \| 45 \| 60 | Passes list: only passes whose peak is above this many degrees |
| `visible_only` | boolean | Passes list: only naked-eye-visible passes (sunlit object, dark sky) |
| `exclude_daytime` | boolean | Passes list: hide passes that peak in daylight |

Example requests: "only debris", "only visible ones", "payloads only", "clear the filter", "next 6 hours"

#### `lists.get`

Read a site list as data (shows it on screen too). Waits for the catalog and the pass scan to finish.

| Option | Type | Notes |
| --- | --- | --- |
| `tab` | tracked \| passes \| inview \| geo | Defaults to the list on screen. also accepts *tracked*: selected, my objects, tracked objects; *passes*: upcoming, current and upcoming, next passes, rising, pass list; *inview*: in view, overhead, above, up now, visible now, in the sky, above me, in view now; *geo*: always in view, geostationary, geosynchronous, geo belt, stationary |
| `limit` | number | range 1 to 500. default `20` |
| `timeout_s` | number | range 5 to 300. default `90` |
| `type` | all \| payload \| rb \| debris | Object type to show. also accepts *all*: everything, all objects, any; *payload*: payloads, satellite, satellites, active, spacecraft; *rb*: rocket body, rocket bodies, r/b, rockets, stages, upper stage; *debris*: junk, fragments, deb |
| `name` | string | Only names or NORAD numbers containing this text ("" clears) |
| `hours` | 1 \| 2 \| 4 \| 6 | Passes list: how many hours ahead |
| `min_elevation` | 0 \| 10 \| 20 \| 30 \| 45 \| 60 | Passes list: only passes whose peak is above this many degrees |
| `visible_only` | boolean | Passes list: only naked-eye-visible passes (sunlit object, dark sky) |
| `exclude_daytime` | boolean | Passes list: hide passes that peak in daylight |

Example requests: "how many objects are overhead", "which debris is above me", "what passes are coming up", "list the visible passes"

#### `lists.recalculate`

Recompute the passes list from the current clock.

No options.


### Catalog

#### `catalog.filter`

Show all objects, payloads, debris or rocket bodies in the 3-D catalog.

| Option | Type | Notes |
| --- | --- | --- |
| `type` | all \| payload \| rb \| debris | **required**. Object type to show. also accepts *all*: everything, all objects, any; *payload*: payloads, satellite, satellites, active, spacecraft; *rb*: rocket body, rocket bodies, r/b, rockets, stages, upper stage; *debris*: junk, fragments, deb |

Example requests: "show only debris in the catalog", "show rocket bodies", "show everything"

#### `catalog.buckets`

Choose which data sets the 3-D catalog loads (full catalog, Starlink, GPS, debris clouds …) and reload.

| Option | Type | Notes |
| --- | --- | --- |
| `only` | list | Exactly these bucket ids |
| `add` | list |  |
| `remove` | list |  |
| `load` | boolean | default `true` |

Example requests: "add starlink to the catalog", "load only the GEO belt"

#### `catalog.counts`

How many objects the 3-D catalog holds, by class.

No options.

Example requests: "how many objects are in orbit", "how much debris is there"

#### `catalog.select`

Highlight one object in the 3-D catalog, draw its orbit and open its card.

| Option | Type | Notes |
| --- | --- | --- |
| `object` | name or NORAD | **required**. Object name (e.g. "ISS", "Hubble") or NORAD catalog number (e.g. 25544) |

Example requests: "show me where the ISS is in the catalog", "highlight Hubble"

#### `catalog.deselect`

Clear the highlighted object in the 3-D catalog.

No options.

#### `catalog.track_selected`

Send the highlighted catalog object to the observer tab for tracking.

No options.


### Camera

#### `camera.zoom`

Zoom the 3-D view in or out.

| Option | Type | Notes |
| --- | --- | --- |
| `direction` | in \| out | **required**. also accepts *in*: closer, nearer; *out*: further, farther, away, back |
| `factor` | number | range 1.05 to 50. default `1.8` |
| `view` | current \| observer \| catalog \| ephemeris \| conjunctions | Which 3-D view (defaults to the one on screen). default `"current"` |

Example requests: "zoom out", "zoom in", "closer", "further away"

#### `camera.rotate`

Turn the 3-D view.

| Option | Type | Notes |
| --- | --- | --- |
| `direction` | left \| right \| up \| down | **required** |
| `degrees` | number | range 1 to 180. default `30` |
| `view` | current \| observer \| catalog \| ephemeris \| conjunctions | Which 3-D view (defaults to the one on screen). default `"current"` |

Example requests: "rotate left", "look from above", "tilt down"

#### `camera.reset`

Put the 3-D view back to its starting angle and distance.

| Option | Type | Notes |
| --- | --- | --- |
| `view` | current \| observer \| catalog \| ephemeris \| conjunctions | Which 3-D view (defaults to the one on screen). default `"current"` |

Example requests: "reset the view", "recenter"


### Ephemeris

#### `eph.resolve`

Find a deep-space object in JPL Horizons by name or number without plotting it.

| Option | Type | Notes |
| --- | --- | --- |
| `query` | string | **required** |

Example requests: "look up Maruthiakella", "what is the Horizons id of CAPSTONE"

#### `eph.plot`

Plot a planet, moon, asteroid, comet or spacecraft from JPL Horizons and return its visibility from the site.

| Option | Type | Notes |
| --- | --- | --- |
| `target` | string | **required**. Name or Horizons id, e.g. "Mars", "Maruthiakella", "CAPSTONE", "433", "Halley" |

Example requests: "plot Mars", "show CAPSTONE", "add Kathleenhowell", "plot Artemis II"

#### `eph.visibility`

Is a deep-space object visible from the site now, and when in the next 72 hours (elevation limit, astronomical darkness).

| Option | Type | Notes |
| --- | --- | --- |
| `target` | string | Defaults to the active ephemeris target |

Example requests: "is Maruthiakella visible from my site", "can I see Jupiter tonight", "when is Mars up", "is CAPSTONE still tracked"

#### `eph.focus`

Make one of the plotted targets the active one.

| Option | Type | Notes |
| --- | --- | --- |
| `target` | string | **required** |

#### `eph.remove`

Remove a plotted target, or all of them.

| Option | Type | Notes |
| --- | --- | --- |
| `target` | string | **required**. Name or "all" |

#### `eph.list`

Plotted targets and the built-in target list.

No options.

#### `eph.min_elevation`

Elevation limit (degrees) used for ephemeris visibility windows.

| Option | Type | Notes |
| --- | --- | --- |
| `degrees` | number | **required**. range 0 to 30 |

#### `eph.refetch`

Fetch the active target again from JPL Horizons.

No options.

#### `solar.scale`

Solar-system map scale: compact (readable) or true linear distances.

| Option | Type | Notes |
| --- | --- | --- |
| `mode` | compact \| true | **required**. also accepts *compact*: compressed, log, readable; *true*: true scale, linear, real, actual |

#### `solar.rate`

Animate the solar-system map at this many days per second.

| Option | Type | Notes |
| --- | --- | --- |
| `days_per_second` | number | **required**. range -3650 to 3650 |

Example requests: "speed up the planets", "run the solar system"

#### `solar.step`

Step the clock by a number of days (for the solar-system map; affects every view).

| Option | Type | Notes |
| --- | --- | --- |
| `days` | number | **required** |


### Conjunctions

#### `conj.list`

Predicted close approaches between catalogued objects (CelesTrak SOCRATES).

| Option | Type | Notes |
| --- | --- | --- |
| `sort` | range \| tca \| probability | Order (defaults to the one on screen). also accepts *range*: distance, miss distance, closest; *tca*: time, soonest, next; *probability*: prob, pc, risk, likelihood |
| `limit` | number | range 1 to 50. default `10` |

Example requests: "any close approaches", "what conjunctions are coming", "riskiest conjunctions"

#### `conj.select`

Open one conjunction (by rank in the current order, or by an object in it) and draw the encounter.

| Option | Type | Notes |
| --- | --- | --- |
| `rank` | number | range 1 to  |
| `object` | string | Name or NORAD number of either object |

#### `conj.refresh`

Fetch the SOCRATES report again.

No options.


### Space weather

#### `spaceweather.get`

Planetary K index and 10.7 cm solar flux from NOAA SWPC (drag and aurora conditions).

No options.

Example requests: "how is space weather", "is there a geomagnetic storm", "what is Kp"


### Other

#### `share.link`

A web address that opens the dashboard in its current state (view, site, tracked objects, list, filters, target).

No options.

Example requests: "give me a link to this view", "share this"

#### `ui.caption`

Show a short caption at the bottom of the dashboard (for example what Claire is saying). Empty text hides it.

| Option | Type | Notes |
| --- | --- | --- |
| `text` | string |  |
| `seconds` | number | 0 keeps it until replaced. range 0 to 120. default `6` |

