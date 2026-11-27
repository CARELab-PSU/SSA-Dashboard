# JPL relay for the Ephemeris tab

Deployed at `https://ssa-jpl.roshanthomase.workers.dev/` and set as
`JPL_PROXY_DEFAULT` in `js/01-astro.js`.

The Ephemeris tab talks to JPL Horizons. JPL's APIs do not allow direct
requests from web pages hosted on other sites, so the browser blocks every
response. The dashboard used to route around this through free public proxies
(corsproxy.io, allorigins). Those no longer serve production sites, which is
why the tab stopped working.

`jpl-proxy-worker.js` is a small Cloudflare Worker that relays requests to the
two JPL API hosts only and adds the missing header. The free Cloudflare plan
(100,000 requests per day) is far more than the dashboard needs.

## Deploy (about five minutes)

1. Sign in at dash.cloudflare.com, open **Workers & Pages**, and create a Worker.
2. Replace the starter code with the contents of `jpl-proxy-worker.js` and deploy.
3. Copy the Worker URL, for example `https://ssa-jpl.<account>.workers.dev`.
4. In `js/01-astro.js`, set `const JPL_PROXY_DEFAULT='https://ssa-jpl.<account>.workers.dev/';`.

## Trying a relay without editing code

Open the dashboard with `?proxy=<relay URL>`. The page remembers it in this
browser until you open it with `?proxy=` (empty) again.
