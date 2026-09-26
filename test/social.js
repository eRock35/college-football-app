// Calls, the crowd, records, badges and brag cards (2026-09-26): crowd.js,
// record.js, cards.js and the routes in social.js.
const fs = require('fs');
const path = require('path');
const h = require('./harness.js');
h.install();

const DAY = 86400000;
const finalsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'espn-finals.json'), 'utf8'));
/** The finals fixture replayed as not yet played, with Georgia at Arkansas
 *  under way (so its calls are closed). */
function preRaw() {
  const r = JSON.parse(JSON.stringify(finalsRaw));
  for (const e of r.events) {
    const inProgress = e.id === '401752701';
    e.status = inProgress
      ? { clock: 600, displayClock: '10:00', period: 2, type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: '10:00 - 2nd' } }
      : { clock: 0, displayClock: '0:00', period: 0, type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: 'Sat' } };
    for (const c of e.competitions) {
      c.status = e.status;
      for (const t of c.competitors || []) { if (inProgress) t.score = '14'; else delete t.score; }
    }
  }
  return r;
}

let slateBody = preRaw();
let lastBody = finalsRaw;
const board = require(path.join(__dirname, '..', 'board.js'));
const thisWeek = board.weekKeyAt(Date.now());
const prevWeek = board.weekKeyAt(Date.parse(thisWeek + 'T12:00:00Z') - 3 * DAY);
const ymd = (key, n) => new Date(Date.parse(key + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10).replace(/-/g, '');
const espnAsked = [];
const netFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.match(/^https:\/\/site(\.web)?\.api\.espn\.com\//)) {
    const m = /&dates=(\d{8})/.exec(u);
    espnAsked.push(m ? m[1] : 'today');
    let body = { events: [] };
    if (m && m[1] === ymd(thisWeek, 4)) body = slateBody;
    if (m && m[1] === ymd(prevWeek, 4)) body = lastBody;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return netFetch(url, opts);
};

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
process.env.CRON_SECRET = 'cron-secret-value-here';
process.env.PORT = '9217';
process.env.CFB_TEST_HOOKS = '1';
require(path.join(__dirname, '..', 'server.js'));
const crowd = require(path.join(__dirname, '..', 'crowd.js'));
const record = require(path.join(__dirname, '..', 'record.js'));
const cards = require(path.join(__dirname, '..', 'cards.js'));
const live = require(path.join(__dirname, '..', 'live.js'));

const B = 'http://127.0.0.1:9217';
const J = { 'content-type': 'application/json' };
const bag = h.bag('college-football-app');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const cookieOf = (r) => ((r.headers.get('set-cookie') || '').match(/cfb_v=([A-Za-z0-9_-]{24})/) || [])[1] || '';
const PNG = (buf) => buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

const THIS_BOARD = board.validate({
  weekKey: thisWeek, resultsWeek: prevWeek, generatedAt: new Date().toISOString(),
  games: [
    { id: 'nm-ou', label: 'New Mexico at Oklahoma', time: 'Sat 10:30p ET' },
    { id: 'uga-ark', label: 'Georgia at Arkansas', time: 'Sat 7p ET' },
    { id: 'lsu-om', label: 'LSU at Ole Miss', time: 'Sat 7:30p ET' },
    { id: 'fsu-bama', label: 'Florida State at Alabama', time: 'Sat 3:30p ET' },
  ],
  picks: [{ id: 'ou-spread', title: 'Oklahoma -22.5', matchup: 'New Mexico at Oklahoma', market: 'Spread', odds: -110 }],
  parlays: [],
  results: [
    { id: 'w1', title: 'Georgia -24.5', outcome: 'win', odds: -110, kind: 'straight' },
    { id: 'w2', title: 'Ohio State -52.5', outcome: 'loss', odds: -110, kind: 'straight' },
    { id: 'w3', title: 'Dog ML', outcome: 'win', odds: 200, kind: 'straight' },
    { id: 'w4', title: 'Parlay', outcome: 'loss', odds: 264, kind: 'parlay' },
    { id: 'w5', title: 'Push', outcome: 'push', odds: -110, kind: 'straight' },
  ],
});
// Last week's board, played from the finals fixture.
const PREV_BOARD = board.validate({
  weekKey: prevWeek, generatedAt: new Date(Date.now() - 7 * DAY).toISOString(),
  games: [{ id: 'nm-ou', label: 'New Mexico at Oklahoma', time: 'Sat 10:30p ET' }, { id: 'lsu-om', label: 'LSU at Ole Miss', time: 'Sat 7:30p ET' },
    { id: 'uga-ark', label: 'Georgia at Arkansas', time: 'Sat 7p ET' }, { id: 'fsu-bama', label: 'Florida State at Alabama', time: 'Sat 3:30p ET' }],
  picks: [
    { id: 'uga', title: 'Georgia -24.5', matchup: 'Georgia at Arkansas', market: 'Spread · Georgia -24.5', odds: -110 },
    { id: 'miss-ml', title: 'Ole Miss ML', matchup: 'LSU at Ole Miss', market: 'Moneyline · Ole Miss', odds: 160 },
    { id: 'lsu', title: 'LSU -2.5', matchup: 'LSU at Ole Miss', market: 'Spread · LSU -2.5', odds: -110 },
  ],
  parlays: [{ id: 'two', title: 'Two favourites', legs: [{ game: 'Georgia at Arkansas', market: 'Georgia -24.5', odds: -110 }, { game: 'New Mexico at Oklahoma', market: 'Oklahoma -22.5', odds: -110 }] }],
});

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  globalThis.__cfbSocial.setToday({ get: async () => ({ available: false }) });

  /* ---------------- pure ---------------- */
  console.log('\n-- crowd.js and record.js');
  const games = live.normalise(finalsRaw, Date.now()).all;
  const fg = crowd.findGame({ label: 'Georgia at Arkansas' }, games);
  const sides = crowd.sidesFor({ label: 'Georgia at Arkansas' }, fg);
  ok('a game\'s two sides carry the spread for each', sides.map((s) => s.label).join() === 'UGA -24.5,ARK +24.5', sides.map((s) => s.label).join());
  ok('a call is graded against the spread it was made at', crowd.gradeCall({ side: 'uga', spread: -24.5 }, fg) === 'win' && crowd.gradeCall({ side: 'uga', spread: -28 }, fg) === 'push' && crowd.gradeCall({ side: 'arkansas', spread: 24.5 }, fg) === 'loss');
  ok('...straight up when no line was posted', crowd.gradeCall({ side: 'arkansas', spread: null }, fg) === 'loss');
  ok('...and not at all before the final', crowd.gradeCall({ side: 'uga', spread: -24.5 }, { ...fg, final: false, state: 'in' }) === null);
  ok('a tally ignores fields that are not votes and negative counts', JSON.stringify(crowd.readTally({ 'v__nm-ou__oklahoma': 3, 'v__nm-ou__new-mexico': -1, junk: 9, 'v__bad id__x': 2 })) === '{"nm-ou":{"oklahoma":3,"new-mexico":0}}');
  ok('slip shares are hidden under five slips', Object.keys(crowd.slipCounts([1, 2, 3, 4].map(() => ({ slip: { a: { placed: true } } }))).counts).length === 0);
  ok('...and counted from five', crowd.slipCounts([1, 2, 3, 4, 5].map(() => ({ slip: { a: { placed: true }, b: { placed: false } } }))).counts.a === 5);
  ok('units at American odds', record.unitsFor('win', -110).toFixed(3) === '0.909' && record.unitsFor('win', 200) === 2 && record.unitsFor('loss', 500) === -1 && record.unitsFor('push', -110) === 0);
  ok('a parlay\'s price from its legs', record.parlayOdds([{ odds: -110 }, { odds: -110 }]) === 264);
  const season = record.boardSeason([THIS_BOARD]);
  ok('the board\'s season: record and units from its graded results', season.total.w === 2 && season.total.l === 2 && season.total.p === 1 && season.total.units === 0.91, JSON.stringify(season.total));
  ok('...filed under the week they graded', season.weeks.length === 1 && season.weeks[0].week === prevWeek);
  ok('streaks skip pushes', JSON.stringify(record.streakOf([{ outcome: 'loss' }, { outcome: 'win' }, { outcome: 'push' }, { outcome: 'win' }])) === '{"kind":"win","count":2}');
  const slipW = record.gradeSlipWeek({ slip: { uga: { stake: 50, placed: true }, 'miss-ml': { stake: 20, placed: true }, lsu: { stake: 10, placed: true }, two: { stake: 10, placed: true }, 'not-placed': { stake: 5 } } }, PREV_BOARD, games);
  ok('a slip is graded from the finals, in money', slipW && slipW.w === 3 && slipW.l === 1 && slipW.net === 45.45 + 32 - 10 + 26.4, JSON.stringify(slipW && { w: slipW.w, l: slipW.l, net: slipW.net }));
  const bdg = record.badges([{ week: prevWeek, slip: slipW, calls: null }]);
  const has = (id) => bdg.find((b) => b.id === id).earned;
  ok('an underdog cashed is "Called the upset", a parlay is "Parlay hit"', has('upset') && has('parlay') && has('first-win'));
  ok('...and badges not earned are still listed, locked', bdg.length === record.BADGES.length && !has('perfect-week'));

  console.log('\n-- cards.js');
  const svg = cards.weekSvg({ by: '<script>alert(1)</script>', calls: { w: 3, l: 1 }, rows: [{ label: 'A"B<img>', outcome: 'win' }] });
  ok('card text is escaped in the SVG', !/<script|<img/.test(svg) && /&lt;script&gt;/.test(svg));
  ok('a card renders to a PNG', PNG(cards.png(svg)));

  /* ---------------- the poll ---------------- */
  console.log('\n-- calling games');
  bag.set('board/current', THIS_BOARD);
  let r = await fetch(B + '/api/crowd');
  let body = await r.json();
  const nm = body.games && body.games.find((g) => g.id === 'nm-ou');
  ok('the poll is open, one entry per board game', body.open === true && body.games.length === 4, JSON.stringify(body).slice(0, 200));
  ok('...asking who covers, with each side\'s spread', nm && nm.question === 'Who covers?' && nm.sides.map((s) => s.label).join() === 'UNM +22.5,OU -22.5', nm && JSON.stringify(nm.sides));
  ok('...a game under way is closed', body.games.find((g) => g.id === 'uga-ark').open === false);
  ok('...and reading it sets no cookie', !cookieOf(r));

  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: J, body: JSON.stringify({ gameId: 'nm-ou', side: 'oklahoma' }) });
  body = await r.json();
  const anon = cookieOf(r);
  const A = { ...J, cookie: 'cfb_v=' + anon };
  let mine = body.games && body.games.find((g) => g.id === 'nm-ou');
  ok('a signed-out call is taken, and gets a voter cookie', r.status === 200 && anon.length === 24 && mine.mine.side === 'oklahoma' && mine.mine.label === 'OU -22.5', `${r.status} ${JSON.stringify(mine && mine.mine)}`);
  ok('...the cookie is HttpOnly', /HttpOnly/.test(r.headers.get('set-cookie')));
  ok('...and the split counts it', mine.total === 1 && mine.sides.find((s) => s.teamId === 'oklahoma').pct === 100);
  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify({ gameId: 'nm-ou', side: 'new-mexico' }) });
  mine = (await r.json()).games.find((g) => g.id === 'nm-ou');
  ok('changing a call moves it, not adds to it', mine.total === 1 && mine.sides.find((s) => s.teamId === 'new-mexico').votes === 1 && mine.sides.find((s) => s.teamId === 'oklahoma').votes === 0);
  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify({ gameId: 'nm-ou', side: 'new-mexico' }) });
  ok('the same call twice counts once', (await r.json()).games.find((g) => g.id === 'nm-ou').total === 1);
  for (const [bodyIn, want, name] of [
    [{ gameId: 'uga-ark', side: 'uga' }, 409, 'a game under way'],
    [{ gameId: 'nm-ou', side: 'texas' }, 400, 'a team not in the game'],
    [{ gameId: 'not-a-game', side: 'uga' }, 404, 'a game not on the board'],
    [{ gameId: '"><img>', side: 'uga' }, 400, 'a hostile id'],
  ]) {
    r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify(bodyIn) });
    ok(`refused: ${name} (${want})`, r.status === want, String(r.status));
  }
  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify({ gameId: 'lsu-om', side: 'lsu' }) });
  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify({ gameId: 'fsu-bama', side: 'alabama' }) });
  r = await fetch(B + '/api/crowd/vote', { method: 'POST', headers: A, body: JSON.stringify({ gameId: 'fsu-bama', side: null }) });
  ok('a call can be taken back', !(await r.json()).games.find((g) => g.id === 'fsu-bama').mine);

  // Ten more readers, nine on Oklahoma: the public side.
  for (let i = 0; i < 10; i++) {
    await fetch(B + '/api/crowd/vote', { method: 'POST', headers: J, body: JSON.stringify({ gameId: 'nm-ou', side: i < 9 ? 'oklahoma' : 'new-mexico' }) });
  }
  body = await (await fetch(B + '/api/crowd', { headers: A })).json();
  mine = body.games.find((g) => g.id === 'nm-ou');
  ok('with ten or more calls and 70% on one side, it is the public side', mine.total === 11 && mine.publicSide === 'oklahoma', `${mine.total} ${mine.publicSide}`);
  ok('...and the reader sees they are with the 18%', mine.sides.find((s) => s.teamId === 'new-mexico').pct === 18 && mine.mine.side === 'new-mexico');
  ok('the tally is stored as counters, not as who voted', Object.keys(bag.get('crowd/' + thisWeek)).every((k) => /^v__/.test(k)));
  ok('a voter\'s document carries no cookie or account', !JSON.stringify([...bag.entries()].filter(([k]) => k.startsWith('crowd-votes/'))).includes(anon));

  /* slip shares */
  for (let i = 0; i < 5; i++) bag.set(`user-state/reader-${i}`, { weekKey: thisWeek, updatedAt: new Date().toISOString(), slip: { 'ou-spread': { stake: 25, placed: i < 3 }, other: { placed: true } } });
  globalThis.__cfbSocial.reset();
  body = await (await fetch(B + '/api/crowd')).json();
  ok('slips: how many carry each card, from five slips', body.slips.slips === 5 && body.slips.counts['ou-spread'] === 3, JSON.stringify(body.slips));

  /* graded */
  console.log('\n-- graded calls and the record');
  slateBody = finalsRaw;
  globalThis.__cfbSocial.reset();
  body = await (await fetch(B + '/api/crowd', { headers: A })).json();
  ok('once final: UNM +22.5 in a 42-13 game is a loss, LSU -2.5 in a 31-28 loss is a loss', body.you.l === 2 && body.you.w === 0,
    JSON.stringify(body.you));
  ok('...the readers\' calls are graded together', body.readers.w === 9 && body.readers.l === 3, JSON.stringify(body.readers));
  ok('...and each game says who covered', body.games.find((g) => g.id === 'nm-ou').covered === 'oklahoma');

  r = await fetch(B + '/api/record/me', { headers: A });
  let me = await r.json();
  ok('a signed-out reader has a record from their calls', me.known === true && me.weeks.length === 1 && me.weeks[0].calls.l === 2, JSON.stringify(me).slice(0, 200));
  ok('...with "On the board" earned and "First win" not yet', me.badges.find((b) => b.id === 'first-call').earned && !me.badges.find((b) => b.id === 'first-win').earned);
  r = await fetch(B + '/api/record/me');
  me = await r.json();
  ok('someone who has never called has an empty record, all badges locked', me.known === false && me.badges.every((b) => !b.earned));

  /* the board's season */
  r = await fetch(B + '/api/record');
  body = await r.json();
  ok('the board\'s record is public', r.status === 200 && body.board.total.w === 2 && body.board.total.l === 2 && body.board.weeks[0].weekLabel !== undefined, JSON.stringify(body.board && body.board.total));

  /* signing in keeps the calls */
  console.log('\n-- signing in, and the slip');
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { email: 'fan@example.com', displayName: 'Erik Strong', createdAt: 'x' });
  const fan = h.session(SECRET, 'fan@example.com');
  r = await fetch(B + '/api/record/me', { headers: { cookie: `${fan}; cfb_v=${anon}` } });
  me = await r.json();
  ok('signing in brings the signed-out calls along', me.signedIn === true && me.weeks[0] && me.weeks[0].calls.l === 2, JSON.stringify(me.weeks[0] && me.weeks[0].calls));
  ok('...clears the voter cookie', /cfb_v=;/.test(r.headers.get('set-cookie') || ''));
  ok('...and the tally is unchanged', body && (await (await fetch(B + '/api/crowd', { headers: { cookie: fan } })).json()).games.find((g) => g.id === 'nm-ou').total === 11);

  // Last week's slip, still in user-state; this week's first save archives it.
  bag.set(`board/week-${prevWeek}`, PREV_BOARD);
  bag.set(`user-state/${uidOf('fan@example.com')}`, {
    weekKey: prevWeek, updatedAt: new Date(Date.parse(prevWeek + 'T20:00:00Z')).toISOString(),
    slip: { uga: { stake: 50, placed: true }, 'miss-ml': { stake: 20, placed: true }, lsu: { stake: 10, placed: true }, two: { stake: 10, placed: true } },
  });
  r = await fetch(B + '/api/slip', { method: 'PUT', headers: { ...J, cookie: fan }, body: JSON.stringify({ slip: { 'ou-spread': { stake: 25, placed: true } } }) });
  const archived = bag.get(`slip-history/${uidOf('fan@example.com')}__${prevWeek}`);
  ok('this week\'s first save keeps last week\'s slip', r.status === 200 && archived && archived.owner === uidOf('fan@example.com') && archived.slip.uga.placed === true);
  globalThis.__cfbSocial.reset();
  r = await fetch(B + '/api/record/me', { headers: { cookie: fan } });
  me = await r.json();
  const lastWk = me.weeks.find((w) => w.week === prevWeek);
  ok('last week\'s slip is graded from ESPN\'s finals, which are then kept', lastWk && lastWk.slip && lastWk.slip.w === 3 && lastWk.slip.l === 1 &&
    Array.isArray((bag.get('finals/' + prevWeek) || {}).games), JSON.stringify(lastWk && lastWk.slip && { w: lastWk.slip.w, l: lastWk.slip.l }));
  ok('...and earns its badges', ['upset', 'parlay', 'first-win'].every((id) => me.badges.find((b) => b.id === id).earned));
  // Last week's 3-1, plus this week's Oklahoma -22.5 (the slate is final here: 42-13).
  ok('...with the season adding up both weeks', me.season.slip.w === 4 && me.season.slip.l === 1 && me.season.slip.net > 0, JSON.stringify(me.season));
  lastBody = { events: [] };
  globalThis.__cfbSocial.reset();
  r = await fetch(B + '/api/record/me', { headers: { cookie: fan } });
  ok('a finished week is graded from the stored finals, not ESPN again', (await r.json()).weeks.find((w) => w.week === prevWeek).slip.w === 3);

  /* ---------------- brag cards ---------------- */
  console.log('\n-- brag cards');
  r = await fetch(B + '/api/brag', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ kind: 'week', weekKey: prevWeek }) });
  body = await r.json();
  ok('a week card is made, with a link and a picture', r.status === 200 && /^[A-Za-z0-9_-]{12}$/.test(body.id) && body.url.endsWith('/b/' + body.id) && body.image.endsWith('.png'), JSON.stringify(body));
  const page = await (await fetch(B + '/b/' + body.id)).text();
  ok('the link unfolds: og:image, twitter card', page.includes(`og:image" content="${B}/b/${body.id}.png`) && page.includes('summary_large_image'));
  let img = Buffer.from(await (await fetch(B + '/b/' + body.id + '.png')).arrayBuffer());
  ok('...and the picture is a PNG', PNG(img));
  const stored = bag.get('brags/' + body.id);
  ok('the card is frozen numbers, no account in it', stored && !JSON.stringify(stored).includes('fan@example.com') && !JSON.stringify(stored).includes(uidOf('fan@example.com')));
  r = await fetch(B + '/api/brag', { method: 'POST', headers: { ...J, cookie: fan }, body: JSON.stringify({ kind: 'season' }) });
  body = await r.json();
  ok('a season card too', r.status === 200 && PNG(Buffer.from(await (await fetch(body.image)).arrayBuffer())));
  r = await fetch(B + '/api/brag', { method: 'POST', headers: J, body: JSON.stringify({ kind: 'week' }) });
  ok('nothing to brag about is a 400, not an empty card', r.status === 400);
  for (const bad of ['/b/zzzzzzzzzzzz', '/b/short', '/b/zzzzzzzzzzzz.png', '/s/zzzzzzzzzz.png']) {
    r = await fetch(B + bad);
    ok(`unknown card ${bad} is a 404`, r.status === 404, String(r.status));
  }

  // A shared slip unfolds too.
  bag.set('shared-slips/abcdefghij', { items: [{ kind: 'straight', title: 'Georgia -24.5 <b>', odds: -110, stake: 25, toWin: 22.7, legs: [] }],
    totalRisk: 25, totalToWin: 22.7, weekKey: thisWeek, by: 'Erik', byKind: 'name', createdAt: new Date().toISOString() });
  const slipPage = await (await fetch(B + '/s/abcdefghij')).text();
  ok('a shared slip page carries its picture', slipPage.includes('/s/abcdefghij.png') && slipPage.includes('og:title'));
  ok('...escaped', !slipPage.includes('<b>'));
  img = Buffer.from(await (await fetch(B + '/s/abcdefghij.png')).arrayBuffer());
  ok('...which is a PNG', PNG(img));
  r = await fetch(B + '/s/nothere123');
  ok('an unknown shared slip still gets the page (it says so itself)', r.status === 200 && !(await r.text()).includes('og:image'));
  img = Buffer.from(await (await fetch(B + '/og.png')).arrayBuffer());
  ok('the app\'s own preview is a PNG', PNG(img));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
