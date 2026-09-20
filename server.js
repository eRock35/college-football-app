const express = require('express');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE_ID || 'college-football-app';

const SITE_LOGIN_USERNAME = process.env.SITE_LOGIN_USERNAME || '';
const SITE_LOGIN_PASSWORD = process.env.SITE_LOGIN_PASSWORD || '';

const db = new Firestore({ projectId: PROJECT_ID, databaseId: FIRESTORE_DB });
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth: HTTP Basic, route-scoped. Gates only routes that spend API tokens.
// ---------------------------------------------------------------------------
function requireLogin(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === SITE_LOGIN_USERNAME && pass === SITE_LOGIN_PASSWORD) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="College Football App"');
  return res.status(401).send('Login required.');
}

// Same credentials as requireLogin, but a 401 here deliberately omits the
// WWW-Authenticate header. The slip routes are polled on page load, and with
// that header every anonymous visitor would get a native browser login popup
// before they'd even seen the page. Without it the fetch just fails and the
// page falls back to localStorage.
function requireLoginSilent(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (decoded.slice(0, sep) === SITE_LOGIN_USERNAME && decoded.slice(sep + 1) === SITE_LOGIN_PASSWORD) {
      return next();
    }
  }
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

// Hitting this with credentials is what triggers the browser's login prompt,
// so the "sync across devices" button has something to authenticate against.
app.get('/api/login', requireLogin, (req, res) => {
  res.json({ ok: true, weekKey: currentWeekKey() });
});

// Cross-device slip state. Gated: this app is public, and an ungated write
// route would let any visitor scribble on the slip.
app.get('/api/slip', requireLoginSilent, async (req, res) => {
  try {
    const doc = await db.collection('user-state').doc('slip').get();
    const week = currentWeekKey();
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

app.put('/api/slip', requireLoginSilent, async (req, res) => {
  try {
    const { slip, customPicks, bankroll } = req.body || {};
    const week = currentWeekKey();
    await db.collection('user-state').doc('slip').set({
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
async function runResearch({ prompt, systemPrompt }) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: systemPrompt,
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 5,
      },
    ],
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlocks = response.content.filter((b) => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n\n');
}

// Same as runResearch, but asks for (and parses) a single JSON object back -
// used by the two routes below that need structured game-board updates
// rather than free text.
async function runStructuredResearch({ prompt, systemPrompt }) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 3072,
    system: systemPrompt,
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 5,
      },
    ],
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlocks = response.content.filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('\n\n');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Model did not return a JSON object.');
  }
  return JSON.parse(match[0]);
}

// Per-game chat. Deliberately has NO web_search tool: the prompt the page
// sends tells the model it has no live internet and to say so rather than
// guess at anything that may have moved. Giving it search here would
// contradict its own instructions.
app.post('/api/chat', requireLogin, async (req, res) => {
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

app.post('/api/research/custom', requireLogin, async (req, res) => {
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

app.post('/api/research/add-game', requireLogin, async (req, res) => {
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

app.post('/api/research/refresh-board', requireLogin, async (req, res) => {
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

// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`College Football App listening on :${PORT}`);
});
