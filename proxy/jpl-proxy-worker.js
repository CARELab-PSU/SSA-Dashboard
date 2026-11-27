// Relay for the SSA dashboard: forwards requests to JPL Horizons / SBDB only
// and adds the header browsers need. Usage: https://<worker>/?url=<JPL URL>
//
// Deployed at https://ssa-jpl.roshanthomase.workers.dev/ (Cloudflare Workers,
// free plan). JPL's APIs do not allow cross-site requests from web pages,
// so the Ephemeris tab goes through this. Only the two JPL hosts below are
// relayed, so it cannot be used to reach any other site.
const ALLOWED_HOSTS = new Set(['ssd.jpl.nasa.gov', 'ssd-api.jpl.nasa.gov']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
    let u;
    try { u = new URL(target); } catch { return new Response('missing or bad ?url=', { status: 400, headers: CORS }); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
      return new Response('host not allowed', { status: 403, headers: CORS });
    }

    const upstream = await fetch(u.toString(), {
      headers: { 'User-Agent': 'CARELab-SSA-Dashboard (Penn State)' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const headers = new Headers(CORS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'text/plain');
    headers.set('Cache-Control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
