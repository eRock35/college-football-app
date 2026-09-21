// The board: what the front page draws, and the weekly turnover that keeps it
// from being last week's.
//
// The bug this suite exists to prevent is the one that shipped: a board that
// can only be annotated, never turned over, so finished games stay on the
// front page and the research sweep spends tokens explaining that they are
// finished. The turnover route and its validator are the two things standing
// between that and a page of half-written cards.
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
process.env.CRON_SECRET = 'cron-secret-value-here';
process.env.PORT = '9207';
require(require('path').join(__dirname, '..', 'server.js'));
const board = require(require('path').join(__dirname, '..', 'board.js'));

const B = 'http://127.0.0.1:9207';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const refuses = (name, raw, needle) => {
  try { board.validate(raw); ok(name, false, 'it was accepted'); }
  catch (e) { ok(name, String(e.message).includes(needle), e.message); }
};

const GOOD = {
  games: [{ id: 'a-b', label: 'A at B', time: 'Sat 3:30p ET', kicker: '#1 A at B' }],
  picks: [{ id: 'p1', title: 'B -3.5', matchup: 'A at B', market: 'Spread', odds: -110, confidence: 3,
            thesis: 't', why: 'w', risk: 'r' }],
  parlays: [{ id: 'l1', title: 'Two', confidence: 2, legs: [
    { game: 'A at B', market: 'B -3.5', odds: -110 }, { game: 'C at D', market: 'D -7', odds: -105 }] }],
};

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  /* ---------- the validator ---------- */
  const v = board.validate(GOOD);
  ok('a good board validates', v.picks.length === 1 && v.parlays[0].legs.length === 2);
  ok('...and odds come back as numbers', typeof board.validate({ ...GOOD, picks: [{ ...GOOD.picks[0], odds: '+115' }] }).picks[0].odds === 'number');

  refuses('a board with no games is refused', { picks: GOOD.picks }, 'no games');
  refuses('a board with no picks is refused', { games: GOOD.games }, 'no picks');
  refuses('a pick with unusable odds is refused', { ...GOOD, picks: [{ title: 'x', odds: 'even' }] }, 'odds');
  refuses('a one-leg parlay is refused', { ...GOOD, parlays: [{ title: 'x', legs: [{ game: 'g', market: 'm', odds: -110 }] }] }, 'two legs');
  refuses('two cards with one id are refused',
          { ...GOOD, picks: [GOOD.picks[0], { ...GOOD.picks[0], title: 'Other' }] }, 'duplicate id');

  // The cards are written into innerHTML by the page. They used to be typed
  // by a person; they come from a model with web search now.
  const nasty = board.validate({ ...GOOD, picks: [{ ...GOOD.picks[0], why: '<script>alert(1)</script>ok' }] });
  ok('markup is stripped out of a card', !/[<>]/.test(nasty.picks[0].why), nasty.picks[0].why);

  ok('the seed itself validates', board.seed().picks.length > 0);
  ok('...and an outcome the model invented is dropped, not shown',
     board.validate({ ...GOOD, results: [{ id: 'r', title: 'x', outcome: 'cashed' }] }).results[0].outcome === '');
  ok('...while a real one is kept',
     board.validate({ ...GOOD, results: [{ id: 'r', title: 'x', outcome: 'WIN' }] }).results[0].outcome === 'win');

  /* ---------- the route ---------- */
  let r = await fetch(B + '/api/board');
  let body = await r.json();
  ok('the board is public', r.status === 200, String(r.status));
  ok('a fresh database serves the seed', body.seeded === true && body.picks.length > 0);
  ok('...and says so rather than passing it off as this week', body.stale === true);

  h.bag('college-football-app').set('board/current', { ...GOOD, weekKey: 'not-this-week', generatedAt: 'x' });
  body = await (await fetch(B + '/api/board')).json();
  ok('a stored board wins over the seed', body.picks.length === 1 && body.seeded === false);
  ok('...and a board from another week is marked stale', body.stale === true);

  // A stored board that no longer validates must not blank the front page.
  h.bag('college-football-app').set('board/current', { games: [], picks: [] });
  body = await (await fetch(B + '/api/board')).json();
  ok('an unreadable stored board falls back to the seed', body.seeded === true && body.picks.length > 0, JSON.stringify(body).slice(0, 120));

  /* ---------- the turnover is gated ---------- */
  r = await fetch(B + '/api/research/weekly-board', { method: 'POST' });
  ok('a stranger cannot spend tokens rebuilding the board', r.status === 401 || r.status === 403, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
