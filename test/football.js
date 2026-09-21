const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'cfb-secret-abcdefghijklmnopq';
process.env.SITE_LOGIN_USERNAME = 'erik';
process.env.SITE_LOGIN_PASSWORD = 'site-password-here-1';
process.env.RESEARCH_ALLOWED_EMAILS = 'owner@example.com';
process.env.FIRESTORE_DATABASE_ID = 'college-football-app';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9204';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9204';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  // Nobody signs in ON football - the whole point is that the cookie already
  // travelled here from a sibling app.
  const fan = h.session(SECRET, 'fan@example.com');
  const owner = h.session(SECRET, 'owner@example.com');
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { email: 'fan@example.com', createdAt: 'x' });
  h.bag('identity').set('users/' + uidOf('owner@example.com'), { email: 'owner@example.com', createdAt: 'x' });

  let r = await fetch(B + '/api/slip', { headers: { cookie: fan } });
  ok('a session made on ANOTHER app opens the slip here, with no login on this app', r.status === 200, String(r.status));
  r = await fetch(B + '/api/slip');
  ok('anonymous is still refused', r.status === 401, String(r.status));

  // the slip is per person
  r = await fetch(B + '/api/slip', { method: 'PUT', headers: { ...J, cookie: fan }, body: JSON.stringify({ slip: { a: 1 }, bankroll: '50' }) });
  ok('they can save a slip', r.status === 200, String(r.status));
  const docs = [...h.bag('college-football-app').entries()].filter(([k]) => k.startsWith('user-state/'));
  ok('it is stored under the shared uid', docs.some(([k]) => k === 'user-state/' + uidOf('fan@example.com')), JSON.stringify(docs.map(([k]) => k)));
  r = await fetch(B + '/api/slip', { headers: { cookie: fan } });
  ok('and reads back', JSON.stringify(await r.json()).includes('"50"'));
  r = await fetch(B + '/api/slip', { headers: { cookie: owner } });
  ok('another account does NOT see it', !JSON.stringify(await r.json()).includes('"50"'));

  // an older slip under this app's raw-email key is not lost
  const week = await (await fetch(B + '/api/slip', { headers: { cookie: owner } })).json();
  h.bag('college-football-app').set('user-state/owner@example.com', { weekKey: week.weekKey, slip: { legacy: 1 }, bankroll: '999' });
  r = await fetch(B + '/api/slip', { headers: { cookie: owner } });
  ok('a slip saved under the OLD key is still found', JSON.stringify(await r.json()).includes('"999"'));

  // research tier
  r = await fetch(B + '/api/chat', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  ok('an ordinary shared account cannot spend tokens', r.status === 403, String(r.status));
  r = await fetch(B + '/api/chat', { method: 'POST', headers: { ...J, cookie: owner }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  ok('an allowlisted address still can', r.status === 200, String(r.status));

  // an admin grant is the third way in
  const u = h.bag('identity').get('users/' + uidOf('fan@example.com'));
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { ...u, access: { football: 'research' } });
  r = await fetch(B + '/api/chat', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  ok('an admin grant of research opens it without touching the env allowlist', r.status === 200, String(r.status));
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { ...u, access: { dataviz: 'pro' } });
  r = await fetch(B + '/api/chat', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  ok('a grant for a DIFFERENT app does not', r.status === 403, String(r.status));

  // the site password remains the owner's own door
  const basic = 'Basic ' + Buffer.from('erik:site-password-here-1').toString('base64');
  r = await fetch(B + '/api/chat', { method: 'POST', headers: { ...J, authorization: basic }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  ok('the site password still opens research', r.status === 200, String(r.status));

  // board reads stay public
  r = await fetch(B + '/api/games');
  ok('the board is still public to anyone', r.status === 200);
  r = await fetch(B + '/analytics.js');
  ok('/analytics.js is still ungated', r.status === 200);

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
