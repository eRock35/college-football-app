// The 2026-09-26 audit, server half: stored XSS through ids and games
// documents, research jobs paying for finished games, the week boundary, the
// owner-only surface, privacy, caching headers, DraftKings links and the
// line-now. test/render.js is the page half.
const fs = require('fs');
const path = require('path');
const h = require('./harness.js');
h.install();

// The model, faked: one mutable reply, and every batch request recorded.
let reply = {};
let researchCalls = 0;
let batchCreated = null;
let batchResults = [];
require.cache['FAKE_AN'].exports = function () {
  const message = async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: JSON.stringify(reply) }] });
  return {
    messages: {
      create: message,
      stream: () => { researchCalls++; return { finalMessage: message }; },
      batches: {
        create: async (req) => { batchCreated = req; return { id: 'batch_1' }; },
        retrieve: async () => ({ processing_status: 'ended' }),
        results: async () => (async function* () { for (const r of batchResults) yield r; })(),
      },
    },
  };
};

// ESPN, faked: the Saturday-night fixture with New Mexico at Oklahoma moved
// three hours into the future (the one game on the board not yet kicked off),
// and a DraftKings link on it - plus a hostile one on another game.
const NOW = Date.now();
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'espn-live.json'), 'utf8'));
for (const e of raw.events) {
  const c = e.competitions[0];
  if (e.id === '401752705') {
    e.date = c.date = new Date(NOW + 3 * 3600 * 1000).toISOString();
    c.odds = [{ provider: { name: 'DraftKings' }, details: 'OU -22.5', overUnder: 46.5,
      link: { href: 'https://sportsbook.draftkings.com/event/new-mexico-%40-oklahoma/123?wpcid=abc&sid=9' } }];
  }
  if (e.id === '401752701') {
    c.odds = [{ provider: { name: 'ESPN BET' }, details: 'UGA -27.5', overUnder: 54.5,
      links: [{ href: 'https://evil.example/draftkings.com' }, { href: 'http://sportsbook.draftkings.com/x' }] }];
  }
}
const netFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.match(/^https:\/\/site(\.web)?\.api\.espn\.com\//) && /scoreboard/.test(u)) {
    return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
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
process.env.PORT = '9215';
require(path.join(__dirname, '..', 'server.js'));
const board = require(path.join(__dirname, '..', 'board.js'));
const games = require(path.join(__dirname, '..', 'games.js'));
const live = require(path.join(__dirname, '..', 'live.js'));
const LiveCore = require(path.join(__dirname, '..', 'public', 'live-core.js'));

const B = 'http://127.0.0.1:9215';
const J = { 'content-type': 'application/json' };
const CRON = { ...J, 'x-cron-key': 'cron-secret-value-here' };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const bag = h.bag('college-football-app');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const MARKUP = /[<>]|onerror|onfocus=|autofocus|"/;

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  /* ---------- 1. ids and markup ---------- */
  const seed = board.SEED;
  const hostile = board.validate({
    ...seed,
    games: [{ ...seed.games[0], id: 'q" autofocus onfocus="window.x=1" x="', label: 'A at B<img src=x onerror=alert(1)>' }, ...seed.games.slice(1)],
    picks: [{ ...seed.picks[0], id: 'Georgia/Spread' }, ...seed.picks.slice(1)],
    rankings: [{ rank: 1, team: 'Texas', gameId: '"><script>', dkUrl: 'javascript:alert(1)' }],
  });
  ok('every board id is [a-z0-9-]{1,60}', [...hostile.games, ...hostile.picks, ...hostile.parlays].every((r) => board.ID_RE.test(r.id)),
    hostile.games[0].id);
  ok('...a quote-breaking id is slugged, not kept', hostile.games[0].id === 'q-autofocus-onfocus-window-x-1-x', hostile.games[0].id);
  ok('...and a slash becomes a dash', hostile.picks[0].id === 'georgia-spread', hostile.picks[0].id);
  ok('a ranking row keeps no hostile gameId or link', hostile.rankings[0].gameId === 'script' || hostile.rankings[0].gameId === '', hostile.rankings[0].gameId);
  ok('...and no javascript: link', hostile.rankings[0].dkUrl === '');

  // 6. American odds inside -100..+100 are not odds.
  for (const bad of [-5, 50, '+99', -99.5, 0]) {
    let threw = false;
    try { board.validate({ ...seed, picks: [{ ...seed.picks[0], odds: bad }] }); } catch (e) { threw = /odds/.test(e.message); }
    ok(`board refuses odds ${bad}`, threw);
  }
  ok('board keeps -100 and +100', board.odds(-100) === -100 && board.odds('+100') === 100);

  // games.validate: the games collection's door.
  const g = games.validate({ label: 'Test at Probe<img src=x onerror="x()">', home: 'Probe', away: 'Test', tag: 'TOP25',
    pickConfidence: 11, summary: '<script>alert(1)</script>ok', why: 'x'.repeat(5000), pass: 'yes', id: 'a/b' }, {});
  ok('games.validate strips markup from every string', !/[<>]/.test(JSON.stringify(g)), JSON.stringify(g).slice(0, 120));
  ok('...bounds prose', g.why.length === 2000);
  ok('...enums the tag and bounds the confidence', g.tag === 'top25' && g.pickConfidence === null);
  ok('...a string "yes" is not a pass', g.pass === false);
  ok('...and the model\'s id is ignored', g.id !== 'a/b' && board.ID_RE.test(g.id), g.id);
  ok('an id is derived from the teams when both are known', games.idFor({ label: 'Georgia at Arkansas' }) === 'uga-arkansas', games.idFor({ label: 'Georgia at Arkansas' }));
  ok('...else from a slug of the matchup, never with a slash', games.idFor({ label: 'Foo U at Bar/Baz' }) === 'foo-u-at-bar-baz');
  let refused = false;
  try { games.validate({ label: '' }); } catch (e) { refused = true; }
  ok('a game with no label is refused', refused);

  // add-game: the model picks a "/" id and hands back markup.
  const member = h.session(SECRET, 'fan@example.com');
  h.bag('identity').set('users/' + uidOf('fan@example.com'), { email: 'fan@example.com', createdAt: 'x' });
  reply = { id: '../../etc/passwd', label: 'Kansas State at Arizona<img src=x onerror=alert(1)>', home: 'Arizona', away: 'Kansas State',
    kickoff: 'Sat 10:30p ET', tag: 'script', pick: 'K-State +3" onfocus="x', summary: 's' };
  let r = await fetch(B + '/api/research/add-game', { method: 'POST', headers: { ...J, cookie: member }, body: JSON.stringify({ query: 'kstate arizona' }) });
  let body = await r.json();
  ok('add-game with a slash id from the model does not 500', r.status === 200, r.status + ' ' + JSON.stringify(body));
  const stored = bag.get('games/' + body.id);
  ok('...stored under a derived id', body.id === 'kansas-state-arizona' && !!stored, body.id);
  ok('...with no markup anywhere', stored && !/[<>]/.test(JSON.stringify(stored)));
  ok('...and nothing written under the model\'s id', ![...bag.keys()].some((k) => k.includes('passwd')));
  reply = { summary: 'no label' };
  r = await fetch(B + '/api/research/add-game', { method: 'POST', headers: { ...J, cookie: member }, body: JSON.stringify({ query: 'nothing' }) });
  ok('an answer with no game is a 422 with a sentence, not a 500', r.status === 422 && !!(await r.json()).error, String(r.status));

  // A user-written slip and arrangement are cleaned before they are stored.
  r = await fetch(B + '/api/slip', { method: 'PUT', headers: { ...J, cookie: member }, body: JSON.stringify({
    slip: { 'ok-id': { stake: 25, placed: true }, 'x" onfocus="y': { stake: 1, placed: true }, 'neg': { stake: -5, placed: 'yes' } },
    customPicks: { 'ok-game': { title: 'A <img src=x onerror=1> -3', odds: 5 }, 'bad"id': { title: 'x' } },
    board: { hidden: ['fine-id', '"><img>'], pinned: ['a"b'], order: [], own: [{ id: 'own-1" x="', title: 'Mine', odds: -110, gameId: '"><b>' }] },
  }) });
  const saved = bag.get('user-state/' + uidOf('fan@example.com'));
  ok('slip keys outside the id alphabet are dropped', Object.keys(saved.slip).join() === 'ok-id,neg', Object.keys(saved.slip).join());
  ok('...placed is a real boolean and a stake is never negative', saved.slip.neg.placed === false && saved.slip.neg.stake === 0);
  ok('custom picks are cleaned (keys, markup, odds)', Object.keys(saved.customPicks).join() === 'ok-game' &&
    !/[<>]/.test(saved.customPicks['ok-game'].title) && saved.customPicks['ok-game'].odds === -110, JSON.stringify(saved.customPicks));
  ok('arrangement ids outside the alphabet are dropped', saved.board.hidden.join() === 'fine-id' && saved.board.pinned.length === 0);
  ok('an own card\'s id and gameId are slugged', board.ID_RE.test(saved.board.own[0].id) && (saved.board.own[0].gameId === '' || board.ID_RE.test(saved.board.own[0].gameId)), JSON.stringify(saved.board.own[0]));

  /* ---------- 2. research only this week's games that have not kicked off ---------- */
  const week = board.weekKeyAt(NOW);
  bag.set('board/current', { ...board.seed(), weekKey: week, generatedAt: new Date(NOW - 86400000).toISOString() });
  // Last week's legacy documents, which nothing ever retired.
  bag.set('games/uga-ark-old', { label: 'Georgia at Kentucky', home: 'Kentucky', away: 'Georgia', summary: 'last week', lastChecked: new Date().toISOString() });
  bag.set('games/lastweek-x', { label: 'Army at Navy', weekKey: '2020-01-07', summary: 'old' });

  researchCalls = 0;
  reply = { updates: [
    { id: 'nm-ou', market: 'OU -22.5', pick: 'Oklahoma -22.5', pickConfidence: 3, summary: 'Mateer<script>', why: 'w' },
    { id: 'uga-ark', summary: 'a game that has kicked off must not be written' },
    { id: 'made-up', summary: 'a game nobody sent' },
  ], summary: 'One change.' };
  r = await fetch(B + '/api/research/refresh-board', { method: 'POST', headers: CRON });
  body = await r.json();
  // Two: New Mexico at Oklahoma, and the game added above this week (no
  // scoreboard entry, a Saturday 10:30 PM kickoff by its own label).
  const addedUpcoming = Date.parse(games.kickoffFor('Sat 10:30p ET', week)) > Date.now();
  const expectIds = addedUpcoming ? 'kansas-state-arizona,nm-ou' : 'nm-ou';
  ok('the Saturday sweep researched only the games not yet kicked off', body.researched === expectIds.split(',').length && researchCalls === 1, JSON.stringify(body));
  ok('...and says how many it skipped', body.finished >= 8, String(body.finished));
  ok('...wrote the one it sent', !!bag.get('games/nm-ou') && bag.get('games/nm-ou').weekKey === week);
  ok('...cleaned', !/[<>]/.test(bag.get('games/nm-ou').summary));
  ok('...and nothing for a game that has started or a game nobody sent', !bag.get('games/uga-ark') && !bag.get('games/made-up'));

  batchCreated = null;
  r = await fetch(B + '/api/research/batch-submit', { method: 'POST', headers: CRON });
  body = await r.json();
  ok('the weekday batch submits only this week\'s upcoming games', batchCreated &&
    batchCreated.requests.map((q) => q.custom_id).sort().join() === expectIds, JSON.stringify(body));
  ok('...never last week\'s legacy documents', !JSON.stringify(batchCreated).includes('Kentucky') && !JSON.stringify(batchCreated).includes('Navy'));

  batchResults = [
    { custom_id: 'nm-ou', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ changed: true, summary: 'Late news<img src=x>', pick: 'Oklahoma -21', pickConfidence: 9 }) }] } } },
    { custom_id: '../x', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{"summary":"x"}' }] } } },
  ];
  r = await fetch(B + '/api/research/batch-collect', { method: 'POST', headers: CRON });
  body = await r.json();
  ok('batch-collect writes the game it sent, cleaned', body.updated === 1 && bag.get('games/nm-ou').pick === 'Oklahoma -21' &&
    !/[<>]/.test(bag.get('games/nm-ou').summary), JSON.stringify(body));
  ok('...refuses a custom_id this app never sends', body.failed === 1 && !bag.get('games/../x'));

  // A board from last week: nothing to research, and no model call.
  bag.set('board/current', { ...board.seed(), weekKey: '2020-01-07' });
  researchCalls = 0;
  r = await fetch(B + '/api/research/refresh-board', { method: 'POST', headers: CRON });
  body = await r.json();
  ok('a stale board is researched not at all', !!body.skipped && researchCalls === 0, JSON.stringify(body));
  bag.delete('control/batch');
  batchCreated = null;
  r = await fetch(B + '/api/research/batch-submit', { method: 'POST', headers: CRON });
  ok('...and no batch is submitted for it', batchCreated === null && !!(await r.json()).skipped);

  // The Games tab reads this week only.
  bag.set('board/current', { ...board.seed(), weekKey: week });
  const list = await (await fetch(B + '/api/games')).json();
  ok('/api/games is this week\'s board games', list.length >= 9 && list.some((x) => x.id === 'nm-ou'), String(list.length));
  ok('...without last week\'s legacy documents', !list.some((x) => /Kentucky|Navy/.test(x.label)));
  ok('...each marked started or not', list.find((x) => x.id === 'uga-ark').started === true && list.find((x) => x.id === 'nm-ou').started === false);
  ok('...with no markup', !/[<>]/.test(JSON.stringify(list)));

  /* ---------- 3. one week, turning over at 6 AM Eastern Sunday ---------- */
  const at = (s) => board.weekKeyAt(Date.parse(s));
  ok('Saturday night is this week', at('2026-09-27T03:30:00Z') === '2026-09-22');
  ok('1 AM Sunday Eastern (a late game on) is still this week', at('2026-09-27T05:00:00Z') === '2026-09-22');
  ok('7 AM Sunday Eastern is next week', at('2026-09-27T11:00:00Z') === '2026-09-29');
  ok('Monday and Tuesday are next week', at('2026-09-28T16:00:00Z') === '2026-09-29' && at('2026-09-29T16:00:00Z') === '2026-09-29');
  ok('across the November clock change', at('2026-11-01T10:30:00Z') === '2026-10-27' && at('2026-11-01T12:00:00Z') === '2026-11-03');

  // A slip saved under the old Tuesday week on a Sunday is still readable
  // (read by when it was saved).
  const owner = h.session(SECRET, 'owner@example.com');
  h.bag('identity').set('users/' + uidOf('owner@example.com'), { email: 'owner@example.com', createdAt: 'x' });
  bag.set('user-state/' + uidOf('owner@example.com'), { weekKey: 'old-tuesday-scheme', slip: { 'a-pick': { stake: 5, placed: true } },
    updatedAt: new Date(NOW - 60000).toISOString() });
  body = await (await fetch(B + '/api/slip', { headers: { cookie: owner } })).json();
  ok('a slip is read by the week it was saved in, whatever key it carries', !!body.slip['a-pick'], JSON.stringify(body.slip));
  bag.set('user-state/' + uidOf('owner@example.com'), { weekKey: week, slip: { 'a-pick': { stake: 5, placed: true } },
    updatedAt: new Date(NOW - 8 * 86400000).toISOString() });
  body = await (await fetch(B + '/api/slip', { headers: { cookie: owner } })).json();
  ok('...and one saved last week is not', !body.slip['a-pick']);

  /* ---------- 5. owner-only, and no browser password box ---------- */
  for (const [m, u] of [['POST', '/api/research/refresh-board'], ['POST', '/api/research/custom'], ['GET', '/api/asks'],
    ['POST', '/api/chat'], ['GET', '/api/login'], ['POST', '/api/research/add-game'], ['GET', '/api/slip']]) {
    r = await fetch(B + u, { method: m, headers: J, body: m === 'POST' ? '{}' : undefined });
    const type = r.headers.get('content-type') || '';
    ok(`${m} ${u} refuses a stranger with JSON and no WWW-Authenticate`,
      (r.status === 401 || r.status === 403) && !r.headers.get('www-authenticate') && type.includes('json'), `${r.status} ${r.headers.get('www-authenticate')} ${type}`);
  }
  r = await fetch(B + '/api/login?prompt=1');
  ok('only /api/login?prompt=1, typed by the owner, raises the Basic prompt', r.status === 401 && /Basic/.test(r.headers.get('www-authenticate') || ''));
  r = await fetch(B + '/api/research/refresh-board', { method: 'POST', headers: { ...J, cookie: member } });
  ok('a signed-in member who is not the owner gets 403 JSON', r.status === 403 && !r.headers.get('www-authenticate'));

  let st = await (await fetch(B + '/api/auth/status')).json();
  ok('status tells a stranger they may not research', st.canResearch === false);
  st = await (await fetch(B + '/api/auth/status', { headers: { cookie: member } })).json();
  ok('...nor a member', st.canResearch === false && st.signedInAnywhere === true);
  st = await (await fetch(B + '/api/auth/status', { headers: { cookie: owner } })).json();
  ok('...but the owner may', st.canResearch === true);
  st = await (await fetch(B + '/api/auth/status', { headers: { authorization: 'Basic ' + Buffer.from('erik:site-password-here-1').toString('base64') } })).json();
  ok('...and so may the site password', st.canResearch === true);

  /* ---------- 10. privacy ---------- */
  bag.set('asks/a1', { query: 'the owner\'s private question', askedAt: new Date().toISOString() });
  r = await fetch(B + '/api/asks');
  ok('/api/asks is closed to strangers', r.status === 401);
  r = await fetch(B + '/api/asks', { headers: { cookie: member } });
  ok('...and to members', r.status === 403);
  r = await fetch(B + '/api/asks', { headers: { cookie: owner } });
  ok('...and open to the owner', r.status === 200 && JSON.stringify(await r.json()).includes('private question'));

  /* ---------- 9. caching, compression, proxy ---------- */
  r = await fetch(B + '/api/teams');
  ok('/api/teams is cacheable for a day', /max-age=86400/.test(r.headers.get('cache-control') || ''));
  r = await fetch(B + '/api/board');
  ok('/api/board is cacheable briefly', /max-age=60\b/.test(r.headers.get('cache-control') || ''));
  r = await fetch(B + '/', { headers: { 'accept-encoding': 'gzip' } });
  ok('the page is compressed', (r.headers.get('content-encoding') || '') === 'gzip');

  /* ---------- DraftKings links ---------- */
  ok('dkUrl keeps an https draftkings.com link, minus its query', LiveCore.dkUrl('https://sportsbook.draftkings.com/event/1?wpcid=x#y') === 'https://sportsbook.draftkings.com/event/1');
  for (const bad of ['http://sportsbook.draftkings.com/x', 'https://draftkings.com.evil.com/', 'https://evil.com@sportsbook.draftkings.com/',
    'https://xdraftkings.com/', 'javascript:alert(1)', 'https://sportsbook.draftkings.com/a"onclick=1', 'https://sportsbook.draftkings.com:444/', 42, null]) {
    ok(`dkUrl refuses ${JSON.stringify(bad)}`, LiveCore.dkUrl(bad) === '');
  }
  // The 2026 feed's real shape (measured 2026-09-26): DraftKings' gateway
  // redirect, with the event page in `preurl`, on each market's sides.
  const GATEWAY = 'https://sportsbook.draftkings.com/gateway?s=__s__&wpcid=__wpcid__&wpsrc=413&wpcn=ESPN&wpscn=Widget&wpcrn=BetSlipDeepLink&wpscid=__wpscid__&wpcrid=xx&preurl=https%3A%2F%2Fsportsbook.draftkings.com%2Fevent%2F34674758%3Foutcomes%3D0ML86319052_1';
  ok('a gateway link is unwrapped to the event page it redirects to', LiveCore.dkUrl(GATEWAY) === 'https://sportsbook.draftkings.com/event/34674758', LiveCore.dkUrl(GATEWAY));
  for (const bad of ['https://sportsbook.draftkings.com/gateway?s=1', 'https://sportsbook.draftkings.com/gateway?preurl=https%3A%2F%2Fevil.com%2Fx',
    'https://sportsbook.draftkings.com/gateway?preurl=https%3A%2F%2Fsportsbook.draftkings.com%2Fgateway%3Fpreurl%3Dx', 'https://sportsbook.draftkings.com/gateway?preurl=%E0%A4%A']) {
    ok(`...and a gateway going nowhere good is no link: ${bad.slice(52, 110)}`, LiveCore.dkUrl(bad) === '');
  }
  const realOdds = [{ provider: { id: '100', name: 'Draft Kings', logos: [{ href: 'https://a.espncdn.com/i/betting/Draftkings_Light.svg' }] },
    details: 'UGA -10.5', moneyline: { home: { close: { odds: '-395', link: { href: GATEWAY } } } } }];
  const foundDk = require(path.join(__dirname, '..', 'live.js')).dkUrlFromOdds(realOdds);
  ok('the link is found where the feed puts it, on a market side', foundDk === 'https://sportsbook.draftkings.com/event/34674758', foundDk);
  ok('dkLink falls back to the college football page', LiveCore.dkLink({ url: 'https://evil.example/' }).href === 'https://sportsbook.draftkings.com/leagues/football/ncaaf');
  ok('...and says the line when there is one', LiveCore.dkLink({ line: 'Georgia -24.5' }).text === 'Georgia -24.5 on DraftKings ↗');
  ok('escaped, a link cannot break its attribute', !/"/.test(LiveCore.esc(LiveCore.dkLink({ line: '"><img>' }).text)));
  const feedBoard = await (await fetch(B + '/api/board')).json();
  ok('the board carries the feed\'s DraftKings deep link for a game that has one',
    feedBoard.feed && feedBoard.feed['nm-ou'] && feedBoard.feed['nm-ou'].dkUrl === 'https://sportsbook.draftkings.com/event/new-mexico-%40-oklahoma/123', JSON.stringify(feedBoard.feed && feedBoard.feed['nm-ou']));
  ok('...and none for a game whose links are not https draftkings.com', feedBoard.feed['uga-ark'] && feedBoard.feed['uga-ark'].dkUrl === '');

  /* ---------- A. the line now, beside the line picked ---------- */
  const slipResp = await (await fetch(B + '/api/live/slip', { method: 'POST', headers: J, body: JSON.stringify({ items: [],
    cards: [{ id: 'georgia-spread', kind: 'straight', title: 'Georgia -24.5', matchup: 'Georgia at Arkansas', market: 'Spread · Georgia -24.5' },
            { id: 'ou', kind: 'straight', title: 'Oklahoma -20.5', matchup: 'New Mexico at Oklahoma', market: 'Spread' },
            { id: 'tot', kind: 'straight', title: 'Over 44.5', matchup: 'New Mexico at Oklahoma', market: 'Total' }] }) })).json();
  const byId = Object.fromEntries((slipResp.cards || []).map((c) => [c.id, c]));
  ok('a card gets its live status without being on the slip', byId['georgia-spread'] && byId['georgia-spread'].state === 'live', JSON.stringify(byId['georgia-spread']));
  ok('...and the slip is not ordered by it', !(slipResp.games || []).some((x) => x.mine === 'slip'));
  ok('picked -24.5, closed -27.5: beat the close', byId['georgia-spread'].lineNow && byId['georgia-spread'].lineNow.now === -27.5 && byId['georgia-spread'].lineNow.better === true,
    JSON.stringify(byId['georgia-spread'].lineNow));
  ok('picked -20.5 with the market at -22.5: better than now', byId.ou.lineNow && byId.ou.lineNow.better === true && byId.ou.state === 'pre');
  ok('over 44.5 with the total at 46.5: better than now', byId.tot.lineNow && byId.tot.lineNow.kind === 'total' && byId.tot.lineNow.better === true);
  const fakeGame = { home: { teamId: 'arkansas', abbr: 'ARK' }, away: { teamId: 'uga', abbr: 'UGA' }, line: 'ZZZ -3', overUnder: null };
  ok('a feed line naming neither team is not guessed at', live.lineNow({ type: 'spread', teamId: 'uga', line: -3 }, fakeGame) === null);
  ok('the underdog side reads the line flipped', live.lineNow({ type: 'spread', teamId: 'arkansas', line: 27.5 }, { ...fakeGame, line: 'UGA -24.5' }).now === 24.5);

  /* ---------- B. last week graded from ESPN's finals ---------- */
  const finalsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'espn-finals.json'), 'utf8'));
  let finalsAsked = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const m = /&dates=(\d{8})/.exec(u);
    if (u.match(/^https:\/\/site(\.web)?\.api\.espn\.com\//) && m) {
      finalsAsked.push(m[1]);
      // Every final is a Saturday game in this fixture: answer on Saturday only.
      const body = m[1] === '20260926' ? finalsRaw : { events: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return before(url, opts);
  };
  const lastWeek = board.seed();
  lastWeek.weekKey = '2026-09-22';
  // One pick ESPN cannot settle: a team total is not a full-game market.
  lastWeek.picks.push({ ...lastWeek.picks[0], id: 'team-total', title: 'Georgia team total over 40.5', market: 'Team total' });
  bag.set('board/current', lastWeek);
  reply = {
    results: [{ id: 'team-total', title: 'Georgia team total over 40.5', outcome: 'win', finalScore: 'Georgia 45, Arkansas 17', note: 'model' },
              { id: 'georgia-spread', title: 'x', outcome: 'loss', note: 'the model disagreeing with ESPN must lose' }],
    games: [{ id: 'n1', label: 'Next at Week', time: 'Sat 3:30p ET' }],
    picks: [{ id: 'np1', title: 'Week -3.5', matchup: 'Next at Week', market: 'Spread', odds: -110 }],
    parlays: [],
  };
  researchCalls = 0;
  r = await fetch(B + '/api/research/weekly-board?force=1', { method: 'POST', headers: CRON });
  body = await r.json();
  const built = bag.get('board/current');
  const res = Object.fromEntries((built.results || []).map((x) => [x.id, x]));
  ok('the weekly rebuild asks ESPN for Thursday, Friday and Saturday of last week', finalsAsked.join() === '20260924,20260925,20260926', finalsAsked.join());
  ok('Georgia -24.5 in a 45-17 game: graded a win from the final, not by the model', res['georgia-spread'] && res['georgia-spread'].outcome === 'win' &&
    res['georgia-spread'].source === 'espn' && /Georgia 45, Arkansas 17/.test(res['georgia-spread'].finalScore), JSON.stringify(res['georgia-spread']));
  ok('Under 58.5 in LSU 28, Ole Miss 31: a loss', res['lsu-om-under'] && res['lsu-om-under'].outcome === 'loss');
  ok('a parlay is graded leg by leg', res['blowout-board'] && res['blowout-board'].outcome === 'win', JSON.stringify(res['blowout-board']));
  ok('only what ESPN could not settle goes to the model', res['team-total'] && res['team-total'].source === '' && res['team-total'].outcome === 'win');
  ok('...and the model cannot overrule a final', res['georgia-spread'].outcome === 'win');
  globalThis.fetch = before;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
