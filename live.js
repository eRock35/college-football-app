/**
 * The live layer: today's scores, and what they mean for the reader's slip.
 *
 * ONE module owns the upstream. Today that is ESPN's public scoreboard JSON -
 * keyless, unofficial, and able to change shape or vanish without notice - so
 * everything it says is treated as untrusted input: every field is picked out
 * by name, type-checked, bounded, and stripped of anything that could become
 * markup, and any failure at all becomes "Live scores unavailable" rather than
 * a 500 or a blank board. Swapping the source for CollegeFootballData (keyed,
 * documented, rate-limited) means rewriting `fetchScoreboard` and
 * `normaliseEvent` to produce the same game shape; nothing downstream knows
 * where a score came from.
 *
 * No model call anywhere in here. It is arithmetic on a feed.
 *
 * BILLED PER REQUEST. The service runs with cpuIdle, so there is no timer and
 * no background refresh: the cache is filled by whichever request finds it
 * stale, and that request waits for the fetch. Any number of viewers polling
 * therefore costs one upstream fetch per TTL window, and nothing runs between
 * requests.
 */

const teams = require('./teams');

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300';

const TTL_MS = 20 * 1000;
// A feed that fails briefly should not blank a Saturday. The last good board
// is served, marked stale, for this long before the page says unavailable.
const STALE_OK_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_EVENTS = 300;
const UNAVAILABLE = 'Live scores unavailable';

/* ------------------------------------------------------------------ *
 * Cleaning untrusted strings
 * ------------------------------------------------------------------ */

/** A plain, bounded string, or ''. Objects, arrays and booleans are not text
 *  however the feed dresses them; control characters and angle brackets go
 *  (the page escapes too - this is the second lock, not the only one). */
function str(v, cap) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/** A whole number in [lo, hi], or null. "14" is a score; "14abc", 1e9, -3 and
 *  14.5 are not. */
function int(v, lo, hi) {
  if (typeof v === 'string' && !/^\s*-?\d{1,4}\s*$/.test(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

function num(v, lo, hi) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function isoOrEmpty(v) {
  const s = str(v, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s)) return '';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/* ------------------------------------------------------------------ *
 * Team names -> teams.js ids
 * ------------------------------------------------------------------ */

/**
 * The comparison key for a team name. Lowercase, accents and apostrophes gone
 * (San José, Hawai'i), "&" dropped (Texas A&M -> texas am), punctuation to
 * spaces, and "St"/"St." read as "State" - ESPN's short names abbreviate it
 * and nobody on FBS is a Saint.
 */
function teamKey(s) {
  return String(s === undefined || s === null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'ʻ`‘]/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w, i) => !(i === 0 && w === 'the'))
    .map((w) => (w === 'st' ? 'state' : w))
    .join(' ');
}

/**
 * Names a slip or the feed uses that teams.js does not spell out. Exact keys
 * only - there is no fuzzy matching anywhere, because a near-miss that lands
 * on the wrong team would show someone a status for a bet they did not make.
 * Deliberately absent: letters that name two schools (OSU, UT, KSU, UW,
 * CSU, MSU, and ISU/JSU/TTU/WSU, which an FCS opponent shares), and mascots
 * alone.
 */
const ALIASES = {
  uga: ['georgia'],
  alabama: ['bama'],
  'mississippi-state': ['miss state', 'miss st', 'mississippi st'],
  'ole-miss': ['mississippi'],
  'south-carolina': ['sc', 's carolina'],
  'texas-am': ['tamu', 'am'],
  vanderbilt: ['vandy'],
  lsu: ['louisiana state'],
  'ohio-state': ['tosu'],
  'penn-state': ['psu'],
  'michigan-state': [],
  usc: ['southern cal', 'southern california'],
  ucla: [],
  'boston-college': ['bc'],
  'florida-state': ['fsu'],
  'georgia-tech': ['gt', 'ga tech'],
  miami: ['miami fl', 'miami florida', 'the u'],
  'nc-state': ['north carolina state', 'n c state', 'ncsu'],
  'north-carolina': ['unc'],
  pittsburgh: ['pitt'],
  smu: ['southern methodist'],
  'virginia-tech': ['vt', 'va tech'],
  virginia: ['uva'],
  'wake-forest': ['wake'],
  byu: ['brigham young'],
  tcu: ['texas christian'],
  ucf: ['central florida'],
  'west-virginia': ['wvu'],
  'kansas-state': ['k state'],
  'oklahoma-state': ['ok state', 'okla state'],
  'notre-dame': ['nd'],
  uconn: ['connecticut'],
  'east-carolina': ['ecu'],
  'florida-atlantic': ['fau'],
  'south-florida': ['usf'],
  utsa: ['ut san antonio', 'texas san antonio'],
  'north-texas': ['unt'],
  'air-force': ['afa'],
  'boise-state': ['boise'],
  'san-diego-state': ['sdsu'],
  'san-jose-state': ['sjsu'],
  hawaii: [],
  'utah-state': ['usu'],
  'appalachian-state': ['app state', 'appalachian st'],
  'coastal-carolina': ['coastal', 'ccu'],
  'georgia-southern': ['ga southern'],
  'georgia-state': ['ga state'],
  'james-madison': ['jmu'],
  louisiana: ['ul lafayette', 'louisiana lafayette', 'ull'],
  'louisiana-monroe': ['ul monroe', 'ulm'],
  'old-dominion': ['odu'],
  'southern-miss': ['southern mississippi', 'usm'],
  'miami-oh': ['miami ohio', 'miami oh'],
  'northern-illinois': ['niu'],
  'central-michigan': ['cmu'],
  'eastern-michigan': ['emu'],
  'western-michigan': ['wmu'],
  'bowling-green': ['bgsu'],
  'kent-state': ['kent'],
  fiu: ['florida international'],
  'jacksonville-state': ['jax state', 'jacksonville st'],
  'louisiana-tech': ['la tech'],
  'middle-tennessee': ['mtsu', 'middle tennessee state', 'middle tenn'],
  'new-mexico-state': ['nmsu'],
  'sam-houston': ['sam houston state', 'shsu'],
  'western-kentucky': ['wku'],
  'washington-state': ['wazzu'],
  'oregon-state': [],
};

/** name -> id. Built once. A key two teams would both claim is dropped
 *  rather than given to whichever came first, and the test suite checks that
 *  no such key exists today. */
function buildIndex() {
  const claims = new Map();
  const claim = (key, id) => {
    if (!key) return;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key).add(id);
  };
  for (const t of teams.TEAMS) {
    claim(teamKey(t.name), t.id);
    claim(teamKey(`${t.name} ${t.mascot}`), t.id);
    claim(teamKey(t.id.replace(/-/g, ' ')), t.id);
    // An alias with the mascot is how the feed spells some of them in full:
    // "App State Mountaineers", "UL Monroe Warhawks".
    for (const a of ALIASES[t.id] || []) { claim(teamKey(a), t.id); claim(teamKey(`${a} ${t.mascot}`), t.id); }
  }
  const index = new Map();
  const ambiguous = [];
  for (const [key, ids] of claims) {
    if (ids.size === 1) index.set(key, [...ids][0]);
    else ambiguous.push(key);
  }
  return { index, ambiguous };
}
const INDEX = buildIndex();

/** A ranked prefix is not part of a name: "#7 LSU", "No. 7 LSU", "(7) LSU". */
function stripRank(s) {
  return String(s || '')
    .replace(/(^|\s)(#\s?\d{1,2}|no\.\s?\d{1,2}|\(\d{1,2}\))(?=\s|$)/gi, ' ')
    .trim();
}

/** A teams.js id, or null. Exact key match only. */
function resolveTeam(text) {
  const key = teamKey(stripRank(text));
  return key ? INDEX.index.get(key) || null : null;
}

/** ESPN's team -> a teams.js id, or null. Every name the feed gives is tried;
 *  if they disagree about who this is, it is nobody. */
function resolveEspnTeam(t) {
  const found = new Set();
  for (const f of [t.displayName, t.location, t.shortDisplayName,
    t.location && t.name ? `${t.location} ${t.name}` : '']) {
    const id = f ? resolveTeam(f) : null;
    if (id) found.add(id);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** "Florida at Auburn", "LSU vs. Ole Miss", "#7 LSU @ #8 Ole Miss",
 *  "LSU–Ole Miss", "LSU/Ole Miss" -> the ids it names (0, 1 or 2). */
function matchupTeams(text) {
  const s = String(text || '').replace(/\(([^)]*\d[^)]*)\)/g, ' ');
  const parts = s.split(/\s+(?:at|@|vs\.?|v\.?)\s+|\s*[\/–—]\s*|\s+-\s+/i);
  const ids = [];
  for (const p of parts) {
    const id = resolveTeam(p);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * Normalising the feed
 * ------------------------------------------------------------------ */

const STATES = new Set(['pre', 'in', 'half', 'final', 'postponed', 'canceled', 'delayed']);

function gameState(status) {
  const type = obj(status.type);
  const name = str(type.name, 40).toUpperCase();
  const state = str(type.state, 10).toLowerCase();
  if (/POSTPONED/.test(name)) return 'postponed';
  if (/CANCEL/.test(name)) return 'canceled';
  if (/HALFTIME/.test(name)) return 'half';
  if (state === 'in') return 'in';
  if (state === 'post') return 'final';
  if (state === 'pre') return /DELAY/.test(name) ? 'delayed' : 'pre';
  return null;
}

const LEADER_LABEL = [[/pass/i, 'Passing'], [/rush/i, 'Rushing'], [/receiv|rec/i, 'Receiving']];

function leaders(comp, sideOf) {
  // The game's leaders sit on the competition, or on each competitor, depending
  // on the feed's mood. Both are read; only the first three categories kept.
  const cats = arr(comp.leaders).length ? arr(comp.leaders)
    : arr(comp.competitors).flatMap((c) => arr(obj(c).leaders));
  const out = [];
  for (const cat of cats.slice(0, 12)) {
    const c = obj(cat);
    const catName = str(c.name, 40) + ' ' + str(c.displayName, 40);
    const label = (LEADER_LABEL.find(([re]) => re.test(catName)) || [])[1];
    if (!label || out.some((l) => l.label === label)) continue;
    const top = obj(arr(c.leaders)[0]);
    const athlete = obj(top.athlete);
    const name = str(athlete.shortName || athlete.displayName, 40);
    const line = str(top.displayValue, 60);
    if (!name || !line) continue;
    out.push({ label, name, line, side: sideOf(str(obj(top.team).id || obj(athlete.team).id, 12)) });
    if (out.length === 3) break;
  }
  return out;
}

function teamSide(c) {
  const t = obj(c.team);
  const teamId = resolveEspnTeam({
    displayName: str(t.displayName, 60), location: str(t.location, 60),
    shortDisplayName: str(t.shortDisplayName, 60), name: str(t.name, 40),
  });
  const meta = teamId ? teams.get(teamId) : null;
  const color = /^[0-9a-f]{6}$/i.test(str(t.color, 10)) ? '#' + str(t.color, 10) : '';
  const record = arr(c.records).map((r) => str(obj(r).summary, 12)).find((r) => /^\d{1,2}-\d{1,2}(-\d{1,2})?$/.test(r)) || '';
  const lines = arr(c.linescores).slice(0, 8).map((l) => int(obj(l).value, 0, 99));
  return {
    espnId: str(t.id, 12),
    teamId,
    // A team we know is named the way the rest of the app names it; only an
    // unknown one (an FCS opponent, a new FBS program) carries the feed's name.
    name: meta ? meta.name : (str(t.location, 40) || str(t.shortDisplayName, 40) || str(t.displayName, 40) || 'TBD'),
    mascot: str(t.name, 30),
    abbr: str(t.abbreviation, 6).toUpperCase(),
    color: meta ? meta.color : color,
    rank: int(obj(c.curatedRank).current, 1, 25),
    record,
    score: int(c.score, 0, 250),
    // A line score with a hole in it is not a line score.
    linescores: lines.every((n) => n !== null) ? lines : [],
  };
}

/** One ESPN event -> one game, or null when it cannot be read. */
function normaliseEvent(raw) {
  const ev = obj(raw);
  const id = str(ev.id, 20);
  if (!/^\d{1,20}$/.test(id)) return null;
  const comp = obj(arr(ev.competitions)[0]);
  const cs = arr(comp.competitors).map(obj);
  const homeRaw = cs.find((c) => c.homeAway === 'home');
  const awayRaw = cs.find((c) => c.homeAway === 'away');
  if (cs.length !== 2 || !homeRaw || !awayRaw) return null;
  const status = obj(comp.status && Object.keys(obj(comp.status)).length ? comp.status : ev.status);
  const state = gameState(status);
  if (!state) return null;

  const home = teamSide(homeRaw);
  const away = teamSide(awayRaw);
  const live = state === 'in' || state === 'half';
  const final = state === 'final';
  // A live or finished game with no readable score cannot say who is winning.
  // Keep it on the ticker, but with no scores, so nothing is computed from it.
  if ((live || final) && (home.score === null || away.score === null)) { home.score = null; away.score = null; }
  if (!live && !final) { home.score = null; away.score = null; }

  const clock = str(status.displayClock, 6);
  const sit = obj(comp.situation);
  const sideOf = (espnTeamId) => (espnTeamId && espnTeamId === home.espnId ? 'home'
    : espnTeamId && espnTeamId === away.espnId ? 'away' : '');
  const odds = obj(arr(comp.odds)[0]);
  const tv = [];
  for (const b of arr(comp.broadcasts).slice(0, 4)) {
    for (const n of arr(obj(b).names).slice(0, 3)) { const s = str(n, 16); if (s && !tv.includes(s)) tv.push(s); }
  }

  return {
    id,
    state,
    live,
    final,
    startsAt: isoOrEmpty(comp.date || ev.date),
    period: int(status.period, 0, 12) || 0,
    clock: /^\d{1,2}:\d{2}$/.test(clock) ? clock : '',
    detail: str(obj(status.type).shortDetail || obj(status.type).detail, 40),
    away,
    home,
    possession: live ? sideOf(str(sit.possession, 12)) : '',
    redZone: live && sit.isRedZone === true,
    downDistance: live ? str(sit.downDistanceText || sit.shortDownDistanceText, 60) : '',
    lastPlay: live || final ? str(obj(sit.lastPlay).text, 200) : '',
    leaders: live || final ? leaders(comp, sideOf) : [],
    tv: tv.slice(0, 2),
    venue: str(obj(comp.venue).fullName, 80),
    neutral: comp.neutralSite === true,
    line: str(odds.details, 40),
    overUnder: num(odds.overUnder, 20, 150),
  };
}

/** The US Eastern calendar day an instant falls on - the day a college
 *  football fan means by "today". */
function etDay(t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(t));
}

/**
 * The whole feed -> { games, all, anyLive, today, next }.
 *
 * `all` is every readable event (the week, as the feed gives it) and is what
 * slip picks are matched against; `games` is what the ticker draws: anything
 * live, plus everything whose kickoff is today in Eastern time.
 */
function normalise(raw, nowMs) {
  const events = arr(obj(raw).events);
  if (!Array.isArray(obj(raw).events)) throw new Error('feed has no events list');
  const all = [];
  const seen = new Set();
  for (const e of events.slice(0, MAX_EVENTS)) {
    const g = normaliseEvent(e);
    if (g && !seen.has(g.id)) { seen.add(g.id); all.push(g); }
  }
  const today = etDay(nowMs);
  const games = all.filter((g) => g.live || (g.startsAt && etDay(Date.parse(g.startsAt)) === today));
  const upcoming = all
    .filter((g) => g.state === 'pre' && g.startsAt && Date.parse(g.startsAt) > nowMs && etDay(Date.parse(g.startsAt)) !== today)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const next = upcoming[0]
    ? { startsAt: upcoming[0].startsAt, label: `${upcoming[0].away.name} at ${upcoming[0].home.name}` }
    : null;
  return { today, games: order(games), all, anyLive: games.some((g) => g.live), next };
}

/* ------------------------------------------------------------------ *
 * Ordering: your team, your slip, the Top 25, everyone else
 * ------------------------------------------------------------------ */

const STATE_ORDER = { in: 0, half: 0, delayed: 1, pre: 1, final: 2, postponed: 3, canceled: 3 };

function bestRank(g) {
  return Math.min(g.away.rank || 99, g.home.rank || 99);
}

/** Sorts a copy. `teamId` pins the reader's team; `slipIds` (a Set of game
 *  ids) comes next; then games with a ranked team; then the rest. Within a
 *  group, live before upcoming before final, then by rank, then by kickoff. */
function order(games, { teamId = null, slipIds = new Set() } = {}) {
  const group = (g) => {
    if (teamId && (g.away.teamId === teamId || g.home.teamId === teamId)) return 0;
    if (slipIds.has(g.id)) return 1;
    if (bestRank(g) <= 25) return 2;
    return 3;
  };
  return games
    .map((g) => ({ ...g, mine: group(g) === 0 ? 'team' : group(g) === 1 ? 'slip' : '' }))
    .sort((a, b) => group(a) - group(b)
      || (STATE_ORDER[a.state] ?? 4) - (STATE_ORDER[b.state] ?? 4)
      || bestRank(a) - bestRank(b)
      || String(a.startsAt).localeCompare(String(b.startsAt))
      || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * Reading a bet
 * ------------------------------------------------------------------ */

// Anything that is not a full-game side, total or moneyline. A first-half
// spread scored against the full-game score would be a confident wrong answer,
// which is worse than no answer.
const NOT_FULL_GAME = /\b(1h|2h|1st half|2nd half|first half|second half|half|halftime|1q|2q|3q|4q|q[1-4]|quarter|team total|tt|yards?|yds|tds?|touchdowns?|receptions?|passing|rushing|receiving|sacks?|interceptions?|anytime|first score|margin|exact|race to|winning margin|props?)\b/i;

function cleanBetText(s) {
  return String(s || '')
    .replace(/[−–—](?=\s?\d)/g, '-')          // unicode minus / dash before a number
    .replace(/\((?=[^)]*(?:\d|\bml\b|odds))[^)]*\)/gi, ' ')     // "(-115)", "(or ML +115)"; keeps "(OH)"
    .replace(/^\s*(spread|total|moneyline|money line|ml|side)\s*[·:|-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "Georgia -24.5" -> spread; "Under 58.5" / "o54.5" -> total; "Auburn ML",
 * "Auburn +115" -> moneyline; "Auburn PK" -> a spread of zero. Anything else,
 * or anything that is not about the full game, is null.
 */
function parseBet(text) {
  const s = cleanBetText(text);
  if (!s || s.length > 120 || NOT_FULL_GAME.test(s)) return null;

  let m = s.match(/^(.*?)\s*\b(over|under|o|u)\s?(\d{2,3}(?:\.[05])?)(?:\s+[+-]\d{3,4})?$/i);
  if (m) {
    const line = Number(m[3]);
    if (!(line >= 20 && line <= 150)) return null;
    return { type: 'total', dir: /^o/i.test(m[2]) ? 'over' : 'under', line, prefix: m[1].trim() };
  }
  m = s.match(/^(.+?)\s*(?:\bml\b|\bmoneyline\b|\bmoney line\b|\bto win\b|\bstraight up\b|\bwin outright\b)(?:\s+[+-]?\d{3,4})?$/i);
  if (m) return { type: 'ml', side: m[1].trim() };
  // Spread before a bare price: "Georgia -24.5 -115" is a spread at -115, not
  // a moneyline on a team called "Georgia -24.5".
  m = s.match(/^(.+?)\s*([+-]\s?\d{1,2}(?:\.[05])?|\bpk\b|\bpick(?:'?em)?\b)(?:\s+[+-]\d{3,4})?$/i);
  if (m) {
    const raw = m[2].replace(/\s/g, '');
    const line = /^[+-]/.test(raw) ? Number(raw) : 0;
    if (!Number.isFinite(line) || Math.abs(line) > 70) return null;
    return { type: 'spread', side: m[1].trim(), line };
  }
  // "Auburn +115": a price with no line is a moneyline.
  m = s.match(/^(.+?)\s+([+-]\d{3,5})$/);
  if (m) return { type: 'ml', side: m[1].trim() };
  return null;
}

/** The market kind a card declares, if any: "Spread · ...", own cards'
 *  "Moneyline", etc. A declared kind that contradicts the parsed bet means we
 *  do not understand the card, so it gets no status. */
function declaredKind(market) {
  const m = String(market || '').trim().match(/^(spread|total|moneyline|money line|ml|player prop|prop)\b/i);
  if (!m) return null;
  const k = m[1].toLowerCase();
  if (k === 'spread') return 'spread';
  if (k === 'total') return 'total';
  if (k === 'player prop' || k === 'prop') return 'prop';
  return 'ml';
}

/**
 * A bet (one straight pick, or one parlay leg) -> { bet, game } against the
 * feed, or null. `texts` are tried in order (title first, then the market
 * line); `matchup` names the game.
 */
function matchBet({ texts, market, matchup }, allGames) {
  const kind = declaredKind(market);
  if (kind === 'prop') return null;
  let bet = null;
  for (const t of texts) { bet = parseBet(t); if (bet) break; }
  if (!bet) return null;
  if (kind && kind !== bet.type) return null;

  const ids = matchupTeams(matchup);
  if (bet.type === 'total') {
    // "Georgia Over 30.5" is a team total, not the game's. A prefix naming
    // exactly one team is therefore refused rather than guessed at.
    const pre = bet.prefix ? matchupTeams(bet.prefix) : [];
    if (bet.prefix && pre.length === 1 && !resolveMatchupish(bet.prefix)) return null;
    for (const id of pre) if (!ids.includes(id)) ids.push(id);
  } else {
    const side = resolveTeam(bet.side);
    if (!side) return null;
    if (ids.length === 2 && !ids.includes(side)) return null;
    if (!ids.includes(side)) ids.push(side);
    bet.teamId = side;
  }
  if (!ids.length || ids.length > 2) return null;
  const hits = allGames.filter((g) => ids.every((id) => g.away.teamId === id || g.home.teamId === id));
  if (hits.length !== 1) return null;
  return { bet, game: hits[0] };
}

/** True when a total's prefix is a matchup ("LSU/Ole Miss") rather than one
 *  team ("Georgia"). */
function resolveMatchupish(prefix) {
  return /\s+(?:at|@|vs\.?|v\.?)\s+|[\/–—]|\s-\s/i.test(prefix);
}

/* ------------------------------------------------------------------ *
 * The maths
 * ------------------------------------------------------------------ */

const pts = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

/** Minutes of the 60 played, or null when the clock cannot be read. */
function elapsedMinutes(g) {
  if (g.state === 'final') return 60;
  if (g.state === 'half') return 30;
  if (g.state !== 'in') return 0;
  if (g.period > 4) return 60;            // overtime: regulation is spent
  if (g.period < 1) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(g.clock);
  if (!m) return null;
  const left = Math.min(15, Number(m[1]) + Number(m[2]) / 60);
  return (g.period - 1) * 15 + (15 - left);
}

// Five minutes in, a pace is noise: one early touchdown projects to 84.
const PACE_MIN_ELAPSED = 5;

/** Points on pace for the full 60, or null when it is too early to say. */
function pace(total, elapsed) {
  if (elapsed === null || elapsed < PACE_MIN_ELAPSED) return null;
  if (elapsed >= 60) return total;
  return total * 60 / elapsed;
}

function scoreLine(g) {
  const a = g.away.abbr || g.away.name;
  const h = g.home.abbr || g.home.name;
  return `${a} ${g.away.score}, ${h} ${g.home.score}`;
}

function clockLine(g) {
  if (g.state === 'final') return g.period > 4 ? 'Final/OT' : 'Final';
  if (g.state === 'half') return 'Halftime';
  if (g.period > 4) return g.period === 5 ? 'OT' : `${g.period - 4}OT`;
  const q = ['', '1st', '2nd', '3rd', '4th'][g.period] || '';
  return [q, g.clock].filter(Boolean).join(' ');
}

/**
 * One bet against one game -> its status, or null when there is nothing
 * honest to say (not started, postponed, no score).
 *
 * outcome: live -> 'hitting' | 'missing' | 'push' | 'pending'
 *          final -> 'won' | 'lost' | 'push'
 */
function evaluate(bet, g) {
  if (!(g.live || g.final)) return null;
  if (g.away.score === null || g.home.score === null) return null;
  const final = g.final;
  const detail = `${scoreLine(g)} · ${clockLine(g)}`;
  const base = { gameId: g.id, state: final ? 'final' : 'live', detail };

  if (bet.type === 'spread' || bet.type === 'ml') {
    const mine = g.home.teamId === bet.teamId ? g.home : g.away.teamId === bet.teamId ? g.away : null;
    if (!mine) return null;
    const theirs = mine === g.home ? g.away : g.home;
    const margin = mine.score - theirs.score;
    if (bet.type === 'ml') {
      if (final) {
        const outcome = margin > 0 ? 'won' : margin < 0 ? 'lost' : 'push';
        return { ...base, outcome, text: margin > 0 ? `Won by ${margin}` : margin < 0 ? `Lost by ${-margin}` : 'Tied — push' };
      }
      return { ...base, outcome: margin > 0 ? 'hitting' : margin < 0 ? 'missing' : 'push',
        text: margin > 0 ? `Leading by ${margin}` : margin < 0 ? `Trailing by ${-margin}` : 'Tied' };
    }
    const adj = margin + bet.line;
    if (final) {
      const outcome = adj > 0 ? 'won' : adj < 0 ? 'lost' : 'push';
      return { ...base, outcome, text: adj > 0 ? `Covered by ${pts(adj)}` : adj < 0 ? `Missed by ${pts(-adj)}` : 'Landed on the number — push' };
    }
    if (adj > 0) return { ...base, outcome: 'hitting', text: `Covering by ${pts(adj)}` };
    if (adj === 0) return { ...base, outcome: 'push', text: 'On the number — a push as it stands' };
    const need = Math.floor(-adj) + 1;
    const toPush = Number.isInteger(adj) ? ` (${-adj} to push)` : '';
    return { ...base, outcome: 'missing', text: `Needs ${need} more to cover${toPush}` };
  }

  // Totals
  const total = g.away.score + g.home.score;
  const label = `${bet.dir} ${pts(bet.line)}`;
  if (final) {
    const outcome = total === bet.line ? 'push'
      : (bet.dir === 'over') === (total > bet.line) ? 'won' : 'lost';
    return { ...base, outcome, text: `${total} total (${label})` };
  }
  // Already decided while the game is still on: an over that has cleared, an
  // under that has been passed. More scoring cannot undo either.
  if (total > bet.line) {
    return bet.dir === 'over'
      ? { ...base, outcome: 'hitting', clinched: true, text: `Already over — ${total} so far (${label})` }
      : { ...base, outcome: 'missing', clinched: true, text: `Already past it — ${total} so far (${label})` };
  }
  const proj = pace(total, elapsedMinutes(g));
  if (proj === null) return { ...base, outcome: 'pending', text: `${total} so far — too early for a pace (${label})` };
  const outcome = proj === bet.line ? 'push' : (bet.dir === 'over') === (proj > bet.line) ? 'hitting' : 'missing';
  return { ...base, outcome, pace: Math.round(proj), text: `On pace for ${Math.round(proj)} (${label})` };
}

/* ------------------------------------------------------------------ *
 * The reader's slip
 * ------------------------------------------------------------------ */

const clip = (v, n) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, n) : '');

/** What the page sends: the plays it is drawing as placed. Bounded - this is
 *  request input from anyone. */
function cleanSlipItems(raw) {
  return arr(raw).slice(0, 30).map((r) => {
    const o = obj(r);
    const id = clip(o.id, 60);
    if (!id) return null;
    return {
      id,
      kind: o.kind === 'parlay' ? 'parlay' : 'straight',
      title: clip(o.title, 120),
      matchup: clip(o.matchup, 160),
      market: clip(o.market, 160),
      legs: arr(o.legs).slice(0, 12).map((l) => ({ game: clip(obj(l).game, 160), market: clip(obj(l).market, 160) })),
    };
  }).filter(Boolean);
}

/** A matched game with nothing to score yet: not started, or called off. */
function notUnderway(g) {
  if (g.state === 'postponed' || g.state === 'canceled') {
    return { gameId: g.id, state: 'off', outcome: 'void', text: g.state === 'postponed' ? 'Postponed' : 'Canceled', detail: '' };
  }
  return { gameId: g.id, state: 'pre', outcome: 'pending', text: '', detail: '' };
}

function statusFor(item, allGames) {
  if (item.kind === 'straight') {
    const hit = matchBet({ texts: [item.title, item.market], market: item.market, matchup: item.matchup }, allGames);
    if (!hit) return { id: item.id, kind: 'straight', matched: false };
    const st = evaluate(hit.bet, hit.game) || notUnderway(hit.game);
    return { id: item.id, kind: 'straight', matched: true, gameId: hit.game.id, title: item.title, ...st };
  }

  const legs = item.legs.map((l) => {
    const hit = matchBet({ texts: [l.market], market: l.market, matchup: l.game }, allGames);
    if (!hit) return { game: l.game, market: l.market, matched: false };
    const st = evaluate(hit.bet, hit.game) || notUnderway(hit.game);
    return { game: l.game, market: l.market, matched: true, gameId: hit.game.id, ...st };
  });
  const out = { id: item.id, kind: 'parlay', title: item.title, legs, gameIds: [...new Set(legs.filter((l) => l.matched).map((l) => l.gameId))] };
  return { ...out, ...parlayStatus(legs) };
}

/**
 * A parlay from its legs. Lost the moment any leg loses, whatever the others
 * say. Won only when every leg is known, final and won (a pushed leg drops
 * out; all pushes is a push). Otherwise "2 of 3 legs hitting".
 */
function parlayStatus(legs) {
  const total = legs.length;
  const known = legs.filter((l) => l.matched && (l.state === 'live' || l.state === 'final'));
  const hitting = legs.filter((l) => l.outcome === 'hitting' || l.outcome === 'won').length;
  const toPlay = legs.filter((l) => l.matched && l.state === 'pre').length;
  const lostLeg = legs.find((l) => l.outcome === 'lost');
  if (!known.length) return { matched: legs.some((l) => l.matched), state: 'pre', outcome: 'pending', text: '', hitting: 0, total };
  if (lostLeg) return { matched: true, state: 'final', outcome: 'lost', text: `Lost — ${lostLeg.market || 'a leg'} missed`, hitting, total };
  const allFinal = legs.every((l) => l.matched && l.state === 'final');
  if (allFinal) {
    const allPush = legs.every((l) => l.outcome === 'push');
    return { matched: true, state: 'final', outcome: allPush ? 'push' : 'won',
      text: allPush ? 'Every leg pushed' : `Cashed — ${hitting} of ${total} legs won${hitting < total ? ', the rest pushed' : ''}`, hitting, total };
  }
  const missing = legs.some((l) => l.outcome === 'missing');
  const extra = [];
  if (toPlay) extra.push(`${toPlay} to play`);
  const unknown = legs.filter((l) => !l.matched).length;
  if (unknown) extra.push(`${unknown} not tracked`);
  return {
    matched: true, state: 'live', outcome: missing ? 'missing' : 'hitting',
    text: `${hitting} of ${total} legs hitting` + (extra.length ? ` · ${extra.join(' · ')}` : ''),
    hitting, total,
  };
}

function slipStatus(items, allGames) {
  return cleanSlipItems(items).map((it) => statusFor(it, allGames));
}

/** Game ids the slip touches, for ordering and for which games alert. */
function slipGameIds(statuses) {
  const ids = new Set();
  for (const s of statuses) {
    if (s.gameId) ids.add(s.gameId);
    for (const id of s.gameIds || []) ids.add(id);
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * The feed, cached
 * ------------------------------------------------------------------ */

async function fetchScoreboard(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'college-football-app (+https://footballapp.strongtechnicalconsulting.com)' },
    });
    if (!r || !r.ok) throw new Error(`upstream status ${r && r.status}`);
    const len = Number(r.headers && r.headers.get ? r.headers.get('content-length') : 0);
    if (len > MAX_BYTES) throw new Error('upstream body too large');
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('upstream body too large');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shared, cached scoreboard. `get()` resolves to either
 *   { available: true, stale, fetchedAt, today, games, all, anyLive, next }
 * or
 *   { available: false, message }
 * and never rejects. Concurrent callers share one in-flight fetch.
 */
function createFeed({ fetch: fetchImpl, url = ESPN_SCOREBOARD, ttlMs = TTL_MS, staleOkMs = STALE_OK_MS,
  timeoutMs = FETCH_TIMEOUT_MS, now = Date.now, log = console } = {}) {
  let cached = null;      // { at, result }
  let lastGood = null;    // { at, data }
  let inflight = null;
  let upstreamCalls = 0;

  async function refresh() {
    upstreamCalls++;
    try {
      const raw = await fetchScoreboard(fetchImpl, url, timeoutMs);
      const data = normalise(raw, now());
      lastGood = { at: now(), data };
      return { available: true, stale: false, fetchedAt: new Date(lastGood.at).toISOString(), ...data };
    } catch (err) {
      log.error('[live] scoreboard fetch failed:', err && err.message ? err.message : err);
      if (lastGood && now() - lastGood.at < staleOkMs) {
        return { available: true, stale: true, fetchedAt: new Date(lastGood.at).toISOString(), ...lastGood.data };
      }
      return { available: false, message: UNAVAILABLE };
    }
  }

  async function get() {
    if (cached && now() - cached.at < ttlMs) return cached.result;
    if (!inflight) {
      inflight = refresh().then((result) => {
        // A failure is cached too, for the same window: a feed that is down
        // should cost one attempt per 20 s, not one per viewer.
        cached = { at: now(), result };
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { get, stats: () => ({ upstreamCalls }) };
}

/** What a route sends: the ticker's games without the week-long `all`. */
function publicView(result, { teamId = null, slipIds = new Set() } = {}) {
  if (!result || !result.available) return { available: false, message: UNAVAILABLE };
  return {
    available: true,
    stale: result.stale,
    fetchedAt: result.fetchedAt,
    today: result.today,
    anyLive: result.anyLive,
    next: result.next,
    games: order(result.games, { teamId, slipIds }),
  };
}

module.exports = {
  ESPN_SCOREBOARD, TTL_MS, UNAVAILABLE, INDEX,
  teamKey, resolveTeam, resolveEspnTeam, matchupTeams,
  normalise, normaliseEvent, order, etDay,
  parseBet, matchBet, evaluate, elapsedMinutes, pace, parlayStatus,
  cleanSlipItems, slipStatus, slipGameIds,
  createFeed, publicView, STATES,
  // The cleaning helpers, for teamfacts.js: the same upstream, the same rules.
  str, int, isoOrEmpty, gameState, obj, arr,
};
