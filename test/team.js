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
let lastParams = null;
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
      stream: (params) => { researchCalls++; lastParams = params; return { finalMessage: message }; },
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
  // The id is derived here from the matchup, never the model's own "id".
  ok('...and it landed where everyone reads it, under an id this app chose',
      Boolean(h.bag('college-football-app').get('games/x-at-y')) && !h.bag('college-football-app').get('games/x-y'),
      JSON.stringify([...h.bag('college-football-app').keys()].filter((k) => k.startsWith('games/'))));
  ok('...stamped with this week, so it leaves the Games tab next week',
      /^\d{4}-\d{2}-\d{2}$/.test((h.bag('college-football-app').get('games/x-at-y') || {}).weekKey || ''));

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

  // --- "Write every team page" (owner-only batch, 2026-11-24) --------------
  // A few pages per request, through the SAME researchTeamPage() a member's
  // Refresh uses, skipping pages refreshed in the last 7 days, under a $40 a
  // month guard. The page calls again until `remaining` is 0.
  reply = {
    rank: '#11', record: '3-1', confRecord: '1-0 Big Ten',
    nextGame: { opponent: 'at Ohio State', kickoffISO: '2026-10-03T16:00:00Z', tv: 'FOX' },
    schedule: [{ wk: 'Sep 5', opp: 'Fresno State', loc: 'home', result: 'W 30-10' }],
    storyline: ['A paragraph about the season.'],
  };
  const OWNER = { authorization: 'Basic ' + Buffer.from('erik:site-password-here-1').toString('base64') };
  const batch = (body, headers) => fetch(B + '/api/research/teams-batch', {
    method: 'POST', headers: { ...J, ...(headers || {}) }, body: JSON.stringify(body || {}),
  });
  const fanBag = h.bag('college-football-app');
  const DAY = 24 * 3600 * 1000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  // Every team fresh except five: three never written, two a week+ old.
  const ids = teams.TEAMS.map((t) => t.id);
  for (const id of ids) fanBag.set('fan/' + id, { record: 'fresh', schedule: [], storyline: [], lastChecked: ago(2 * DAY) });
  const missing = ids.slice(0, 3);
  const stale = ids.slice(3, 5);
  for (const id of missing) fanBag.delete('fan/' + id);
  for (const id of stale) fanBag.set('fan/' + id, { record: 'old', schedule: [], storyline: [], lastChecked: ago(8 * DAY) });
  fanBag.delete('control/teams-batch');

  let calls0 = researchCalls;
  r = await batch({});
  ok('writing every team page needs someone signed in (401)', r.status === 401, String(r.status));
  r = await batch({}, { cookie });
  ok('...and a member who is not the owner is refused (403)', r.status === 403, String(r.status));
  ok('...spending nothing', researchCalls === calls0, String(researchCalls - calls0));

  r = await batch({}, OWNER);
  let b = await r.json();
  ok('the owner may write every team page', r.status === 200, JSON.stringify(b).slice(0, 200));
  ok('...writing only the missing and the stale ones',
      JSON.stringify([...b.done].sort()) === JSON.stringify([...missing, ...stale].sort()), JSON.stringify(b.done));
  ok('...missing pages first', missing.every((id) => b.done.indexOf(id) > -1 && b.done.indexOf(id) < 5));
  ok('...one model call each', researchCalls === calls0 + 5, String(researchCalls - calls0));
  ok('...skipping every page refreshed in the last 7 days', b.skipped === ids.length - 5, String(b.skipped));
  ok('...untouched', fanBag.get('fan/' + ids[10]).record === 'fresh');
  ok('...with nothing left to do', b.remaining === 0 && b.written === ids.length, JSON.stringify([b.remaining, b.written]));
  ok('...each page written through validate()',
      [...missing, ...stale].every((id) => fanBag.get('fan/' + id).record === '3-1' && Date.now() - Date.parse(fanBag.get('fan/' + id).lastChecked) < 60000));
  ok('...by the same research as a team Refresh (same prompt, same budget)',
      lastParams && lastParams.max_tokens === 12000 && /^Research .+ for the \d{4} season\./.test(lastParams.messages[0].content)
      && /return ONE JSON object/.test(lastParams.system), JSON.stringify(lastParams && lastParams.max_tokens));
  const ctl = fanBag.get('control/teams-batch') || {};
  ok('...with its spend kept for the month in control/teams-batch',
      ctl.month === new Date().toISOString().slice(0, 7) && ctl.teams === 5 && ctl.usd > 0 && b.costUsd > 0,
      JSON.stringify(ctl));

  calls0 = researchCalls;
  r = await batch({}, OWNER);
  b = await r.json();
  ok('a second run with nothing stale spends nothing', b.remaining === 0 && b.done.length === 0 && researchCalls === calls0,
      JSON.stringify(b).slice(0, 200));

  // Remaining counts down across calls, n is bounded.
  const twenty = ids.slice(10, 30);
  for (const id of twenty) fanBag.set('fan/' + id, { record: 'old', schedule: [], storyline: [], lastChecked: ago(30 * DAY) });
  r = await batch({ n: 4 }, OWNER);
  b = await r.json();
  ok('a call writes the number asked for', b.done.length === 4, String(b.done.length));
  ok('...and says how many are left', b.remaining === 16 && b.written === ids.length - 16, JSON.stringify([b.remaining, b.written]));
  r = await batch({ n: 500 }, OWNER);
  b = await r.json();
  ok('...never more than 12 in one call', b.done.length === 12 && b.remaining === 4, JSON.stringify([b.done.length, b.remaining]));
  r = await batch({}, OWNER);
  b = await r.json();
  ok('...and the default call finishes the rest', b.done.length === 4 && b.remaining === 0, JSON.stringify([b.done.length, b.remaining]));

  // A bad answer is refused by validate(): the old page stays, and the team
  // is held back so the page's loop does not buy the same failure again.
  const bad = ids[40];
  fanBag.set('fan/' + bad, { record: 'kept', schedule: [], storyline: [], lastChecked: ago(9 * DAY) });
  reply = { schedule: [{ wk: 'Sep 5', loc: 'home' }] };
  r = await batch({}, OWNER);
  b = await r.json();
  ok('a page the model gets wrong is not written', b.failed.join() === bad && fanBag.get('fan/' + bad).record === 'kept',
      JSON.stringify(b).slice(0, 200));
  ok('...and is held back rather than counted as remaining', b.remaining === 0 && b.held === 1, JSON.stringify([b.remaining, b.held]));
  calls0 = researchCalls;
  r = await batch({}, OWNER);
  b = await r.json();
  ok('...so the next call does not buy the same failure', researchCalls === calls0 && b.remaining === 0, String(researchCalls - calls0));

  // The monthly guard.
  const month = new Date().toISOString().slice(0, 7);
  reply = { record: '3-1', schedule: [{ wk: 'Sep 5', opp: 'Fresno State', loc: 'home' }], storyline: ['x'] };
  fanBag.set('fan/' + ids[50], { record: 'old', schedule: [], storyline: [], lastChecked: ago(9 * DAY) });
  const held = (fanBag.get('control/teams-batch') || {}).failedAt;
  fanBag.set('control/teams-batch', { month, usd: 39.95, teams: 100, failedAt: held });
  calls0 = researchCalls;
  r = await batch({}, OWNER);
  b = await r.json();
  ok('the batch refuses (409) once another page could pass $40 this month', r.status === 409 && b.code === 'cap',
      String(r.status) + ' ' + JSON.stringify(b).slice(0, 160));
  ok('...spending nothing', researchCalls === calls0, String(researchCalls - calls0));
  ok('...and still says what is left', b.remaining === 1, String(b.remaining));
  fanBag.set('control/teams-batch', { month: '2000-01', usd: 39.95, teams: 100, failedAt: held });
  r = await batch({}, OWNER);
  b = await r.json();
  ok('...last month\'s spend does not count', r.status === 200 && b.done.join() === ids[50], String(r.status));
  ok('...and the month starts again from what this one spent',
      (fanBag.get('control/teams-batch') || {}).month === month && (fanBag.get('control/teams-batch') || {}).usd < 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
