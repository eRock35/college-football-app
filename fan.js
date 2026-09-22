/**
 * A team's own page: rank, record, next game, season schedule, storylines.
 *
 * This is `board.js` for the My Team tab, and it exists for the same reason.
 * The content comes out of a model with web search, the page interpolates it
 * into innerHTML, and a schedule row with no opponent or a kickoff that is not
 * a date renders as a broken tab that needs a deploy to fix. validate() runs
 * on the PROPOSAL, before anything is written, so a bad research run fails
 * loudly and the last good document keeps serving.
 *
 * The one difference from the board: there is no seed. A board must always
 * have something to show, because it is the front page. A team page can
 * honestly say "not researched yet" and offer the button that fixes it, and
 * that is better than shipping 130 fabricated schedules to make the tab look
 * full.
 *
 * `secRecord` is read but never written. It is what the hand-built Georgia
 * document used before this tab could be any team; `confRecord` is the name
 * that makes sense for a Big Ten team, and dropping the old one on read would
 * blank a field on the one document that already had real content in it.
 */

const MAX = { id: 60, short: 120, line: 400, prose: 2000 };

const clean = (v, cap) => String(v === undefined || v === null ? '' : v)
  .replace(/[<>]/g, '')
  .trim()
  .slice(0, cap);

/** An ISO instant, or ''. The page runs a live countdown off this, and
 *  `new Date('soon')` is an Invalid Date that renders as NaN and never
 *  recovers. */
function instant(value) {
  const s = clean(value, MAX.id);
  if (!s) return '';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

const LOCATIONS = new Set(['home', 'away', 'neutral', 'bye']);

function row(raw, i) {
  const opp = clean(raw && raw.opp, MAX.short);
  if (!opp) throw new Error(`schedule row ${i + 1} has no opponent`);
  const loc = clean(raw.loc, 10).toLowerCase();
  return {
    wk: clean(raw.wk, MAX.id),
    opp,
    loc: LOCATIONS.has(loc) ? loc : 'home',
    result: clean(raw.result, MAX.short),
    // Flags, not strings: the page keys CSS classes off them.
    current: raw.current === true,
    ranked: raw.ranked === true,
    rivalry: raw.rivalry === true,
  };
}

function nextGame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const opponent = clean(raw.opponent, MAX.short);
  if (!opponent) return null;
  return {
    opponent,
    kickoffISO: instant(raw.kickoffISO),
    tv: clean(raw.tv, MAX.id),
    line: clean(raw.line, MAX.short),
    // Ties the tab to a card on the board, so "my team plays Saturday" and
    // the slate agree about which game that is. Optional: a team on a bye,
    // or one whose game the board did not cover, simply has no card.
    gameId: clean(raw.gameId, MAX.id),
  };
}

/**
 * Returns a clean team page, or throws with a reason a human can act on.
 *
 * Only `team` is structurally required. A team can genuinely be unranked, on
 * a bye, and between storylines, and refusing to store that would mean the
 * tab stays empty for exactly the teams nobody writes about.
 */
function validate(raw, teamId) {
  if (!raw || typeof raw !== 'object') throw new Error('team page is not an object');
  const team = clean(teamId || raw.team, MAX.id);
  if (!team) throw new Error('team page has no team');

  const schedule = (Array.isArray(raw.schedule) ? raw.schedule : []).map(row);
  const storyline = (Array.isArray(raw.storyline) ? raw.storyline : [])
    .map((s) => clean(s, MAX.prose))
    .filter(Boolean)
    .slice(0, 6);

  // At most one row is "this week". Two highlighted rows is a schedule that
  // cannot say where the season is.
  let marked = false;
  for (const r of schedule) {
    if (!r.current) continue;
    if (marked) r.current = false;
    marked = true;
  }

  return {
    team,
    rank: clean(raw.rank, 12),
    record: clean(raw.record, 24),
    confRecord: clean(raw.confRecord || raw.secRecord, 24),
    nextGame: nextGame(raw.nextGame),
    schedule,
    storyline,
    lastChecked: instant(raw.lastChecked) || new Date().toISOString(),
  };
}

module.exports = { validate };
