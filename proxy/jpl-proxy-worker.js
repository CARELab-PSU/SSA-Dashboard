/*
 * Minimal relay for the SSA dashboard.
 *
 * JPL's SSD APIs (Horizons, Horizons Lookup, SBDB) do not send
 * Access-Control-Allow-Origin, so a browser page on another site cannot read
 * their responses. This Cloudflare Worker fetches the JPL URL server-side and
 * returns it with that header added.
 *
 * It only forwards GET requests to the JPL hosts listed below, so it cannot
 * be used as a general-purpose open proxy.
 *
 * Usage from the page:  https://<worker>.workers.dev/?url=<encoded JPL URL>
 */
const ALLOWED_HOSTS = new Set(['ssd.jpl.nasa.gov', 'ssd-api.jpl.nasa.gov']);

/* Pages allowed to use this relay. Add your own origins here. */
const ALLOWED_ORIGINS = [
  'https://carelab-psu.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });

    const target = new URL(request.url).searchParams.get('url');
    let u;
    try { u = new URL(target); } catch { return new Response('missing or bad ?url=', { status: 400 }); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }

    const upstream = await fetch(u.toString(), {
      headers: { 'User-Agent': 'CARELab-SSA-Dashboard (Penn State)' },
      cf: { cacheTtl: 300, cacheEverything: true },   // identical queries within 5 min hit the cache
    });
    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'text/plain');
    headers.set('Cache-Control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
