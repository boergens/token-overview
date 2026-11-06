import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { verifyAccessToken, getLive } from '../worker.js';
globalThis.crypto ??= webcrypto;
const config = { ACCESS_TEAM_DOMAIN: 'allowance-tests.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64), OWNER_EMAIL: 'owner@example.com' };
const now = Date.now();
const pair = await crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid:'test-key', use:'sig', alg:'RS256' };
const certs = async (url, options) => {
  assert.equal(url, `https://${config.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  assert.ok(['follow', 'manual'].includes(options.redirect), 'Workers fetch supports only redirect follow/manual');
  return Response.json({ keys:[jwk] });
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function sign(overrides = {}, headers = {}) {
  const claims = { type:'app', iss:`https://${config.ACCESS_TEAM_DOMAIN}`, aud:[config.ACCESS_AUD], email:config.OWNER_EMAIL, iat:Math.floor(now/1000)-60, exp:Math.floor(now/1000)+600, ...overrides };
  const input = `${encode({alg:'RS256',kid:jwk.kid,...headers})}.${encode(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

test('a valid, signed Access token admits exactly the owner', async () => {
  const claims = await verifyAccessToken(await sign(), config, certs, now);
  assert.equal(claims.email, config.OWNER_EMAIL);
});

test('forged or invalid identities cannot reach any dashboard asset', async t => {
  const cases = [
    ['wrong email', {email:'someone@example.com'}],
    ['wrong audience', {aud:['b'.repeat(64)]}],
    ['wrong issuer', {iss:'https://attacker.example'}],
    ['expired token', {exp:Math.floor(now/1000)-1}],
    ['missing expiry', {exp:null}],
    ['future token', {nbf:Math.floor(now/1000)+600}],
    ['future issue time', {iat:Math.floor(now/1000)+600}],
    ['service token', {type:'service'}],
  ];
  for (const [name, claims] of cases) await t.test(name, async () => assert.rejects(verifyAccessToken(await sign(claims), config, certs, now)));
  await t.test('unsigned algorithm', async () => assert.rejects(verifyAccessToken(await sign({}, {alg:'none'}), config, certs, now)));
  await t.test('tampered body', async () => {
    const token = await sign({email:'someone@example.com'}), parts = token.split('.');
    const body = JSON.parse(Buffer.from(parts[1], 'base64url'));
    body.email = config.OWNER_EMAIL;
    parts[1] = encode(body);
    await assert.rejects(verifyAccessToken(parts.join('.'), config, certs, now), /Invalid signature/);
  });
  await t.test('malformed token', async () => assert.rejects(verifyAccessToken('not.a.token', config, certs, now)));
});

test('missing configuration and missing authentication both fail closed for all routes', async () => {
  let served = 0;
  const assets = { fetch:async () => { served++; return new Response('PRIVATE'); } };
  const live = { get:async () => { served++; return {}; } };
  for (const path of ['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg', '/api/session', '/api/usage', '/api/live']) {
    const request = new Request(`https://example.pages.dev${path}`);
    const unconfigured = await worker.fetch(request, { ASSETS:assets, LIVE:live });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.headers.get('Cache-Control'), 'private, no-store');
    const unauthenticated = await worker.fetch(request, {...config, ASSETS:assets, LIVE:live});
    assert.equal(unauthenticated.status, 403);
  }
  assert.equal(served, 0);
});

test('forged header email is never treated as authentication', async () => {
  const request = new Request('https://example.pages.dev/', { headers:{ 'Cf-Access-Authenticated-User-Email':config.OWNER_EMAIL, 'Cf-Access-Jwt-Assertion':'forged.token.signature' } });
  const response = await worker.fetch(request, {...config, ASSETS:{ fetch:() => assert.fail('Must not serve assets') }});
  assert.equal(response.status, 403);
});

test('owner can fetch assets, session and the live feed with restrictive security headers', async () => {
  // The trusted test JWKS is already cached by token verification above.
  const token = await sign();
  const feed = { version:1, collectedAt:new Date(now).toISOString(), collector:'box', providers:{ claude:{ status:'ok', windows:[] } } };
  const env = { ...config, ASSETS:{ fetch:async () => new Response('Dashboard', {headers:{'Content-Type':'text/html'}}) }, LIVE:{ get:async (key, options) => { assert.equal(key, 'live'); assert.equal(options.type, 'json'); return feed; } } };
  const request = path => new Request(`https://example.pages.dev${path}`, { headers:{ 'Cf-Access-Jwt-Assertion':token } });
  const response = await worker.fetch(request('/'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Dashboard');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const session = await worker.fetch(request('/api/session'), env);
  assert.deepEqual(await session.json(), { email:config.OWNER_EMAIL, access:'owner', mode:'private' });
  const live = await worker.fetch(request('/api/live'), env);
  assert.equal(live.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await live.json(), { status:'ok', ...feed });
});

test('the live feed reports not connected rather than inventing data', async () => {
  assert.equal((await getLive({})).status, 'not_connected');
  assert.equal((await getLive({ LIVE:{ get:async () => null } })).status, 'not_connected');
  assert.equal((await getLive({ LIVE:{ get:async () => ({ collectedAt:'soon', providers:{} }) } })).status, 'not_connected');
  assert.equal((await getLive({ LIVE:{ get:async () => { throw new Error('KV down'); } } })).status, 'error');
});

test('a certificate service outage does not allow requests through', async () => {
  const token = await sign({}, {kid:'rotated-key'});
  await assert.rejects(verifyAccessToken(token, config, async () => { throw new Error('Network unavailable'); }, now));
});
