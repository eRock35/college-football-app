// Team facts: record, results, schedule, next game and rank from ESPN, laid
// over the model's team page.
//
// What is worth pinning down: that every team maps to exactly one ESPN id (or
// says it does not), that a schedule is read the way the page needs it, that
// facts win over a stale model page while the model keeps its prose - dated,
// and flagged once a game has been played since - that ESPN being down never
// blanks a page, and that the ticker and the team page read one poll.
const path = require('path');
const fs = require('fs');
const h = require('./harness.js');
h.install();

let modelCalls = 0;
let reply = { rank: '#9', record: '1-2', confRecord: '0-1 SEC',
  nextGame: { opponent: 'at Arkansas', kickoffISO: '2026-09-19T16:00:00Z', tv: 'ABC', line: 'Georgia -24.5' },
  schedule: [{ wk: 'Sep 5', opp: 'Tennessee State', loc: 'home', result: 'W 63-3' }],
  storyline: ['A fresh take, written after the game.'] };
require.cache['FAKE_AN'].exports = function () {
  const message = async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(reply) }] });
  return { messages: { create: message, stream: () => { modelCalls++; return { finalMessage: message }; } }, batches: {} };
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
process.env.PORT = '9215';

const ROOT = path.join(__dirname, '..');
const tf = require(path.join(ROOT, 'teamfacts.js'));
const live = require(path.join(ROOT, 'live.js'));
const board = require(path.join(ROOT, 'board.js'));
const teams = require(path.join(ROOT, 'teams.js'));
const { Firestore } = require('@google-cloud/firestore');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `espn-${name}.json`), 'utf8'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

// Saturday 2026-09-26, noon ET: Georgia beat Arkansas last week and plays at
// Oklahoma tonight.
const SAT_NOON = Date.parse('2026-09-26T16:00:00Z');
// The stored page Erik saw: researched the morning of the Arkansas game.
const STALE_UGA = {
  team: 'uga', rank: '#2', record: '2-0', confRecord: '0-0 SEC',
  nextGame: { opponent: 'at Arkansas', kickoffISO: '2026-09-19T16:00:00.000Z', tv: 'ABC', line: 'Georgia -24.5', gameId: 'uga-ark' },
  schedule: [
    { wk: 'Sep 19', opp: 'at Arkansas', loc: 'away', current: true },
    { wk: 'Oct 31', opp: 'vs Florida (Atlanta)', loc: 'neutral', rivalry: true },
    { wk: 'Nov 28', opp: 'Georgia Tech', loc: 'home', rivalry: true },
  ],
  storyline: ['Gunner Stockton has been sharp through two games.'],
  lastChecked: '2026-09-19T15:30:00.000Z',
};

(async () => {
  /* ================================================================ *
   * The id map
   * ================================================================ */
  console.log('\n-- teams.js ids -> ESPN ids');
  const ids = tf.ESPN_IDS;
  const everyTeam = teams.TEAMS.map((t) => t.id);
  ok('every teams.js id maps to an ESPN id or is listed as unmapped',
    everyTeam.every((id) => Boolean(ids[id]) !== tf.UNMAPPED.includes(id)),
    everyTeam.filter((id) => Boolean(ids[id]) === tf.UNMAPPED.includes(id)).join(', '));
  ok('...and nothing else is in the map', Object.keys(ids).every((id) => teams.validId(id) === id));
  const espnSeen = Object.values(ids);
  ok('...each to a different ESPN team', new Set(espnSeen).size === espnSeen.length);
  ok('...by a numeric ESPN id', espnSeen.every((v) => /^\d{1,8}$/.test(v)));
  eq('Georgia is ESPN 61', ids.uga, '61');
  const built = tf.buildEspnMap(fixture('teams'));
  eq('the committed map is what the generator makes from the team list', built.map, ids);
  eq('...with nobody missing and no conflicts', [built.missing, built.conflicts], [tf.UNMAPPED, []]);
  eq('...and the FBS programs teams.js does not list come out unmatched, not guessed',
    built.unmatched.map((s) => s.split(' ')[0]).sort(), ['113', '2623', '48']);
  const twoGeorgias = fixture('teams');
  twoGeorgias.sports[0].leagues[0].teams.push({ team: { id: '9999', location: 'Georgia', name: 'Bulldogs', displayName: 'Georgia Bulldogs', shortDisplayName: 'Georgia' } });
  const clash = tf.buildEspnMap(twoGeorgias);
  ok('two ESPN teams claiming one teams.js id is a conflict, and neither is used',
    !clash.map.uga && clash.missing.includes('uga') && clash.conflicts.some((c) => c.startsWith('uga')));
  ok('a team list with no teams is refused', throws(() => tf.buildEspnMap({ sports: [] })));

  /* ================================================================ *
   * A schedule
   * ================================================================ */
  console.log('\n-- the schedule');
  const f = tf.normaliseSchedule(fixture('schedule-uga'), 'uga', SAT_NOON);
  eq('record and conference record come from the finals', [f.record, f.confRecord], ['3-0', '1-0']);
  eq('every game, in date order', f.schedule.map((r) => r.wk),
    ['Sep 5', 'Sep 12', 'Sep 19', 'Sep 26', 'Oct 3', 'Oct 10', 'Oct 17', 'Oct 31', 'Nov 7', 'Nov 14', 'Nov 21', 'Nov 28']);
  eq('results read as ours first', f.schedule.slice(0, 3).map((r) => r.result), ['W 63-3', 'W 70-20', 'W 34-20']);
  eq('home, away and neutral are spelled the way the page always spelled them',
    [f.schedule[0].opp, f.schedule[2].opp, f.schedule[7].opp, f.schedule[7].loc], ['Tennessee State', 'at Arkansas', 'vs Florida', 'neutral']);
  eq('exactly one row is this week, and it is tonight\'s', f.schedule.filter((r) => r.current).map((r) => r.opp), ['at Oklahoma']);
  eq('the next game', [f.nextGame.opponent, f.nextGame.kickoffISO, f.nextGame.kickoffLabel, f.nextGame.tv, f.nextGame.oppRank],
    ['at Oklahoma', '2026-09-26T23:30:00.000Z', 'Sat 7:30 PM ET', 'ABC', 24]);
  eq('the last game', [f.lastGame.oppName, f.lastGame.result], ['Arkansas', 'W 34-20']);
  const tba = f.schedule.find((r) => r.wk === 'Nov 7');
  eq('a kickoff ESPN has no time for is TBA, and no countdown', [tba.kickoffISO, tba.kickoffLabel], ['', 'Sat, Nov 7 · time TBA']);
  ok('an FCS opponent keeps its own name', f.schedule[0].oppTeamId === null && f.schedule[0].oppName === 'Tennessee State');

  const liveNow = fixture('schedule-uga');
  const okc = liveNow.events[3].competitions[0];
  okc.status = { displayClock: '5:12', period: 3, type: { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: '5:12 - 3rd' } };
  okc.competitors.find((c) => c.id === '61').score = '24';
  okc.competitors.find((c) => c.id !== '61').score = '14';
  const fl = tf.normaliseSchedule(liveNow, 'uga', SAT_NOON);
  eq('a game in progress is still this week\'s, with its score', [fl.nextGame.live, fl.nextGame.liveScore, fl.nextGame.detail], [true, '24-14', '5:12 - 3rd']);
  eq('...and counts for nothing until it is final', fl.record, '3-0');
  okc.status = { type: { name: 'STATUS_FINAL', state: 'post', completed: true } };
  okc.competitors.find((c) => c.id === '61').score = { value: 17, displayValue: '17' };
  okc.competitors.find((c) => c.id !== '61').score = { value: 20, displayValue: '20' };
  okc.competitors.find((c) => c.id !== '61').winner = true;
  const lost = tf.normaliseSchedule(liveNow, 'uga', SAT_NOON);
  eq('a loss is a loss, and the next game moves on', [lost.record, lost.confRecord, lost.schedule[3].result, lost.nextGame.opponent], ['3-1', '1-1', 'L 17-20', 'Vanderbilt']);

  const noFlags = fixture('schedule-uga');
  for (const e of noFlags.events) delete e.competitions[0].conferenceCompetition;
  noFlags.events[2].competitions[0].competitors.find((c) => c.id === '61').record.push({ type: 'vsconf', displayValue: '1-0' });
  eq('without conference flags, ESPN\'s own vs-conference split is used', tf.normaliseSchedule(noFlags, 'uga', SAT_NOON).confRecord, '1-0');

  ok('a schedule for a different team is refused, not shown under this one',
    throws(() => tf.normaliseSchedule(fixture('schedule-uga'), 'alabama', SAT_NOON)));
  ok('...as is one with no events list', throws(() => tf.normaliseSchedule({ team: fixture('schedule-uga').team }, 'uga', SAT_NOON)));
  ok('...or a team with no ESPN id', throws(() => tf.normaliseSchedule(fixture('schedule-uga'), 'not-a-team', SAT_NOON)));

  /* ================================================================ *
   * The poll
   * ================================================================ */
  console.log('\n-- the poll');
  const poll = tf.normalisePoll(fixture('rankings'));
  eq('the AP poll, not the coaches\'', [poll.name, poll.week, poll.ranks[0].team, poll.ranks[1].team], ['AP Top 25', 'Week 4', 'Texas', 'Georgia']);
  eq('twenty-five rows, in order', poll.ranks.map((r) => r.rank), Array.from({ length: 25 }, (_, i) => i + 1));
  eq('released when ESPN says', poll.date, '2026-09-20T18:00:00.000Z');
  eq('Georgia is #2 and 3-0', [tf.pollRankOf(poll, '61'), poll.ranks[1].record, poll.ranks[1].teamId], [2, '3-0', 'uga']);
  const messy = fixture('rankings');
  const ap = messy.rankings.find((p) => p.type === 'ap');
  ap.ranks[5].current = 0; ap.ranks[6].current = 26; ap.ranks[7].current = '#8';
  ap.ranks[8].current = 2;                                   // a second #2
  const mp = tf.normalisePoll(messy);
  ok('ranks outside 1..25, and a second team at one rank, are dropped',
    mp.ranks.length === 21 && !mp.ranks.some((r) => r.team === 'Miami') && mp.ranks.find((r) => r.rank === 2).team === 'Georgia',
    mp.ranks.map((r) => r.rank + r.team).join(','));
  ok('a rankings response with no AP poll is refused', throws(() => tf.normalisePoll({ rankings: [messy.rankings[1]].map((p) => ({ ...p, type: 'usa', name: 'Coaches' })) })));
  ok('...as is one with a handful of readable rows', throws(() => tf.normalisePoll({ rankings: [{ ...ap, ranks: ap.ranks.slice(0, 3) }] })));

  /* ================================================================ *
   * Hostile data
   * ================================================================ */
  console.log('\n-- hostile data');
  const bad = fixture('schedule-uga');
  bad.events[0].competitions[0].competitors[1].team = { id: '2634', location: '<img src=x onerror=alert(1)>State', displayName: '"><svg onload=alert(1)>', name: { evil: 1 } };
  bad.events[1].competitions[0].broadcasts = [{ media: { shortName: '<script>x</script>' } }];
  bad.events[2].competitions[0].competitors[0].score = { displayValue: '14abc' };
  bad.events.push({ id: 'not-a-number', competitions: [] }, { id: '1', competitions: [{ competitors: [{}] }] }, null, 'str');
  bad.events.push(...Array.from({ length: 50 }, (_, i) => ({ ...fixture('schedule-uga').events[4], id: String(500 + i) })));
  const hb = tf.normaliseSchedule(bad, 'uga', SAT_NOON);
  const hbText = JSON.stringify(hb);
  ok('nothing from a hostile schedule carries an angle bracket', !/[<>]/.test(hbText));
  ok('unreadable events are dropped and the list is bounded', hb.schedule.length <= 20 && hb.schedule.every((r) => /^\d+$/.test(r.eventId || r.id)));
  ok('a score that is not a number is no result, rather than a wrong one', hb.schedule.find((r) => r.wk === 'Sep 19').result === '');
  const badPoll = fixture('rankings');
  badPoll.rankings[0].ranks[0].team.location = '<script>alert(1)</script>';
  badPoll.rankings[0].ranks[0].record.summary = '<b>3-0</b>';
  const bp = tf.normalisePoll(badPoll);
  ok('...nor from a hostile poll', !/[<>]/.test(JSON.stringify(bp)));
  ok('...and a record that is not a record is blank', bp.ranks[0].record === '');

  /* ================================================================ *
   * Facts over a stored page
   * ================================================================ */
  console.log('\n-- the overlay');
  const facts = { ...f, fetchedAt: '2026-09-26T15:55:00.000Z', stale: false };
  const meta = teams.get('uga');
  const o = tf.overlay(STALE_UGA, facts, poll, { teamId: 'uga', meta });
  eq('facts win over the stale page: record, conference, rank', [o.record, o.confRecord, o.rank], ['3-0', '1-0', '#2']);
  eq('...and the next game is tonight\'s, not last week\'s', [o.nextGame.opponent, o.nextGame.kickoffISO], ['at Oklahoma', '2026-09-26T23:30:00.000Z']);
  eq('...without last week\'s betting line or board card riding along', [o.nextGame.line, o.nextGame.gameId], ['', '']);
  eq('...with the schedule from ESPN, results and all', o.schedule.slice(0, 4).map((r) => [r.opp, r.result, r.current]),
    [['Tennessee State', 'W 63-3', false], ['Western Kentucky', 'W 70-20', false], ['at Arkansas', 'W 34-20', false], ['at Oklahoma', '', true]]);
  eq('...keeping the model\'s rivalry flags where the opponent matches', o.schedule.filter((r) => r.rivalry).map((r) => r.opp), ['vs Florida', 'Georgia Tech']);
  eq('...and ranked opponents from the poll', o.schedule.filter((r) => r.ranked).map((r) => r.opp + ' #' + r.oppRank), ['at Oklahoma #24', 'at Alabama #10', 'at Ole Miss #8', 'Missouri #17']);
  eq('the storyline stays, dated', [o.storyline, o.storylineAsOf], [STALE_UGA.storyline, STALE_UGA.lastChecked]);
  eq('...and says a game has been played since', [o.storylineStale, o.storylineNote],
    [true, 'Written before the Arkansas game — refresh for a new take']);
  eq('...with the source named', [o.facts.source, o.facts.rankSource, o.researched], ['ESPN', 'AP Top 25, Week 4', true]);
  ok('the old secRecord does not come back from the dead', !('secRecord' in JSON.parse(JSON.stringify(o))));

  const fresh = tf.overlay({ ...STALE_UGA, lastChecked: '2026-09-20T12:00:00.000Z' }, facts, poll, { teamId: 'uga', meta });
  eq('a storyline written after the last game is not flagged', [fresh.storylineStale, fresh.storylineNote], [false, '']);
  const early = tf.overlay({ ...STALE_UGA, lastChecked: '2026-09-10T12:00:00.000Z' }, facts, poll, { teamId: 'uga', meta });
  eq('two games since reads naturally', early.storylineNote, 'Written before the Western Kentucky and Arkansas games — refresh for a new take');
  eq('three reads as a count', tf.gamesPhrase(['A', 'B', 'C']), 'the last 3 games');
  const sameGame = tf.overlay({ ...STALE_UGA, nextGame: { opponent: 'at Oklahoma', line: 'Georgia -6.5', gameId: 'uga-ou' } }, facts, poll, { teamId: 'uga', meta });
  eq('the model\'s line is kept while it is still the same game', [sameGame.nextGame.line, sameGame.nextGame.gameId], ['Georgia -6.5', 'uga-ou']);
  const noFacts = tf.overlay(STALE_UGA, null, poll, { teamId: 'uga', meta });
  eq('with no facts the stored page stands as it was', [noFacts.record, noFacts.rank, noFacts.nextGame.opponent, noFacts.facts], ['2-0', '#2', 'at Arkansas', null]);
  const noPage = tf.overlay(null, facts, poll, { teamId: 'uga', meta });
  eq('a team nobody has written up still gets its real season', [noPage.researched, noPage.record, noPage.schedule.length, noPage.storylineNote], [false, '3-0', 12, '']);
  const noPoll = tf.overlay(STALE_UGA, facts, null, { teamId: 'uga', meta });
  eq('with no poll, ESPN\'s own rank on the game stands', [noPoll.rank, noPoll.facts.rankSource], ['#2', 'ESPN']);

  /* ================================================================ *
   * The Top 25 for the board, and the ticker's ranks
   * ================================================================ */
  console.log('\n-- the Top 25');
  const SAT_NIGHT = Date.parse('2026-09-27T01:15:00Z');
  const sb = live.normalise(fixture('live'), SAT_NIGHT);
  const rows = board.validateRankings(tf.pollRows(poll, sb.all, SAT_NIGHT));
  eq('twenty-five rows that pass the board\'s own rules', rows.map((r) => r.rank), Array.from({ length: 25 }, (_, i) => i + 1));
  const ugaRow = rows.find((r) => r.team === 'Georgia');
  eq('Georgia\'s game this week, live, from the scoreboard', [ugaRow.game, ugaRow.time], ['at Arkansas', 'Live · 24-14 · 7:12 - 3rd']);
  const ouRow = rows.find((r) => r.team === 'Oklahoma');
  eq('a game not yet played has its kickoff, TV and line', [ouRow.game, ouRow.time, ouRow.line], ['vs New Mexico', 'Sat 10:30 PM ET \u00b7 ESPN2', 'OU -22.5']);
  const ndRow = rows.find((r) => r.team === 'Notre Dame');
  eq('a finished one has its score', ndRow.time, 'Final · W 41-10');
  eq('a ranked team not on the scoreboard has no game (the page decides what that means)', rows.find((r) => r.team === 'Texas').game, '');
  eq('opponents carry their poll rank', rows.find((r) => r.team === 'LSU').game, 'at #8 Ole Miss');

  ok('a board with no Top 25 takes the poll', tf.boardNeedsPoll({ rankings: [], generatedAt: '2026-09-25T00:00:00Z' }, poll));
  ok('...as does one built before the poll came out', tf.boardNeedsPoll({ rankings: [{ rank: 1 }], generatedAt: '2026-09-19T00:00:00Z' }, poll));
  ok('...but one built after it keeps its own', !tf.boardNeedsPoll({ rankings: [{ rank: 1 }], generatedAt: '2026-09-22T00:00:00Z' }, poll));
  ok('...and with no poll nothing changes', !tf.boardNeedsPoll({ rankings: [] }, null));

  const ranked = tf.applyPollRanks({ available: true, games: sb.games, all: sb.all }, poll);
  ok('the ticker\'s ranks become the poll\'s', ranked.all.every((g) => [g.away, g.home].every((s) => s.rank === tf.pollRankOf(poll, s.espnId))));
  ok('...without touching the cached feed', sb.all.find((g) => g.id === '401752701').away.rank === 2 && ranked.all !== sb.all);
  ok('...and an unavailable feed passes through', tf.applyPollRanks({ available: false }, poll).available === false);

  /* ================================================================ *
   * The cache and its fallbacks
   * ================================================================ */
  console.log('\n-- cache and fallback');
  let clock = SAT_NOON;
  let mode = 'ok';
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    if (mode === 'down') throw new Error('ENOTFOUND');
    if (mode === '500') return new Response('no', { status: 500 });
    if (/\/rankings/.test(url)) return new Response(JSON.stringify(fixture('rankings')), { status: 200 });
    if (/\/teams\/61\/schedule\?season=2026$/.test(url)) return new Response(JSON.stringify(fixture('schedule-uga')), { status: 200 });
    if (/\/teams\/333\/schedule/.test(url)) return new Response(JSON.stringify(fixture('schedule-uga')), { status: 200 }); // Georgia's, under Alabama's id
    return new Response('not found', { status: 404 });
  };
  const quiet = { error: () => {} };
  const store = new Firestore({ databaseId: 'teamfacts-test' });
  const mk = () => tf.createTeamFacts({ fetch: fakeFetch, db: store, now: () => clock, log: quiet });
  let a = mk();
  const [x1, x2] = await Promise.all([a.facts('uga'), a.facts('uga')]);
  ok('two readers at once share one fetch', calls === 1 && x1.record === '3-0' && x2.record === '3-0', String(calls));
  eq('...served fresh, stamped', [x1.stale, x1.fetchedAt], [false, new Date(SAT_NOON).toISOString()]);
  ok('...and written to Firestore for the next cold instance', (h.bag('teamfacts-test').get('teamfacts/uga') || {}).record === '3-0');
  clock += 10 * 60 * 1000;
  await a.facts('uga');
  ok('inside 30 minutes it costs nothing', calls === 1, String(calls));

  const b = mk();
  const cold = await b.facts('uga');
  ok('a cold instance reads Firestore rather than ESPN', calls === 1 && cold.record === '3-0' && cold.stale === false, String(calls));

  clock += 25 * 60 * 1000;                     // 35 minutes after the fetch
  mode = 'down';
  const stale = await a.facts('uga');
  ok('after 30 minutes it refetches, and when ESPN is down serves the last good copy, marked stale',
    calls === 2 && stale.record === '3-0' && stale.stale === true, `${calls} ${JSON.stringify(stale && stale.stale)}`);
  await a.facts('uga');
  ok('...and does not ask again for a couple of minutes', calls === 2, String(calls));
  clock += 3 * 60 * 1000;
  mode = '500';
  const stale2 = await a.facts('uga');
  ok('...then tries again, and a 500 is survived the same way', calls === 3 && stale2.stale === true, String(calls));

  const c = mk();                               // cold, with a stored copy that is now old
  const fromStore = await c.facts('uga');
  ok('a cold instance with ESPN down serves the stored copy, stale', fromStore && fromStore.record === '3-0' && fromStore.stale === true);
  const d = tf.createTeamFacts({ fetch: fakeFetch, db: new Firestore({ databaseId: 'teamfacts-empty' }), now: () => clock, log: quiet });
  eq('with nothing stored anywhere, it is null - the model page stands', await d.facts('uga'), null);

  mode = 'ok';
  const e = tf.createTeamFacts({ fetch: fakeFetch, db: new Firestore({ databaseId: 'teamfacts-wrong' }), now: () => clock, log: quiet });
  eq('a schedule that is someone else\'s is refused', await e.facts('alabama'), null);
  ok('...and nothing is stored for it', !h.bag('teamfacts-wrong').get('teamfacts/alabama'));
  const before = calls;
  eq('an unknown team never reaches ESPN or Firestore', [await e.facts('../evil'), await e.facts('Georgia Bulldogs')], [null, null]);
  ok('...not even a fetch', calls === before && ![...h.bag('teamfacts-wrong').keys()].some((k) => /evil|Georgia/.test(k)));
  const p1 = await e.poll();
  const p2 = await e.poll();
  ok('the poll is cached the same way', p1.ranks.length === 25 && p2.ranks.length === 25 && calls === before + 1, String(calls - before));
  ok('...in its own document', Boolean(h.bag('teamfacts-wrong').get('polls/ap')));
  eq('January belongs to last season', [tf.seasonFor(Date.parse('2027-01-10T00:00:00Z')), tf.seasonFor(SAT_NOON)], [2026, 2026]);

  /* ================================================================ *
   * The routes
   * ================================================================ */
  console.log('\n-- the routes');
  // Dates relative to now, so "a game finished since the page was written"
  // can be arranged inside the 12-hour research cache.
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
  function scheduleNow() {
    const raw = fixture('schedule-uga');
    const at = [NOW - 20 * 864e5, NOW - 13 * 864e5, NOW - 6 * 36e5, NOW + 7 * 36e5];
    raw.events.forEach((ev, i) => {
      const t = i < at.length ? at[i] : NOW + (i - 2) * 7 * 864e5;
      ev.date = iso(t); ev.competitions[0].date = iso(t);
    });
    return raw;
  }
  let net = 'ok';
  let espnCalls = 0;
  let hostilePoll = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://site.api.espn.com/')) return realFetch(url, opts);
    espnCalls++;
    if (net === 'down') throw new Error('ENOTFOUND');
    if (/\/rankings/.test(u)) {
      const r = fixture('rankings');
      if (hostilePoll) r.rankings[0].ranks[2].team.location = '<img src=x onerror=alert(1)>';
      return new Response(JSON.stringify(r), { status: 200 });
    }
    if (/\/teams\/61\/schedule/.test(u)) return new Response(JSON.stringify(scheduleNow()), { status: 200 });
    if (/\/scoreboard/.test(u)) return new Response(JSON.stringify(fixture('live')), { status: 200 });
    return new Response('not found', { status: 404 });
  };

  require(path.join(ROOT, 'server.js'));
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:9215';
  const J = { 'content-type': 'application/json' };
  const appBag = h.bag('college-football-app');
  appBag.set('fan/uga', JSON.parse(JSON.stringify(STALE_UGA)));

  let res = await fetch(B + '/api/fan/uga');
  let page = await res.json();
  ok('GET /api/fan/uga answers 200', res.status === 200, String(res.status));
  eq('...with ESPN\'s record, rank and next game over the stale page',
    [page.record, page.confRecord, page.rank, page.nextGame.opponent], ['3-0', '1-0', '#2', 'at Oklahoma']);
  eq('...the Arkansas result on the schedule', page.schedule[2].result, 'W 34-20');
  eq('...and the model\'s storyline, dated and flagged',
    [page.storyline[0], page.storylineAsOf, page.storylineNote],
    [STALE_UGA.storyline[0], STALE_UGA.lastChecked, 'Written before the Arkansas game — refresh for a new take']);
  ok('...leaving the stored page untouched', appBag.get('fan/uga').record === '2-0');
  ok('...and caching the facts for a cold instance', (appBag.get('teamfacts/uga') || {}).record === '3-0');

  res = await fetch(B + '/api/fan/michigan');
  page = await res.json();
  ok('a team ESPN will not answer for still reads fine, honestly empty', res.status === 200 && page.researched === false && !page.schedule && page.facts === null,
    JSON.stringify(page).slice(0, 200));
  res = await fetch(B + '/api/fan/..%2Fevil');
  ok('an unknown id is still a 404', res.status === 404, String(res.status));

  // The paid refresh: a game finished after the page was written, inside
  // the 12-hour window, so the cache must not hand back the old take.
  const cookie = (await fetch(B + '/api/id/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'fan@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  appBag.set('fan/uga', { ...JSON.parse(JSON.stringify(STALE_UGA)), lastChecked: new Date(NOW - 8 * 36e5).toISOString() });
  res = await fetch(B + '/api/fan/uga/research', { method: 'POST', headers: { ...J, cookie } });
  page = await res.json();
  ok('a page written before the last game is re-researched, even inside 12 hours', res.status === 200 && modelCalls === 1 && page.cached === false,
    `${res.status} ${modelCalls} ${JSON.stringify(page).slice(0, 160)}`);
  eq('...and what comes back still shows ESPN\'s facts, not the model\'s', [page.record, page.rank, page.nextGame.opponent], ['3-0', '#2', 'at Oklahoma']);
  eq('...with the new storyline, no longer flagged', [page.storyline[0], page.storylineNote], [reply.storyline[0], '']);
  res = await fetch(B + '/api/fan/uga/research', { method: 'POST', headers: { ...J, cookie } });
  page = await res.json();
  ok('the next refresh is the cache again', page.cached === true && modelCalls === 1, String(modelCalls));

  res = await fetch(B + '/api/board');
  let b1 = await res.json();
  ok('a board with no Top 25 gets the AP poll', res.status === 200 && b1.rankings.length === 25 && b1.rankingsFrom && b1.rankingsFrom.source === 'poll',
    JSON.stringify(b1.rankingsFrom));
  eq('...labelled as the poll', [b1.rankingsFrom.name, b1.rankingsFrom.week, b1.rankingsFrom.games], ['AP Top 25', 'Week 4', true]);
  eq('...with each team\'s game from the scoreboard', b1.rankings.find((r) => r.team === 'Georgia').game, 'at Arkansas');

  appBag.set('board/current', { ...board.SEED, weekKey: 'x', generatedAt: '2026-09-22T00:00:00.000Z',
    rankings: [{ rank: 1, team: 'Model Pick', record: '3-0' }] });
  b1 = await (await fetch(B + '/api/board')).json();
  ok('a board whose own Top 25 is newer than the poll keeps it', b1.rankings.length === 1 && b1.rankings[0].team === 'Model Pick' && !b1.rankingsFrom,
    JSON.stringify(b1.rankings).slice(0, 120));
  appBag.set('board/current', { ...board.SEED, weekKey: 'x', generatedAt: '2026-09-18T00:00:00.000Z',
    rankings: [{ rank: 1, team: 'Model Pick', record: '3-0' }] });
  b1 = await (await fetch(B + '/api/board')).json();
  ok('...one older than the poll gives way to it', b1.rankings.length === 25 && b1.rankings[0].team === 'Texas');

  // A cold instance's view of the same things with ESPN gone: served from
  // Firestore, stale, and never a 500.
  net = 'down';
  const cold2 = tf.createTeamFacts({ fetch: (...args) => globalThis.fetch(...args), db: new Firestore({ databaseId: 'college-football-app' }), now: () => Date.now() + 3600e3, log: quiet });
  const cf = await cold2.facts('uga');
  ok('ESPN down on a cold instance: the stored facts, marked stale', cf && cf.record === '3-0' && cf.stale === true);
  appBag.delete('board/current');
  res = await fetch(B + '/api/board');
  ok('the board never breaks for the poll (served from cache here)', res.status === 200 && (await res.json()).picks.length > 0);

  // A hostile poll, end to end: a fresh server-side cache would be needed to
  // re-read it, so check the module path the route uses.
  net = 'ok'; hostilePoll = true;
  const hp = tf.createTeamFacts({ fetch: (...args) => globalThis.fetch(...args), db: null, log: quiet });
  const hpoll = await hp.poll();
  ok('a hostile poll reaches the board with no markup in it',
    !/[<>]/.test(JSON.stringify(board.validateRankings(tf.pollRows(hpoll, [], Date.now())))));

  ok('ESPN was only ever asked through the fake', espnCalls > 0);
  ok('no model was called except the one paid refresh', modelCalls === 1, String(modelCalls));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
