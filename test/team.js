// My Team: the tab that used to be Georgia, hardcoded.
//
// The thing worth testing is not that a dropdown works. It is the shape that
// makes 132 teams affordable: a team's page is cached under `fan/<id>` and
// SHARED, so cost scales with teams in use rather than with users, and an
// unknown id can never become a Firestore document key.
const h = require('./harness.js');
h.install();

// One mutable reply, read on every call. The server builds its Anthropic
// client once at startup, so swapping require.cache later does nothing - a
// mistake that made two assertions pass for the wrong reason before this.
let researchCalls = 0;
let reply = {
  rank: '#11', record: '3-1', confRecord: '1-0 Big Ten',
  nextGame: { opponent: 'at Ohio State', kickoffISO: '2026-10-03T16:00:00Z', tv: 'FOX' },
  schedule: [{ wk: 'Sep 5', opp: 'Fresno State', loc: 'home', result: 'W 30-10' },
             { wk: 'Oct 3', opp: 'at Ohio State', loc: 'away', current: true, ranked: true }],
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
      // identity.meter() wraps both, so both must exist or the app does not boot.
      create: message,
      // Counted HERE, not in finalMessage(): meter() calls finalMessage() to
      // price the call and the caller calls it again, and on the real SDK both
      // resolve the same single request. Counting the resolutions would have
      // reported two API calls for every one that happened.
      stream: () => { researchCalls++; return { finalMessage: message }; },
    },
    batches: {},
  };
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
process.env.PASSKEY_RP_ID = 'strongtechnicalconsulting.com';
process.env.PORT = '9209';
require(require('path').join(__dirname, '..', 'server.js'));
const teams = require(require('path').join(__dirname, '..', 'teams.js'));

const B = 'http://127.0.0.1:9209';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const send = (m, p, b, c) => fetch(B + p, {
  method: m, headers: c ? { ...J, cookie: c } : J,
  body: b === undefined ? undefined : JSON.stringify(b),
});
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  // --- the picker ----------------------------------------------------------
  let r = await send('GET', '/api/teams');
  const list = await r.json();
  ok('the team list is open to anyone', r.status === 200, String(r.status));
  const all = list.conferences.flatMap((c) => c.teams);
  ok('...and carries every FBS team', all.length === teams.TEAMS.length, String(all.length));
  ok('...grouped, because 132 names is not a list anyone scans', list.conferences.length > 5);
  ok('...with Georgia still the default', list.default === 'uga', list.default);
  ok('...and a colour per team, for the tab chrome', all.every((t) => /^#[0-9A-Fa-f]{6}$/.test(t.color)));

  // --- an unknown id never becomes a document key --------------------------
  // Without this, a typo in a URL creates a `fan/<junk>` row nothing cleans up
  // - and a path separator in one would not stay inside the collection.
  for (const junk of ['../evil', 'not-a-team', 'Georgia Bulldogs']) {
    const bad = await send('GET', `/api/fan/${encodeURIComponent(junk)}`);
    ok(`an unknown team id is a 404, not a new document (${junk || 'empty'})`,
        bad.status === 404, String(bad.status));
  }

  // --- reading a team is open, and honest about being empty ----------------
  r = await send('GET', '/api/fan/michigan');
  let page = await r.json();
  ok('an unresearched team reads back fine', r.status === 200, String(r.status));
  ok('...and says it has never been looked up', page.researched === false);
  ok('...rather than inventing a season', !page.schedule);
  ok('...but still names the team, so the tab can be drawn', page.meta.name === 'Michigan');

  // --- researching costs credit, so it needs an account --------------------
  const anon = await send('POST', '/api/fan/michigan/research');
  ok('researching a team needs an account', anon.status === 401, String(anon.status));
  ok('...and nothing was spent doing it', researchCalls === 0, String(researchCalls));

  const cookie = jar(await send('POST', '/api/id/register',
    { email: 'fan@example.com', password: 'a-long-password-1' }));

  // A plain member, NOT on the research allowlist. This is the point of the
  // change: research used to be the owner's alone.
  r = await send('POST', '/api/fan/michigan/research', {}, cookie);
  page = await r.json();
  ok('a member who is not the owner may research their own team',
      r.status === 200, JSON.stringify(page).slice(0, 160));
  ok('...and it cost exactly one model call', researchCalls === 1, String(researchCalls));
  ok('...and the page came back filled in', page.record === '3-1' && page.schedule.length === 2);
  ok('...marked as researched', page.researched === true && page.cached === false);

  // --- the cache is the whole economics ------------------------------------
  // The second fan of a team pays nothing. Without this, cost scales with
  // users rather than with teams, and 132 teams is a bill rather than a list.
  const second = jar(await send('POST', '/api/id/register',
    { email: 'fan2@example.com', password: 'a-long-password-2' }));
  r = await send('POST', '/api/fan/michigan/research', {}, second);
  const again = await r.json();
  ok('the next person to ask for that team is served the cache', again.cached === true);
  ok('...spending nothing', researchCalls === 1, String(researchCalls));

  // --- a bad research run leaves the good page standing --------------------
  // validate() runs on the PROPOSAL. Without that, one bad run replaces a good
  // page with a broken tab that needs a deploy to fix.
  reply = { schedule: [{ wk: 'Sep 5', loc: 'home' }] };   // a row with no opponent
  const bag = h.bag('college-football-app');
  const stored = bag.get('fan/michigan');
  bag.set('fan/michigan', { ...stored, lastChecked: '2020-01-01T00:00:00.000Z' });
  const before = researchCalls;
  r = await send('POST', '/api/fan/michigan/research', {}, cookie);
  ok('a stale page IS re-researched', researchCalls === before + 1, String(researchCalls - before));
  ok('...a run that returns junk fails', r.status >= 400, String(r.status));
  ok('...and the last good page is still there',
      (bag.get('fan/michigan') || {}).record === '3-1',
      JSON.stringify(bag.get('fan/michigan')));

  // --- the choice is durable, not weekly -----------------------------------
  // The slip resets every Tuesday. A team is not a weekly decision, so it
  // lives somewhere that does not get handed back empty.
  r = await send('PUT', '/api/prefs', { team: 'michigan' }, cookie);
  ok('a member saves their team', r.status === 200, String(r.status));
  r = await send('GET', '/api/prefs', undefined, cookie);
  ok('...and gets it back', (await r.json()).team === 'michigan');
  r = await send('PUT', '/api/prefs', { team: '../evil' }, cookie);
  ok('an unknown team is refused rather than stored', r.status === 400, String(r.status));

  // --- adding a game the board missed --------------------------------------
  // This was the owner's alone. The result lands in the SHARED games
  // collection, so one member paying to cover a game covers it for everyone.
  reply = { id: 'x-y', label: 'X at Y', home: 'Y', away: 'X', kickoff: 'Sat 3:30p ET',
            tag: 'interesting', market: 'Y -3 (-110)', pick: 'Y -3', pickConfidence: 3,
            summary: 'A sentence.', why: 'A paragraph.' };
  const noAccount = await send('POST', '/api/research/add-game', { query: 'X at Y' });
  ok('adding a game needs an account', noAccount.status === 401, String(noAccount.status));

  r = await send('POST', '/api/research/add-game', { query: 'X at Y' }, cookie);
  ok('a member who is not the owner may add a game', r.status === 200, String(r.status));
  ok('...and it landed where everyone reads it',
      Boolean(h.bag('college-football-app').get('games/x-y')),
      JSON.stringify(h.bag('college-football-app').get('games/x-y')));

  // --- the Top 25 ----------------------------------------------------------
  const board = require(require('path').join(__dirname, '..', 'board.js'));
  const withPoll = board.validate({
    ...board.SEED,
    rankings: [
      { rank: 3, team: 'Notre Dame', record: '3-0', game: 'vs Michigan State' },
      { rank: 1, team: 'Texas', record: '3-0' },
      { rank: 3, team: 'Second At Three', record: '0-0' },
    ],
  });
  ok('the poll comes back in rank order', withPoll.rankings.map((x) => x.rank).join(',') === '1,3',
      withPoll.rankings.map((x) => x.rank).join(','));
  ok('...with a second team at one rank dropped', withPoll.rankings.length === 2);
  ok('...and a bye is a row with no game', withPoll.rankings[0].game === '');
  for (const bad of [{ rank: 0 }, { rank: 26 }, { rank: '#3' }, {}]) {
    let threw = false;
    try { board.validate({ ...board.SEED, rankings: [{ team: 'T', ...bad }] }); } catch (e) { threw = true; }
    ok(`a poll position of ${JSON.stringify(bad.rank)} is refused`, threw);
  }
  ok('a board with no poll is still a board', board.validate(board.SEED).rankings.length === 0);

  // --- arranging the board -------------------------------------------------
  // Per reader, week-scoped, carried on the slip so it follows them between
  // devices and expires with the board it arranged.
  r = await send('PUT', '/api/slip', {
    slip: {}, customPicks: {}, bankroll: '',
    board: {
      hidden: ['msu-nd'], pinned: ['lsu-om'], order: ['lsu-om', 'msu-nd'],
      own: [{ id: 'own-1', title: 'Vandy +17.5 <script>', matchup: 'Vanderbilt at Alabama',
              market: 'Spread', odds: '-105', thesis: 'Backdoor cover machine.',
              gameId: 'vandy-bama', time: 'Sat 7:00p ET' },
            { title: '' },
            { title: 'No price', odds: '' },
            { title: 'Silly price', odds: '3' },
            { title: 'Made-up market', odds: -110, market: 'Vibes' }],
    },
  }, cookie);
  ok('an arrangement saves with the slip', r.status === 200, String(r.status));

  r = await send('GET', '/api/slip', undefined, cookie);
  const back = await r.json();
  ok('...and comes back', back.board.hidden[0] === 'msu-nd' && back.board.pinned[0] === 'lsu-om');
  ok('...with the order intact', back.board.order.join(',') === 'lsu-om,msu-nd');
  // A card has to be stakeable to be a card: a title AND a real American
  // price. The two without one are notes, and drawing them would give the
  // reader a stake box whose payout is NaN with nothing to explain it.
  // A card has to be stakeable: a title AND a real American price. The one
  // with no title and the two with no usable price are notes, not cards. A
  // made-up MARKET is not disqualifying - it normalises to Other.
  ok('...keeping only the cards that can actually be staked', back.board.own.length === 2,
      JSON.stringify(back.board.own.map((c) => c.title)));
  ok('...dropping a price that is not an American price', 
      !back.board.own.some((c) => c.title === 'Silly price' || c.title === 'No price'),
      JSON.stringify(back.board.own.map((c) => c.title)));
  ok('...with the price stored as a number, not as typed', back.board.own[0].odds === -105,
      JSON.stringify(back.board.own[0].odds));
  ok('...and the slate game it is about', back.board.own[0].gameId === 'vandy-bama');
  // These are drawn straight into innerHTML, same as every other card.
  ok('...with angle brackets stripped from what the reader typed',
      back.board.own[0].title === 'Vandy +17.5 script', back.board.own[0].title);

  // Unbounded arrays here are a way to make your own board unopenable.
  r = await send('PUT', '/api/slip', {
    slip: {}, customPicks: {}, bankroll: '',
    board: { hidden: new Array(500).fill('x'), own: new Array(100).fill({ title: 'a' }) },
  }, cookie);
  r = await send('GET', '/api/slip', undefined, cookie);
  const capped = (await r.json()).board;
  ok('a huge arrangement is capped rather than stored', capped.hidden.length === 200, String(capped.hidden.length));
  // Those 100 all had a title and no price, so none of them is a card.
  ok('...and priceless cards are dropped rather than drawn', capped.own.length === 0, String(capped.own.length));

  // A market the board does not know becomes Other rather than whatever was
  // typed, so a card can be read beside a researched one.
  r = await send('PUT', '/api/slip', { slip: {}, customPicks: {}, bankroll: '',
    board: { own: [{ title: 'A bet', odds: -110, market: 'Vibes' }] } }, cookie);
  r = await send('GET', '/api/slip', undefined, cookie);
  ok('an unknown market is normalised, not stored',
      (await r.json()).board.own[0].market === 'Other');

  // Rubbish in the shape must not become a rendered card.
  r = await send('PUT', '/api/slip', {
    slip: {}, customPicks: {}, bankroll: '',
    board: { hidden: 'not-an-array', pinned: [1, null, 'ok'], own: 'nope' },
  }, cookie);
  r = await send('GET', '/api/slip', undefined, cookie);
  const junk = (await r.json()).board;
  ok('a non-array arrangement reads back empty, not broken',
      Array.isArray(junk.hidden) && junk.hidden.length === 0 && Array.isArray(junk.own));
  ok('...and non-string ids are dropped', junk.pinned.join(',') === 'ok', junk.pinned.join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
