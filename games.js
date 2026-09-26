/**
 * The games collection: research notes on one game each, and which games
 * count as THIS week's.
 *
 * Two problems lived here until 2026-09-26 (audit):
 *
 * 1. Model JSON went into `games/<id>` as it came back, with the MODEL
 *    choosing the document id, and the page drew every field raw into
 *    innerHTML. A label carrying `<img onerror>` was stored XSS for every
 *    reader; an id with a "/" in it made Firestore throw after the credit had
 *    been spent. validate() is board.validate() for this collection: bounded
 *    strings, markup stripped, enums, numbers - and the id is derived here,
 *    from the teams (teams.js ids) or a slug of the matchup, never taken from
 *    the model.
 *
 * 2. Nothing retired a games document, so the weekday batch and the Saturday
 *    sweep paid, every run, to research last week's finished games.
 *    thisWeek() is the only list those jobs research from now: the current
 *    board's games (and any game its picks name), plus games added this week,
 *    with anything that has kicked off left out.
 */

const board = require('./board');
const live = require('./live');

const MAX = { short: 120, line: 400, prose: 2000 };
const TAGS = new Set(['top25', 'interesting']);

/** A plain string: angle brackets and control characters gone (newlines kept
 *  in prose), trimmed, capped. */
function clean(v, cap) {
  if (v === undefined || v === null || typeof v === 'object') return '';
  return String(v)
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, cap);
}

function isoOrEmpty(v) {
  const t = Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function confidence(v) {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 4 ? n : null;
}

/** The research fields: what a refresh or a batch may change. Everything else
 *  on a document (its id, label, week) is decided here, not by a model. */
function validateUpdate(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {
    market: clean(r.market, MAX.short),
    pick: clean(r.pick, MAX.short),
    pickConfidence: confidence(r.pickConfidence),
    summary: clean(r.summary, MAX.line),
    why: clean(r.why, MAX.prose),
    injuryNote: clean(r.injuryNote, MAX.line),
    pass: r.pass === true,
    passReason: clean(r.passReason, MAX.line),
  };
  // A pass with a pick, or a pick with no confidence, is a model hedging; the
  // pick wins and a missing confidence is a middling one.
  if (out.pick) { out.pass = false; out.passReason = ''; if (!out.pickConfidence) out.pickConfidence = 3; }
  if (!out.pick) out.pickConfidence = null;
  return out;
}

/** The two teams a game is about, as teams.js ids, in the order found. */
function teamsOf(g) {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  if (g && (g.away || g.home)) { add(live.resolveTeam(g.away)); add(live.resolveTeam(g.home)); }
  if (ids.length < 2 && g) for (const id of live.matchupTeams(g.label || g.matchup || '')) add(id);
  return ids.slice(0, 2);
}

/** Order-free key for "the same game", or '' when the teams are not both known. */
function pairKey(g) {
  const ids = teamsOf(g);
  return ids.length === 2 ? ids.slice().sort().join('|') : '';
}

/**
 * The document id for a game, derived here and never taken from a model:
 * "<away>-<home>" in teams.js ids when both teams are known, otherwise a slug
 * of the label (or of what was asked for). Always matches board.ID_RE, so it
 * is safe as a Firestore key and in an attribute.
 */
function idFor(g, fallbackText) {
  const ids = teamsOf(g);
  if (ids.length === 2) {
    const id = board.cleanId(`${ids[0]}-${ids[1]}`);
    if (id) return id;
  }
  return board.cleanId(g && g.label) || board.cleanId(fallbackText) ||
    'game-' + Math.abs(hash(String((g && g.label) || fallbackText || Date.now()))).toString(36);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * A whole games document, cleaned. Throws when there is no game to speak of
 * (no label), so a bad model answer is refused before it is written.
 */
function validate(raw, { id, weekKey } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const label = clean(r.label, MAX.short);
  if (!label) throw new Error('game has no label');
  const tag = clean(r.tag, 16).toLowerCase();
  return {
    id: board.cleanId(id) || idFor({ label, home: r.home, away: r.away }),
    label,
    home: clean(r.home, 60),
    away: clean(r.away, 60),
    kickoff: clean(r.kickoff, MAX.short),
    tag: TAGS.has(tag) ? tag : 'interesting',
    ranked: clean(r.ranked, MAX.short),
    ...validateUpdate(r),
    risk: clean(r.risk, MAX.line),
    lastChecked: isoOrEmpty(r.lastChecked),
    weekKey: clean(weekKey || r.weekKey, 10),
  };
}

/** A stored document for reading: cleaned again (older documents predate all
 *  of this), or null when it cannot be drawn. */
function forRead(id, raw) {
  try { return validate(raw, { id }); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ *
 * Kickoff
 * ------------------------------------------------------------------ */

const DAY_OFFSET = { tue: 0, wed: 1, thu: 2, fri: 3, sat: 4, sun: 5, mon: 6 };

/** Eastern wall-clock time -> the UTC instant, DST included. */
function etToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess))) p[x.type] = x.value;
  const asEt = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return guess - (asEt - guess);
}

/**
 * "Sat 3:30p ET · ABC" in the week that starts `weekKey` -> an ISO instant,
 * or '' when the text does not say. The board's games carry no instant, only
 * the label a person reads; ESPN's kickoff is preferred wherever a game
 * matches the scoreboard.
 */
function kickoffFor(text, weekKey) {
  const s = String(text || '');
  const wk = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekKey || ''));
  const day = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.exec(s);
  const tm = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?(?![a-z])/i.exec(s);
  if (!wk || !day || !tm) return '';
  let h = Number(tm[1]) % 12;
  if (tm[3].toLowerCase() === 'p') h += 12;
  const mi = Number(tm[2] || 0);
  if (h > 23 || mi > 59) return '';
  const base = new Date(Date.UTC(+wk[1], +wk[2] - 1, +wk[3]));
  base.setUTCDate(base.getUTCDate() + DAY_OFFSET[day[1].toLowerCase()]);
  return new Date(etToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi)).toISOString();
}

/* ------------------------------------------------------------------ *
 * This week's games
 * ------------------------------------------------------------------ */

const STARTED = new Set(['in', 'half', 'final', 'postponed', 'canceled']);

/**
 * The games that are this week's, merged with their research, each marked
 * with whether it has started.
 *
 *   current  - the stored board is this week's board. When it is not (a
 *              board from a finished week, or the seed), every one of its
 *              games is over and there is nothing to research.
 *   games    - every game this week: the board's slate, any game a pick or
 *              parlay leg names that the slate does not, and games added
 *              this week through "Add a game" (weekKey stamped at write).
 *              Legacy documents with no weekKey count only when they are
 *              one of the board's games.
 *   upcoming - games whose kickoff has not passed (by ESPN's scoreboard when
 *              the game is on it, else by the board's own "Sat 3:30p ET").
 *   skipped  - how many were left out for having started or finished.
 */
function thisWeek({ board: b, docs = [], scoreboard = [], now = Date.now() }) {
  const week = board.weekKeyAt(now);
  const current = !!(b && b.weekKey && b.weekKey === week);
  const rows = [];
  const byPair = new Map();
  const byId = new Map();
  const add = (g) => {
    const pk = pairKey(g);
    if (byId.has(g.id) || (pk && byPair.has(pk))) return byId.get(g.id) || byPair.get(pk);
    const row = { ...g, pair: pk };
    rows.push(row);
    byId.set(row.id, row);
    if (pk) byPair.set(pk, row);
    return row;
  };

  const slate = (b && Array.isArray(b.games)) ? b.games : [];
  for (const g of slate) add({ id: g.id, label: g.label, kickoff: g.time || '', kicker: g.kicker || '', onBoard: true });
  // A pick can name a game the slate left out; it is still this week's.
  const named = [];
  for (const p of (b && b.picks) || []) if (p.matchup) named.push({ label: p.matchup, kickoff: p.time || '' });
  for (const p of (b && b.parlays) || []) for (const l of p.legs || []) if (l.game) named.push({ label: l.game, kickoff: '' });
  for (const n of named) {
    const pk = pairKey(n);
    if ((pk && byPair.has(pk)) || rows.some((r) => r.label === n.label)) continue;
    add({ id: idFor(n), label: n.label, kickoff: n.kickoff, kicker: '', onBoard: true });
  }

  // Research documents: onto their board game (by id, or by the two teams),
  // or as a game of their own when they were added this week.
  for (const raw of docs) {
    const d = forRead(raw.id, raw);
    if (!d) continue;
    const pk = pairKey(d);
    const target = byId.get(d.id) || (pk && byPair.get(pk));
    if (target) {
      const { id, label, kickoff, weekKey, ...research } = d;
      Object.assign(target, research, { docId: id, kickoff: target.kickoff || kickoff });
    } else if (current && d.weekKey === week) {
      add({ ...d, docId: d.id, onBoard: false });
    }
  }

  let skipped = 0;
  const games = rows.map((r) => {
    const espn = r.pair ? scoreboard.find((g) => g.away && g.home &&
      [g.away.teamId, g.home.teamId].sort().join('|') === r.pair) : null;
    const kickoffISO = (espn && espn.startsAt) || kickoffFor(r.kickoff, b && b.weekKey) || '';
    const state = espn ? espn.state : '';
    const started = !current || STARTED.has(state) ||
      (!!kickoffISO && Date.parse(kickoffISO) <= now);
    if (started) skipped++;
    const { pair, ...rest } = r;
    return { ...rest, weekKey: (b && b.weekKey) || '', kickoffISO, state, started, final: state === 'final',
      // The feed's line and DraftKings link for the game, when it is on it.
      line: (espn && espn.line) || '', lineSource: (espn && espn.lineSource) || '', dkUrl: (espn && espn.dkUrl) || '' };
  });
  return { week, current, games, upcoming: games.filter((g) => !g.started), skipped };
}

module.exports = { validate, validateUpdate, forRead, idFor, pairKey, teamsOf, kickoffFor, thisWeek, clean };
