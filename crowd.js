/**
 * Crowd vs you (2026-09-26): a one-tap "who covers?" on each game of the
 * week's board, the split of everyone who answered, and each answer graded
 * against the final score.
 *
 * Erik asked for things that draw people in and make it fun. This is the
 * lowest-friction one: no stake, no account needed to answer, and every
 * answer ends up in a record ("your calls: 7-3") and a comparison ("you were
 * with 22% on Oklahoma, and they covered").
 *
 * PURE. Nothing here reads Firestore or the network; server.js does, and hands
 * the documents in. No model call anywhere in it.
 *
 * STORAGE (server.js):
 *   crowd/<weekKey>                 - the tally: `v__<gameId>__<teamId>`: n,
 *                                     top-level fields so an atomic increment
 *                                     works on each (Firestore will not
 *                                     increment inside a map on merge in every
 *                                     client, and ids are [a-z0-9-] so `__`
 *                                     cannot occur inside one).
 *   crowd-votes/<weekKey>__<hash>   - one voter's week: { weekKey, voter,
 *                                     votes: { <gameId>: { side, spread, at } } }.
 *                                     `spread` is the number for the side taken
 *                                     AT THE MOMENT OF THE CALL, so a call is
 *                                     graded against the line the reader saw,
 *                                     not one that moved afterwards; null when
 *                                     no line was posted, which makes it a
 *                                     straight-up call.
 *
 * WHO A VOTER IS. Signed in: the account. Signed out: a random id in an
 * HttpOnly cookie. Clearing cookies lets someone vote twice - this is a fun
 * poll, not a ledger, and asking for an account before the first tap would
 * cost far more readers than the few it would stop.
 */

const crypto = require('crypto');
const live = require('./live');
const teams = require('./teams');
const gamesLib = require('./games');

const VOTER_COOKIE = 'cfb_v';
const VOTER_RE = /^[A-Za-z0-9_-]{24}$/;
// "The public is on Georgia": only with enough answers to mean something.
const PUBLIC_MIN_VOTES = 10;
const PUBLIC_SHARE = 0.7;
// "34% of readers have this on their slip": only with enough slips that a
// percentage cannot point at one person's.
const SLIP_MIN = 5;
// A call on a side fewer than this share took, that then covered, is a
// contrarian hit.
const CONTRARIAN_SHARE = 0.35;

/** The stable, non-reversible key a voter's documents are filed under. */
function voterHash(voterKey) {
  return crypto.createHash('sha256').update(String(voterKey)).digest('base64url').slice(0, 24);
}

function voterDocId(weekKey, voterKey) {
  return `${weekKey}__${voterHash(voterKey)}`;
}

function tallyField(gameId, teamId) {
  return `v__${gameId}__${teamId}`;
}

/** A tally document -> { <gameId>: { <teamId>: n } }. Negative counts (a
 *  race between two instances) read as 0. */
function readTally(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    const m = /^v__([a-z0-9-]{1,60})__([a-z0-9-]{1,40})$/.exec(k);
    if (!m) continue;
    const n = Math.max(0, Math.floor(Number(v) || 0));
    (out[m[1]] = out[m[1]] || {})[m[2]] = n;
  }
  return out;
}

/** The scoreboard game a board game is, by its two teams, or null. */
function findGame(boardGame, slate) {
  const pk = gamesLib.pairKey(boardGame);
  if (!pk) return null;
  return (slate || []).find((x) => x && x.home && x.away &&
    [x.away.teamId, x.home.teamId].sort().join('|') === pk) || null;
}

function fmtSpread(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'PK';
  return (n > 0 ? '+' : '') + n;
}

/**
 * A board game's two sides, away first, each with its spread from the
 * scoreboard game when one is posted: [{ teamId, name, abbr, spread, label }].
 * null when the game does not name two known teams.
 */
function sidesFor(boardGame, feedGame) {
  const ids = live.matchupTeams(boardGame && boardGame.label);
  if (ids.length !== 2) return null;
  return ids.map((teamId) => {
    const t = teams.get(teamId) || { name: teamId };
    const fs = feedGame ? [feedGame.home, feedGame.away].find((s) => s && s.teamId === teamId) : null;
    const ln = feedGame ? live.lineNow({ type: 'spread', teamId, line: 0 }, feedGame) : null;
    const spread = ln && typeof ln.now === 'number' ? ln.now : null;
    const abbr = (fs && fs.abbr) || t.name;
    return { teamId, name: t.name, abbr, spread, label: spread === null ? abbr : `${abbr} ${fmtSpread(spread)}` };
  });
}

/** Has this game started, by the scoreboard, else by the board's own time. */
function started(boardGame, feedGame, weekKey, now = Date.now()) {
  if (feedGame) return feedGame.state !== 'pre';
  const k = gamesLib.kickoffFor(boardGame && boardGame.time, weekKey);
  return !!k && Date.parse(k) <= now;
}

/**
 * One call against a final: 'win' | 'loss' | 'push', or null while the game
 * is not final (or was called off, or is not this game).
 */
function gradeCall(vote, g) {
  if (!vote || !g || !g.final || g.state === 'canceled' || g.state === 'postponed') return null;
  const mine = g.home.teamId === vote.side ? g.home : g.away.teamId === vote.side ? g.away : null;
  const other = mine === g.home ? g.away : g.home;
  if (!mine || typeof mine.score !== 'number' || typeof other.score !== 'number') return null;
  const margin = mine.score - other.score + (typeof vote.spread === 'number' ? vote.spread : 0);
  return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
}

function tallyOf(counts, sides) {
  const c = counts || {};
  const total = sides.reduce((n, s) => n + (c[s.teamId] || 0), 0);
  return {
    total,
    sides: sides.map((s) => {
      const votes = c[s.teamId] || 0;
      return { ...s, votes, pct: total ? Math.round((votes / total) * 100) : 0 };
    }),
  };
}

/**
 * The week's poll for one reader.
 *   board   - the validated current board
 *   slate   - the week's scoreboard games (normalised)
 *   tally   - readTally(crowd/<week>)
 *   mine    - this reader's votes { gameId: { side, spread } }
 * -> { games: [...], you: { w, l, p, pending, called } }
 */
function pollView({ board: b, slate, tally, mine = {}, weekKey, now = Date.now() }) {
  const out = [];
  const you = { w: 0, l: 0, p: 0, pending: 0, called: 0 };
  for (const g of (b && b.games) || []) {
    const fg = findGame(g, slate);
    const sides = sidesFor(g, fg);
    if (!sides) continue;
    const t = tallyOf(tally[g.id], sides);
    const lead = t.sides.slice().sort((a, z) => z.votes - a.votes)[0];
    const publicSide = t.total >= PUBLIC_MIN_VOTES && lead && lead.votes / t.total >= PUBLIC_SHARE ? lead.teamId : null;
    const vote = mine[g.id] && sides.some((s) => s.teamId === mine[g.id].side) ? mine[g.id] : null;
    const outcome = vote ? gradeCall(vote, fg) : null;
    if (vote) {
      you.called++;
      if (outcome === 'win') you.w++; else if (outcome === 'loss') you.l++; else if (outcome === 'push') you.p++; else you.pending++;
    }
    const covered = fg && fg.final ? sides.find((s) => gradeCall({ side: s.teamId, spread: s.spread }, fg) === 'win') : null;
    out.push({
      id: g.id,
      label: g.label,
      time: g.time || '',
      state: fg ? fg.state : 'pre',
      open: !started(g, fg, weekKey, now),
      score: fg && (fg.final || fg.state === 'in' || fg.state === 'half')
        ? `${fg.away.abbr || fg.away.name} ${fg.away.score}, ${fg.home.abbr || fg.home.name} ${fg.home.score}` : '',
      question: sides.some((s) => s.spread !== null) ? 'Who covers?' : 'Who wins?',
      sides: t.sides,
      total: t.total,
      publicSide,
      mine: vote ? { side: vote.side, spread: typeof vote.spread === 'number' ? vote.spread : null,
        label: sideLabel(sides, vote), outcome } : null,
      // Graded against the line posted now, which is what the split is about.
      covered: covered ? covered.teamId : null,
    });
  }
  return { games: out, you };
}

/** What a call says: "UGA -13.5" at the spread it was made at. */
function sideLabel(sides, vote) {
  const s = sides.find((x) => x.teamId === vote.side);
  if (!s) return '';
  return typeof vote.spread === 'number' ? `${s.abbr} ${fmtSpread(vote.spread)}` : s.abbr;
}

/**
 * Every voter's calls graded, summed: how the readers did as a body.
 *   voterDocs - crowd-votes documents for the week
 */
function readersRecord(voterDocs, slate, boardGames) {
  const rec = { w: 0, l: 0, p: 0, voters: 0 };
  const byId = new Map((boardGames || []).map((g) => [g.id, findGame(g, slate)]));
  for (const d of voterDocs || []) {
    const votes = (d && d.votes) || {};
    let any = false;
    for (const [gid, v] of Object.entries(votes)) {
      const o = gradeCall(v, byId.get(gid));
      any = true;
      if (o === 'win') rec.w++; else if (o === 'loss') rec.l++; else if (o === 'push') rec.p++;
    }
    if (any) rec.voters++;
  }
  return rec;
}

/**
 * How many of this week's slips carry each card, from the user-state
 * documents saved this week. { counts: { <cardId>: n }, slips: n }, with
 * nothing per card below SLIP_MIN slips so a share cannot point at a person.
 */
function slipCounts(slipDocs) {
  const counts = {};
  let slips = 0;
  for (const d of slipDocs || []) {
    const s = d && d.slip && typeof d.slip === 'object' ? d.slip : {};
    const placed = Object.entries(s).filter(([, v]) => v && v.placed === true).map(([k]) => k);
    if (!placed.length) continue;
    slips++;
    for (const k of placed) counts[k] = (counts[k] || 0) + 1;
  }
  if (slips < SLIP_MIN) return { counts: {}, slips };
  return { counts, slips };
}

module.exports = {
  VOTER_COOKIE, VOTER_RE, PUBLIC_MIN_VOTES, PUBLIC_SHARE, SLIP_MIN, CONTRARIAN_SHARE,
  voterHash, voterDocId, tallyField, readTally, findGame, sidesFor, started, gradeCall,
  tallyOf, pollView, sideLabel, readersRecord, slipCounts, fmtSpread,
};
