#!/usr/bin/env node
// Boots the app in memory with the live feed answered from a fixture - for
// looking at the live layer in a browser. Not a suite (run.js skips boot-*).
//
//   PORT=9310 LIVE_FIXTURE=live node test/boot-live.js
//
// LIVE_FIXTURE is one of: live, live-next, finals, no-games, down. FACTS_SCENE=1
// adds the stale Georgia page and the team-facts fixtures (see below). If
// LIVE_FIXTURE_CTL names a file, its contents are read on every upstream fetch
// instead, so a running server can be moved from one fixture to the next.
//
// The fixtures are a Saturday (2026-09-26). Their dates are shifted so that
// Saturday is today in US Eastern time, or "today's games" would be nobody's.
const fs = require('fs');
const path = require('path');
const h = require('./harness.js');
h.install();

process.env.IDENTITY_SESSION_SECRET = process.env.IDENTITY_SESSION_SECRET || 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'cfb-secret-abcdefghijklmnopq';
process.env.SITE_LOGIN_USERNAME = 'erik';
process.env.SITE_LOGIN_PASSWORD = 'site-password-here-1';
process.env.RESEARCH_ALLOWED_EMAILS = 'owner@example.com';
process.env.FIRESTORE_DATABASE_ID = 'college-football-app';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = process.env.PORT || '9310';

const FIXTURE_DAY = Date.parse('2026-09-26T00:00:00Z');
const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shiftMs = Date.parse(todayET + 'T00:00:00Z') - FIXTURE_DAY;

function shift(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(v)) {
    return new Date(Date.parse(v) + shiftMs).toISOString().replace(/:00\.000Z$/, 'Z');
  }
  if (Array.isArray(v)) return v.map(shift);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = shift(v[k]); return o; }
  return v;
}

function currentFixture() {
  const ctl = process.env.LIVE_FIXTURE_CTL;
  if (ctl) { try { return fs.readFileSync(ctl, 'utf8').trim(); } catch (e) { /* fall through */ } }
  return process.env.LIVE_FIXTURE || 'live';
}

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `espn-${name}.json`), 'utf8'));

// FACTS_SCENE=1: the situation Erik reported on 2026-09-26. Georgia beat
// Arkansas last week and plays at Oklahoma tonight; fan/uga was researched
// the morning of the Arkansas game. The scoreboard fixtures predate that
// story (they have Georgia at Arkansas today), so Georgia and New Mexico swap
// places: Georgia into the 7:30 PM game at Oklahoma, New Mexico to Arkansas.
const FACTS_SCENE = process.env.FACTS_SCENE === '1';
function factsScene(raw) {
  if (!FACTS_SCENE) return raw;
  const ev = (id) => (raw.events || []).find((e) => e.id === id);
  const ark = ev('401752701');
  const ou = ev('401752705');
  if (!ark || !ou) return raw;
  const a = ark.competitions[0].competitors.findIndex((c) => c.homeAway === 'away');
  const o = ou.competitions[0].competitors.findIndex((c) => c.homeAway === 'away');
  const uga = ark.competitions[0].competitors[a];
  ark.competitions[0].competitors[a] = ou.competitions[0].competitors[o];
  ou.competitions[0].competitors[o] = uga;
  ou.date = ou.competitions[0].date = '2026-09-26T23:30Z';
  const oc = ou.competitions[0];
  if (Array.isArray(oc.odds) && oc.odds[0]) { oc.odds[0].details = 'UGA -6.5'; oc.odds[0].overUnder = 51.5; }
  oc.broadcasts = [{ market: 'national', names: ['ABC'] }];
  return raw;
}

// The app now reads three ESPN endpoints: the scoreboard (live.js), a team's
// schedule and the AP poll (teamfacts.js). Only Georgia's schedule has a
// fixture; any other team answers 404, which the page must survive.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://site.api.espn.com/')) {
    const name = currentFixture();
    if (name === 'down') throw new Error('getaddrinfo ENOTFOUND site.api.espn.com');
    let raw;
    if (/\/rankings(\?|$)/.test(u)) raw = readFixture('rankings');
    else if (/\/teams\/61\/schedule/.test(u)) raw = readFixture('schedule-uga');
    else if (/\/teams\//.test(u)) return new Response('not found', { status: 404 });
    else raw = factsScene(readFixture(name));
    return new Response(JSON.stringify(shift(raw)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

if (FACTS_SCENE) {
  // What fan/uga held when Erik looked: written before the Arkansas game.
  h.bag(process.env.FIRESTORE_DATABASE_ID).set('fan/uga', {
    team: 'uga', rank: '#2', record: '2-0', confRecord: '0-0 SEC',
    nextGame: { opponent: 'at Arkansas', kickoffISO: '2026-09-19T16:00:00.000Z', tv: 'ABC', line: 'Georgia -24.5', gameId: 'uga-ark' },
    schedule: [
      { wk: 'Sep 5', opp: 'Tennessee State', loc: 'home', result: 'W 63-3' },
      { wk: 'Sep 12', opp: 'Western Kentucky', loc: 'home', result: 'W 70-20' },
      { wk: 'Sep 19', opp: 'at Arkansas', loc: 'away', current: true },
      { wk: 'Oct 31', opp: 'vs Florida (Atlanta)', loc: 'neutral', rivalry: true },
      { wk: 'Nov 28', opp: 'Georgia Tech', loc: 'home', rivalry: true },
    ],
    storyline: [
      'Gunner Stockton has been sharp through two games \u2014 28-of-32 for 436 yards and 8 touchdowns combined against Tennessee State and Western Kentucky \u2014 and is drawing real Heisman buzz in his second year as the starter.',
      'The bigger question mark is receiver depth: Georgia lost its top three wideouts from a year ago, leaving wide receiver as the thinnest room on the roster.',
    ],
    lastChecked: new Date(Date.parse('2026-09-19T15:30:00Z') + shiftMs).toISOString(),
  });
}

require(path.join(__dirname, '..', 'server.js'));
console.log(`live boot on :${process.env.PORT} with fixture "${currentFixture()}" (today ET ${todayET})`);
