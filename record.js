/**
 * Track records and badges (2026-09-26).
 *
 * Two records, both graded from ESPN's final scores and never from a model:
 *
 *   - THE BOARD'S. Every weekly rebuild grades the previous board's picks and
 *     stores them as `results` on the new board. `board/current` and the
 *     archived `board/week-<key>` documents therefore already hold the whole
 *     season; this reads them into one record. Public: a new visitor deciding
 *     whether to trust the card should be able to see how it has done.
 *   - A READER'S. Their "who covers?" calls (crowd.js) and the plays they
 *     placed on their slip, graded week by week, with streaks and badges.
 *
 * PURE. server.js reads the documents and the week's scoreboard and hands
 * them in. No model call.
 */

const live = require('./live');
const crowd = require('./crowd');

/** Profit in units on a 1-unit stake at American odds. */
function unitsFor(outcome, odds) {
  if (outcome === 'loss') return -1;
  if (outcome !== 'win') return 0;
  const n = Number(odds);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return 0;
  return n > 0 ? n / 100 : 100 / Math.abs(n);
}

function decimalOf(odds) {
  const n = Number(odds);
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

/** A parlay's combined American price from its legs, or null. */
function parlayOdds(legs) {
  const ls = (Array.isArray(legs) ? legs : []).filter((l) => Number.isFinite(Number(l && l.odds)) && Math.abs(Number(l.odds)) >= 100);
  if (ls.length < 2) return null;
  const dec = ls.reduce((a, l) => a * decimalOf(l.odds), 1);
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

const round2 = (n) => Math.round(n * 100) / 100;

/** The week before a week key. */
function prevWeek(weekKey) {
  const t = Date.parse(`${weekKey}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 7 * 86400000).toISOString().slice(0, 10) : '';
}

function tally(rows) {
  const t = { w: 0, l: 0, p: 0, units: 0, priced: 0 };
  for (const r of rows) {
    if (r.outcome === 'win') t.w++;
    else if (r.outcome === 'loss') t.l++;
    else if (r.outcome === 'push') t.p++;
    else continue;
    if (r.odds !== null && r.odds !== undefined) { t.units += unitsFor(r.outcome, r.odds); t.priced++; }
  }
  t.units = round2(t.units);
  return t;
}

/** The current run of wins or losses, most recent first. Pushes do not break it. */
function streakOf(rowsOldestFirst) {
  let kind = '';
  let count = 0;
  for (let i = rowsOldestFirst.length - 1; i >= 0; i--) {
    const o = rowsOldestFirst[i].outcome;
    if (o !== 'win' && o !== 'loss') continue;
    if (!kind) kind = o;
    if (o !== kind) break;
    count++;
  }
  return { kind, count };
}

/**
 * The board's season from its stored documents.
 *   boardDocs - [{ weekKey, resultsWeek, results, picks, parlays }] in any order
 *   priceBook - { <weekKey>: { <cardId>: odds } } from archived boards, for
 *               results graded before results carried their own price
 * -> { weeks: [{ week, w, l, p, units, rows }], total, streak, since }
 */
function boardSeason(boardDocs, priceBook = {}) {
  const byWeek = new Map();
  for (const d of boardDocs || []) {
    if (!d || !Array.isArray(d.results) || !d.results.length) continue;
    const week = d.resultsWeek || prevWeek(d.weekKey);
    if (!week) continue;
    const prev = byWeek.get(week);
    // Two documents grading one week (a forced rebuild): the later wins.
    if (prev && String(prev.generatedAt || '') > String(d.generatedAt || '')) continue;
    byWeek.set(week, d);
  }
  const weeks = [...byWeek.entries()].sort((a, z) => (a[0] < z[0] ? -1 : 1)).map(([week, d]) => {
    const prices = priceBook[week] || {};
    const rows = d.results.filter((r) => r && ['win', 'loss', 'push'].includes(r.outcome)).map((r) => {
      let odds = r.odds !== undefined && r.odds !== null ? r.odds : prices[r.id];
      if ((odds === undefined || odds === null) && r.kind !== 'parlay' && !/\+/.test(String(r.market || ''))) odds = -110;
      return { id: r.id, title: r.title, outcome: r.outcome, finalScore: r.finalScore || '', odds: odds === undefined ? null : odds, source: r.source || '' };
    });
    return { week, ...tally(rows), rows };
  });
  const all = weeks.flatMap((w) => w.rows);
  return { weeks, total: tally(all), streak: streakOf(all), since: weeks.length ? weeks[0].week : '' };
}

/* ------------------------------------------------------------------ *
 * A reader's slip, graded
 * ------------------------------------------------------------------ */

/**
 * The placed plays on a stored slip, as items gradeFromFinals understands,
 * resolved against the board they were placed from, the reader's own cards
 * and the games they added.
 */
function slipItems(slipDoc, boardDoc) {
  const out = [];
  const slip = (slipDoc && slipDoc.slip) || {};
  const picks = new Map(((boardDoc && boardDoc.picks) || []).map((p) => [p.id, p]));
  const parlays = new Map(((boardDoc && boardDoc.parlays) || []).map((p) => [p.id, p]));
  const own = new Map((((slipDoc && slipDoc.board) || {}).own || []).map((c) => [c.id, c]));
  const custom = (slipDoc && slipDoc.customPicks) || {};
  for (const [id, v] of Object.entries(slip)) {
    if (!v || v.placed !== true) continue;
    const stake = Number(v.stake) > 0 ? Number(v.stake) : 0;
    let card = null;
    if (picks.has(id)) { const p = picks.get(id); card = { kind: 'straight', title: p.title, matchup: p.matchup, market: p.market, odds: p.odds }; }
    else if (parlays.has(id)) { const p = parlays.get(id); card = { kind: 'parlay', title: p.title, legs: p.legs || [], odds: parlayOdds(p.legs) }; }
    else if (own.has(id)) { const c = own.get(id); card = { kind: 'straight', title: c.title, matchup: c.matchup, market: `${c.market} · ${c.title}`, odds: c.odds }; }
    else if (id.startsWith('game-') && custom[id.slice(5)]) { const c = custom[id.slice(5)]; card = { kind: 'straight', title: c.title, matchup: c.matchup, market: c.market, odds: c.odds }; }
    if (card) out.push({ id, stake, ...card });
  }
  return out;
}

function money(outcome, stake, odds) {
  if (!stake) return 0;
  if (outcome === 'loss') return -stake;
  if (outcome !== 'win' || !Number.isFinite(Number(odds))) return 0;
  return round2(stake * unitsFor('win', odds));
}

/** One week of a reader's slip: graded plays and what they came to. */
function gradeSlipWeek(slipDoc, boardDoc, games) {
  const items = slipItems(slipDoc, boardDoc);
  if (!items.length) return null;
  const finals = (games || []).filter((g) => g.final);
  const { graded } = live.gradeFromFinals(items, finals);
  const byId = new Map(graded.map((g) => [g.id, g]));
  const plays = items.map((it) => {
    const g = byId.get(it.id);
    const outcome = g ? g.outcome : 'pending';
    return { id: it.id, kind: it.kind, title: it.title, odds: it.odds === undefined ? null : it.odds, stake: it.stake,
      outcome, finalScore: g ? g.finalScore : '', net: money(outcome, it.stake, it.odds) };
  });
  const t = tally(plays);
  return { ...t, pending: plays.filter((p) => p.outcome === 'pending').length, plays,
    staked: round2(plays.reduce((n, p) => n + p.stake, 0)),
    net: round2(plays.reduce((n, p) => n + p.net, 0)) };
}

/** One week of a reader's calls. `share` is the side's share of the week's
 *  answers, for the contrarian badge. */
function gradeCallsWeek(voterDoc, boardDoc, games, tally0) {
  const votes = (voterDoc && voterDoc.votes) || {};
  const counts = tally0 || {};
  const calls = [];
  for (const g of (boardDoc && boardDoc.games) || []) {
    const v = votes[g.id];
    if (!v || !v.side) continue;
    const fg = crowd.findGame(g, games);
    const sides = crowd.sidesFor(g, fg) || [];
    const c = counts[g.id] || {};
    const total = Object.values(c).reduce((n, x) => n + x, 0);
    calls.push({ gameId: g.id, label: g.label, side: v.side,
      call: crowd.sideLabel(sides, v) || v.side,
      outcome: crowd.gradeCall(v, fg) || 'pending',
      score: fg && fg.final ? `${fg.away.abbr || fg.away.name} ${fg.away.score}, ${fg.home.abbr || fg.home.name} ${fg.home.score}` : '',
      share: total ? (c[v.side] || 0) / total : null, answers: total });
  }
  if (!calls.length) return null;
  const t = tally(calls.map((x) => ({ ...x, odds: null })));
  return { w: t.w, l: t.l, p: t.p, pending: calls.filter((x) => x.outcome === 'pending').length, calls };
}

/* ------------------------------------------------------------------ *
 * Badges
 * ------------------------------------------------------------------ */

/**
 * Every badge, earned or not - the locked ones are the point: a reader who
 * can see "Perfect week" greyed out has a reason to come back Saturday.
 *   weeks - [{ week, calls, slip, board }] oldest first, from the graders
 *           above (`board` is the board's own tally for that week)
 */
const BADGES = [
  { id: 'first-call', icon: '🎯', name: 'On the board', hint: 'Make your first call' },
  { id: 'first-win', icon: '✅', name: 'First win', hint: 'Win a call or a play' },
  { id: 'perfect-week', icon: '💯', name: 'Perfect week', hint: 'Go 3-0 or better in a week of calls' },
  { id: 'contrarian', icon: '🧊', name: 'Contrarian', hint: 'Win a call fewer than 35% of readers made' },
  { id: 'upset', icon: '🐶', name: 'Called the upset', hint: 'Cash a play at +150 or longer' },
  { id: 'parlay', icon: '🎰', name: 'Parlay hit', hint: 'Cash a parlay' },
  { id: 'hot-streak', icon: '🔥', name: 'Heater', hint: 'Win 5 in a row' },
  { id: 'beat-board', icon: '🧠', name: 'Beat the board', hint: 'Out-call the board’s picks in a week' },
  { id: 'regular', icon: '📅', name: 'Regular', hint: 'Make calls in 3 different weeks' },
];

function badges(weeks) {
  const earned = new Map();
  const give = (id, week, detail) => { if (!earned.has(id)) earned.set(id, { week, detail }); };
  const sequence = [];
  let weeksCalled = 0;
  for (const wk of weeks || []) {
    const calls = (wk.calls && wk.calls.calls) || [];
    const plays = (wk.slip && wk.slip.plays) || [];
    if (calls.length) { give('first-call', wk.week, calls[0].call); weeksCalled++; }
    if (weeksCalled >= 3) give('regular', wk.week, `${weeksCalled} weeks of calls`);
    for (const c of calls) {
      if (c.outcome === 'win') give('first-win', wk.week, c.call);
      if (c.outcome === 'win' && c.share !== null && c.answers >= 5 && c.share < crowd.CONTRARIAN_SHARE) {
        give('contrarian', wk.week, `${c.call} with ${Math.round(c.share * 100)}% of readers`);
      }
    }
    for (const p of plays) {
      if (p.outcome === 'win') give('first-win', wk.week, p.title);
      if (p.outcome === 'win' && p.kind === 'straight' && Number(p.odds) >= 150) give('upset', wk.week, `${p.title} (+${p.odds})`);
      if (p.outcome === 'win' && p.kind === 'parlay') give('parlay', wk.week, p.title);
    }
    const c = wk.calls;
    if (c && c.w >= 3 && c.l === 0 && !c.pending) give('perfect-week', wk.week, `${c.w}-0${c.p ? `-${c.p}` : ''}`);
    const b = wk.board;
    if (c && b && (c.w + c.l) >= 3 && (b.w + b.l) >= 3 && c.w / (c.w + c.l) > b.w / (b.w + b.l)) {
      give('beat-board', wk.week, `${c.w}-${c.l} to the board’s ${b.w}-${b.l}`);
    }
    for (const x of [...calls, ...plays]) if (x.outcome === 'win' || x.outcome === 'loss') sequence.push({ outcome: x.outcome, week: wk.week, label: x.call || x.title });
    let run = 0;
    for (const x of sequence) {
      run = x.outcome === 'win' ? run + 1 : 0;
      if (run >= 5) give('hot-streak', x.week, `${run} straight`);
    }
  }
  return BADGES.map((b) => ({ ...b, earned: earned.has(b.id), ...(earned.get(b.id) || {}) }));
}

/** A reader's season from their graded weeks. */
function readerSeason(weeks) {
  const calls = weeks.flatMap((w) => ((w.calls && w.calls.calls) || []).map((c) => ({ ...c, odds: null })));
  const plays = weeks.flatMap((w) => (w.slip && w.slip.plays) || []);
  const ct = tally(calls);
  const pt = tally(plays);
  const decided = [...calls, ...plays].filter((x) => x.outcome === 'win' || x.outcome === 'loss');
  return {
    calls: { w: ct.w, l: ct.l, p: ct.p },
    slip: { w: pt.w, l: pt.l, p: pt.p,
      net: round2(weeks.reduce((n, w) => n + ((w.slip && w.slip.net) || 0), 0)),
      staked: round2(weeks.reduce((n, w) => n + ((w.slip && w.slip.staked) || 0), 0)) },
    streak: streakOf(decided),
  };
}

module.exports = {
  unitsFor, parlayOdds, prevWeek, tally, streakOf, boardSeason,
  slipItems, gradeSlipWeek, gradeCallsWeek, BADGES, badges, readerSeason,
};
