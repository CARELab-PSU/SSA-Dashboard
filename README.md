# CARE Lab SSA Dashboard

A browser dashboard for space situational awareness: SGP4 tracking and pass
prediction for an observer site, a 3-D view of the public catalog, JPL Horizons
ephemerides, and CelesTrak SOCRATES conjunctions.

## Layout

| File | Contents |
| --- | --- |
| `index.html` | Page markup only |
| `css/app.css` | All styles. The monochrome layer at the end overrides the older rules above it |
| `js/01-astro.js` | Constants, TLE parsing, time and frame helpers, network helpers, OrbitSmith loader |
| `js/02-observer.js` | Sim clock, SGP4 propagation, passes, ground track, sky plot, pass lists and data panel |
| `js/03-catalog.js` | 3-D catalog view |
| `js/04-ephemeris.js` | Horizons service, solar-system map, spacecraft trajectory view, Ephemeris tab |
| `js/05-conjunctions.js` | Space-weather readout and the Conjunctions tab |
| `js/06-app.js` | Saved state, tab switching, start-up |
| `proxy/` | Relay that the Ephemeris tab needs to reach JPL. See `proxy/README.md` |

The scripts are plain files loaded in order and share one global scope. There
is no build step: serve the folder (GitHub Pages, or `python3 -m http.server`).

## Data sources

CelesTrak (TLEs, SOCRATES), OrbitSmith (full-catalog mirror), JPL Horizons and
SBDB through the relay, NOAA SWPC (Kp, F10.7).
