import { getApiUsage } from './server/usage.js';
// Advanced-mode Pages Worker: authentication runs before any asset is served.
const keySets = new Map();
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed token');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}

export async function verifyAccessToken(token, config, fetcher = fetch, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw new Error('Unsupported token');
  const seconds = now / 1000;
  const issuer = `https://${config.ACCESS_TEAM_DOMAIN}`;
  if (claims.iss !== issuer || claims.type !== 'app' || !Array.isArray(claims.aud) || !claims.aud.includes(config.ACCESS_AUD)) throw new Error('Wrong application');
  if (!Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 30) throw new Error('Expired or future token');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 30)) throw new Error('Token not active');
  if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== config.OWNER_EMAIL.trim().toLowerCase()) throw new Error('Not the owner');
  let keys = keySets.get(issuer);
  if (!keys || keys.until <= now || !keys.values.some(k => k.kid === header.kid)) {
    // Workers' fetch knows only redirect 'follow' and 'manual' ('error' throws): with 'manual' a redirect is a non-ok response and fails verification.
    const result = await fetcher(`${issuer}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error('Unable to verify identity');
    const body = await result.json();
    if (!Array.isArray(body.keys)) throw new Error('Invalid keys');
    keys = { until: now + 300000, values: body.keys };
    keySets.set(issuer, keys);
  }
  const jwk = keys.values.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
  if (!jwk) throw new Error('Unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Invalid signature');
  return claims;
}

function configured(env) {
  return /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN || '') &&
    /^[a-fA-F0-9]{64}$/.test(env.ACCESS_AUD || '') &&
    typeof env.OWNER_EMAIL === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OWNER_EMAIL.trim());
}

// The live feed: written to KV by collector/collect.py on the owner's machine, served read-only here.
export async function getLive(env) {
  if (!env.LIVE || typeof env.LIVE.get !== 'function') return { status: 'not_connected', message: 'The live feed storage is not bound to this deployment.' };
  let live;
  try { live = await env.LIVE.get('live', { type: 'json' }); }
  catch { return { status: 'error', message: 'The live feed could not be read. Try again in a moment.' }; }
  if (!live || typeof live !== 'object' || typeof live.collectedAt !== 'string' || !Number.isFinite(Date.parse(live.collectedAt)) || !live.providers || typeof live.providers !== 'object') {
    return { status: 'not_connected', message: 'No live readings have arrived from the collector yet.' };
  }
  return { status: 'ok', version: live.version ?? 1, collectedAt: live.collectedAt, collector: typeof live.collector === 'string' ? live.collector.slice(0, 80) : null, providers: live.providers };
}

function deny(status, title, message) {
  return secure(new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><h1>${title}</h1><p>${message}</p></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
}

export default {
  async fetch(request, env) {
    if (!configured(env)) return deny(503, 'Private dashboard is locked', 'The owner must finish configuring Cloudflare Access before this dashboard can be opened.');
    let claims;
    try { claims = await verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env); }
    catch (error) {
      // The reason is one of this file's own short messages (never token contents); the edge has already authenticated the viewer.
      const reason = String(error && error.message || 'Verification failed').replace(/[^\w .,'-]/g, '').slice(0, 80);
      console.warn('Access token rejected:', reason);
      return deny(403, 'Owner sign-in required', `Open the dashboard’s main address and sign in with the owner’s Cloudflare Access email. (Reason: ${reason}.)`);
    }
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return secure(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
    if (url.pathname === '/api/session') return secure(Response.json({ email: claims.email, access: 'owner', mode: 'private' }));
    if (url.pathname === '/api/live') return secure(Response.json(await getLive(env)));
    if (url.pathname === '/api/usage') return secure(Response.json(await getApiUsage(env)));
    if (url.pathname.startsWith('/api/')) return secure(new Response('Not found', { status: 404 }));
    // Never pass through on exceptions: unavailable verification must stay closed.
    return secure(await env.ASSETS.fetch(request));
  },
};
