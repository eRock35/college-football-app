/**
 * The routes behind "Call it", the track records and the brag cards
 * (2026-09-26). crowd.js, record.js and cards.js are pure; this is where they
 * meet Firestore, the scoreboard and the request.
 *
 * Nothing here calls a model, so nothing here is metered: calls, records and
 * cards are free to everyone, signed in or not. That is deliberate - these are
 * the reasons to come back on a Saturday, and the AI features are what cost.
 *
 * Firestore, all in this app's database:
 *   crowd/<week>                  tally (crowd.js)
 *   crowd-votes/<week>__<hash>    one voter's week (crowd.js)
 *   finals/<week>                 the week's scoreboard once the week is over,
 *                                 so a past week is graded without asking ESPN
 *                                 again - and graded the same way forever
 *   slip-history/<owner>__<week>  a slip kept when the next week's first save
 *                                 would overwrite it (server.js, PUT /api/slip)
 *   brags/<id>                    a shared card's frozen numbers
 *
 * Billed per request: every cache here is filled inside a request, never by a
 * timer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const board = require('./board');
const live = require('./live');
const crowd = require('./crowd');
const record = require('./record');
const cards = require('./cards');

const SLATE_TTL_MS = 5 * 60 * 1000;
const CROWD_TTL_MS = 60 * 1000;
const RECORD_TTL_MS = 5 * 60 * 1000;
const BRAG_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** "Week 5" for a week key: Week 1 is the week of the Saturday before Labor
 *  Day. The page's seasonWeekLabel, server side. */
function weekLabel(weekKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekKey || ''));
  if (!m) return '';
  const day = 86400000;
  const sat = Date.UTC(+m[1], +m[2] - 1, +m[3]) + 4 * day;
  const sept1 = new Date(Date.UTC(+m[1], 8, 1));
  const laborDay = Date.UTC(+m[1], 8, 1 + ((1 - sept1.getUTCDay() + 7) % 7));
  const n = Math.round((sat - (laborDay - 2 * day)) / (7 * day)) + 1;
  return n >= 0 && n <= 16 ? `Week ${n}` : '';
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** A scoreboard game with the fields grading and the poll use, and nothing
 *  heavier - it is stored once per week. */
function compactGame(g) {
  const side = (s) => ({ teamId: s.teamId || null, espnId: s.espnId || '', name: s.name || '', abbr: s.abbr || '',
    score: typeof s.score === 'number' ? s.score : null, rank: s.rank || null });
  return JSON.parse(JSON.stringify({
    id: g.id, state: g.state, live: !!g.live, final: !!g.final, startsAt: g.startsAt || '', period: g.period || 0,
    clock: g.clock || '', detail: g.detail || '', neutral: !!g.neutral, line: g.line || '',
    overUnder: typeof g.overUnder === 'number' ? g.overUnder : null, lineSource: g.lineSource || '',
    home: side(g.home || {}), away: side(g.away || {}),
  }));
}

/** A tiny per-key rate limit, per instance. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) { hits.set(key, h); return false; }
    h.push(now);
    hits.set(key, h);
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

function mountSocial(app, deps) {
  const { db, FieldValue, liveFeed, currentUser, slipDocId, boardWeekKey, sharerName } = deps;
  const fetchImpl = (...a) => (deps.fetch || globalThis.fetch)(...a);
  const now = () => Date.now();

  /* ---------------- the board, by week ---------------- */

  async function currentBoard() {
    const doc = await db.collection('board').doc('current').get();
    if (!doc.exists) return board.seed();
    try { return board.validate(doc.data()); } catch (e) { return board.seed(); }
  }

  /** The board a week was played from: the current one, or its archive. */
  async function boardForWeek(week) {
    const cur = await currentBoard();
    if (cur.weekKey === week) return cur;
    const doc = await db.collection('board').doc(`week-${week}`).get();
    if (!doc.exists) return null;
    try { return board.validate(doc.data()); } catch (e) { return null; }
  }

  /* ---------------- the week's scoreboard ---------------- */

  const slateCache = new Map();
  /**
   * Every game of a board week, normalised. A finished week is read from
   * `finals/<week>` (written the first time it is asked for after the week
   * ends); this week is fetched and held for five minutes, with today's
   * games taken from the 20-second live feed, which is fresher.
   */
  async function slateForWeek(week) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return [];
    const over = week < boardWeekKey();
    const hit = slateCache.get(week);
    if (hit && (over ? hit.stored : now() - hit.at < SLATE_TTL_MS)) {
      return over ? hit.games : mergeToday(hit.games);
    }
    if (over) {
      const doc = await db.collection('finals').doc(week).get();
      if (doc.exists && Array.isArray(doc.data().games)) {
        slateCache.set(week, { at: now(), games: doc.data().games, stored: true });
        return doc.data().games;
      }
    }
    const games = (await live.fetchDays(fetchImpl, live.weekDays(week))).map(compactGame);
    let stored = false;
    if (over && games.length) {
      await db.collection('finals').doc(week).set({ weekKey: week, storedAt: new Date().toISOString(), games })
        .then(() => { stored = true; }).catch((e) => console.error('finals: store failed', e.message));
    }
    if (slateCache.size > 60) slateCache.clear();
    slateCache.set(week, { at: now(), games, stored });
    return over ? games : mergeToday(games);
  }

  let todayFeed = liveFeed;
  async function mergeToday(games) {
    try {
      const sb = await todayFeed.get();
      if (!sb.available) return games;
      const fresh = new Map((sb.all || []).map((g) => [g.id, compactGame(g)]));
      const seen = new Set();
      const out = games.map((g) => { seen.add(g.id); return fresh.get(g.id) || g; });
      for (const [id, g] of fresh) if (!seen.has(id)) out.push(g);
      return out;
    } catch (e) {
      return games;
    }
  }

  /* ---------------- who is voting ---------------- */

  /** 'u:<uid>' signed in, 'a:<cookie>' signed out, or null. With `create`,
   *  a signed-out reader is given a cookie. */
  function voterKeyFor(req, res, create) {
    const me = currentUser(req);
    if (me) return `u:${me.uid}`;
    const c = readCookie(req, crowd.VOTER_COOKIE);
    if (crowd.VOTER_RE.test(c)) return `a:${c}`;
    if (!create) return null;
    const id = crypto.randomBytes(18).toString('base64url');
    res.append('Set-Cookie', `${crowd.VOTER_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
    return `a:${id}`;
  }

  /**
   * Calls made signed out, moved onto the account the first time the reader
   * is seen signed in, so signing in never costs a record. Where both have a
   * call on one game the account's stands and the other is taken back out of
   * the tally, which counted it.
   */
  async function adoptAnon(req, res) {
    const me = currentUser(req);
    const c = readCookie(req, crowd.VOTER_COOKIE);
    if (!me || !crowd.VOTER_RE.test(c)) return;
    const anonKey = `a:${c}`;
    const userKey = `u:${me.uid}`;
    try {
      const snap = await db.collection('crowd-votes').where('voter', '==', crowd.voterHash(anonKey)).limit(30).get();
      for (const d of snap.docs) {
        const a = d.data() || {};
        const week = a.weekKey;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week || ''))) continue;
        const uref = db.collection('crowd-votes').doc(crowd.voterDocId(week, userKey));
        const udoc = await uref.get();
        const u = udoc.exists ? udoc.data() : { weekKey: week, voter: crowd.voterHash(userKey), votes: {} };
        const votes = { ...(u.votes || {}) };
        const dec = {};
        for (const [gid, v] of Object.entries(a.votes || {})) {
          if (!v || !v.side) continue;
          if (votes[gid]) dec[crowd.tallyField(gid, v.side)] = FieldValue.increment(-1);
          else votes[gid] = v;
        }
        await uref.set({ weekKey: week, voter: crowd.voterHash(userKey), votes, updatedAt: new Date().toISOString() });
        if (Object.keys(dec).length) await db.collection('crowd').doc(week).set(dec, { merge: true });
        await d.ref.delete();
        crowdCache.delete(week);
      }
      res.append('Set-Cookie', `${crowd.VOTER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    } catch (e) {
      console.error('crowd: adopting signed-out calls failed', e.message);
    }
  }

  /* ---------------- the crowd, by week ---------------- */

  const crowdCache = new Map();
  async function crowdWeek(week, { fresh = false } = {}) {
    const hit = crowdCache.get(week);
    if (!fresh && hit && now() - hit.at < CROWD_TTL_MS) return hit.data;
    const [tdoc, voters, slips] = await Promise.all([
      db.collection('crowd').doc(week).get(),
      db.collection('crowd-votes').where('weekKey', '==', week).limit(5000).get(),
      db.collection('user-state').where('weekKey', '==', week).limit(5000).get(),
    ]);
    const data = {
      tally: crowd.readTally(tdoc.exists ? tdoc.data() : {}),
      voters: voters.docs.map((d) => d.data()),
      slips: crowd.slipCounts(slips.docs.map((d) => d.data())),
    };
    if (crowdCache.size > 30) crowdCache.clear();
    crowdCache.set(week, { at: now(), data });
    return data;
  }

  async function myVotes(week, vk) {
    if (!vk) return {};
    const doc = await db.collection('crowd-votes').doc(crowd.voterDocId(week, vk)).get();
    return doc.exists ? (doc.data().votes || {}) : {};
  }

  async function crowdView(req, res, { fresh = false, voterKey = null } = {}) {
    const week = boardWeekKey();
    const b = await currentBoard();
    if (b.weekKey !== week) {
      return { weekKey: week, weekLabel: weekLabel(week), open: false, games: [], you: null, readers: null,
        slips: { counts: {}, slips: 0 }, note: 'Calls open when this week’s board is up.' };
    }
    if (!voterKey) await adoptAnon(req, res);
    // A first call has just been given its cookie, which is on the response,
    // not yet on the request.
    const vk = voterKey || voterKeyFor(req, res, false);
    const [slate, state, mine] = await Promise.all([slateForWeek(week), crowdWeek(week, { fresh }), myVotes(week, vk)]);
    const view = crowd.pollView({ board: b, slate, tally: state.tally, mine, weekKey: week });
    return {
      weekKey: week, weekLabel: weekLabel(week), open: true,
      games: view.games, you: view.you,
      readers: crowd.readersRecord(state.voters, slate, b.games),
      slips: state.slips,
    };
  }

  app.get('/api/crowd', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await crowdView(req, res));
    } catch (err) {
      console.error('GET /api/crowd', err);
      res.json({ open: false, games: [], error: 'Calls are unavailable just now.' });
    }
  });

  const voteLimit = limiter(60, 60 * 1000);
  const voterLocks = new Map();
  function withLock(key, fn) {
    const prev = voterLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    voterLocks.set(key, next.catch(() => {}));
    next.finally(() => { if (voterLocks.get(key) === next) voterLocks.delete(key); }).catch(() => {});
    return next;
  }

  app.post('/api/crowd/vote', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!voteLimit(req.ip || 'x')) return res.status(429).json({ error: 'Easy - too many calls at once. Try again in a minute.' });
      const body = req.body || {};
      const gameId = typeof body.gameId === 'string' ? body.gameId : '';
      if (!board.ID_RE.test(gameId)) return res.status(400).json({ error: 'Which game?' });
      const week = boardWeekKey();
      const b = await currentBoard();
      if (b.weekKey !== week) return res.status(409).json({ error: 'Calls open when this week’s board is up.' });
      const g = b.games.find((x) => x.id === gameId);
      if (!g) return res.status(404).json({ error: 'That game is not on this week’s board.' });
      const slate = await slateForWeek(week);
      const fg = crowd.findGame(g, slate);
      const sides = fg ? crowd.sidesFor(g, fg) : null;
      if (!sides) return res.status(400).json({ error: 'That game is not on this week\u2019s schedule, so it cannot be called.' });
      if (crowd.started(g, fg, week)) return res.status(409).json({ error: 'Calls closed at kickoff.' });
      const side = body.side === null || body.side === '' || body.side === undefined ? null : String(body.side);
      if (side && !sides.some((s) => s.teamId === side)) return res.status(400).json({ error: 'Pick one of the two teams.' });

      const vk = voterKeyFor(req, res, true);
      const hash = crowd.voterHash(vk);
      await withLock(vk, async () => {
        const ref = db.collection('crowd-votes').doc(crowd.voterDocId(week, vk));
        const doc = await ref.get();
        const data = doc.exists ? doc.data() : { votes: {} };
        const prev = (data.votes || {})[gameId];
        if ((prev && prev.side) === (side || undefined) || (!prev && !side)) return;
        const inc = {};
        if (prev && prev.side) inc[crowd.tallyField(gameId, prev.side)] = FieldValue.increment(-1);
        if (side) inc[crowd.tallyField(gameId, side)] = FieldValue.increment(1);
        const votes = { ...(data.votes || {}) };
        if (side) votes[gameId] = { side, spread: sides.find((s) => s.teamId === side).spread, at: new Date().toISOString() };
        else delete votes[gameId];
        await ref.set({ weekKey: week, voter: hash, votes, updatedAt: new Date().toISOString() });
        await db.collection('crowd').doc(week).set(inc, { merge: true });
      });
      crowdCache.delete(week);
      mineCache.clear();
      res.json(await crowdView(req, res, { fresh: true, voterKey: vk }));
    } catch (err) {
      console.error('POST /api/crowd/vote', err);
      res.status(500).json({ error: 'That call did not save. Try again.' });
    }
  });

  /* ---------------- records ---------------- */

  let boardRecordCache = null;
  async function boardRecord() {
    if (boardRecordCache && now() - boardRecordCache.at < RECORD_TTL_MS) return boardRecordCache.data;
    const snap = await db.collection('board').get();
    const docs = [];
    const priceBook = {};
    for (const d of snap.docs) {
      let v;
      try { v = board.validate(d.data()); } catch (e) { continue; }
      docs.push(v);
      if (v.weekKey) {
        const book = priceBook[v.weekKey] = {};
        for (const p of v.picks) book[p.id] = p.odds;
        for (const p of v.parlays) book[p.id] = record.parlayOdds(p.legs);
      }
    }
    const data = record.boardSeason(docs, priceBook);
    for (const w of data.weeks) w.weekLabel = weekLabel(w.week);
    boardRecordCache = { at: now(), data };
    return data;
  }

  app.get('/api/record', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=120');
    try {
      res.json({ board: await boardRecord() });
    } catch (err) {
      console.error('GET /api/record', err);
      res.json({ board: null, error: 'The record is unavailable just now.' });
    }
  });

  const mineCache = new Map();
  /** A reader's graded weeks, season and badges. */
  async function myRecord(req, res) {
    await adoptAnon(req, res);
    const me = currentUser(req);
    const vk = voterKeyFor(req, res, false);
    const key = `${vk || ''}|${me ? me.uid : ''}`;
    const hit = mineCache.get(key);
    if (hit && now() - hit.at < 60 * 1000) return hit.data;

    const byWeek = new Map();
    const at = (w) => { if (!byWeek.has(w)) byWeek.set(w, {}); return byWeek.get(w); };
    if (vk) {
      const snap = await db.collection('crowd-votes').where('voter', '==', crowd.voterHash(vk)).limit(60).get();
      for (const d of snap.docs) { const v = d.data(); if (v && v.weekKey) at(v.weekKey).votes = v; }
    }
    if (me) {
      const owner = slipDocId(req);
      const snap = await db.collection('slip-history').where('owner', '==', owner).limit(60).get();
      for (const d of snap.docs) { const v = d.data(); if (v && v.weekKey) at(v.weekKey).slip = v; }
      const cur = await db.collection('user-state').doc(owner).get();
      if (cur.exists) {
        const v = cur.data();
        const w = deps.slipWeekOf(v);
        if (w) at(w).slip = v;
      }
    }
    const boardRec = await boardRecord().catch(() => null);
    const boardByWeek = new Map(((boardRec && boardRec.weeks) || []).map((w) => [w.week, w]));
    const weeks = [];
    for (const week of [...byWeek.keys()].sort().slice(-20)) {
      const src = byWeek.get(week);
      const [slate, bdoc, st] = await Promise.all([slateForWeek(week), boardForWeek(week), crowdWeek(week)]);
      const calls = src.votes && bdoc ? record.gradeCallsWeek(src.votes, bdoc, slate, st.tally) : null;
      const slip = src.slip && bdoc ? record.gradeSlipWeek(src.slip, bdoc, slate) : null;
      if (!calls && !slip) continue;
      weeks.push({ week, weekLabel: weekLabel(week), calls, slip, board: boardByWeek.get(week) || null });
    }
    const data = {
      known: !!(vk || me), signedIn: !!me,
      season: record.readerSeason(weeks),
      badges: record.badges(weeks),
      weeks: weeks.slice().reverse().map((w) => ({ ...w, board: w.board ? { w: w.board.w, l: w.board.l, p: w.board.p } : null })),
    };
    if (mineCache.size > 2000) mineCache.clear();
    mineCache.set(key, { at: now(), data });
    return data;
  }

  app.get('/api/record/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await myRecord(req, res));
    } catch (err) {
      console.error('GET /api/record/me', err);
      res.json({ known: false, error: 'Your record is unavailable just now.', weeks: [], badges: record.badges([]) });
    }
  });

  /* ---------------- brag cards ---------------- */

  const bragLimit = limiter(30, 60 * 60 * 1000);
  const pngCache = cards.createCache(200);
  const origin = (req) => `${req.protocol}://${req.get('host')}`;

  app.post('/api/brag', async (req, res) => {
    try {
      if (!bragLimit(req.ip || 'x')) return res.status(429).json({ error: 'That is a lot of cards. Try again later.' });
      const kind = (req.body || {}).kind === 'season' ? 'season' : 'week';
      const mine = await myRecord(req, res);
      const by = currentUser(req) ? sharerName(req) : 'A reader';
      let snap;
      if (kind === 'season') {
        const earned = mine.badges.filter((b) => b.earned).map((b) => b.name);
        const s = mine.season;
        if (!(s.calls.w + s.calls.l + s.calls.p) && !(s.slip.w + s.slip.l)) return res.status(400).json({ error: 'Make a few calls first - your season card needs a record.' });
        snap = { kind, by, calls: s.calls, slip: s.slip, streak: s.streak, badges: earned };
      } else {
        const wantWeek = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).weekKey || '')) ? req.body.weekKey : '';
        const wk = wantWeek ? mine.weeks.find((w) => w.week === wantWeek) : mine.weeks[0];
        if (!wk) return res.status(400).json({ error: 'Make a call first - there is nothing to brag about yet.' });
        const calls = wk.calls || { w: 0, l: 0, p: 0, calls: [] };
        const earned = mine.badges.filter((b) => b.earned && b.week === wk.week).map((b) => b.name);
        snap = {
          kind, by, weekKey: wk.week, weekLabel: wk.weekLabel || '',
          calls: { w: calls.w, l: calls.l, p: calls.p, pending: calls.pending || 0 },
          slip: wk.slip ? { w: wk.slip.w, l: wk.slip.l, p: wk.slip.p, net: wk.slip.net } : null,
          rows: (calls.calls || []).slice(0, 8).map((c) => ({ label: c.call, outcome: c.outcome })),
          badges: earned,
        };
      }
      const id = crypto.randomBytes(9).toString('base64url');
      await db.collection('brags').doc(id).set({ ...snap, createdAt: new Date().toISOString() });
      const o = origin(req);
      res.json({ id, url: `${o}/b/${id}`, image: `${o}/b/${id}.png`, text: bragText(snap) });
    } catch (err) {
      console.error('POST /api/brag', err);
      res.status(500).json({ error: 'Could not make that card.' });
    }
  });

  function bragText(s) {
    const r = cards.wlp(s.calls);
    const me = s.by === 'A reader';
    if (s.kind === 'season') return `${me ? 'My' : `${s.by}’s`} season calling college football games: ${r}.`;
    const c = s.calls || {};
    // Nothing final yet: a dare rather than a 0-0.
    if (!(c.w || c.l || c.p) && c.pending) {
      return `${me ? 'I’ve' : `${s.by} has`} called ${c.pending} ${s.weekLabel || 'this week’s'} game${c.pending === 1 ? '' : 's'} against the spread. Think ${me ? 'I’m' : 'they’re'} wrong?`;
    }
    return `${me ? 'I' : s.by} went ${r} calling ${s.weekLabel || 'this week’s'} college football games.`;
  }

  function bragSvg(s) {
    if (s.kind === 'season') return cards.seasonSvg(s);
    return cards.weekSvg({ ...s, vsReaders: s.calls && s.calls.pending ? `${s.calls.pending} still to play` : '' });
  }

  function sendPng(res, key, svgFn, maxAge) {
    let buf = pngCache.get(key);
    if (!buf) {
      buf = cards.png(svgFn());
      if (!buf) return res.status(503).type('text/plain').send('Cards are unavailable.');
      pngCache.set(key, buf);
    }
    res.set('Cache-Control', `public, max-age=${maxAge}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('image/png').send(buf);
  }

  /** A small page around a card, with the tags that make a pasted link
   *  unfold into the picture. Every value is escaped. */
  function cardPage(req, { title, description, image, path: p, cta = 'Make your calls' }) {
    const e = cards.x;
    const url = `${origin(req)}${p}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${e(title)}</title><meta name="description" content="${e(description)}"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="College Football">
<meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(description)}">
<meta property="og:image" content="${e(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${e(url)}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}"><meta name="twitter:image" content="${e(image)}">
<meta name="theme-color" content="#05070D"><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>:root{color-scheme:dark}body{margin:0;background:#05070D;color:#fff;font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{width:100%;max-width:760px;padding:24px 16px;box-sizing:border-box;text-align:center}img{width:100%;height:auto;border-radius:16px;box-shadow:0 20px 60px -20px #0A84FF55}
h1{font-size:22px;margin:22px 0 6px}p{color:#A1A1AA;margin:0 0 22px}a.go{display:inline-block;background:#0A84FF;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;min-height:20px}
small{display:block;color:#71717A;margin-top:26px;font-size:13px}</style></head><body><main>
<img src="${e(image)}" alt="${e(title)}" width="1200" height="630">
<h1>${e(title)}</h1><p>${e(description)}</p><a class="go" href="/">${e(cta)} →</a>
<small>Free to play. Calls are for fun - nothing here places a bet.</small></main></body></html>`;
  }

  app.get(/^\/b\/([A-Za-z0-9_-]{12})\.png$/, async (req, res) => {
    const id = req.params[0];
    try {
      const doc = await db.collection('brags').doc(id).get();
      if (!doc.exists) return res.status(404).type('text/plain').send('Not here.');
      sendPng(res, `b:${id}`, () => bragSvg(doc.data()), 86400);
    } catch (err) {
      console.error('GET /b/:id.png', err);
      res.status(500).type('text/plain').send('Could not draw that card.');
    }
  });

  app.get('/b/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!BRAG_ID_RE.test(id)) return res.status(404).type('text/plain').send('Not here.');
    try {
      const doc = await db.collection('brags').doc(id).get();
      if (!doc.exists) return res.status(404).type('text/plain').send('Not here.');
      const s = doc.data();
      res.set('Cache-Control', 'public, max-age=300');
      res.type('html').send(cardPage(req, {
        title: bragText(s),
        description: 'Call every game against the spread, see where the crowd is, and keep a season record. Free.',
        image: `${origin(req)}/b/${id}.png`, path: `/b/${id}`,
      }));
    } catch (err) {
      console.error('GET /b/:id', err);
      res.status(500).type('text/plain').send('Could not load that card.');
    }
  });

  /* A shared slip: the same page as before, now with a picture when the
   * link is pasted somewhere. */
  const SLIP_HTML = fs.readFileSync(path.join(__dirname, 'public', 'shared-slip.html'), 'utf8');

  app.get(/^\/s\/([A-Za-z0-9_-]{8,40})\.png$/, async (req, res) => {
    const id = req.params[0];
    try {
      const doc = await db.collection('shared-slips').doc(id).get();
      if (!doc.exists) return res.status(404).type('text/plain').send('Not here.');
      const d = doc.data();
      sendPng(res, `s:${id}`, () => cards.slipSvg({
        by: d.byKind === 'name' && d.by ? d.by : 'A reader', weekLabel: weekLabel(d.weekKey),
        items: d.items || [], totalRisk: d.totalRisk || 0, totalToWin: d.totalToWin || 0,
      }), 86400);
    } catch (err) {
      console.error('GET /s/:id.png', err);
      res.status(500).type('text/plain').send('Could not draw that slip.');
    }
  });

  app.get('/s/:shareId', async (req, res) => {
    const id = String(req.params.shareId || '');
    let meta = '';
    if (SHARE_ID_RE.test(id)) {
      try {
        const doc = await db.collection('shared-slips').doc(id).get();
        if (doc.exists) {
          const d = doc.data();
          const by = d.byKind === 'name' && d.by ? d.by : 'A reader';
          const n = (d.items || []).length;
          const e = cards.x;
          const title = `${by}’s slip: ${n} play${n === 1 ? '' : 's'}`;
          const img = `${origin(req)}/s/${id}.png`;
          meta = `<meta property="og:type" content="website"><meta property="og:title" content="${e(title)}">` +
            `<meta property="og:description" content="${e((d.items || []).slice(0, 3).map((i) => i.title).join(' · '))}">` +
            `<meta property="og:image" content="${e(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` +
            `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${e(img)}">`;
        }
      } catch (err) {
        console.error('GET /s/:id meta', err.message);
      }
    }
    res.type('html').send(meta ? SLIP_HTML.replace('</head>', `${meta}\n</head>`) : SLIP_HTML);
  });

  /* The app's own preview: what a link to the front page unfolds into. */
  app.get('/og.png', async (_req, res) => {
    try {
      const [rec, b] = await Promise.all([boardRecord().catch(() => null), currentBoard()]);
      const week = boardWeekKey();
      const label = weekLabel(week);
      const current = b.weekKey === week;
      const games = current ? b.games.slice(0, 4).map((g) => g.label) : [];
      const key = `og:${week}:${rec ? `${rec.total.w}-${rec.total.l}` : ''}:${games.join('|')}`;
      sendPng(res, key, () => cards.appSvg({
        headline: label ? `${label}: call every game` : 'Call every game',
        sub: 'Live scores, the crowd’s split, and a season record. Free.',
        record: rec && rec.total, games,
      }), 600);
    } catch (err) {
      console.error('GET /og.png', err);
      res.status(500).type('text/plain').send('Could not draw the preview.');
    }
  });

  const api = { slateForWeek, currentBoard, boardRecord, myRecord, weekLabel };
  // Tests only (CFB_TEST_HOOKS is never set on the service): drop every cache
  // and stand a fake in for today's live feed.
  if (process.env.CFB_TEST_HOOKS) {
    globalThis.__cfbSocial = {
      reset() { slateCache.clear(); crowdCache.clear(); mineCache.clear(); boardRecordCache = null; },
      setToday(feed) { todayFeed = feed || liveFeed; },
    };
  }
  return api;
}

module.exports = { mountSocial, weekLabel, compactGame, readCookie };
