// Sharing a slip by link.
//
// The things worth pinning down: a share needs an account, an empty post is
// refused, the link is open to strangers, and what comes back is a frozen
// copy - editing the slip afterwards must not change what was sent.
const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'cfb-secret-abcdefghijklmnopq';
process.env.SITE_LOGIN_USERNAME = 'erik';
process.env.SITE_LOGIN_PASSWORD = 'site-password-here-1';
process.env.FIRESTORE_DATABASE_ID = 'college-football-app';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9207';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9207';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

const ITEMS = [
  {
    kind: 'straight', title: 'Georgia -24.5', matchup: 'Georgia at Arkansas',
    time: 'Sat 12:00p ET', market: 'Spread * Georgia -24.5', odds: -115,
    why: 'Widest roster gap on the slate.', risk: 'Backdoor cover if the starters sit.',
    stake: 50, toWin: 43.48,
  },
  {
    kind: 'parlay', title: 'Blowout Board',
    legs: [
      { game: 'Florida State at Alabama', market: 'Alabama -20', odds: -110 },
      { game: 'New Mexico at Oklahoma', market: 'Oklahoma -22.5', odds: -110 },
    ],
    why: 'Two numbers closer to expect-it than hope-for-it.',
    risk: 'Correlated: one early blowout and a leg gets shaky.',
    stake: 20, toWin: 52.8,
  },
];

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  const fan = h.session(SECRET, 'fan@example.com');
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { email: 'fan@example.com', createdAt: 'x' });

  let r = await fetch(B + '/api/slip/share', { method: 'POST', headers: J, body: JSON.stringify({ items: ITEMS }) });
  ok('a stranger cannot mint a share link', r.status === 401, String(r.status));

  r = await fetch(B + '/api/slip/share', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ items: [] }) });
  ok('an empty slip is refused', r.status === 400, String(r.status));

  r = await fetch(B + '/api/slip/share', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ items: ITEMS }) });
  const made = await r.json();
  ok('a signed-in fan gets a link', r.status === 200 && !!made.shareId && /\/s\//.test(made.url || ''), JSON.stringify(made));

  // Open to anyone: no cookie, no password, no identity session.
  r = await fetch(B + '/api/shared-slip/' + made.shareId);
  const got = await r.json();
  ok('anyone with the link can read it', r.status === 200, String(r.status));
  ok('both plays came through', (got.items || []).length === 2, JSON.stringify(got.items && got.items.length));
  ok('the prose travelled with it', (got.items[0].why || '').includes('roster gap'));
  ok('parlay legs survived', (got.items[1].legs || []).length === 2);
  ok('totals are the server’s own sum', got.totalRisk === 70, String(got.totalRisk));
  // A share link is public: never the email's local part (audit, 2026-09-26).
  ok('with no display name it says "A reader", not the email', got.by === 'A reader' && !JSON.stringify(got).includes('fan@'), String(got.by));

  // With one, the first name only.
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { email: 'fan@example.com', createdAt: 'x', displayName: 'Jamie <b>Fan</b>' });
  r = await fetch(B + '/api/slip/share', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ items: ITEMS }) });
  const named = await (await fetch(B + '/api/shared-slip/' + (await r.json()).shareId)).json();
  ok('with a display name it says the first name only', named.by === 'Jamie', String(named.by));

  // Links made before this stored the local part; they read as "A reader".
  h.bag('college-football-app').set('shared-slips/legacy1', { items: ITEMS, weekKey: 'x', by: 'erik.strong', createdAt: new Date().toISOString() });
  const legacy = await (await fetch(B + '/api/shared-slip/legacy1')).json();
  ok('an old link no longer publishes the email local part', legacy.by === 'A reader', String(legacy.by));
  ok('a share link is https behind the proxy', /^https:/.test(((await (await fetch(B + '/api/slip/share', { method: 'POST', headers: { ...J, cookie: fan, 'x-forwarded-proto': 'https' }, body: JSON.stringify({ items: ITEMS }) })).json()).url) || ''));
  ok('a current-week share is not stale', got.stale === false, String(got.stale));

  // The bankroll is the one number that must never ride along.
  ok('no bankroll anywhere in the payload', !('bankroll' in got) && !JSON.stringify(got).includes('bankroll'));

  // A snapshot, not a live view.
  r = await fetch(B + '/api/slip', {
    method: 'PUT', headers: { ...J, cookie: fan },
    body: JSON.stringify({ slip: { 'georgia-spread': { stake: 999, placed: true } }, bankroll: '5000' }),
  });
  r = await fetch(B + '/api/shared-slip/' + made.shareId);
  const again = await r.json();
  ok('editing the slip afterwards does not change the link', again.totalRisk === 70, String(again.totalRisk));

  // Anything stored here is served to strangers, so it is clamped first.
  r = await fetch(B + '/api/slip/share', {
    method: 'POST', headers: { ...J, cookie: fan },
    body: JSON.stringify({ items: [{ kind: 'weird', title: 'x'.repeat(500), why: 'y'.repeat(9000), stake: -40, toWin: 'nope', legs: 'not-an-array' }] }),
  });
  const dirty = await (await fetch(B + '/api/shared-slip/' + (await r.json()).shareId)).json();
  const it = dirty.items[0];
  ok('an unknown kind falls back to straight', it.kind === 'straight', it.kind);
  ok('long strings are clipped', it.title.length === 120 && it.why.length === 2000, it.title.length + '/' + it.why.length);
  ok('a negative stake cannot ride along', it.stake === 0, String(it.stake));
  ok('a non-numeric payout becomes a number', it.toWin === 0, String(it.toWin));
  ok('legs are always an array', Array.isArray(it.legs) && it.legs.length === 0);

  r = await fetch(B + '/api/shared-slip/does-not-exist');
  ok('an unknown id is a 404, not a blank page', r.status === 404, String(r.status));

  r = await fetch(B + '/s/' + made.shareId);
  ok('the share URL serves the page to anyone', r.status === 200, String(r.status));
  const page = await r.text();
  ok('and that page is the shared-slip page', page.includes('/api/shared-slip/'));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
