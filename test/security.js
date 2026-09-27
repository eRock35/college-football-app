// The security review of 2026-09-27: who may research, who is metered, what a
// public read may say about who researched, whose old slip a shared session
// may read, and the three small ones (the proxy, the cron key, password
// guessing). See CLAUDE.md "Security review fixes".
const h = require('./harness.js');
h.install();

let modelCalls = 0;
const reply = {
  rank: '#2', record: '3-0', confRecord: '1-0 SEC',
  nextGame: { opponent: 'at Oklahoma', kickoffISO: '2026-10-03T16:00:00Z', tv: 'ABC' },
  schedule: [{ wk: 'Sep 5', opp: 'Tennessee State', loc: 'home', result: 'W 63-3' }],
  storyline: ['A paragraph about the season.'],
};
require.cache['FAKE_AN'].exports = function () {
  const message = async () => ({
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(reply) }],
  });
  return {
    messages: {
      create: async (...a) => { modelCalls++; return message(...a); },
      stream: () => { modelCalls++; return { finalMessage: message }; },
    },
    batches: {},
  };
};

const SECRET = 'identity-secret-abcdefghijklmn';
const OWN_SECRET = 'cfb-secret-abcdefghijklmnopq';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = OWN_SECRET;
process.env.SITE_LOGIN_USERNAME = 'erik';
process.env.SITE_LOGIN_PASSWORD = 'site-password-here-1';
process.env.RESEARCH_ALLOWED_EMAILS = 'owner@example.com,second@example.com';
process.env.FIRESTORE_DATABASE_ID = 'college-football-app';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.CRON_SECRET = 'cron-secret-value-here';
process.env.FREE_TIER_DAILY_CAP_USD = '5';
process.env.DAILY_CAP_CACHE_MS = '0';
process.env.PORT = '9231';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9231';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const ids = h.bag('identity');
const bag = h.bag('college-football-app');
// Each request names its own client address, so the password limiter below
// counts only the requests meant for it.
let ipN = 1;
const freshIp = () => `10.1.0.${ipN++}`;
const send = (m, p, { cookie, body, auth, ip, headers } = {}) => fetch(B + p, {
  method: m,
  headers: { ...J, 'x-forwarded-for': ip || freshIp(), ...(cookie ? { cookie } : {}), ...(auth ? { authorization: auth } : {}), ...(headers || {}) },
  body: body === undefined ? (m === 'POST' || m === 'PUT' ? '{}' : undefined) : JSON.stringify(body),
});
const basic = (pw) => 'Basic ' + Buffer.from('erik:' + pw).toString('base64');
const CHAT = { messages: [{ role: 'user', content: 'x' }] };

function account(email, extra = {}) {
  ids.set('users/' + uidOf(email), { email, ...extra });
  return h.session(SECRET, email, extra.via || 'password');
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  let r, j;

  /* ---------- 1. research on the shared account ---------- */
  console.log('-- 1. an allowlisted address on the shared account');
  const squatter = account('owner@example.com', { createdAt: '2026-09-28T09:00:00Z' });
  r = await send('POST', '/api/chat', { cookie: squatter, body: CHAT });
  ok('registered AFTER the cutoff, it does not open /api/chat', r.status === 403, String(r.status));
  for (const [m, u] of [['POST', '/api/research/custom'], ['GET', '/api/asks'], ['POST', '/api/research/refresh-board'], ['POST', '/api/research/weekly-board']]) {
    r = await send(m, u, { cookie: squatter });
    ok(`...nor ${m} ${u}`, r.status === 403, String(r.status));
  }
  j = await (await send('GET', '/api/auth/status', { cookie: squatter })).json();
  ok('...and the page is told it may not research', j.canResearch === false, JSON.stringify(j));

  account('owner@example.com', { createdAt: '2026-09-27T21:00:00Z' });
  r = await send('POST', '/api/chat', { cookie: squatter, body: CHAT });
  ok('exactly AT the cutoff is not before it', r.status === 403, String(r.status));
  account('owner@example.com', {});
  r = await send('POST', '/api/chat', { cookie: squatter, body: CHAT });
  ok('no createdAt at all fails closed', r.status === 403, String(r.status));
  account('owner@example.com', { createdAt: 'x' });
  r = await send('POST', '/api/chat', { cookie: squatter, body: CHAT });
  ok('an unreadable createdAt fails closed', r.status === 403, String(r.status));

  const owner = account('owner@example.com', { createdAt: '2026-09-20T12:00:00Z' });
  r = await send('POST', '/api/chat', { cookie: owner, body: CHAT });
  ok('an allowlisted account made BEFORE the cutoff keeps research', r.status === 200, String(r.status));
  r = await send('GET', '/api/asks', { cookie: owner });
  ok('...and /api/asks', r.status === 200, String(r.status));
  j = await (await send('GET', '/api/auth/status', { cookie: owner })).json();
  ok('...and the page shows it the owner buttons', j.canResearch === true);

  const granted = account('friend@example.com', { createdAt: '2026-10-01T00:00:00Z', access: { football: 'research' } });
  r = await send('POST', '/api/chat', { cookie: granted, body: CHAT });
  ok('a new account with the admin panel\'s football research grant may research', r.status === 200, String(r.status));
  const otherGrant = account('friend2@example.com', { createdAt: '2026-10-01T00:00:00Z', access: { football: 'member', dataviz: 'research' } });
  r = await send('POST', '/api/chat', { cookie: otherGrant, body: CHAT });
  ok('...a lesser level, or another app\'s grant, does not', r.status === 403, String(r.status));
  const admin = account('boss@example.com', { createdAt: '2026-10-01T00:00:00Z', admin: true });
  r = await send('POST', '/api/chat', { cookie: admin, body: CHAT });
  ok('the domain owner flag (admin: true) may research', r.status === 200, String(r.status));

  /* ---------- the own door keeps the allowlist ---------- */
  console.log('-- the own door');
  const ownOwner = h.ownSession(OWN_SECRET, 'second@example.com');
  r = await send('POST', '/api/chat', { cookie: ownOwner, body: CHAT });
  ok('an own-door session for an allowlisted address still researches', r.status === 200, String(r.status));
  const ownFan = h.ownSession(OWN_SECRET, 'fan@example.com');
  r = await send('POST', '/api/chat', { cookie: ownFan, body: CHAT });
  ok('...an ordinary own-door session does not', r.status === 403, String(r.status));
  r = await send('POST', '/api/auth/passkey/register/options', { body: { email: 'second@example.com' } });
  j = await r.json();
  ok('claiming an allowlisted address on the own door still needs the site password', r.status === 401 && j.needsPassword === true, `${r.status} ${JSON.stringify(j)}`);
  account('owner@example.com', { createdAt: '2026-09-28T09:00:00Z' });
  r = await send('POST', '/api/chat', { cookie: squatter + '; ' + ownFan, body: CHAT });
  ok('a post-cutoff shared squatter plus an ordinary own-door session is still refused', r.status === 403, String(r.status));

  /* ---------- the site password cannot be taken by a squatter ---------- */
  console.log('-- changing the site password');
  account('owner@example.com', { createdAt: '2026-09-28T09:00:00Z' });
  const squatterPasskey = h.session(SECRET, 'owner@example.com', 'passkey');
  r = await send('POST', '/api/auth/password/change', { cookie: squatterPasskey, body: { next: 'a-brand-new-password-1' } });
  ok('a post-cutoff shared account, even proved by passkey, cannot change the site password', r.status === 401, String(r.status));
  account('owner@example.com', { createdAt: '2026-09-20T12:00:00Z' });
  r = await send('POST', '/api/auth/password/change', { cookie: h.ownSession(OWN_SECRET, 'fan@example.com', 'passkey') + '; ' + owner, body: { next: 'a-brand-new-password-1' } });
  ok('...nor an ordinary passkey on one door paired with the owner\'s PASSWORD session on the other', r.status === 401, String(r.status));
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), body: CHAT });
  ok('...and the site password is unchanged', r.status === 200, String(r.status));

  /* ---------- 2. metered routes need the shared account ---------- */
  console.log('-- 2. metered routes');
  modelCalls = 0;
  r = await send('POST', '/api/research/add-game', { cookie: ownFan, body: { query: 'Georgia at Oklahoma' } });
  j = await r.json();
  ok('an own-door session cannot add a game unmetered', r.status === 401 && !!j.accountUrl, `${r.status} ${JSON.stringify(j)}`);
  r = await send('POST', '/api/fan/uga/research', { cookie: ownFan });
  ok('...nor research a team', r.status === 401, String(r.status));
  ok('...and no model was called for either', modelCalls === 0, String(modelCalls));
  const fan = account('fan@example.com', { createdAt: '2026-10-01T00:00:00Z' });
  r = await send('POST', '/api/research/add-game', { cookie: fan, body: {} });
  ok('a shared account gets past the gate (to the 400 for an empty query)', r.status === 400, String(r.status));
  r = await send('POST', '/api/fan/not-a-team/research', { cookie: fan });
  ok('...and to team research (404 for an unknown team)', r.status === 404, String(r.status));
  r = await send('POST', '/api/research/add-game', { auth: basic('site-password-here-1'), body: {} });
  ok('the owner\'s site password still gets past it, as for /api/chat', r.status === 400, String(r.status));
  r = await send('POST', '/api/research/add-game', { cookie: ownOwner, body: {} });
  ok('...and so does the owner\'s own-door session', r.status === 400, String(r.status));

  /* ---------- 3. researchedBy never reaches a reader ---------- */
  console.log('-- 3. researchedBy');
  bag.set('fan/uga', { team: 'uga', record: '3-0', storyline: ['Old take.'], schedule: [], lastChecked: '2026-09-19T15:30:00Z', researchedBy: 'owner@example.com' });
  j = await (await send('GET', '/api/fan/uga')).json();
  ok('GET /api/fan/:team strips researchedBy from an old document', !('researchedBy' in j) && !JSON.stringify(j).includes('owner@example.com') && j.researched === true, JSON.stringify(j).slice(0, 200));
  j = await (await send('GET', '/api/uga')).json();
  ok('GET /api/uga strips it too, and still serves the page', !('researchedBy' in j) && !JSON.stringify(j).includes('owner@example.com') && j.storyline[0] === 'Old take.', JSON.stringify(j));
  const teamfacts = require(require('path').join(__dirname, '..', 'teamfacts.js'));
  ok('overlay strips it with facts as well as without', !('researchedBy' in teamfacts.overlay({ researchedBy: 'a@b.c' }, null, null, { teamId: 'uga' })));
  r = await send('POST', '/api/fan/michigan/research', { cookie: fan });
  ok('a paid team refresh succeeds', r.status === 200, String(r.status));
  const stored = bag.get('fan/michigan');
  ok('...and stores no researchedBy', stored && !('researchedBy' in stored) && !JSON.stringify(stored).includes(uidOf('fan@example.com')), JSON.stringify(stored));

  /* ---------- 4. the legacy slip ---------- */
  console.log('-- 4. the legacy slip');
  const week = (await (await send('GET', '/api/slip', { cookie: fan })).json()).weekKey;
  bag.set('user-state/victim@example.com', { weekKey: week, slip: { secret: 1 }, bankroll: '4242', updatedAt: new Date().toISOString() });
  const claimed = account('victim@example.com', { createdAt: '2026-10-01T00:00:00Z' });
  j = await (await send('GET', '/api/slip', { cookie: claimed })).json();
  ok('a shared account claiming an own-door user\'s address does not get their slip', !JSON.stringify(j).includes('4242'), JSON.stringify(j));
  const both = claimed + '; ' + h.ownSession(OWN_SECRET, 'victim@example.com');
  j = await (await send('GET', '/api/slip', { cookie: both })).json();
  ok('...the same person, proved on this app\'s own door too, still does', JSON.stringify(j).includes('4242'), JSON.stringify(j));
  j = await (await send('GET', '/api/slip', { cookie: claimed + '; ' + ownFan })).json();
  ok('...an own-door session for a DIFFERENT address does not count', !JSON.stringify(j).includes('4242'));
  bag.set('user-state/slip', { weekKey: week, slip: { ownerOld: 1 }, bankroll: '777', updatedAt: new Date().toISOString() });
  account('owner@example.com', { createdAt: '2026-09-28T09:00:00Z' });
  j = await (await send('GET', '/api/slip', { cookie: squatter })).json();
  ok('the owner\'s pre-accounts slip is not handed to a post-cutoff squatter', !JSON.stringify(j).includes('777'), JSON.stringify(j));
  account('owner@example.com', { createdAt: '2026-09-20T12:00:00Z' });
  j = await (await send('GET', '/api/slip', { cookie: owner })).json();
  ok('...but still is to the owner', JSON.stringify(j).includes('777'), JSON.stringify(j));

  /* ---------- 5. the proxy, the cron key, password guessing ---------- */
  console.log('-- 5. proxy, cron key, password attempts');
  r = await send('POST', '/api/research/refresh-board', { headers: { 'x-cron-key': 'cron-secret-value-herx' } });
  ok('a wrong cron key of the right length is refused', r.status === 401, String(r.status));
  r = await send('POST', '/api/research/refresh-board', { headers: { 'x-cron-key': 'cron' } });
  ok('...and a short one', r.status === 401, String(r.status));
  r = await send('POST', '/api/research/refresh-board', { headers: { 'x-cron-key': 'cron-secret-value-here' } });
  ok('the right cron key opens it', r.status === 200, String(r.status));

  const guesser = '10.9.9.9';
  let statuses = [];
  for (let i = 0; i < 10; i++) {
    r = await send('POST', '/api/chat', { auth: basic('guess-' + i), ip: guesser, body: CHAT });
    statuses.push(r.status);
  }
  ok('ten wrong site passwords are ordinary refusals', statuses.every((s) => s === 401), statuses.join(','));
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: guesser, body: CHAT });
  ok('the eleventh attempt is a 429, even with the right password', r.status === 429, String(r.status));
  r = await send('GET', '/api/login', { auth: basic('site-password-here-1'), ip: guesser });
  ok('...on /api/login too', r.status === 429, String(r.status));
  r = await send('POST', '/api/auth/passkey/register/options', { ip: guesser, body: { email: 'second@example.com', password: 'site-password-here-1' } });
  ok('...and for the password typed into registration', r.status === 429, String(r.status));
  r = await send('POST', '/api/auth/password/change', { ip: guesser, body: { current: 'site-password-here-1', next: 'whatever-it-is-1' } });
  ok('...and for the current password on a change', r.status === 429, String(r.status));
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: '1.2.3.4, ' + guesser, body: CHAT });
  ok('a client-written X-Forwarded-For entry does not change who is counted', r.status === 429, String(r.status));
  r = await send('GET', '/api/board', { ip: guesser });
  ok('reading the board from that address is unaffected', r.status === 200, String(r.status));
  r = await send('POST', '/api/chat', { cookie: owner, ip: guesser, body: CHAT });
  ok('...and so is a signed-in owner there with no password attempt', r.status === 200, String(r.status));
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: '10.9.9.10', body: CHAT });
  ok('another address is not affected', r.status === 200, String(r.status));
  const regGuesser = '10.8.8.8';
  for (let i = 0; i < 10; i++) await send('POST', '/api/auth/passkey/register/options', { ip: regGuesser, body: { email: 'second@example.com', password: 'wrong-' + i } });
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: regGuesser, body: CHAT });
  ok('failures through the registration form count against the same limit', r.status === 429, String(r.status));
  const okUser = '10.7.7.7';
  for (let i = 0; i < 9; i++) await send('POST', '/api/chat', { auth: basic('nope-' + i), ip: okUser, body: CHAT });
  await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: okUser, body: CHAT });
  for (let i = 0; i < 9; i++) await send('POST', '/api/chat', { auth: basic('nope-again-' + i), ip: okUser, body: CHAT });
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), ip: okUser, body: CHAT });
  ok('a success clears the count', r.status === 200, String(r.status));

  /* ---------- 2b. the daily cap on chat and custom research (last: it closes the free tier) ---------- */
  console.log('-- the daily cap');
  const today = new Date().toISOString().slice(0, 10);
  ids.set(`control/free-spend-football-${today}`, { usd: 50 });
  r = await send('POST', '/api/chat', { auth: basic('site-password-here-1'), body: CHAT });
  ok('/api/chat now answers to the free tier\'s daily cap', r.status === 503, String(r.status));
  r = await send('POST', '/api/research/custom', { auth: basic('site-password-here-1'), body: { query: 'x' } });
  ok('...and so does /api/research/custom', r.status === 503, String(r.status));
  r = await send('POST', '/api/chat', { cookie: admin, body: CHAT });
  ok('...while someone spending their own money is not capped', r.status === 200, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
