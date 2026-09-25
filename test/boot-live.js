#!/usr/bin/env node
// Boots the app in memory with the live feed answered from a fixture - for
// looking at the live layer in a browser. Not a suite (run.js skips boot-*).
//
//   PORT=9310 LIVE_FIXTURE=live node test/boot-live.js
//
// LIVE_FIXTURE is one of: live, live-next, finals, no-games, down. If
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://site.api.espn.com/')) {
    const name = currentFixture();
    if (name === 'down') throw new Error('getaddrinfo ENOTFOUND site.api.espn.com');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `espn-${name}.json`), 'utf8'));
    return new Response(JSON.stringify(shift(raw)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

require(path.join(__dirname, '..', 'server.js'));
console.log(`live boot on :${process.env.PORT} with fixture "${currentFixture()}" (today ET ${todayET})`);
