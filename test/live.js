// The live layer: scores from an unofficial feed, and what they mean for a
// slip.
//
// What is worth pinning down here is not that a scoreboard draws. It is that
// the feed is treated as hostile, that a pick is matched to a game only when
// the match is certain (an unmatched pick shows nothing; a mismatched one would
// show a confident wrong answer), that the betting arithmetic is right at the
// half points and the pushes, and that any number of viewers cost one upstream
// fetch per 20 seconds.
const path = require('path');
const fs = require('fs');
const h = require('./harness.js');
h.install();

let modelCalls = 0;
require.cache['FAKE_AN'].exports = function () {
  const message = async () => { modelCalls++; return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{}' }] }; };
  return { messages: { create: message, stream: () => ({ finalMessage: message }) }, batches: {} };
};

process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'cfb-secret-abcdefghijklmnopq';
process.env.SITE_LOGIN_USERNAME = 'erik';
process.env.SITE_LOGIN_PASSWORD = 'site-password-here-1';
process.env.RESEARCH_ALLOWED_EMAILS = 'owner@example.com';
process.env.FIRESTORE_DATABASE_ID = 'college-football-app';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9213';

const ROOT = path.join(__dirname, '..');
const live = require(path.join(ROOT, 'live.js'));
const LC = require(path.join(ROOT, 'public', 'live-core.js'));
const teams = require(path.join(ROOT, 'teams.js'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `espn-${name}.json`), 'utf8'));

// The fixtures are a Saturday night. 9:15 PM ET on 2026-09-26.
const SAT_NIGHT = Date.parse('2026-09-27T01:15:00Z');

// The upstream, faked at fetch. The test's own requests to the app go through.
const realFetch = globalThis.fetch;
let upstream = { mode: 'fixture', name: 'live', calls: 0 };
// The AP poll, which the ticker's ranks now come from (teamfacts.js). Counted
// on its own, so "one scoreboard fetch per 20 s" still means the scoreboard.
let pollCalls = 0;
// The poll fixture agrees with the scoreboard's curatedRank everywhere, which
// would prove nothing. Here the poll has Alabama #11 and Michigan #10 while the
// feed still says Alabama #10: the ticker must follow the poll.
function swappedPoll() {
  const raw = fixture('rankings');
  const ap = raw.rankings.find((p) => p.type === 'ap');
  for (const r of ap.ranks) {
    if (r.team.location === 'Alabama') r.current = 11;
    else if (r.team.location === 'Michigan') r.current = 10;
  }
  return raw;
}
globalThis.fetch = async (url, opts) => {
  if (!String(url).match(/^https:\/\/site(\.web)?\.api\.espn\.com\//)) return realFetch(url, opts);
  if (/\/rankings(\?|$)/.test(String(url))) {
    pollCalls++;
    if (upstream.mode === 'down') throw new Error('ENOTFOUND');
    return new Response(JSON.stringify(swappedPoll()), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  upstream.calls++;
  if (upstream.mode === 'down') throw new Error('ENOTFOUND');
  if (upstream.mode === '500') return new Response('oops', { status: 500 });
  return new Response(JSON.stringify(fixture(upstream.name)), { status: 200, headers: { 'content-type': 'application/json' } });
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A game in the normalised shape, for the arithmetic.
function game({ away = 'georgia', home = 'arkansas', as = 0, hs = 0, state = 'in', period = 3, clock = '7:12', awayId, homeId } = {}) {
  return {
    id: 'g1', state, live: state === 'in' || state === 'half', final: state === 'final', period, clock,
    away: { name: away, abbr: 'A', teamId: awayId || live.resolveTeam(away), score: as, linescores: [] },
    home: { name: home, abbr: 'H', teamId: homeId || live.resolveTeam(home), score: hs, linescores: [] },
  };
}
const spread = (team, line) => ({ type: 'spread', teamId: live.resolveTeam(team), line });
const ml = (team) => ({ type: 'ml', teamId: live.resolveTeam(team) });
const total = (dir, line) => ({ type: 'total', dir, line });

(async () => {
  /* ================================================================ *
   * Team names
   * ================================================================ */
  console.log('\n-- team matching');
  eq('no name is claimed by two teams', live.INDEX.ambiguous, []);
  ok('every team resolves by its own name', teams.TEAMS.every((t) => live.resolveTeam(t.name) === t.id),
    teams.TEAMS.filter((t) => live.resolveTeam(t.name) !== t.id).map((t) => t.name).join(', '));
  ok('...and by name plus mascot', teams.TEAMS.every((t) => live.resolveTeam(`${t.name} ${t.mascot}`) === t.id));

  // How ESPN spells them, which is not always how we do.
  for (const [espn, id] of [
    ["Hawai'i Rainbow Warriors", 'hawaii'], ['Hawaiʻi', 'hawaii'], ['San José State Spartans', 'san-jose-state'],
    ['Miami (OH) RedHawks', 'miami-oh'], ['Miami Hurricanes', 'miami'], ['Miami', 'miami'],
    ['Ole Miss Rebels', 'ole-miss'], ['App State Mountaineers', 'appalachian-state'], ['UL Monroe', 'louisiana-monroe'],
    ['Texas A&M Aggies', 'texas-am'], ['NC State Wolfpack', 'nc-state'], ['UConn Huskies', 'uconn'],
    ['Pittsburgh Panthers', 'pittsburgh'], ['Pitt', 'pittsburgh'], ['Florida International', 'fiu'], ['FIU', 'fiu'],
    ['Florida St', 'florida-state'], ['Michigan St.', 'michigan-state'], ['Sam Houston', 'sam-houston'],
    ['Southern Miss', 'southern-miss'], ['#7 LSU', 'lsu'], ['No. 8 Ole Miss', 'ole-miss'], ['(2) Georgia', 'uga'],
    ['Vandy', 'vanderbilt'], ['  georgia  bulldogs ', 'uga'],
  ]) eq(`"${espn}" is ${id}`, live.resolveTeam(espn), id);

  // Near misses are the dangerous ones: a wrong team gives a wrong status.
  for (const [name, id] of [['Georgia St', 'georgia-state'], ['Georgia Tech', 'georgia-tech'], ['Georgia Southern', 'georgia-southern'],
    ['Texas', 'texas'], ['Texas State', 'texas-state'], ['Texas Tech', 'texas-tech'], ['Florida', 'florida'],
    ['Florida Atlantic', 'florida-atlantic'], ['Washington', 'washington'], ['Washington State', 'washington-state'],
    ['Louisiana', 'louisiana'], ['Louisiana Tech', 'louisiana-tech'], ['Miami (OH)', 'miami-oh']]) {
    eq(`"${name}" is ${id} and nobody else`, live.resolveTeam(name), id);
  }
  for (const name of ['OSU', 'UT', 'KSU', 'MSU', 'USC Trojans Football Team', 'Tennessee State', 'Bulldogs', 'Tigers', 'Georgia Bulldog', '', null]) {
    ok(`"${name}" is nobody, not a guess`, live.resolveTeam(name) === null, String(live.resolveTeam(name)));
  }
  ok('an ESPN team whose names disagree is nobody', live.resolveEspnTeam({ displayName: 'Georgia Bulldogs', location: 'Arkansas' }) === null);

  eq('"#7 LSU at #8 Ole Miss" names both', live.matchupTeams('#7 LSU at #8 Ole Miss'), ['lsu', 'ole-miss']);
  eq('"LSU–Ole Miss"', live.matchupTeams('LSU–Ole Miss'), ['lsu', 'ole-miss']);
  eq('"Florida @ Auburn"', live.matchupTeams('Florida @ Auburn'), ['florida', 'auburn']);
  eq('"Miami (OH) vs. Toledo" keeps the (OH)', live.matchupTeams('Miami (OH) vs. Toledo'), ['miami-oh', 'toledo']);
  eq('a kicker with a line in brackets', live.matchupTeams('#2 Georgia (-24.5) at Arkansas'), ['uga', 'arkansas']);
  eq('"Tennessee State at Middle Tennessee" names the one we know', live.matchupTeams('Tennessee State at Middle Tennessee'), ['middle-tennessee']);

  /* ================================================================ *
   * Reading a bet
   * ================================================================ */
  console.log('\n-- reading a bet');
  eq('"Georgia -24.5" is a spread', live.parseBet('Georgia -24.5'), { type: 'spread', side: 'Georgia', line: -24.5 });
  eq('"Georgia -24.5 -115" is still that spread', live.parseBet('Georgia -24.5 -115'), { type: 'spread', side: 'Georgia', line: -24.5 });
  eq('a unicode minus reads as a minus', live.parseBet('Georgia −24.5'), { type: 'spread', side: 'Georgia', line: -24.5 });
  eq('"Auburn +2.5 (or ML +115)" is the spread it leads with', live.parseBet('Spread · Auburn +2.5 (or ML +115)'), { type: 'spread', side: 'Auburn', line: 2.5 });
  eq('"Auburn PK" is a spread of zero', live.parseBet('Auburn PK'), { type: 'spread', side: 'Auburn', line: 0 });
  eq('"Under 58.5"', live.parseBet('Total · Under 58.5'), { type: 'total', dir: 'under', line: 58.5, prefix: '' });
  eq('"o54.5"', live.parseBet('o54.5'), { type: 'total', dir: 'over', line: 54.5, prefix: '' });
  eq('"Auburn ML"', live.parseBet('Auburn ML'), { type: 'ml', side: 'Auburn' });
  eq('"Auburn +115" is a moneyline, not a 115-point spread', live.parseBet('Auburn +115'), { type: 'ml', side: 'Auburn' });
  eq('"Miami (OH) +3.5" keeps the (OH)', live.parseBet('Miami (OH) +3.5'), { type: 'spread', side: 'Miami (OH)', line: 3.5 });
  for (const s of ['Georgia -3.5 1H', 'Georgia 1st Half -3.5', 'Gunner Stockton over 250.5 passing yards', 'Georgia team total over 30.5',
    'Georgia 24.5', 'Pass', '', 'Georgia -75.5', 'Over 12.5', 'Q1 Georgia -3']) {
    ok(`"${s}" is not read as a full-game bet`, live.parseBet(s) === null, JSON.stringify(live.parseBet(s)));
  }

  const games = live.normalise(fixture('live'), SAT_NIGHT).all;
  const match = (texts, market, matchup) => live.matchBet({ texts, market, matchup }, games);
  ok('Georgia -24.5 finds Georgia at Arkansas', (match(['Georgia -24.5'], 'Spread · Georgia -24.5', 'Georgia at Arkansas') || {}).game.id === '401752701');
  ok('...and so does a parlay leg with no matchup at all', (match(['Georgia -24.5'], '', '') || {}).game.id === '401752701');
  ok('a total needs the game named', match(['Under 58.5'], 'Total', '') === null);
  ok('...and finds it when it is', (match(['Under 58.5'], 'Total', 'LSU at Ole Miss') || {}).game.id === '401752702');
  ok('"Georgia Over 30.5" is a team total and is refused', match(['Georgia Over 30.5'], '', 'Georgia at Arkansas') === null);
  ok('"LSU/Ole Miss Over 58.5" is the game total', (match(['LSU/Ole Miss Over 58.5'], '', '') || {}).game.id === '401752702');
  ok('a side that is not in the named matchup is refused', match(['Alabama -20'], '', 'Georgia at Arkansas') === null);
  ok('a card that says Total but reads as a spread is refused', match(['Georgia -24.5'], 'Total', 'Georgia at Arkansas') === null);
  ok('a player prop is never scored', match(['Georgia -24.5'], 'Player prop', 'Georgia at Arkansas') === null);
  ok('a team not playing today matches nothing', match(['Texas -7'], '', 'Texas at Kansas') === null);
  ok('an FCS opponent does not stop the FBS side matching', (match(['Middle Tennessee -20'], '', 'Tennessee State at Middle Tennessee') || {}).game.id === '401752711');
  // A team in two games (a feed spanning two weeks) is ambiguous, not "the first one".
  const doubled = games.concat([{ ...games.find((g) => g.id === '401752701'), id: '999' }]);
  ok('a team that appears in two games is matched to neither', live.matchBet({ texts: ['Georgia -24.5'], market: '', matchup: 'Georgia at Arkansas' }, doubled) === null);

  /* ================================================================ *
   * The arithmetic
   * ================================================================ */
  console.log('\n-- spreads');
  let r = live.evaluate(spread('georgia', -24.5), game({ as: 24, hs: 14 }));
  eq('Georgia -24.5 up 10: needs 15 more', [r.outcome, r.text], ['missing', 'Needs 15 more to cover']);
  r = live.evaluate(spread('georgia', -7), game({ as: 17, hs: 14 }));
  eq('Georgia -7 up 3: needs 5, and says 4 pushes', [r.outcome, r.text], ['missing', 'Needs 5 more to cover (4 to push)']);
  r = live.evaluate(spread('georgia', -7), game({ as: 21, hs: 14 }));
  eq('Georgia -7 up 7: a push as it stands', r.outcome, 'push');
  r = live.evaluate(spread('georgia', -7.5), game({ as: 28, hs: 14 }));
  eq('Georgia -7.5 up 14: covering by 6.5', [r.outcome, r.text], ['hitting', 'Covering by 6.5']);
  r = live.evaluate(spread('arkansas', 24.5), game({ as: 24, hs: 14 }));
  eq('Arkansas +24.5 down 10: covering by 14.5', [r.outcome, r.text], ['hitting', 'Covering by 14.5']);
  r = live.evaluate(spread('arkansas', 3), game({ as: 17, hs: 14 }));
  eq('Arkansas +3 down 3: a push as it stands', r.outcome, 'push');
  r = live.evaluate(spread('arkansas', 2.5), game({ as: 17, hs: 14 }));
  eq('Arkansas +2.5 down 3: needs 1', [r.outcome, r.text], ['missing', 'Needs 1 more to cover']);
  r = live.evaluate(spread('arkansas', 0), game({ as: 14, hs: 14 }));
  eq('a pick\'em tied is a push', r.outcome, 'push');
  r = live.evaluate(spread('georgia', -24.5), game({ as: 45, hs: 20, state: 'final' }));
  eq('final: won by half a point is won', [r.outcome, r.text], ['won', 'Covered by 0.5']);
  r = live.evaluate(spread('georgia', -24), game({ as: 44, hs: 20, state: 'final' }));
  eq('final: landing on 24 is a push', r.outcome, 'push');
  r = live.evaluate(spread('georgia', -24.5), game({ as: 44, hs: 20, state: 'final' }));
  eq('final: missing by half a point is lost', [r.outcome, r.text], ['lost', 'Missed by 0.5']);
  r = live.evaluate(spread('arkansas', 24.5), game({ as: 44, hs: 20, state: 'final' }));
  eq('final: the dog +24.5 losing by 24 covers', r.outcome, 'won');
  ok('a game not started has no status', live.evaluate(spread('georgia', -3), game({ state: 'pre', as: null, hs: null })) === null);
  ok('a live game with no readable score has no status', live.evaluate(spread('georgia', -3), game({ as: null, hs: 7 })) === null);
  ok('a team not in the game has no status', live.evaluate(spread('alabama', -3), game({ as: 7, hs: 7 })) === null);

  console.log('\n-- moneylines');
  eq('leading', live.evaluate(ml('arkansas'), game({ as: 10, hs: 17 })).text, 'Leading by 7');
  eq('trailing', live.evaluate(ml('georgia'), game({ as: 10, hs: 17 })).outcome, 'missing');
  eq('tied', live.evaluate(ml('georgia'), game({ as: 10, hs: 10 })).text, 'Tied');
  eq('final win', [live.evaluate(ml('georgia'), game({ as: 31, hs: 28, state: 'final', period: 5 })).outcome], ['won']);
  eq('final loss', live.evaluate(ml('arkansas'), game({ as: 31, hs: 28, state: 'final' })).text, 'Lost by 3');

  console.log('\n-- totals and pace');
  eq('Q1 15:00 is no time played', live.elapsedMinutes(game({ period: 1, clock: '15:00' })), 0);
  eq('Q2 2:05 is 27.9 minutes', Math.round(live.elapsedMinutes(game({ period: 2, clock: '2:05' })) * 10) / 10, 27.9);
  eq('halftime is 30', live.elapsedMinutes(game({ state: 'half', period: 2, clock: '0:00' })), 30);
  eq('end of the 4th is 60', live.elapsedMinutes(game({ period: 4, clock: '0:00' })), 60);
  eq('overtime is 60 - regulation is spent', live.elapsedMinutes(game({ period: 5, clock: '' })), 60);
  eq('a clock that cannot be read gives no elapsed time', live.elapsedMinutes(game({ period: 3, clock: '' })), null);
  ok('a pace is points per minute times 60: 31 in 27.9 minutes is 66.6', Math.abs(live.pace(31, 27 + 55 / 60) - 66.627) < 0.001, live.pace(31, 27 + 55 / 60));
  eq('no pace before five minutes', live.pace(7, 4.5), null);

  r = live.evaluate(total('over', 58.5), game({ as: 17, hs: 14, period: 2, clock: '2:05' }));
  eq('Over 58.5 at 31 with 27.9 played: on pace for 67', [r.outcome, r.text], ['hitting', 'On pace for 67 (over 58.5)']);
  r = live.evaluate(total('under', 58.5), game({ as: 21, hs: 24, period: 4, clock: '5:40' }));
  eq('Under 58.5 at 45 in the 4th: on pace for 50', [r.outcome, r.text], ['hitting', 'On pace for 50 (under 58.5)']);
  r = live.evaluate(total('over', 54.5), game({ as: 7, hs: 0, period: 1, clock: '12:30' }));
  eq('too early for a pace is said, not guessed', [r.outcome, r.text], ['pending', '7 so far — too early for a pace (over 54.5)']);
  r = live.evaluate(total('over', 54.5), game({ as: 35, hs: 21, period: 3, clock: '9:00' }));
  eq('an over already cleared is hitting and clinched', [r.outcome, r.clinched], ['hitting', true]);
  r = live.evaluate(total('under', 54.5), game({ as: 35, hs: 21, period: 3, clock: '9:00' }));
  eq('an under already passed is missing and clinched', [r.outcome, r.clinched], ['missing', true]);
  r = live.evaluate(total('over', 60), game({ as: 30, hs: 0, state: 'half', period: 2, clock: '0:00' }));
  eq('a pace landing exactly on the number is a push', r.outcome, 'push');
  r = live.evaluate(total('over', 59.5), game({ as: 3, hs: 56, state: 'final' }));
  eq('final 59 against over 59.5 is lost by the half point', [r.outcome, r.text], ['lost', '59 total (over 59.5)']);
  r = live.evaluate(total('under', 59), game({ as: 3, hs: 56, state: 'final' }));
  eq('final 59 against 59 is a push', r.outcome, 'push');
  r = live.evaluate(total('under', 59.5), game({ as: 3, hs: 56, state: 'final' }));
  eq('final 59 against under 59.5 is won', r.outcome, 'won');

  console.log('\n-- parlays');
  const leg = (outcome, state = 'live', matched = true) => ({ matched, state, outcome, market: 'x' });
  eq('2 of 3 hitting with one to play', live.parlayStatus([leg('hitting'), leg('won', 'final'), leg('pending', 'pre')]).text, '2 of 3 legs hitting · 1 to play');
  eq('...is hitting while nothing is missing', live.parlayStatus([leg('hitting'), leg('won', 'final'), leg('pending', 'pre')]).outcome, 'hitting');
  eq('one leg missing makes it missing', live.parlayStatus([leg('hitting'), leg('missing')]).outcome, 'missing');
  eq('one leg lost loses it, whatever the rest say', live.parlayStatus([leg('hitting'), leg('lost', 'final'), leg('pending', 'pre')]).outcome, 'lost');
  eq('every leg won cashes', live.parlayStatus([leg('won', 'final'), leg('won', 'final')]).outcome, 'won');
  const pushed = live.parlayStatus([leg('won', 'final'), leg('push', 'final'), leg('won', 'final')]);
  eq('a pushed leg drops out and the rest still cash', [pushed.outcome, pushed.text], ['won', 'Cashed — 2 of 3 legs won, the rest pushed']);
  eq('every leg pushed is a push', live.parlayStatus([leg('push', 'final'), leg('push', 'final')]).outcome, 'push');
  const untracked = live.parlayStatus([leg('won', 'final'), leg('won', 'final'), { matched: false, market: 'Vibes -3' }]);
  ok('a leg we cannot track means it never says won', untracked.outcome !== 'won', untracked.outcome);
  eq('...and says so', untracked.text, '2 of 3 legs hitting · 1 not tracked');
  eq('nothing started yet has nothing to say', live.parlayStatus([leg('pending', 'pre'), leg('pending', 'pre')]).text, '');

  console.log('\n-- the seed slip, against the fixture');
  const seed = require(path.join(ROOT, 'board.js')).seed();
  const items = seed.picks.map((p) => ({ id: p.id, kind: 'straight', title: p.title, matchup: p.matchup, market: p.market }))
    .concat(seed.parlays.map((p) => ({ id: p.id, kind: 'parlay', title: p.title, legs: p.legs })));
  const slip = Object.fromEntries(live.slipStatus(items, games).map((s) => [s.id, s]));
  eq('Georgia -24.5 up 10 in the 3rd', [slip['georgia-spread'].outcome, slip['georgia-spread'].text], ['missing', 'Needs 15 more to cover']);
  eq('Clemson -3.5, won 31-28 in OT, lost by half a point', [slip['clemson-spread'].outcome, slip['clemson-spread'].text], ['lost', 'Missed by 0.5']);
  eq('Under 58.5 at LSU-Ole Miss is on pace', slip['lsu-om-under'].text, 'On pace for 50 (under 58.5)');
  eq('Auburn +2.5 at the half, up 3', [slip['fla-aub-dog'].outcome, slip['fla-aub-dog'].text], ['hitting', 'Covering by 5.5']);
  eq('Notre Dame -29.5, won 41-10', slip['notre-dame-spread'].outcome, 'won');
  eq('Oklahoma -22.5 has not kicked off', [slip['oklahoma-spread'].state, slip['oklahoma-spread'].outcome], ['pre', 'pending']);
  eq('the Blowout Board parlay', slip['blowout-board'].text, '1 of 3 legs hitting · 1 to play');
  eq('Scoreboard Overs is dead: Kent State-Ohio State finished on 59', [slip['scoreboard-overs'].outcome, slip['scoreboard-overs'].text], ['lost', 'Lost — Over 59.5 missed']);
  const junk = live.slipStatus([{ id: 'x', kind: 'straight', title: 'Vibes', matchup: 'Georgia at Arkansas' }, { nope: 1 }, 'str', null], games);
  eq('a play we cannot read comes back unmatched, not wrong', junk, [{ id: 'x', kind: 'straight', matched: false }]);
  ok('the slip is bounded', live.cleanSlipItems(Array.from({ length: 500 }, (_, i) => ({ id: 'p' + i, title: 'x'.repeat(5000) }))).length === 30);
  ok('...and so is every string on it', live.cleanSlipItems([{ id: 'p', title: 'x'.repeat(5000) }])[0].title.length === 120);

  /* ================================================================ *
   * The normaliser
   * ================================================================ */
  console.log('\n-- the normaliser');
  const sat = live.normalise(fixture('live'), SAT_NIGHT);
  ok('today is the Eastern calendar day', sat.today === '2026-09-26', sat.today);
  ok('yesterday\'s final is not today\'s game', !sat.games.some((g) => g.id === '401752699'));
  ok('...but the 10:30 PM ET kickoff, which is tomorrow in UTC, is', sat.games.some((g) => g.id === '401752705'));
  ok('Thursday\'s game is not on the ticker', !sat.games.some((g) => g.id === '401752800'));
  ok('anyLive', sat.anyLive === true);
  const uga = sat.all.find((g) => g.id === '401752701');
  eq('a live game reads fully', [uga.state, uga.period, uga.clock, uga.away.teamId, uga.away.score, uga.home.score, uga.possession, uga.redZone],
    ['in', 3, '7:12', 'uga', 24, 14, 'away', true]);
  eq('...with line scores', uga.away.linescores, [7, 10, 7]);
  eq('...ranks, only when 1-25', [uga.away.rank, uga.home.rank], [2, null]);
  eq('...and leaders', uga.leaders.map((l) => [l.label, l.name, l.side]), [['Passing', 'G. Stockton', 'away'], ['Rushing', 'N. Frazier', 'away'], ['Receiving', 'O. Blake', 'home']]);
  const half = sat.all.find((g) => g.id === '401752703');
  eq('halftime is its own state, and live', [half.state, half.live], ['half', true]);
  const ot = sat.all.find((g) => g.id === '401752709');
  eq('a final in overtime keeps its period', [ot.state, ot.period, ot.home.linescores.length], ['final', 5, 5]);
  const pre = sat.all.find((g) => g.id === '401752705');
  eq('a game not started has no score, even though the feed says "0"', [pre.away.score, pre.home.score], [null, null]);
  eq('an FCS team keeps the feed\'s name and no id', [sat.all.find((g) => g.id === '401752711').away.name, sat.all.find((g) => g.id === '401752711').away.teamId], ['Tennessee State', null]);

  const tue = live.normalise(fixture('no-games'), Date.parse('2026-09-29T16:00:00Z'));
  eq('a Tuesday has no games', tue.games.length, 0);
  eq('...and knows when the next one is', tue.next, { startsAt: '2026-10-01T23:30:00.000Z', label: 'Louisiana Tech at FIU' });

  const hostile = live.normalise(fixture('hostile'), SAT_NIGHT);
  const text = JSON.stringify(hostile);
  ok('nothing from a hostile feed carries an angle bracket', !/[<>]/.test(text));
  ok('...or a control character or line separator', !/[\u0000-\u001f\u2028\u2029]/.test(text.replace(/\\[nrt"\\]/g, '')));
  eq('events that cannot be read are dropped, duplicates once', hostile.all.map((g) => g.id), ['401752901', '401752902']);
  const h1 = hostile.all[0];
  ok('a clock with junk in it is no clock', h1.clock === '');
  ok('"yes" is not true for the red zone', h1.redZone === false);
  ok('a colour that is not a hex colour is not used', /^#[0-9A-F]{6}$/i.test(h1.home.color));
  ok('a line score with a hole in it is dropped', h1.away.linescores.length === 0 && h1.home.linescores.length === 3);
  ok('rank 0 is no rank', h1.away.rank === null);
  ok('a record wrapped in markup is not a record', h1.away.record === '');
  ok('a known team is named our way, whatever the feed calls it', h1.away.name === 'Arkansas');
  ok('the last play is bounded', h1.lastPlay.length <= 200);
  ok('an absurd over/under is dropped', h1.overUnder === null);
  eq('a live game with a non-numeric score shows no scores at all', [hostile.all[1].away.score, hostile.all[1].home.score], [null, null]);
  ok('...so nothing is computed from half of one', live.slipStatus([{ id: 'k', kind: 'straight', title: 'Ohio State -40', matchup: 'Kent State at Ohio State' }], hostile.all)[0].state === 'pre');
  const many = { events: Array.from({ length: 450 }, (_, i) => ({ ...fixture('live').events[1], id: String(500000000 + i) })) };
  ok('at most 300 events are read', live.normalise(many, SAT_NIGHT).all.length === 300);
  let threw = false;
  try { live.normalise({ nope: true }, SAT_NIGHT); } catch (e) { threw = true; }
  ok('a body with no events list is a failure, not an empty Saturday', threw);

  console.log('\n-- escaping (the page)');
  eq('esc covers text and attributes', LC.esc('"><script>alert(\'x\')</script>&'), '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;');
  eq('esc of nothing is empty', [LC.esc(null), LC.esc(undefined), LC.esc(0)], ['', '', '0']);

  /* ================================================================ *
   * Swings
   * ================================================================ */
  console.log('\n-- swing detection');
  const slipItems = [
    { id: 'lsu-plus', kind: 'straight', title: 'LSU +2.5', matchup: 'LSU at Ole Miss', market: 'Spread' },
    { id: 'blowout-board', kind: 'parlay', title: 'Blowout Board', legs: seed.parlays[0].legs },
  ];
  const respAt = (name, t, teamId = 'uga') => {
    const n = live.normalise(fixture(name), t);
    const s = live.slipStatus(slipItems, n.all);
    return { ...live.publicView({ available: true, stale: false, ...n }, { teamId, slipIds: live.slipGameIds(s) }), slip: s };
  };
  const a = respAt('live', SAT_NIGHT), b = respAt('live-next', SAT_NIGHT + 20000);
  const s1 = LC.snapshot(a, null), s2 = LC.snapshot(b, s1);
  eq('the first poll says nothing - opening the app must not replay the day', LC.detectSwings(null, s1), []);
  const alerts = LC.detectSwings(s1, s2);
  const kinds = alerts.map((x) => x.kind + ':' + x.gameId);
  ok('LSU taking the lead at Ole Miss is a lead change', kinds.includes('lead:401752702'), kinds.join(' '));
  ok('...said plainly', alerts.find((x) => x.gameId === '401752702').text.startsWith('LSU takes the lead — LSU 28, Ole Miss 24 (4th 3:10)'), alerts.find((x) => x.gameId === '401752702').text);
  ok('Alabama going final is a final', kinds.includes('final:401752708'));
  ok('...with the slip leg it settled folded in, not a second banner', /Alabama -20 \(Blowout Board\) won/.test(alerts.find((x) => x.kind === 'final').text), alerts.find((x) => x.kind === 'final').text);
  ok('LSU +2.5 flipping to hitting rides on that lead change, not a second banner',
    /LSU \+2\.5 now hitting/.test(alerts.find((x) => x.kind === 'lead' && x.gameId === '401752702').text) && !alerts.some((x) => x.kind === 'leg' && /LSU \+2\.5/.test(x.text)));
  ok('the reader\'s own team comes first, then lead changes before finals',
    alerts.map((x) => x.kind).join(',').indexOf('lead') < alerts.map((x) => x.kind).join(',').indexOf('final'));
  ok('a Georgia touchdown in the 3rd is not an alert (not the 4th, no lead change)', !kinds.includes('score:401752701') && !kinds.includes('lead:401752701'));
  ok('a game that is not yours alerts nothing (Mississippi State-South Carolina)', !alerts.some((x) => x.gameId === '401752707'));
  ok('...nor does one that went to halftime', !alerts.some((x) => x.gameId === '401752703'));
  ok('every alert has a key naming the event', alerts.every((x) => typeof x.key === 'string' && x.key.length > 5));

  // A score in the 4th with no lead change.
  const mk = (as, hs, period, clock, mine = 'team', final = false) => ({ games: [{ id: 'z', state: final ? 'final' : 'in', live: !final, final, period, clock, mine,
    away: { name: 'Georgia', score: as }, home: { name: 'Arkansas', score: hs } }], slip: [] });
  let p1 = LC.snapshot(mk(24, 14, 4, '9:00'), null);
  let p2 = LC.snapshot(mk(24, 17, 4, '6:12'), p1);
  eq('a field goal in the 4th is a score alert', LC.detectSwings(p1, p2).map((x) => [x.title, x.text]), [['Arkansas scores', 'Georgia 24, Arkansas 17 (4th 6:12)']]);
  p2 = LC.snapshot(mk(24, 17, 3, '6:12'), p1);
  eq('...the same field goal in the 3rd is not', LC.detectSwings(LC.snapshot(mk(24, 14, 3, '9:00'), null), p2), []);
  p2 = LC.snapshot(mk(24, 17, 5, ''), p1);
  eq('...and in overtime it is', LC.detectSwings(p1, p2).length, 1);
  // A lead that changes hands through a tie between two polls still changed hands.
  p1 = LC.snapshot(mk(14, 10, 3, '5:00'), null);
  p2 = LC.snapshot(mk(14, 14, 3, '2:00'), p1);
  const p3 = LC.snapshot(mk(14, 21, 4, '14:00'), p2);
  eq('tied is not a lead change', LC.detectSwings(p1, p2), []);
  eq('...but leading, tied, then trailing is', LC.detectSwings(p2, p3).map((x) => x.kind), ['lead']);
  p2 = LC.snapshot(mk(14, 10, 4, '0:00', 'team', true), p1);
  eq('going final is one alert', LC.detectSwings(p1, p2).map((x) => [x.kind, x.text]), [['final', 'Georgia 14, Arkansas 10']]);
  p1 = LC.snapshot(mk(24, 14, 4, '9:00', ''), null);
  p2 = LC.snapshot(mk(14, 21, 4, '2:00', ''), p1);
  eq('none of this for a game that is not yours', LC.detectSwings(p1, p2), []);

  // A leg flipping on a game with no banner of its own is its own alert.
  const flipA = { games: [{ id: 'q', state: 'in', live: true, period: 2, clock: '5:00', mine: 'slip', away: { name: 'A', score: 7 }, home: { name: 'B', score: 3 } }],
    slip: [{ id: 'o', kind: 'straight', matched: true, title: 'Over 50.5', state: 'live', outcome: 'missing', text: 'On pace for 45 (over 50.5)', gameId: 'q' }] };
  const flipB = { games: [{ id: 'q', state: 'in', live: true, period: 2, clock: '1:00', mine: 'slip', away: { name: 'A', score: 14 }, home: { name: 'B', score: 10 } }],
    slip: [{ id: 'o', kind: 'straight', matched: true, title: 'Over 50.5', state: 'live', outcome: 'hitting', text: 'On pace for 83 (over 50.5)', gameId: 'q' }] };
  const fs1 = LC.snapshot(flipA, null);
  eq('a leg flip alone is its own alert', LC.detectSwings(fs1, LC.snapshot(flipB, fs1)).map((x) => [x.title, x.text]), [['Now hitting', 'Over 50.5 — On pace for 83 (over 50.5)']]);

  console.log('\n-- alerts are not repeated');
  const store = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
  const seen = LC.createSeen(store, 'k', 5);
  eq('fresh alerts pass once', seen.fresh(alerts).length, alerts.length);
  eq('...and not again', seen.fresh(alerts).length, 0);
  const seenAgain = LC.createSeen(store, 'k', 300);
  ok('a reload remembers what was said', seenAgain.fresh(alerts.slice(-2)).length === 0 || alerts.length > 5);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const memOnly = LC.createSeen(broken, 'k');
  ok('storage that throws still dedupes in memory', memOnly.fresh(alerts).length === alerts.length && memOnly.fresh(alerts).length === 0);
  const garbage = { getItem() { return '{"not":"a list"}'; }, setItem() {} };
  ok('storage holding junk starts empty rather than breaking', LC.createSeen(garbage, 'k').fresh(alerts).length === alerts.length);

  console.log('\n-- polling cadence');
  eq('20 s while a game is live', LC.pollDelay({ available: true, anyLive: true }), 20000);
  eq('5 min when nothing is', LC.pollDelay({ available: true, anyLive: false }), 300000);
  eq('5 min when the feed is down', LC.pollDelay({ available: false }), 300000);
  eq('clock labels', [LC.clockLabel({ state: 'in', period: 3, clock: '7:12' }), LC.clockLabel({ state: 'half' }), LC.clockLabel({ state: 'final', period: 5 }),
    LC.clockLabel({ state: 'in', period: 6, clock: '' }), LC.clockLabel({ state: 'pre', startsAt: 'x' }, () => '7:30 PM')],
  ['3rd 7:12', 'Half', 'Final/OT', '2OT', '7:30 PM']);

  /* ================================================================ *
   * The cache
   * ================================================================ */
  console.log('\n-- the cache');
  let clock = 1_000_000;
  let calls = 0;
  let behaviour = 'ok';
  const quiet = { error() {} };
  const fakeFetch = async (_url, opts) => {
    calls++;
    if (behaviour === 'down') throw new Error('ENOTFOUND');
    if (behaviour === '503') return new Response('busy', { status: 503 });
    if (behaviour === 'html') return new Response('<html>not json</html>', { status: 200 });
    if (behaviour === 'noevents') return new Response('{"leagues":[]}', { status: 200 });
    if (behaviour === 'huge-header') return new Response('{}', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } });
    if (behaviour === 'huge-body') return new Response('{"events":[' + ' '.repeat(7 * 1024 * 1024) + ']}', { status: 200 });
    if (behaviour === 'hang') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return new Response(JSON.stringify(fixture('live')), { status: 200 });
  };
  const feed = live.createFeed({ fetch: fakeFetch, now: () => clock, timeoutMs: 50, log: quiet });
  let got = await feed.get();
  ok('the first viewer fetches', calls === 1 && got.available === true);
  await feed.get(); await feed.get();
  clock += 19_000;
  await feed.get();
  ok('every viewer inside 20 s is served the same fetch', calls === 1, String(calls));
  clock += 1_500;
  await feed.get();
  ok('after 20 s the next viewer refreshes it', calls === 2, String(calls));
  clock += 25_000;
  await Promise.all([feed.get(), feed.get(), feed.get(), feed.get()]);
  ok('viewers arriving together share one fetch', calls === 3, String(calls));

  behaviour = 'down';
  clock += 25_000;
  got = await feed.get();
  ok('a feed that just failed serves the last good board', got.available === true && got.stale === true);
  clock += 5_000;
  await feed.get();
  ok('...and the failure is cached too, not retried per viewer', calls === 4, String(calls));
  clock += 11 * 60_000;
  got = await feed.get();
  eq('ten minutes on, it says unavailable', got, { available: false, message: 'Live scores unavailable' });

  for (const mode of ['down', '503', 'html', 'noevents', 'huge-header', 'huge-body', 'hang']) {
    behaviour = mode;
    const f = live.createFeed({ fetch: fakeFetch, now: () => clock, timeoutMs: 50, log: quiet });
    let res, err = null;
    try { res = await f.get(); } catch (e) { err = e; }
    ok(`upstream "${mode}" is "Live scores unavailable", never a throw`, !err && res.available === false && res.message === 'Live scores unavailable', err ? err.message : JSON.stringify(res).slice(0, 80));
  }

  console.log('\n-- which ESPN host, and a 403');
  // Production met a 403 from site.api for every User-Agent but curl's; the
  // ticker had never loaded. site.web.api is first, the other host a retry.
  eq('the scoreboard is read from site.web.api', live.ESPN_SCOREBOARD.startsWith('https://site.web.api.espn.com/'), true);
  const asked = [];
  const refuseWeb = async (url, opts) => {
    asked.push([url.split('/')[2], opts.headers['user-agent']]);
    if (url.startsWith(live.ESPN_HOST + '/')) return { ok: false, status: 403, headers: { get: () => null }, text: async () => 'denied' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"events":[]}' };
  };
  eq('a 403 is tried once on the other host, each with the agent it admits',
    [await live.fetchEspnJson(refuseWeb, live.ESPN_SCOREBOARD, 50), asked],
    [{ events: [] }, [['site.web.api.espn.com', 'Mozilla/5.0'], ['site.api.espn.com', 'curl/8.5.0']]]);
  asked.length = 0;
  const alwaysNo = async (url) => { asked.push(url); return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' }; };
  let err403 = null;
  try { await live.fetchEspnJson(alwaysNo, live.ESPN_SCOREBOARD, 50); } catch (e) { err403 = e; }
  ok('both hosts refusing is one error after two asks, not a loop', err403 && asked.length === 2, String(asked.length));
  asked.length = 0;
  const fiveHundred = async (url) => { asked.push(url); return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }; };
  try { await live.fetchEspnJson(fiveHundred, live.ESPN_SCOREBOARD, 50); } catch (e) { /* expected */ }
  ok('any other failure is not retried on the other host', asked.length === 1, String(asked.length));

  /* ================================================================ *
   * The routes
   * ================================================================ */
  console.log('\n-- the routes');
  require(path.join(ROOT, 'server.js'));
  await new Promise((res) => setTimeout(res, 900));
  const B = 'http://127.0.0.1:9213';
  const J = { 'content-type': 'application/json' };
  const post = (p, body, cookie) => fetch(B + p, { method: 'POST', headers: cookie ? { ...J, cookie } : J, body: JSON.stringify(body) });

  upstream = { mode: 'fixture', name: 'live', calls: 0 };
  let res = await fetch(B + '/api/live');
  let body = await res.json();
  ok('GET /api/live is open and answers 200', res.status === 200, String(res.status));
  ok('...uncached by the browser', res.headers.get('cache-control') === 'no-store');
  ok('...with today\'s games', body.available === true && Array.isArray(body.games) && body.games.length > 0);
  ok('...and without the week-long list the slip maths uses', body.all === undefined);
  ok('...a signed-out ticker pins nobody', body.games.every((g) => g.mine === ''));
  ok('...ranked games before unranked', body.games.findIndex((g) => Math.min(g.away.rank || 99, g.home.rank || 99) > 25) > body.games.findIndex((g) => g.home.rank || g.away.rank));

  for (let i = 0; i < 5; i++) await fetch(B + '/api/live');
  await post('/api/live/slip', { items: [] });
  ok('six requests, one upstream fetch', upstream.calls === 1, String(upstream.calls));
  ok('...and one fetch of the poll the ranks come from', pollCalls === 1, String(pollCalls));

  // The ticker and the team page read one poll, so a team is one number on
  // both. The feed's own curatedRank gives way to it.
  res = await fetch(B + '/api/live');
  body = await res.json();
  const pollFx = swappedPoll().rankings.find((p) => p.type === 'ap');
  const pollRank = (espnId) => { const r = pollFx.ranks.find((x) => x.team.id === espnId); return r ? r.current : null; };
  const sides = body.games.flatMap((g) => [g.away, g.home]);
  ok('every rank on the ticker is the AP poll\'s', sides.every((t) => (t.rank || null) === pollRank(t.espnId)),
    JSON.stringify(sides.filter((t) => (t.rank || null) !== pollRank(t.espnId)).map((t) => [t.name, t.rank, pollRank(t.espnId)])));
  const ugaSide = sides.find((t) => t.teamId === 'uga');
  ok('...Georgia included', ugaSide && ugaSide.rank === 2, JSON.stringify(ugaSide && ugaSide.rank));
  const bama = sides.find((t) => t.teamId === 'alabama');
  ok('...where the feed and the poll disagree, the poll wins', bama && bama.rank === 11, JSON.stringify(bama && bama.rank));

  res = await post('/api/live/slip', { items: slipItems });
  body = await res.json();
  ok('a signed-out reader gets their slip scored', res.status === 200 && body.slip.length === 2 && body.team === null);
  ok('...and the slip\'s games lead the ticker', ['slip'].includes(body.games[0].mine), body.games[0].mine);

  const cookie = (await fetch(B + '/api/id/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'fan@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  res = await post('/api/live/slip', { items: slipItems }, cookie);
  body = await res.json();
  ok('a signed-in reader who never chose a team is not handed Georgia', body.team === null, String(body.team));
  await fetch(B + '/api/prefs', { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ team: 'florida' }) });
  const other = (await fetch(B + '/api/id/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'fan2@example.com', password: 'a-long-password-2' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  await fetch(B + '/api/prefs', { method: 'PUT', headers: { ...J, cookie: other }, body: JSON.stringify({ team: 'florida' }) });
  res = await post('/api/live/slip', { items: slipItems }, other);
  body = await res.json();
  eq('a reader who chose Florida sees Florida first', [body.team, body.games[0].id, body.games[0].mine], ['florida', '401752703', 'team']);
  ok('...then their slip', body.games[1].mine === 'slip');

  // A body that is not a JSON object never reaches the route: the app-wide
  // parser refuses it with a 400, which is right for a request no page sends.
  for (const bad of ['null', '"nope"', '{not json']) {
    res = await fetch(B + '/api/live/slip', { method: 'POST', headers: J, body: bad });
    ok(`a body of ${bad} is refused, not a 500`, res.status === 400, String(res.status));
  }
  for (const bad of [{}, { items: 'nope' }, { items: [{ id: { $gt: '' } }] }, { items: Array(1000).fill({ id: 'x', title: 'Georgia -3' }) }]) {
    res = await fetch(B + '/api/live/slip', { method: 'POST', headers: J, body: JSON.stringify(bad) });
    body = await res.json().catch(() => null);
    ok(`a nonsense body (${JSON.stringify(bad).slice(0, 30)}) is a 200 with a scoreboard`, res.status === 200 && body && body.available === true && body.slip.length <= 30,
      res.status + ' ' + JSON.stringify(body).slice(0, 80));
  }

  upstream.mode = 'down';
  res = await fetch(B + '/api/live');
  body = await res.json();
  ok('inside the 20 s window the cached board is served whatever upstream is doing', res.status === 200 && body.available === true && upstream.calls === 1);

  ok('no model was called by any of it', modelCalls === 0, String(modelCalls));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
