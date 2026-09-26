const express = require('express');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createPasskeyAuth } = require('./auth');
const analytics = require('./analytics');
const sitepass = require('./sitepass');
const board = require('./board');
const gamesLib = require('./games');
const teams = require('./teams');
const fan = require('./fan');
const live = require('./live');
const teamfacts = require('./teamfacts');
const identityLib = require('./identity');
const identityStore = require('./identity-store');

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE_ID || 'college-football-app';

const SITE_LOGIN_USERNAME = process.env.SITE_LOGIN_USERNAME || '';
const SITE_LOGIN_PASSWORD = process.env.SITE_LOGIN_PASSWORD || '';
// Cloud Scheduler's key. Deliberately NOT the site login: a scheduler job
// config is readable by anyone with project access, and the site password is
// something a person types.
const CRON_SECRET = process.env.CRON_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
// Who may spend Anthropic tokens. Anyone can register an account and keep a
// slip; research and chat are the owner's. Comma-separated, matched on the
// normalized email. Unset means nobody qualifies by email - which fails
// CLOSED, and the site password below still works as the owner's way in.
const RESEARCH_ALLOWED_EMAILS = (process.env.RESEARCH_ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isResearchEmail(email) {
  return RESEARCH_ALLOWED_EMAILS.indexOf(String(email || '').trim().toLowerCase()) !== -1;
}

const db = new Firestore({ projectId: PROJECT_ID, databaseId: FIRESTORE_DB });
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const app = express();
// Cloud Run terminates TLS in front of us, so without this req.protocol is
// "http" and every share link went out as http:// (audit, 2026-09-26).
app.set('trust proxy', true);
// Text only: the page is ~250 KB of HTML and the board a few dozen KB of
// JSON, both of which gzip to a fraction.
app.use(compression());
app.use(express.json());

// Only the landing page may put this app in a frame - it shows a live
// preview you can swipe through. Nothing else should be able to: a gated app
// inside a hostile page is the setup for clickjacking a signed-in session.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});
// Analytics. Serves an inert file unless GA_MEASUREMENT_ID is set.
analytics.mount(app, 'football');

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth: HTTP Basic, route-scoped. Gates only routes that spend API tokens.
// ---------------------------------------------------------------------------
/** The Basic Auth header, checked against whatever the CURRENT password is.
 *  Async because the current one may be the stored password rather than the
 *  environment variable; comparing to the env var would leave a retired
 *  password working here after a change. */
async function passwordOk(req) {
  if (!SITE_LOGIN_USERNAME) return false;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (decoded.slice(0, sep) !== SITE_LOGIN_USERNAME) return false;
  return sitePassword.verify(decoded.slice(sep + 1));
}

// The registration form posts the owner password in its own field instead of
// leaning on the browser's Basic dialog - see the note in auth.js. Scoped to
// registration: every other gate stays header-only.
async function passwordOkForRegistration(req) {
  if (await passwordOk(req)) return true;
  const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  return sitePassword.verify(supplied);
}

// Any registered account, or the password. Gates things every signed-in user
// may do - keeping a slip - not the things that cost money.
//
// No `WWW-Authenticate` on any API answer (audit, 2026-09-26): with it, a
// stranger who tapped an owner-only button got the browser's native password
// box for a password they do not have. Every refusal is JSON the page can
// explain. The one place a Basic prompt is still offered is /api/login?prompt=1,
// which no button reaches - the owner types it.
async function requireLogin(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  if (signedIn(req)) return next();
  if (await passwordOk(req)) return next();
  return res.status(401).json({ error: 'not signed in' });
}

// Same credentials as requireLogin, but a 401 here deliberately omits the
// WWW-Authenticate header. The slip routes are polled on page load, and with
// that header every anonymous visitor would get a native browser login popup
// before they'd even seen the page. Without it the fetch just fails and the
// page falls back to localStorage.
async function requireLoginSilent(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  if (signedIn(req)) return next();
  if (await passwordOk(req)) return next();
  return res.status(401).json({ error: 'not signed in' });
}

/**
 * Which week it is: the Tuesday that starts the week containing the next
 * Saturday of games, turning over at 6 AM Eastern on Sunday (board.weekKeyAt).
 *
 * ONE week for the board, the slip and the board arrangement (2026-09-26).
 * The slip used to have its own week, rolling on Tuesday, while the board
 * turned over on Sunday - so plays placed Sunday or Monday from the new board
 * were filed under the old week and wiped on Tuesday. The board still turns
 * over on Sunday or Monday, when the weekend is settled; a Sunday rebuild is
 * stamped with the coming weekend's week, never the one that just finished.
 */
function boardWeekKey() {
  return board.weekKeyAt(Date.now());
}

/** The week a stored slip belongs to. Worked out from when it was SAVED
 *  rather than from its stored weekKey: slips saved before 2026-09-26 carry
 *  the old Tuesday week, and a Sunday save under that scheme was a play on the
 *  new board. Reading every slip by its save time keeps those readable
 *  through the switch, and new ones agree with their weekKey anyway. */
function slipWeekOf(data) {
  const t = Date.parse((data && data.updatedAt) || '');
  return Number.isFinite(t) ? board.weekKeyAt(t) : (data && data.weekKey) || '';
}

const passkeyAuth = createPasskeyAuth({
  db,
  collection: 'webauthn-credentials',
  usersCollection: 'users',
  rpName: 'College Football App',
  sessionSecret: SESSION_SECRET,
  passwordOk: passwordOkForRegistration,
  // Claiming an allowlisted address needs the site password. Without that,
  // anyone could register the owner's email and hand themselves research.
  needsPasswordForEmail: isResearchEmail,
  isResearchEmail,
  // What the page may offer this reader (2026-09-26). canResearch here is the
  // whole of requireResearch - the allowlist, a shared-account grant, or the
  // site password - where auth.js alone only knows the allowlist; the owner's
  // buttons are hidden from everyone it says no to.
  statusExtra: async (req) => {
    // This route is mounted before the shared account's middleware, so the
    // shared session is read here or an owner signed in there reads as no one.
    if (!req.user) await new Promise((done) => identity.attachUser(req, null, done));
    return { canResearch: await mayResearch(req), signedInAnywhere: signedIn(req) };
  },
});
passkeyAuth.mount(app);

// The shared account, mounted at its own /api/id so it collides with nothing
// this app already serves. There is deliberately NO new UI here: the session
// cookie is scoped to the parent domain, so signing in on any sibling app
// means this one already sees you on the next request. This app's own
// registration stays exactly as it was, as the second door.
const identity = identityLib.create({
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'football',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'College Football App',
});
identity.mount(app);
// Every Anthropic call through this client is now priced and recorded.
identity.meter(anthropic);

/** Whoever is signed in, by either door. The shared account wins when both
 *  are present, since it is the one that means something across the domain.
 *  `uid` differs between them - identity derives base64url of the email, this
 *  app's own accounts used the raw address - so callers must not assume. */
function currentUser(req) {
  if (req.user) return { uid: req.user.id, email: req.user.email, shared: true, access: req.user.access };
  const me = passkeyAuth.currentUser(req);
  return me ? { uid: me.uid, email: me.email, shared: false } : null;
}

function signedIn(req) {
  return Boolean(req.user) || passkeyAuth.hasSession(req);
}

// The site password can be changed without a deploy. The env var stays as the
// bootstrap: it is what works on a fresh deploy, and what still works if the
// stored password is ever cleared.
//
// Who may change it is narrower here than in the single-account apps. This app
// has many accounts, but only ONE site password, and it is the owner's - it
// gates research spending. So an ordinary user's passkey must not be able to
// change it; the proof is the current password, or a Face ID session belonging
// to an address that is allowed to spend.
const sitePassword = sitepass.create({
  store: {
    async get(c, i) { const d = await db.collection(c).doc(i).get(); return d.exists ? d.data() : null; },
    async set(c, i, v) { await db.collection(c).doc(i).set(v); },
  },
  envPassword: () => SITE_LOGIN_PASSWORD,
  canChange: async (req) => {
    const supplied = (req.body || {}).current;
    if (supplied && await sitePassword.verify(supplied)) return true;
    // A Face ID session proves identity at least as well as the password it
    // would replace - by either door - but it still has to belong to someone
    // allowed to spend, since this password is what gates that.
    const viaPasskey = (req.user && req.user.via === 'passkey') || passkeyAuth.sessionVia(req) === 'passkey';
    if (!viaPasskey) return false;
    const me = currentUser(req);
    if (!me) return false;
    return isResearchEmail(me.email) || identityLib.hasAccess(req.user, 'football', 'research');
  },
});
sitePassword.mount(app);

// Anything that spends Anthropic tokens. A signed-in allowlisted account, or
// the site password - which only the owner has, and which therefore doubles as
// the way in if RESEARCH_ALLOWED_EMAILS was never set on the service.
//
// A signed-in account that simply isn't allowed gets 403, deliberately: a 401
// here would pop the browser's password box at an ordinary user who has no
// password to type and never will.
async function requireResearch(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  // MUST be awaited. This is the gate on everything that spends Anthropic
  // tokens, and `if (promise)` is always true.
  if (await passwordOk(req)) return next();
  const me = currentUser(req);
  // Three ways to qualify: the env allowlist (how it always worked), an admin
  // grant on the shared account, or the site password above.
  if (me && isResearchEmail(me.email)) return next();
  if (me && identityLib.hasAccess(req.user, 'football', 'research')) return next();
  // JSON, and no WWW-Authenticate: see requireLogin.
  if (!me) return res.status(401).json({ error: 'not signed in' });
  return res.status(403).json({ error: 'not_permitted' });
}

/** The same question as requireResearch, answered rather than enforced - for
 *  /api/auth/status, so the page shows owner-only buttons to the owner only. */
async function mayResearch(req) {
  if (await passwordOk(req)) return true;
  const me = currentUser(req);
  return !!(me && (isResearchEmail(me.email) || identityLib.hasAccess(req.user, 'football', 'research')));
}

// Scheduler-or-human gate: a cron key, or a research-permitted human.
function requireLoginOrCron(req, res, next) {
  const key = req.get('X-Cron-Key');
  if (CRON_SECRET && key && key === CRON_SECRET) return next();
  return requireResearch(req, res, next);
}

// The owner's Basic-auth door. It answers JSON like every other route unless
// asked for the prompt with ?prompt=1, which no button on the page sends: a
// native password box is for the one person who has the password, typed on
// purpose, never something a stranger's tap can raise.
app.get('/api/login', async (req, res, next) => {
  if (req.query.prompt === '1' && !signedIn(req) && !(await passwordOk(req))) {
    res.set('WWW-Authenticate', 'Basic realm="College Football App"');
    return res.status(401).json({ error: 'not signed in' });
  }
  return requireLogin(req, res, next);
}, (req, res) => {
  res.json({ ok: true, weekKey: boardWeekKey() });
});

// One slip document per account. Before accounts there was a single shared
// 'slip' document; without this every signed-in visitor would write over the
// owner's.
function slipDocId(req) {
  const me = currentUser(req);
  return me ? me.uid : 'slip';
}

/** The same person under this app's older key. Accounts here were keyed by the
 *  raw address; the shared account uses base64url of it. Reading the old
 *  document once keeps a slip from vanishing the first time someone arrives on
 *  the shared session instead of this app's own. */
function legacySlipDocId(req) {
  const me = currentUser(req);
  return me && me.shared ? me.email : null;
}

// Cross-device slip state. Gated: this app is public, and an ungated write
// route would let any visitor scribble on the slip.
app.get('/api/slip', requireLoginSilent, async (req, res) => {
  try {
    const week = boardWeekKey();
    const id = slipDocId(req);
    let doc = await db.collection('user-state').doc(id).get();
    // The owner's pre-accounts slip lived under 'slip'. Read it once as a
    // fallback so the current week survives the migration; the next save
    // writes to their own document and this stops mattering.
    const me = currentUser(req);
    if (!doc.exists || slipWeekOf(doc.data()) !== week) {
      // This app's older per-account key, then the owner's pre-accounts slip.
      for (const fallback of [legacySlipDocId(req), (me && isResearchEmail(me.email)) ? 'slip' : null]) {
        if (!fallback || fallback === id) continue;
        const legacy = await db.collection('user-state').doc(fallback).get();
        if (legacy.exists && slipWeekOf(legacy.data()) === week) { doc = legacy; break; }
      }
    }
    const data = doc.exists ? doc.data() : null;
    // Last week's slip is stale by definition - don't hand it back.
    if (!data || slipWeekOf(data) !== week) {
      return res.json({ weekKey: week, slip: {}, customPicks: {}, bankroll: '', board: boardPrefs(null) });
    }
    res.json({
      weekKey: week,
      // Cleaned on the way out as well as in: a slip saved before these
      // rules existed is still drawn by the page.
      slip: cleanSlip(data.slip),
      customPicks: cleanCustomPicks(data.customPicks),
      bankroll: data.bankroll || '',
      board: boardPrefs(data.board),
      updatedAt: data.updatedAt || null,
    });
  } catch (err) {
    console.error('GET /api/slip', err);
    res.status(500).json({ error: 'Failed to load slip.' });
  }
});

// Share a slip by link.
//
// A slip is the one thing here worth sending to someone: "this is what I am
// on this week". It was locked to one account across that account's own
// devices, which is sync, not sharing.
//
// The snapshot is a COPY, not a live view of the slip. Someone who opens the
// link a day later should see what was sent, not whatever has been edited
// since - and a live view would also mean a link that keeps reading a private
// document forever. The bankroll is deliberately left out: the stake on each
// play travels with the pick because that is part of what was sent, but the
// size of the roll behind it is nobody else's business.
//
// The pick prose (title, market, why, risk) lives in public/index.html as a
// literal and the server has never seen it, so the browser sends the resolved
// items it is already showing. That also keeps the snapshot honest once next
// week's card replaces this week's: the link still renders what was sent,
// rather than resolving stale ids against a board that has moved on.
const clipStr = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const finiteNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Who a shared slip says it is from: the first word of the display name the
 *  shared account chose, or "A reader". Never the email - a share link is
 *  public, and "erik.strong" from erik.strong@... is half an address. */
function sharerName(req) {
  const name = String((req.user && req.user.displayName) || '')
    .replace(/[^\p{L}\p{M}' -]/gu, '').trim().split(/\s+/)[0] || '';
  return name ? name.slice(0, 30) : 'A reader';
}

// Anything stored here is served to strangers, so every field is clamped to a
// plain string of bounded length and the page escapes all of it on render.
function cleanSharedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clipStr(raw.title, 120);
  if (!title) return null;
  return {
    kind: raw.kind === 'parlay' ? 'parlay' : 'straight',
    title,
    matchup: clipStr(raw.matchup, 160),
    time: clipStr(raw.time, 80),
    market: clipStr(raw.market, 160),
    odds: finiteNum(raw.odds),
    legs: (Array.isArray(raw.legs) ? raw.legs : []).slice(0, 12).map((l) => ({
      game: clipStr(l && l.game, 160),
      market: clipStr(l && l.market, 160),
      odds: finiteNum(l && l.odds),
    })),
    why: clipStr(raw.why, 2000),
    risk: clipStr(raw.risk, 2000),
    stake: Math.max(0, finiteNum(raw.stake)),
    toWin: Math.max(0, finiteNum(raw.toWin)),
  };
}

app.post('/api/slip/share', requireLoginSilent, async (req, res) => {
  try {
    const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
      .slice(0, 30)
      .map(cleanSharedItem)
      .filter(Boolean);
    if (!items.length) {
      return res.status(400).json({ error: 'Nothing on your slip to share yet.' });
    }
    const shareId = crypto.randomBytes(9).toString('base64url');
    await db.collection('shared-slips').doc(shareId).set({
      items,
      totalRisk: items.reduce((n, i) => n + i.stake, 0),
      totalToWin: items.reduce((n, i) => n + i.toWin, 0),
      weekKey: boardWeekKey(),
      by: sharerName(req),
      byKind: 'name',
      createdAt: new Date().toISOString(),
    });
    res.json({ shareId, url: `${req.protocol}://${req.get('host')}/s/${shareId}` });
  } catch (err) {
    console.error('POST /api/slip/share', err);
    res.status(500).json({ error: 'Could not share that slip.' });
  }
});

// Open to anyone with the link - that is what a share is. It carries no
// account, no bankroll and no way back to the person's other slips.
app.get('/api/shared-slip/:shareId', async (req, res) => {
  try {
    const doc = await db.collection('shared-slips').doc(String(req.params.shareId).slice(0, 40)).get();
    if (!doc.exists) return res.status(404).json({ error: 'That slip is not here.' });
    const d = doc.data();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      items: d.items || [],
      totalRisk: d.totalRisk || 0,
      totalToWin: d.totalToWin || 0,
      weekKey: d.weekKey,
      // Links made before 2026-09-26 stored the sender's email local part.
      // Those are public to anyone with the link, so they read as "A reader"
      // now; only a name the account chose is ever shown.
      by: d.byKind === 'name' && d.by ? d.by : 'A reader',
      createdAt: d.createdAt,
      stale: board.weekKeyAt(Date.parse(d.createdAt) || 0) !== boardWeekKey(),
    });
  } catch (err) {
    console.error('GET /api/shared-slip', err);
    res.status(500).json({ error: 'Could not load that slip.' });
  }
});

/**
 * How one person has arranged this week's board: what they hid, what they
 * pinned to the top, the order they put it in, and any card they wrote
 * themselves.
 *
 * It rides on the slip document, which is week-scoped - so an arrangement
 * expires with the board it arranged. Hiding a game in week 3 should not hide
 * anything in week 4, because the ids mean different games by then.
 *
 * Bounded on the way in. This is a user-writable document that the page reads
 * back and draws, so an unbounded array here is a way to make somebody's own
 * board unopenable, and Firestore will not store a nested array at all.
 */
const OWN_CARD_MAX = { id: 60, short: 120, line: 400 };
const OWN_MARKETS = new Set(['Spread', 'Total', 'Moneyline', 'Player prop', 'Other']);

/** American odds as a number, or null. Anything inside -100..+100 is not an
 *  American price, whatever it parses to. */
function american(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).trim().replace(/^\+/, ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null;
}

function boardPrefs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  // Card ids go into data-* attributes when the page draws them back, so only
  // ids in the board's own alphabet are kept (board.ID_RE).
  const ids = (v) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === 'string' && board.ID_RE.test(x))
    .slice(0, 200);
  const text = (v, cap) => String(v === undefined || v === null ? '' : v)
    .replace(/[<>]/g, '').trim().slice(0, cap);
  return {
    hidden: ids(obj.hidden),
    pinned: ids(obj.pinned),
    order: ids(obj.order),
    own: (Array.isArray(obj.own) ? obj.own : []).slice(0, 25).map((c, i) => ({
      id: board.cleanId(c && c.id, `own-${i + 1}`),
      title: text(c && c.title, OWN_CARD_MAX.short),
      matchup: text(c && c.matchup, OWN_CARD_MAX.short),
      time: text(c && c.time, OWN_CARD_MAX.short),
      // One of the kinds the board already knows, so a hand-written card can
      // be filtered and read beside a researched one rather than carrying
      // whatever the reader typed.
      market: OWN_MARKETS.has(text(c && c.market, 24)) ? text(c && c.market, 24) : 'Other',
      // A real American price, or null. The payout maths turns a NaN into a
      // blank stake box with nothing to explain it, and a card that cannot be
      // staked is a note rather than a card - so a bad price is dropped here
      // and the client refuses it at the form.
      odds: american(c && c.odds),
      // The slate game this is about, so the card names the same matchup the
      // researched ones do.
      gameId: board.cleanId(c && c.gameId, ''),
      thesis: text(c && c.thesis, OWN_CARD_MAX.line),
    })).filter((c) => c.title && c.odds !== null),
  };
}

/** The slip itself: `{ <cardId>: { stake, placed } }`. User-written and read
 *  back into the page, so the keys are card ids and the values two plain
 *  fields - nothing else survives. */
function cleanSlip(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, 200)) {
    if (!board.ID_RE.test(k) || !v || typeof v !== 'object') continue;
    const stake = Number(v.stake);
    out[k] = { stake: Number.isFinite(stake) && stake >= 0 ? Math.min(stake, 1e7) : 0, placed: v.placed === true };
  }
  return out;
}

/** Games added to the slip from All Games: `{ <gameId>: card }`. The card's
 *  text is drawn into the page, so it goes through the same rules as a
 *  hand-written card. */
function cleanCustomPicks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const text = (v, cap) => String(v === undefined || v === null || typeof v === 'object' ? '' : v)
    .replace(/[<>]/g, '').trim().slice(0, cap);
  for (const [k, c] of Object.entries(raw).slice(0, 50)) {
    if (!board.ID_RE.test(k) || !c || typeof c !== 'object') continue;
    const title = text(c.title, OWN_CARD_MAX.short);
    if (!title) continue;
    out[k] = {
      title,
      matchup: text(c.matchup, OWN_CARD_MAX.short),
      time: text(c.time, OWN_CARD_MAX.short),
      market: text(c.market, OWN_CARD_MAX.short),
      odds: american(c.odds) || -110,
      thesis: text(c.thesis, OWN_CARD_MAX.line),
      why: text(c.why, 2000),
      risk: text(c.risk, OWN_CARD_MAX.line),
      confidence: Math.min(4, Math.max(1, Math.round(Number(c.confidence)) || 3)),
    };
  }
  return out;
}

app.put('/api/slip', requireLoginSilent, async (req, res) => {
  try {
    const { slip, customPicks, bankroll, board: arrangement } = req.body || {};
    const week = boardWeekKey();
    await db.collection('user-state').doc(slipDocId(req)).set({
      slip: cleanSlip(slip),
      customPicks: cleanCustomPicks(customPicks),
      bankroll: typeof bankroll === 'string' ? bankroll.slice(0, 32) : '',
      board: boardPrefs(arrangement),
      weekKey: week,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true, weekKey: week });
  } catch (err) {
    console.error('PUT /api/slip', err);
    res.status(500).json({ error: 'Failed to save slip.' });
  }
});

// ---------------------------------------------------------------------------
// Public read routes - board data, no login required. Field names/shapes
// here match what public/index.html (the ported artifact) expects, not an
// independently designed API - see that file's GAMES_FALLBACK/UGA_FALLBACK
// for the canonical shapes.
// ---------------------------------------------------------------------------

/**
 * A 60-second in-memory copy of a read that every open page polls. The page
 * asked for /api/games, /api/changelog and /api/status on a timer from every
 * tab of every reader, and each ask was a Firestore read of the collection;
 * none of them changes faster than a research pass. Concurrent askers share
 * one read. Per instance, and filled inside the request (billed per request:
 * no timer).
 */
const readCache = new Map();
function cachedRead(key, ttlMs, load) {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = load();
  readCache.set(key, { at: Date.now(), promise });
  // A failure must not be served for a minute.
  promise.catch(() => { if (readCache.get(key) && readCache.get(key).promise === promise) readCache.delete(key); });
  return promise;
}
/** Anything that writes what a cached read returns calls this. */
function dropCached(...keys) { for (const k of keys) readCache.delete(k); }
const READ_TTL_MS = 60 * 1000;

/**
 * This week's games, from the current board, each with whatever research
 * notes exist for it (see games.thisWeek). Legacy documents in `games` count
 * only when they are one of the board's games, or were added this week: the
 * Games tab used to draw the whole collection, which nothing retires, so it
 * listed last week's finished games beside this week's.
 */
async function loadThisWeek() {
  const [boardDoc, snap, sb] = await Promise.all([
    db.collection('board').doc('current').get(),
    db.collection('games').limit(200).get(),
    liveFeed.get(),
  ]);
  // The seed when nothing is stored (or it no longer validates), as
  // /api/board does - its weekKey is empty, so it is never "this week" and
  // nothing on it is ever researched.
  let current;
  try { current = boardDoc.exists ? board.validate(boardDoc.data()) : board.seed(); } catch (e) { current = board.seed(); }
  return gamesLib.thisWeek({
    board: current,
    docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    scoreboard: sb && sb.available ? sb.all : [],
    now: Date.now(),
  });
}

app.get('/api/games', async (req, res) => {
  try {
    const week = await cachedRead('games', READ_TTL_MS, loadThisWeek);
    res.set('Cache-Control', 'private, max-age=30');
    res.json(week.games);
  } catch (err) {
    console.error('GET /api/games', err);
    res.status(500).json({ error: 'Failed to load games.' });
  }
});

// The owner's own custom questions, with the answers. Owner-only since
// 2026-09-26: it was public, so anyone could read what the owner had asked.
app.get('/api/asks', requireResearch, async (req, res) => {
  try {
    const snap = await db.collection('asks').orderBy('askedAt', 'desc').limit(50).get();
    res.set('Cache-Control', 'private, no-store');
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/asks', err);
    res.status(500).json({ error: 'Failed to load research asks.' });
  }
});

app.get('/api/changelog', async (req, res) => {
  try {
    const rows = await cachedRead('changelog', READ_TTL_MS, async () => {
      const snap = await db.collection('changelog').orderBy('changedAt', 'desc').limit(50).get();
      // The page reads which game changed and when; the note is model text
      // and is not drawn, so it is not sent.
      return snap.docs.map((d) => ({ id: d.id, gameId: board.cleanId(d.data().gameId, ''), changedAt: d.data().changedAt || '' }));
    });
    res.json(rows);
  } catch (err) {
    console.error('GET /api/changelog', err);
    res.status(500).json({ error: 'Failed to load changelog.' });
  }
});

app.get('/api/uga', async (req, res) => {
  try {
    const doc = await db.collection('fan').doc('uga').get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    console.error('GET /api/uga', err);
    res.status(500).json({ error: 'Failed to load My Dawgs content.' });
  }
});

/* ---------- My Team: the tab that used to be Georgia, hardcoded ----------
 *
 * The tab was "My Dawgs": a --uga-red in the stylesheet, a UGA_FALLBACK in the
 * page and a `fan/uga` document. Right for one fan, wrong for everyone else.
 *
 * The shape that makes this affordable: a team's page is cached under
 * `fan/<teamId>` and SHARED by everyone who picks that team. Cost scales with
 * teams in use, not with users - the second Georgia Tech fan pays nothing, and
 * neither does the hundredth. Whoever triggers a refresh spends their own
 * credit, which is why the route is behind requireBudget rather than behind
 * the owner's allowlist.
 */

// Static: 132 names and colours that change with a deploy, not a week.
app.get('/api/teams', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ conferences: teams.list(), default: teams.DEFAULT_TEAM });
});

/** Durable per-user settings. Deliberately NOT the slip document: that one is
 *  week-scoped and is handed back empty every Tuesday, which is right for a
 *  slip and would silently forget which team someone supports. */
function prefsDocId(req) {
  const me = currentUser(req);
  return me ? me.uid : null;
}

app.get('/api/prefs', requireLoginSilent, async (req, res) => {
  try {
    const id = prefsDocId(req);
    if (!id) return res.json({ team: teams.DEFAULT_TEAM });
    const doc = await db.collection('prefs').doc(id).get();
    const data = doc.exists ? doc.data() : {};
    res.json({ team: teams.validId(data.team) || teams.DEFAULT_TEAM });
  } catch (err) {
    console.error('GET /api/prefs', err);
    res.status(500).json({ error: 'Failed to load your settings.' });
  }
});

app.put('/api/prefs', requireLoginSilent, async (req, res) => {
  try {
    const id = prefsDocId(req);
    if (!id) return res.status(401).json({ error: 'not signed in' });
    // An unknown id must never become a document key: a typo in a request
    // would otherwise create a `fan/<junk>` row nothing will ever clean up.
    const team = teams.validId((req.body || {}).team);
    if (!team) return res.status(400).json({ error: 'Not a team I know.' });
    await db.collection('prefs').doc(id).set({ team, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ team });
  } catch (err) {
    console.error('PUT /api/prefs', err);
    res.status(500).json({ error: 'Failed to save your team.' });
  }
});

/* ---------- team facts from ESPN (2026-09-26) ----------
 *
 * Facts from ESPN, prose from the model. A team page used to be entirely a
 * model's answer, refreshed only when someone paid for it, so its record and
 * next game froze after every game: Georgia's still said 2-0 and "next: at
 * Arkansas" on the day of the Oklahoma game. The record, results, schedule,
 * next game and AP rank now come from ESPN's public JSON on every read (cached
 * 30 minutes in memory and in `teamfacts/<id>`), laid over the stored page.
 * The model keeps the storyline, shown with its date. No model call here, and
 * no timer: the cache fills inside whichever request finds it stale.
 */
const teamFacts = teamfacts.createTeamFacts({
  // Resolved per call so a test can stand a fake in front of ESPN.
  fetch: (...args) => globalThis.fetch(...args),
  db,
});

/** A team's page. Open, like the rest of the reading surface - and `researched`
 *  false is an honest answer, not an error: most teams have never been looked
 *  up, and the tab says so and offers the button rather than faking a season.
 *  The facts are real whether or not anyone has written the prose. */
app.get('/api/fan/:team', async (req, res) => {
  try {
    const id = teams.validId(req.params.team);
    if (!id) return res.status(404).json({ error: 'Not a team I know.' });
    const [doc, facts, poll] = await Promise.all([
      db.collection('fan').doc(id).get(), teamFacts.facts(id), teamFacts.poll(),
    ]);
    const meta = teams.get(id);
    res.json(teamfacts.overlay(doc.exists ? doc.data() : null, facts, poll, { teamId: id, meta }));
  } catch (err) {
    console.error('GET /api/fan/:team', err);
    res.status(500).json({ error: 'Failed to load that team.' });
  }
});

// How long a team page is considered current. A rank and a record move once a
// week; a schedule barely moves at all. Re-researching on every visit would
// spend somebody's credit to learn the same thing.
const TEAM_FRESH_HOURS = 12;

app.post('/api/fan/:team/research', requireLoginSilent, identity.requireBudget, identity.requireDailyCap,
  async (req, res) => {
    try {
      const id = teams.validId(req.params.team);
      if (!id) return res.status(404).json({ error: 'Not a team I know.' });
      const meta = teams.get(id);
      const ref = db.collection('fan').doc(id);

      const [existing, facts, poll] = await Promise.all([ref.get(), teamFacts.facts(id), teamFacts.poll()]);
      const view = (page, extra) => ({ ...teamfacts.overlay(page, facts, poll, { teamId: id, meta }), ...extra });

      // Someone else may have just paid for this. Handing back their answer
      // rather than buying it again is the whole point of a shared cache -
      // unless a game has finished since it was written, which is exactly
      // when a new take is worth paying for.
      if (existing.exists) {
        const age = Date.now() - Date.parse(existing.data().lastChecked || 0);
        const overtaken = teamfacts.playedSince(facts, existing.data().lastChecked).length > 0;
        if (Number.isFinite(age) && age < TEAM_FRESH_HOURS * 3600 * 1000 && !overtaken) {
          return res.json(view(existing.data(), { cached: true }));
        }
      }

      // What ESPN already says, so the model writes about the season as it
      // stands rather than re-deriving a record it might get wrong.
      const rankNow = view(null, {}).rank;
      const known = facts ? [
        '',
        `Known facts (from the scoreboard, correct as of ${facts.fetchedAt}; do not contradict them):`,
        `- Record ${facts.record}${facts.confRecord ? `, ${facts.confRecord} in conference` : ''}` +
          `${rankNow ? `, ${rankNow} in the AP poll` : ', unranked'}.`,
        ...facts.schedule.filter((r) => r.result).map((r) => `- ${r.wk}: ${r.opp}, ${r.result}`),
        facts.nextGame ? `- Next: ${facts.nextGame.opponent}, ${facts.nextGame.kickoffLabel}` : '- No game left on the schedule.',
      ] : [];

      const season = new Date().getFullYear();
      const raw = await runStructuredResearch({
        user: req.user,
        maxTokens: 12000,
        systemPrompt:
          'You research one college football team and return ONE JSON object and nothing else. '
          + 'Search the web for current information. Never invent a game, a score or a date: leave a '
          + 'field empty rather than guessing at it.',
        prompt: [
          `Research ${meta.name} (${meta.mascot}), ${meta.conf}, for the ${season} season.`,
          '',
          'Return exactly this JSON object:',
          '{',
          '  "rank": "#2 or empty string if unranked",',
          '  "record": "2-0",',
          '  "confRecord": "0-0 SEC",',
          '  "nextGame": { "opponent": "at Arkansas", "kickoffISO": "2026-09-19T16:00:00Z",',
          '                "tv": "ABC", "line": "Georgia -24.5" },',
          '  "schedule": [ { "wk": "Sep 5", "opp": "Tennessee State", "loc": "home|away|neutral|bye",',
          '                  "result": "W 63-3 or empty if unplayed", "current": true for THIS week only,',
          '                  "ranked": true if the opponent is ranked, "rivalry": true for a rivalry game } ],',
          '  "storyline": ["2 to 4 paragraphs on where the season stands: form, injuries, what to watch."]',
          '}',
          '',
          'The full regular-season schedule, in order, including bye weeks. Mark exactly one row current.',
          'kickoffISO must be a real UTC instant or an empty string - the page runs a live countdown off it.',
          ...known,
        ].join('\n'),
      });

      // Validated BEFORE it is written, so a bad run leaves the last good
      // document serving rather than replacing it with a broken tab.
      const page = fan.validate({ ...raw, lastChecked: new Date().toISOString() }, id);
      await ref.set({ ...page, researchedBy: (currentUser(req) || {}).uid || null });
      res.json(view(page, { cached: false }));
    } catch (err) {
      console.error('POST /api/fan/:team/research', err);
      res.status(500).json({ error: err.message || 'Could not research that team.' });
    }
  });

/* ---------- the board: slate, best bets, last week's results ---------- */

/**
 * What the front page draws. Open, like the rest of the reading surface.
 *
 * `stale` is the honest part: the board is rebuilt once a week, and if that
 * run has not happened the page should be able to say so rather than present
 * finished games as this week's card. It is what the September 20 slate
 * needed and did not have.
 */
app.get('/api/board', async (_req, res) => {
  // Short: the page re-asks every ten minutes and on coming back to the
  // foreground, and a rebuilt board should reach it within a minute.
  res.set('Cache-Control', 'public, max-age=60');
  try {
    const doc = await db.collection('board').doc('current').get();
    const current = doc.exists ? board.validate(doc.data()) : board.seed();
    res.json({ ...current, ...(await pollTop25(current)), ...(await slateFromFeed(current)),
               stale: current.weekKey !== boardWeekKey(), seeded: !doc.exists });
  } catch (err) {
    // A stored board that no longer validates is a bug worth shouting about,
    // but not one worth an empty front page: fall back to the seed.
    console.error('GET /api/board', err);
    const fallback = board.seed();
    res.json({ ...fallback, ...(await pollTop25(fallback)), stale: true, seeded: true, error: 'stored board was unreadable' });
  }
});

/**
 * Each slate game as the live scoreboard sees it, keyed by board game id:
 * kickoff, state, the feed's current line and a DraftKings link when the feed
 * carries one. The page uses it for the "Bet on DraftKings" links and for the
 * line-now beside each pick. Never throws; with no scoreboard it is {}.
 */
async function slateFromFeed(current) {
  try {
    const sb = await liveFeed.get();
    if (!sb.available) return {};
    const feed = {};
    for (const g of current.games) {
      const pk = gamesLib.pairKey(g);
      if (!pk) continue;
      const e = sb.all.find((x) => [x.away.teamId, x.home.teamId].sort().join('|') === pk);
      if (e) feed[g.id] = { startsAt: e.startsAt, state: e.state, line: e.line, overUnder: e.overUnder, lineSource: e.lineSource, dkUrl: e.dkUrl };
    }
    return { feed };
  } catch (err) {
    console.error('board: slate from feed failed', err && err.message);
    return {};
  }
}

/**
 * The Top 25 from the AP poll, when the board's own is missing or older than
 * the latest poll - every board built before `rankings` existed has none, and
 * a model's copy of last week's poll is worse than this week's poll. Each row
 * carries its team's game this week from the live scoreboard. Returns fields
 * to spread over the board, or {} to leave the board's own list alone. Never
 * throws: this decorates the front page.
 */
async function pollTop25(current) {
  try {
    const poll = await teamFacts.poll();
    if (!teamfacts.boardNeedsPoll(current, poll)) return {};
    const sb = await liveFeed.get();
    const rankings = board.validateRankings(teamfacts.pollRows(poll, sb.available ? sb.all : [], Date.now()));
    return {
      rankings,
      rankingsFrom: { source: 'poll', name: poll.name, week: poll.week, date: poll.date,
                      fetchedAt: poll.fetchedAt, games: !!sb.available },
    };
  } catch (err) {
    console.error('board: poll Top 25 failed', err && err.message);
    return {};
  }
}

/* ---------- live scores (2026-09-25) ----------
 *
 * One shared scoreboard, cached in memory for 20 s, so a Saturday full of
 * viewers costs one upstream fetch per 20 s. Filled by whichever request finds
 * it stale - there is no timer, because this service is billed per request and
 * anything running between requests stalls (see CLAUDE.md, "Billed per
 * request"). Every failure is a 200 saying live scores are unavailable: this
 * decorates the board and must never break it. No model call anywhere here.
 */
const liveFeed = live.createFeed({
  // Resolved on every call rather than captured, so the test suite can stand
  // a fake in front of the upstream while its own requests still go through.
  fetch: (...args) => globalThis.fetch(...args),
});

// The reader's team, from prefs/<uid>. The page polls every 20 s on a game
// day, so the answer is held for a minute rather than read from Firestore on
// every poll. Signed out: no team - the ticker is not personal until you are.
const liveTeamCache = new Map();
async function liveTeamFor(req) {
  const id = prefsDocId(req);
  if (!id) return null;
  const hit = liveTeamCache.get(id);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.team;
  let team = null;
  try {
    const doc = await db.collection('prefs').doc(id).get();
    // Only a team they actually chose. The My Team tab falls back to Georgia
    // for someone who never picked; pinning Georgia on their ticker would be
    // telling a stranger who they support.
    team = teams.validId(doc.exists ? doc.data().team : null);
  } catch (err) {
    console.error('live: prefs read failed', err.message);
  }
  if (liveTeamCache.size > 5000) liveTeamCache.clear();
  liveTeamCache.set(id, { at: Date.now(), team });
  return team;
}

/** The scoreboard with its ranks taken from the same AP poll the team pages
 *  read, so a team is the same number on the ticker and on its own page. The
 *  poll is cached for 30 minutes; without one the feed's own ranks stand. */
async function rankedFeed() {
  const [result, poll] = await Promise.all([liveFeed.get(), teamFacts.poll()]);
  return teamfacts.applyPollRanks(result, poll);
}

app.get('/api/live', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(live.publicView(await rankedFeed()));
  } catch (err) {
    console.error('GET /api/live', err);
    res.json({ available: false, message: live.UNAVAILABLE });
  }
});

/**
 * The scoreboard ordered for this reader, plus where each play on their slip
 * stands. The page sends the plays it is drawing as placed: a signed-out
 * reader's slip exists only in their browser, and a signed-in one may have an
 * edit the server has not seen yet. Nothing is stored; it is arithmetic on the
 * cached feed.
 */
app.post('/api/live/slip', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await rankedFeed();
    const teamId = await liveTeamFor(req);
    if (!result.available) return res.json({ ...live.publicView(result), team: teamId, slip: [] });
    const slip = live.slipStatus((req.body || {}).items, result.all);
    // `cards`: the board's cards, placed or not, for the live score and
    // line-now on each card (2026-09-26). Kept apart from `items` so a card
    // nobody backed does not order the ticker as if it were on their slip.
    const cards = live.slipStatus((req.body || {}).cards, result.all);
    res.json({ ...live.publicView(result, { teamId, slipIds: live.slipGameIds(slip) }), team: teamId, slip, cards });
  } catch (err) {
    console.error('POST /api/live/slip', err);
    res.json({ available: false, message: live.UNAVAILABLE, slip: [] });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const data = await cachedRead('status', READ_TTL_MS, async () => {
      const doc = await db.collection('control').doc('status').get();
      const d = doc.exists ? doc.data() : {};
      // Timestamps only; the page draws nothing else from here.
      return { lastRunAt: d.lastRunAt || null, boardWeek: d.boardWeek || null };
    });
    res.json(data);
  } catch (err) {
    console.error('GET /api/status', err);
    res.status(500).json({ error: 'Failed to load status.' });
  }
});

// ---------------------------------------------------------------------------
// Login-gated: anything that calls the Anthropic API.
// ---------------------------------------------------------------------------
// The free allowance runs on Haiku, which is half Sonnet's price and holds up
// fine here; the owner, Pro, and anyone on their own key get Sonnet. The
// search tool comes back from planFor rather than being written out, because
// Haiku returns 400 on web_search_20260209 - model and tool move together.
const MODEL_TIERS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

/** The client this request should use: the caller's own key if they have one
 *  on file, otherwise the app's. */
function clientFor(user) {
  return identity.clientFor(user, anthropic, (apiKey) => new Anthropic({ apiKey }));
}

async function runResearch({ prompt, systemPrompt, user }) {
  const plan = identityLib.planFor(user, MODEL_TIERS);
  const response = await (await clientFor(user)).messages.create({
    model: plan.model,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [plan.webSearch],
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlocks = response.content.filter((b) => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n\n');
}

// Same as runResearch, but asks for (and parses) a single JSON object back -
// used by the routes below that need structured game-board updates rather
// than free text.
//
// Two things here were learned from a failed run rather than from the docs.
//
// `pause_turn`. web_search is a SERVER-side tool: Anthropic runs the search
// loop inside the request, and when that loop hits its iteration limit the
// turn comes back with `stop_reason: "pause_turn"` and no final answer. A
// single create() call therefore returns prose or nothing at all on exactly
// the questions worth searching hardest for, and the caller sees "Model did
// not return a JSON object" 24 seconds in. Resuming is just re-sending the
// conversation with the paused assistant turn appended - the API sees the
// trailing server_tool_use block and picks up where it stopped. No extra
// "continue" message: that would be a new instruction, not a resumption.
//
// `maxTokens`. This is the one that actually bit, twice. A whole board - nine
// games, seven picks with a paragraph each, three parlays - does not fit in
// 3072 tokens, and a JSON object cut off at the ceiling fails to parse with
// the same unhelpful error. Worse: the server-side search loop's own output
// counts against this ceiling too, so a thorough search can spend the whole
// budget and return `stop_reason: max_tokens` with ZERO characters of text.
// That is what the first live rebuild did. The ceilings here are set for the
// searching, not just for the answer.
const MAX_CONTINUATIONS = 5;

async function runStructuredResearch({ prompt, systemPrompt, user, maxTokens = 3072, tier }) {
  // `tier: 'paid'` is for work the APP wants done, not work a visitor asked
  // for: the weekly board is the front page, it runs unattended from Cloud
  // Scheduler with no user to bill or tier, and four searches cannot survey a
  // week of games.
  const plan = identityLib.planFor(tier === 'paid' ? { admin: true } : user, MODEL_TIERS);
  const client = await clientFor(user);
  const messages = [{ role: 'user', content: prompt }];

  let response;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    // Streamed, not because anything here reads a stream, but because these
    // requests run for minutes and a non-streaming call of this size hits the
    // SDK's HTTP timeout - then retries it twice, which is how one rebuild
    // spent ten minutes failing three times over. `finalMessage()` gives back
    // exactly what create() would have.
    response = await client.messages.stream({
      model: plan.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: [plan.webSearch],
      messages,
    }).finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }

  const textBlocks = response.content.filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('\n\n');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    // Say which of the several ways this went wrong actually happened. The
    // bare message cost an afternoon: a paused turn, a truncated object and a
    // model answering in prose all looked identical from the log.
    throw new Error(`Model did not return a JSON object (stop_reason: ${response.stop_reason}, ${text.length} chars of text).`);
  }
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`Model returned unparseable JSON (stop_reason: ${response.stop_reason}, ${match[0].length} chars): ${err.message}`);
  }
}

// Per-game chat. Deliberately has NO web_search tool: the prompt the page
// sends tells the model it has no live internet and to say so rather than
// guess at anything that may have moved. Giving it search here would
// contradict its own instructions.
app.post('/api/chat', requireResearch, identity.requireBudget, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array is required.' });
    }
    const clean = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
      .slice(-20);
    if (!clean.length || clean[0].role !== 'user') {
      return res.status(400).json({ error: 'conversation must start with a user message.' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: clean,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'refused' });
    }
    res.json({ text });
  } catch (err) {
    console.error('POST /api/chat', err);
    const status = err && err.status === 429 ? 429 : 500;
    res.status(status).json({ error: status === 429 ? 'rate_limited' : 'Chat request failed.' });
  }
});

app.post('/api/research/custom', requireResearch, identity.requireBudget, async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question) {
      return res.status(400).json({ error: 'question is required.' });
    }
    const answer = await runResearch({
      systemPrompt:
        'You are a college football betting research assistant inside College Football App. Answer the ' +
        "user's question using current, verifiable information from web search - it might name a specific " +
        'game, ask for a general betting recommendation, or be a general question. Be specific and direct, ' +
        'not generic. Never invent a score, injury, or line - if you cannot verify something, say so.',
      prompt: question,
      user: req.user,
    });

    const askedAt = new Date().toISOString();
    await db.collection('asks').add({
      query: question,
      askedAt,
      answeredAt: askedAt,
      status: 'answered',
      answer,
      relatedGameId: null,
    });

    res.json({ answer });
  } catch (err) {
    console.error('POST /api/research/custom', err);
    res.status(500).json({ error: 'Research request failed.' });
  }
});

// Adding a game the board missed.
//
// This was the owner's alone. It is now any signed-in member, on their own
// credit - the same reasoning as researching a team: the result lands in the
// SHARED games collection, so one person paying to cover a game covers it for
// everyone, and the budget is what bounds the spend rather than an allowlist.
// The owner still passes, by session or by site password.
//
// Since 2026-09-26 the answer goes through games.validate() before it is
// written, and the document id is derived here from the two teams (or a slug
// of the matchup) - the model used to choose it, and an id with a "/" in it
// made Firestore throw after the credit had already been spent. It is stamped
// with this week, which is what keeps it off next week's Games tab.
app.post('/api/research/add-game', requireLoginSilent, identity.requireBudget, identity.requireDailyCap,
  async (req, res) => {
  try {
    const query = typeof (req.body || {}).query === 'string' ? req.body.query.trim().slice(0, 120) : '';
    if (!query) {
      return res.status(400).json({ error: 'query is required.' });
    }
    const data = await runStructuredResearch({
      systemPrompt:
        'You are a college football betting research assistant. Research the given team or matchup using ' +
        'web search for the current DraftKings-market line, injuries, and storylines. Respond with ONLY a ' +
        'single JSON object (no prose, no markdown fences) with these exact keys: ' +
        '{"label": "Team A at Team B", "home": "Team B", "away": "Team A", "kickoff": "Day H:MMp ET · Network", ' +
        '"tag": "top25 or interesting", "ranked": "e.g. #5 Team A (or empty string)", "market": "spread/total ' +
        'summary", "pick": "e.g. Team A -3.5 (empty string if passing)", "pickConfidence": 1-4, "summary": ' +
        '"1-2 sentence summary", "why": "fuller reasoning paragraph", "injuryNote": "or empty string", ' +
        '"pass": true or false, "passReason": "if pass, why (else empty string)"}. Plain text only in every ' +
        'field - no HTML. Never invent a score, injury, or line - if you cannot verify something, omit it or ' +
        'say so in the text fields.',
      prompt: `Research this team or matchup for this week's games board: ${query}`,
      user: req.user,
    });

    let game;
    try {
      game = gamesLib.validate({ ...data, lastChecked: new Date().toISOString() },
        { id: gamesLib.idFor(data || {}, query), weekKey: boardWeekKey() });
    } catch (e) {
      console.error('POST /api/research/add-game: unusable answer -', e.message);
      return res.status(422).json({ error: 'The research came back without a game to add, so nothing was saved. Try naming both teams.' });
    }

    await db.collection('games').doc(game.id).set(game, { merge: true });
    await db.collection('changelog').add({
      gameId: game.id,
      changedAt: new Date().toISOString(),
      note: `Added ${game.label} to this week's games`,
    });
    dropCached('games', 'changelog');

    res.json({ id: game.id, game });
  } catch (err) {
    console.error('POST /api/research/add-game', err);
    res.status(500).json({ error: 'Could not research and add that game.' });
  }
});

/** What a research call is told about one game: the board's facts plus the
 *  notes already held, nothing more. */
function researchBrief(g) {
  const out = { id: g.id, label: g.label, kickoff: g.kickoffISO || g.kickoff || '' };
  for (const k of ['kicker', 'market', 'pick', 'summary', 'why', 'injuryNote', 'passReason', 'lastChecked']) {
    if (g[k]) out[k] = g[k];
  }
  return out;
}

/** The games document a research update produces: the board's facts, the
 *  model's cleaned research fields, this week's stamp. */
function researchedDoc(g, update, now) {
  return gamesLib.validate({
    label: g.label, home: g.home, away: g.away, kickoff: g.kickoff, tag: g.tag,
    ranked: g.ranked || g.kicker || '', risk: g.risk,
    ...gamesLib.validateUpdate(update), lastChecked: now,
  }, { id: g.docId || g.id, weekKey: g.weekKey });
}

/**
 * The games a research job may spend on: this week's, not yet kicked off.
 * Logged with how many were left out, because the jobs this feeds used to
 * research every games document ever written - last week's finished games
 * included, every run (audit, 2026-09-26).
 */
async function researchableGames(route, cap) {
  const week = await loadThisWeek();
  const games = week.upcoming.slice(0, cap);
  console.log(`${route}: ${games.length} upcoming game(s) to research; skipped ${week.skipped} that have kicked off or finished` +
    (week.current ? '' : ' (the stored board is not this week\'s, so all of its games are over)'));
  const skippedWhy = week.current
    ? 'every game on this week\'s board has kicked off'
    : 'the board is not this week\'s yet - nothing to research until it is rebuilt';
  return { week, games, skippedWhy };
}

// The Saturday sweep (Cloud Scheduler `cfb-saturday-live`, hourly) and the
// Refresh research button. Researches this week's games that have not kicked
// off - see researchableGames().
app.post('/api/research/refresh-board', requireLoginOrCron, async (req, res) => {
  try {
    const { week, games, skippedWhy } = await researchableGames('refresh-board', 15);
    if (!games.length) {
      return res.json({ skipped: skippedWhy, finished: week.skipped, updated: 0, summary: `Nothing to refresh: ${skippedWhy}.` });
    }

    const data = await runStructuredResearch({
      systemPrompt:
        'You are a college football betting research assistant reviewing this week\'s games board. ' +
        'For EACH game given, use web search to check current injuries, line movement, and storylines, and ' +
        'decide if anything materially changed since it was last checked. Respond with ONLY a single JSON ' +
        'object (no prose, no markdown fences): {"updates": [{"id": "<matching id>", "market": "...", ' +
        '"pick": "...", "pickConfidence": 1-4, "summary": "...", "why": "...", "injuryNote": "...", ' +
        '"pass": true or false, "passReason": "..."}], "summary": "one sentence describing what changed ' +
        'overall"}. Only include a game in "updates" if something genuinely changed - do not rewrite games ' +
        'with nothing new. Plain text only, no HTML. Never invent a score, injury, or line.',
      prompt: `This week's games, none kicked off yet:\n${JSON.stringify(games.map(researchBrief), null, 2)}`,
      user: req.user,
    });

    // Only the games that were sent, by the id they were sent under: the
    // model does not get to create or rename a document.
    const byId = new Map(games.map((g) => [g.id, g]));
    const updates = (Array.isArray(data.updates) ? data.updates : [])
      .map((u) => ({ u, g: u && byId.get(board.cleanId(u.id)) }))
      .filter((x) => x.g);
    const batch = db.batch();
    const now = new Date().toISOString();
    for (const { u, g } of updates) {
      const doc = researchedDoc(g, u, now);
      batch.set(db.collection('games').doc(doc.id), doc, { merge: true });
      batch.set(db.collection('changelog').doc(), { gameId: doc.id, changedAt: now, note: gamesLib.clean(u.summary, 400) || 'Research update' });
    }
    batch.set(db.collection('control').doc('status'), { lastRunAt: now }, { merge: true });
    await batch.commit();
    dropCached('games', 'changelog', 'status');

    res.json({
      summary: gamesLib.clean(data.summary, 400) || `Reviewed ${games.length} games.`,
      updated: updates.length, researched: games.length, finished: week.skipped,
    });
  } catch (err) {
    console.error('POST /api/research/refresh-board', err);
    res.status(500).json({ error: 'Refresh failed.' });
  }
});

/**
 * Turn the board over to a new week.
 *
 * This is the route the app was missing. `refresh-board` can only ANNOTATE
 * the cards that already exist - which is how the front page ended up telling
 * people, at length and accurately, that every game on it had already been
 * played. Nothing retired a finished bet, and nothing ever added the next
 * week's.
 *
 * Two research calls, in this order, because the second must not overwrite
 * what the first is reading:
 *
 *   1. GRADE. Take the picks now on the board and find out how they finished.
 *      This is a question about the past, so it is asked on its own and
 *      answered with a final score - "Ole Miss 32, LSU 24" - rather than a
 *      verdict we would have to take on faith.
 *   2. BUILD. Research the coming week and propose a fresh slate and a fresh
 *      set of bets.
 *
 * The graded results ride along on the new board, so the front page can open
 * with how last week went before asking for another stake. Erik asked for
 * exactly that: wins or losses, or new cards.
 */
app.post('/api/research/weekly-board', requireLoginOrCron, async (req, res) => {
  try {
    const doc = await db.collection('board').doc('current').get();
    const current = doc.exists ? board.validate(doc.data()) : board.seed();
    const week = boardWeekKey();

    if (current.weekKey === week && !req.query.force) {
      return res.json({ skipped: 'the board is already on this week', weekKey: week });
    }

    // 1. How last week finished - from ESPN's finals first (2026-09-26): a
    // pick whose game matched a final with certainty is graded by the same
    // arithmetic as the live slip, against the real score, for free. Only
    // what could not be matched goes to the model, which used to grade it all.
    const cards = [
      ...current.picks.map((p) => ({ id: p.id, kind: 'straight', title: p.title, matchup: p.matchup, market: p.market })),
      ...current.parlays.map((p) => ({ id: p.id, kind: 'parlay', title: p.title, legs: p.legs.map((l) => ({ game: l.game, market: l.market })) })),
    ];
    let fromFinals = { graded: [], rest: cards };
    if (/^\d{4}-\d{2}-\d{2}$/.test(current.weekKey || '')) {
      const tue = Date.parse(current.weekKey + 'T12:00:00Z');
      const days = [2, 3, 4].map((n) => new Date(tue + n * 86400000).toISOString().slice(0, 10).replace(/-/g, ''));
      const finals = await live.fetchFinals((...a) => globalThis.fetch(...a), days);
      fromFinals = live.gradeFromFinals(cards, finals);
    }
    console.log(`weekly-board: ${fromFinals.graded.length} graded from ESPN finals, ${fromFinals.rest.length} left for the model`);
    const staked = fromFinals.rest.map((p) => ({
      id: p.id, title: p.title, matchup: p.matchup || (p.legs || []).map((l) => l.game).join(' + '),
      market: p.market || (p.legs || []).map((l) => l.market).join(' + '),
    }));

    let results = fromFinals.graded;
    if (staked.length) {
      const graded = await runStructuredResearch({
        systemPrompt:
          'You are grading college football bets that have already been played. Use web search to find the ' +
          'FINAL SCORE of each game, then decide whether the bet won, lost or pushed. Respond with ONLY a ' +
          'single JSON object (no prose, no markdown fences): {"results": [{"id": "<matching id>", ' +
          '"title": "...", "matchup": "...", "market": "...", "finalScore": "Team 31, Team 24", ' +
          '"outcome": "win" | "loss" | "push" | "void", "note": "one sentence on how it played out"}]}. ' +
          'Use "void" ONLY when the game has not been played yet or was cancelled. Never invent a score: ' +
          'if you cannot verify the final, use "void" and say so in the note.',
        prompt: `Bets to grade:\n${JSON.stringify(staked, null, 2)}`,
        user: req.user,
        maxTokens: 16000,
        tier: 'paid',
      });
      // The model's grades, for what ESPN could not settle - and never for
      // a card ESPN already graded.
      const done = new Set(results.map((r) => r.id));
      const byModel = (Array.isArray(graded.results) ? graded.results : [])
        .filter((r) => r && staked.some((s) => s.id === board.cleanId(r.id)) && !done.has(board.cleanId(r.id)));
      results = results.concat(byModel);
    }

    // 2. The coming week.
    const built = await runStructuredResearch({
      systemPrompt:
        'You are a college football betting analyst building this week\'s board. Use web search for the ' +
        'CURRENT week\'s schedule and the lines posted for it. Respond with ONLY a single JSON object (no ' +
        'prose, no markdown fences): {"games": [{"id": "short-slug", "label": "Away at Home", "time": ' +
        '"Sat 3:30p ET \u00b7 ABC", "kicker": "#5 Away (-3.5) at Home"}], "picks": [{"id": "short-slug", ' +
        '"title": "Team -3.5", "matchup": "Away at Home", "time": "Sat 3:30p ET", "market": ' +
        '"Spread \u00b7 Team -3.5", "odds": -110, "confidence": 1-4, "thesis": "one sentence", "why": ' +
        '"a full paragraph of reasoning", "risk": "what would break this"}], "parlays": [{"id": ' +
        '"short-slug", "title": "...", "confidence": 1-4, "thesis": "one sentence", "legs": [{"game": ' +
        '"Away at Home", "market": "Team -3.5", "odds": -110}], "why": "...", "risk": "..."}], ' +
        // The poll, which is a different question from the best bets: "who is
        // ranked and what are they doing on Saturday" rather than "what should
        // I back". A ranked team on a bye is a real row with an empty game.
        '"rankings": [{"rank": 1-25, "team": "Texas", "record": "3-0", "game": "vs Michigan State", ' +
        '"time": "Sat 7:30p ET", "line": "Texas -29.5", "gameId": "the id of the matching slate game, ' +
        'or an empty string"}]}. ' +
        'Give 6-10 games, 5-8 picks and 2-3 parlays, and ALL 25 rows of the current AP Top 25 with each ' +
        'ranked team\'s game this week (empty game for a bye). Every parlay needs at least two legs. ' +
        'Odds are American and numeric. Only include games that have NOT yet been played. Never invent a ' +
        'line, an injury or a score - if a line is not posted yet, say so in the market field.',
      prompt:
        `Today is ${new Date().toISOString().slice(0, 10)}. Build the board for the games being played ` +
        'this coming weekend. These games are finished and must NOT appear again:\n' +
        JSON.stringify(current.games.map((g) => g.label), null, 2),
      user: req.user,
      // A full board is long - nine games, seven picks with a paragraph of
      // reasoning each, three parlays - and the searching that precedes it
      // comes out of the same budget.
      maxTokens: 32000,
      tier: 'paid',
    });

    // The model proposed it; this is what decides whether anyone sees it. A
    // board that does not validate leaves the old one in place, which is a
    // week out of date but coherent - strictly better than a front page of
    // half-written cards.
    const next = board.validate({ ...built, results, weekKey: week, generatedAt: new Date().toISOString() });

    await db.collection('board').doc('current').set(next);
    // Last week's board, kept so a result can be checked against what was
    // actually offered rather than against what we now say we offered.
    await db.collection('board').doc(`week-${current.weekKey || 'seed'}`).set(current).catch(() => {});
    await db.collection('control').doc('status').set({ lastRunAt: next.generatedAt, boardWeek: week }, { merge: true });

    res.json({ weekKey: week, games: next.games.length, picks: next.picks.length,
               parlays: next.parlays.length, results: next.results.length,
               rankings: next.rankings.length });
  } catch (err) {
    console.error('POST /api/research/weekly-board', err);
    res.status(500).json({ error: err.message || 'Could not rebuild the board.' });
  }
});

// ---------------------------------------------------------------------------
// Batched research (weekdays). Same work as refresh-board, but submitted to
// the Batch API at half price. Batches usually land in minutes but are
// allowed up to 24h, so this is only used where freshness doesn't matter -
// Saturday and the manual button both stay on the live path.
//
// Same list as refresh-board: this week's games that have not kicked off
// (researchableGames). It used to be `games.limit(20)` - every document ever
// written, so each run paid to research last week's finished games.
// ---------------------------------------------------------------------------
const BATCH_SYSTEM_PROMPT =
  'You are a college football betting research assistant. Use web search to check the current ' +
  'DraftKings-market line, injuries, and storylines for the ONE game described below, then respond ' +
  'with ONLY a single JSON object (no prose, no markdown fences) using these keys: {"market": "...", ' +
  '"pick": "... (empty string if passing)", "pickConfidence": 1-4, "summary": "1-2 sentences", ' +
  '"why": "fuller reasoning", "injuryNote": "or empty string", "pass": true or false, ' +
  '"passReason": "if pass, why (else empty string)", "changed": true or false}. Set "changed" to ' +
  'false if nothing material has moved since the notes below. Plain text only, no HTML. Never invent ' +
  'a score, injury, or line.';

app.post('/api/research/batch-submit', requireLoginOrCron, async (req, res) => {
  try {
    const pending = await db.collection('control').doc('batch').get();
    if (pending.exists && pending.data().status === 'pending') {
      return res.json({ skipped: 'a batch is already in flight', batchId: pending.data().batchId });
    }

    const { week, games, skippedWhy } = await researchableGames('batch-submit', 20);
    if (!games.length) return res.json({ skipped: skippedWhy, finished: week.skipped });

    const batch = await anthropic.messages.batches.create({
      requests: games.map((g) => ({
        // board.ID_RE ids fit the Batch API's custom_id rule as they are.
        custom_id: g.id,
        params: {
          model: 'claude-sonnet-5',
          max_tokens: 2048,
          system: BATCH_SYSTEM_PROMPT,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
          messages: [{ role: 'user', content: `Current notes for this game:\n${JSON.stringify(researchBrief(g), null, 2)}` }],
        },
      })),
    });

    await db.collection('control').doc('batch').set({
      batchId: batch.id,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      gameCount: games.length,
      skipped: week.skipped,
      // What each custom_id stands for, so collect writes a whole document
      // under the right id without trusting anything in the answer.
      games: games.map((g) => ({
        id: g.id, docId: g.docId || g.id, label: g.label, home: g.home || '', away: g.away || '',
        kickoff: g.kickoff || '', kicker: g.kicker || '', tag: g.tag || '', ranked: g.ranked || '',
        weekKey: g.weekKey || '',
      })),
    });

    res.json({ batchId: batch.id, submitted: games.length, finished: week.skipped });
  } catch (err) {
    console.error('POST /api/research/batch-submit', err);
    res.status(500).json({ error: 'Batch submit failed.' });
  }
});

app.post('/api/research/batch-collect', requireLoginOrCron, async (req, res) => {
  try {
    const ref = db.collection('control').doc('batch');
    const doc = await ref.get();
    if (!doc.exists || doc.data().status !== 'pending') {
      return res.json({ skipped: 'nothing pending' });
    }
    const batchId = doc.data().batchId;
    const sent = new Map((Array.isArray(doc.data().games) ? doc.data().games : []).map((g) => [g.id, g]));
    const batch = await anthropic.messages.batches.retrieve(batchId);
    if (batch.processing_status !== 'ended') {
      return res.json({ batchId, status: batch.processing_status, waiting: true });
    }

    const now = new Date().toISOString();
    const writer = db.batch();
    let updated = 0;
    let failed = 0;
    // A bare count says something broke but not what, and nothing here can read
    // Cloud Logging (the deployer account gets 403 on every log view). Two runs
    // in a row came back with exactly one failure, which is the signature of one
    // game failing consistently rather than random flakiness - and there was no
    // way to tell which. Record the id and the reason.
    const failures = [];
    const note = (id, why) => { failed += 1; failures.push(`${id}: ${why}`); };

    for await (const entry of await anthropic.messages.batches.results(batchId)) {
      const id = String(entry.custom_id || '');
      if (!board.ID_RE.test(id)) { note(id.slice(0, 60), 'not an id this app sends'); continue; }
      if (entry.result.type !== 'succeeded') {
        note(id, entry.result.type + (entry.result.error ? ` (${entry.result.error.type || 'error'})` : ''));
        continue;
      }
      const text = entry.result.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        note(id, `no JSON in ${text.length} chars (stop_reason: ${entry.result.message.stop_reason})`);
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(match[0]); } catch (e) { note(id, `unparseable JSON: ${e.message}`); continue; }
      if (!parsed || typeof parsed !== 'object' || parsed.changed === false) continue;

      const g = sent.get(id);
      // A batch submitted before 2026-09-26 carries no game list: merge the
      // cleaned research fields only, onto whatever the document already has.
      const out = g ? researchedDoc(g, parsed, now) : { ...gamesLib.validateUpdate(parsed), lastChecked: now };
      const docId = g ? out.id : id;
      writer.set(db.collection('games').doc(docId), out, { merge: true });
      writer.set(db.collection('changelog').doc(), {
        gameId: docId,
        changedAt: now,
        note: gamesLib.clean(parsed.summary, 400) || 'Batched research update',
      });
      updated += 1;
    }

    writer.set(db.collection('control').doc('status'), { lastRunAt: now }, { merge: true });
    writer.set(ref, { batchId, status: 'done', collectedAt: now, updated, failed, failures }, { merge: true });
    await writer.commit();
    dropCached('games', 'changelog', 'status');

    res.json({ batchId, updated, failed, failures });
  } catch (err) {
    console.error('POST /api/research/batch-collect', err);
    res.status(500).json({ error: 'Batch collect failed.' });
  }
});

// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.status(200).send('ok'));
// Cloud Run's edge swallows /healthz: in production it returns a 404 with no
// Server header, on the run.app URL and the custom domain alike, while every
// other path - including ones the app does not define - reaches the app. It
// works locally, which is why it went unnoticed: CI and boot checks were
// testing a route no external monitor could ever reach. /api/health is the
// same handler on a path the edge leaves alone.
app.get('/api/health', (req, res) => res.status(200).send('ok'));

// A shared slip is a page anyone can open. Registered before the catch-all,
// and outside the gate for the same reason the link exists at all.
app.get('/s/:shareId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shared-slip.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`College Football App listening on :${PORT}`);
});
