const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createPasskeyAuth } = require('./auth');
const analytics = require('./analytics');
const sitepass = require('./sitepass');
const board = require('./board');
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
async function requireLogin(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  if (signedIn(req)) return next();
  if (await passwordOk(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="College Football App"');
  return res.status(401).send('Login required.');
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

// A college football week runs Tuesday through Monday - games land Thu-Sat
// with a Sunday/Monday tail, so Tuesday is the quiet boundary to roll on.
// Anchored to US Eastern regardless of where the viewer is.
function currentWeekKey() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - ((et.getDay() - 2 + 7) % 7));
  return et.toISOString().slice(0, 10);
}

/**
 * Which week a BOARD belongs to: the Tuesday that starts the week containing
 * the next Saturday of games.
 *
 * Deliberately not `currentWeekKey()`, which answers a different question -
 * which week's slip you are filling in - and rolls on Tuesday. Turning the
 * board over happens on Sunday or Monday, when the weekend is settled and the
 * next one is what anybody wants to read about. Labelling a Sunday rebuild
 * with `currentWeekKey()` would stamp the coming weekend's games with the
 * week that just finished, and the board would then look stale the moment it
 * was built.
 */
function boardWeekKey() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  // Forward to the coming Saturday (today, if today is Saturday)...
  et.setDate(et.getDate() + ((6 - et.getDay() + 7) % 7));
  // ...then back to the Tuesday that starts its week.
  et.setDate(et.getDate() - ((et.getDay() - 2 + 7) % 7));
  return et.toISOString().slice(0, 10);
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
  if (!me) {
    res.set('WWW-Authenticate', 'Basic realm="College Football App"');
    return res.status(401).send('Login required.');
  }
  return res.status(403).json({ error: 'not_permitted' });
}

// Scheduler-or-human gate: a cron key, or a research-permitted human.
function requireLoginOrCron(req, res, next) {
  const key = req.get('X-Cron-Key');
  if (CRON_SECRET && key && key === CRON_SECRET) return next();
  return requireResearch(req, res, next);
}

// Hitting this with credentials is what triggers the browser's login prompt,
// so the "sync across devices" button has something to authenticate against.
app.get('/api/login', requireLogin, (req, res) => {
  res.json({ ok: true, weekKey: currentWeekKey() });
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
    const week = currentWeekKey();
    const id = slipDocId(req);
    let doc = await db.collection('user-state').doc(id).get();
    // The owner's pre-accounts slip lived under 'slip'. Read it once as a
    // fallback so the current week survives the migration; the next save
    // writes to their own document and this stops mattering.
    const me = currentUser(req);
    if (!doc.exists || doc.data().weekKey !== week) {
      // This app's older per-account key, then the owner's pre-accounts slip.
      for (const fallback of [legacySlipDocId(req), (me && isResearchEmail(me.email)) ? 'slip' : null]) {
        if (!fallback || fallback === id) continue;
        const legacy = await db.collection('user-state').doc(fallback).get();
        if (legacy.exists && legacy.data().weekKey === week) { doc = legacy; break; }
      }
    }
    const data = doc.exists ? doc.data() : null;
    // Last week's slip is stale by definition - don't hand it back.
    if (!data || data.weekKey !== week) {
      return res.json({ weekKey: week, slip: {}, customPicks: {}, bankroll: '' });
    }
    res.json({
      weekKey: week,
      slip: data.slip || {},
      customPicks: data.customPicks || {},
      bankroll: data.bankroll || '',
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
    const me = currentUser(req);
    await db.collection('shared-slips').doc(shareId).set({
      items,
      totalRisk: items.reduce((n, i) => n + i.stake, 0),
      totalToWin: items.reduce((n, i) => n + i.toWin, 0),
      weekKey: currentWeekKey(),
      by: (me && me.email ? me.email.split('@')[0] : 'someone'),
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
      by: d.by,
      createdAt: d.createdAt,
      stale: d.weekKey !== currentWeekKey(),
    });
  } catch (err) {
    console.error('GET /api/shared-slip', err);
    res.status(500).json({ error: 'Could not load that slip.' });
  }
});

app.put('/api/slip', requireLoginSilent, async (req, res) => {
  try {
    const { slip, customPicks, bankroll } = req.body || {};
    const week = currentWeekKey();
    await db.collection('user-state').doc(slipDocId(req)).set({
      slip: slip && typeof slip === 'object' ? slip : {},
      customPicks: customPicks && typeof customPicks === 'object' ? customPicks : {},
      bankroll: typeof bankroll === 'string' ? bankroll.slice(0, 32) : '',
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
app.get('/api/games', async (req, res) => {
  try {
    const snap = await db.collection('games').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/games', err);
    res.status(500).json({ error: 'Failed to load games.' });
  }
});

app.get('/api/asks', async (req, res) => {
  try {
    const snap = await db.collection('asks').orderBy('askedAt', 'desc').limit(50).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/asks', err);
    res.status(500).json({ error: 'Failed to load research asks.' });
  }
});

app.get('/api/changelog', async (req, res) => {
  try {
    const snap = await db.collection('changelog').orderBy('changedAt', 'desc').limit(50).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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
  try {
    const doc = await db.collection('board').doc('current').get();
    const current = doc.exists ? board.validate(doc.data()) : board.seed();
    res.json({ ...current, stale: current.weekKey !== boardWeekKey(), seeded: !doc.exists });
  } catch (err) {
    // A stored board that no longer validates is a bug worth shouting about,
    // but not one worth an empty front page: fall back to the seed.
    console.error('GET /api/board', err);
    const fallback = board.seed();
    res.json({ ...fallback, stale: true, seeded: true, error: 'stored board was unreadable' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const doc = await db.collection('control').doc('status').get();
    res.json(doc.exists ? doc.data() : {});
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

app.post('/api/research/add-game', requireResearch, identity.requireBudget, async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: 'query is required.' });
    }
    const data = await runStructuredResearch({
      systemPrompt:
        'You are a college football betting research assistant. Research the given team or matchup using ' +
        'web search for the current DraftKings-market line, injuries, and storylines. Respond with ONLY a ' +
        'single JSON object (no prose, no markdown fences) with these exact keys: {"id": "short-kebab-id", ' +
        '"label": "Team A at Team B", "home": "Team B", "away": "Team A", "kickoff": "Day H:MMp ET · Network", ' +
        '"tag": "top25 or interesting", "ranked": "e.g. #5 Team A (or empty string)", "market": "spread/total ' +
        'summary", "pick": "e.g. Team A -3.5 (empty string if passing)", "pickConfidence": 1-4, "summary": ' +
        '"1-2 sentence summary", "why": "fuller reasoning paragraph", "injuryNote": "or empty string", ' +
        '"pass": true or false, "passReason": "if pass, why (else empty string)"}. Never invent a score, ' +
        'injury, or line - if you cannot verify something, omit it or say so in the text fields.',
      prompt: `Research this team or matchup for the tracked games board: ${query}`,
      user: req.user,
    });

    data.id = data.id || query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `game-${Date.now()}`;
    data.lastChecked = new Date().toISOString();

    await db.collection('games').doc(data.id).set(data, { merge: true });
    await db.collection('changelog').add({
      gameId: data.id,
      changedAt: new Date().toISOString(),
      note: `Added ${data.label || query} to tracked games`,
    });

    res.json({ id: data.id, game: data });
  } catch (err) {
    console.error('POST /api/research/add-game', err);
    res.status(500).json({ error: 'Could not research and add that game.' });
  }
});

app.post('/api/research/refresh-board', requireLoginOrCron, async (req, res) => {
  try {
    const snap = await db.collection('games').limit(15).get();
    const games = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const data = await runStructuredResearch({
      systemPrompt:
        'You are a college football betting research assistant reviewing an existing tracked-games board. ' +
        'For EACH game given, use web search to check current injuries, line movement, and storylines, and ' +
        'decide if anything materially changed since it was last checked. Respond with ONLY a single JSON ' +
        'object (no prose, no markdown fences): {"updates": [{"id": "<matching id>", "market": "...", ' +
        '"pick": "...", "pickConfidence": 1-4, "summary": "...", "why": "...", "injuryNote": "...", ' +
        '"pass": true or false, "passReason": "..."}], "summary": "one sentence describing what changed ' +
        'overall"}. Only include a game in "updates" if something genuinely changed - do not rewrite games ' +
        'with nothing new. Never invent a score, injury, or line.',
      prompt: `Current tracked games:\n${JSON.stringify(games, null, 2)}`,
      user: req.user,
    });

    const updates = Array.isArray(data.updates) ? data.updates : [];
    const batch = db.batch();
    const now = new Date().toISOString();
    updates.forEach((u) => {
      if (!u || !u.id) return;
      batch.set(db.collection('games').doc(u.id), { ...u, lastChecked: now }, { merge: true });
      batch.set(db.collection('changelog').doc(), {
        gameId: u.id,
        changedAt: now,
        note: u.summary || 'Research update',
      });
    });
    batch.set(db.collection('control').doc('status'), { lastRunAt: now }, { merge: true });
    await batch.commit();

    res.json({ summary: data.summary || `Reviewed ${games.length} games.`, updated: updates.length });
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

    const staked = [...current.picks, ...current.parlays].map((p) => ({
      id: p.id, title: p.title, matchup: p.matchup || (p.legs || []).map((l) => l.game).join(' + '),
      market: p.market || (p.legs || []).map((l) => l.market).join(' + '),
    }));

    // 1. How last week finished.
    let results = [];
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
      results = Array.isArray(graded.results) ? graded.results : [];
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
        '"Away at Home", "market": "Team -3.5", "odds": -110}], "why": "...", "risk": "..."}]}. ' +
        'Give 6-10 games, 5-8 picks and 2-3 parlays. Every parlay needs at least two legs. Odds are ' +
        'American and numeric. Only include games that have NOT yet been played. Never invent a line, an ' +
        'injury or a score - if a line is not posted yet, say so in the market field.',
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
               parlays: next.parlays.length, results: next.results.length });
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
// ---------------------------------------------------------------------------
const BATCH_SYSTEM_PROMPT =
  'You are a college football betting research assistant. Use web search to check the current ' +
  'DraftKings-market line, injuries, and storylines for the ONE game described below, then respond ' +
  'with ONLY a single JSON object (no prose, no markdown fences) using these keys: {"market": "...", ' +
  '"pick": "... (empty string if passing)", "pickConfidence": 1-4, "summary": "1-2 sentences", ' +
  '"why": "fuller reasoning", "injuryNote": "or empty string", "pass": true or false, ' +
  '"passReason": "if pass, why (else empty string)", "changed": true or false}. Set "changed" to ' +
  'false if nothing material has moved since the notes below. Never invent a score, injury, or line.';

app.post('/api/research/batch-submit', requireLoginOrCron, async (req, res) => {
  try {
    const pending = await db.collection('control').doc('batch').get();
    if (pending.exists && pending.data().status === 'pending') {
      return res.json({ skipped: 'a batch is already in flight', batchId: pending.data().batchId });
    }

    const snap = await db.collection('games').limit(20).get();
    const games = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!games.length) return res.json({ skipped: 'no games tracked' });

    const batch = await anthropic.messages.batches.create({
      requests: games.map((g) => ({
        custom_id: g.id,
        params: {
          model: 'claude-sonnet-5',
          max_tokens: 2048,
          system: BATCH_SYSTEM_PROMPT,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
          messages: [{ role: 'user', content: `Current notes for this game:\n${JSON.stringify(g, null, 2)}` }],
        },
      })),
    });

    await db.collection('control').doc('batch').set({
      batchId: batch.id,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      gameCount: games.length,
    });

    res.json({ batchId: batch.id, submitted: games.length });
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
      if (entry.result.type !== 'succeeded') {
        note(entry.custom_id, entry.result.type + (entry.result.error ? ` (${entry.result.error.type || 'error'})` : ''));
        continue;
      }
      const text = entry.result.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        note(entry.custom_id, `no JSON in ${text.length} chars (stop_reason: ${entry.result.message.stop_reason})`);
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(match[0]); } catch (e) { note(entry.custom_id, `unparseable JSON: ${e.message}`); continue; }
      if (parsed.changed === false) continue;

      delete parsed.changed;
      writer.set(db.collection('games').doc(entry.custom_id), { ...parsed, lastChecked: now }, { merge: true });
      writer.set(db.collection('changelog').doc(), {
        gameId: entry.custom_id,
        changedAt: now,
        note: parsed.summary || 'Batched research update',
      });
      updated += 1;
    }

    writer.set(db.collection('control').doc('status'), { lastRunAt: now }, { merge: true });
    writer.set(ref, { batchId, status: 'done', collectedAt: now, updated, failed, failures }, { merge: true });
    await writer.commit();

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
