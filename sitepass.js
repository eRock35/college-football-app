// A changeable password for the apps that have exactly one.
//
// COPY. The source is eriks-projects/shared/sitepass.js - edit it there and
// run `node scripts/sync-shared.js`. CI fails if a copy drifts.

const crypto = require('crypto');

const DOC = 'site-password';
const MIN_LENGTH = 10;

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('base64');
}

function makeRecord(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: hash(password, salt), updatedAt: new Date().toISOString() };
}

function matchesRecord(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const a = Buffer.from(hash(password, record.salt));
  const b = Buffer.from(record.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Constant-time compare for the environment-variable fallback. Padding to a
 *  fixed width keeps the comparison from leaking the length. */
function matchesEnv(password, expected) {
  if (!expected || !password) return false;
  const a = Buffer.from(String(password).padEnd(72).slice(0, 72));
  const b = Buffer.from(String(expected).padEnd(72).slice(0, 72));
  return crypto.timingSafeEqual(a, b);
}

/* ---------- writes come from the site's own page (2026-09-27) ---------- */

// Every app is a subdomain of one registrable domain, so a page on any of
// them is "same-site" to the others and a SameSite=Lax cookie rides along on
// a form it auto-submits. A Face ID session may change this password without
// the old one, so a hidden form on a sibling could otherwise do it in that
// browser. Refused unless the browser says the request came from this origin
// and the body is JSON (a plain form cannot send JSON). The same rule as
// identity's sameOriginOnly and the landing's crossSiteWrite.
function crossSiteWrite(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  const get = (h) => (req.get ? req.get(h) : req.headers[h.toLowerCase()]);
  const site = get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== String(get('host') || '')) return true;
    } catch (e) { return true; }
  }
  const type = get('content-type');
  if (type && !/^application\/([a-z0-9.+-]*\+)?json\s*(;|$)/i.test(String(type).trim())) return true;
  return false;
}

/** The address Cloud Run's front end saw: the rightmost X-Forwarded-For
 *  entry, which is the one it appended. */
function clientIp(req) {
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1].slice(0, 64);
  return String(req.ip || 'unknown').slice(0, 64);
}

// The change route checks the CURRENT password with no session needed, so
// without a count it is a password oracle beside the sign-in form. Failures
// per address, per instance: 10 in 15 minutes.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

/**
 * @param opts.store       { get, set } over a collection
 * @param opts.collection  where to keep the record, default 'control'
 * @param opts.envPassword () => string   bootstrap password
 * @param opts.canChange   async (req) => boolean  proves identity
 * @param opts.onChanged   optional async () => void, e.g. to end other sessions
 */
function create(opts) {
  const { store, collection = 'control', envPassword, canChange, onChanged } = opts;

  async function stored() {
    try { return await store.get(collection, DOC); } catch (e) { return null; }
  }

  /** The stored password wins when there is one; otherwise the env var. */
  async function verify(candidate) {
    if (!candidate) return false;
    const rec = await stored();
    if (rec && rec.hash) return matchesRecord(candidate, rec);
    return matchesEnv(candidate, envPassword());
  }

  async function isCustom() {
    const rec = await stored();
    return Boolean(rec && rec.hash);
  }

  async function change(next) {
    const value = String(next || '');
    if (value.length < MIN_LENGTH) {
      throw Object.assign(new Error(`Use at least ${MIN_LENGTH} characters.`), { status: 400 });
    }
    await store.set(collection, DOC, makeRecord(value));
    if (onChanged) await onChanged();
  }

  /** Back to whatever the environment variable says. The escape hatch if the
   *  stored password is ever lost AND no passkey is enrolled. */
  async function clear() {
    await store.set(collection, DOC, { clearedAt: new Date().toISOString() });
  }

  function mount(app, path = '/api/auth/password') {
    app.get(`${path}/state`, async (_req, res) => {
      res.json({ custom: await isCustom(), minLength: MIN_LENGTH });
    });

    const failures = new Map(); // ip -> [times]
    const recent = (ip) => (failures.get(ip) || []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);

    app.post(`${path}/change`, async (req, res) => {
      try {
        if (crossSiteWrite(req)) {
          return res.status(403).json({ error: 'That request has to come from this site’s own page.' });
        }
        const ip = clientIp(req);
        if (recent(ip).length >= FAIL_LIMIT) {
          res.set('Retry-After', String(FAIL_WINDOW_MS / 1000));
          return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
        }
        // canChange is where the host decides what counts as proof: the
        // current password, or a session that was itself proved by Face ID.
        // A plain session must NOT be enough, or a borrowed one could take
        // the account permanently.
        if (!(await canChange(req))) {
          const list = recent(ip);
          list.push(Date.now());
          failures.set(ip, list);
          if (failures.size > 5000) failures.clear();
          await new Promise((r) => setTimeout(r, 400));
          return res.status(401).json({ error: 'That did not prove who you are.' });
        }
        await change((req.body || {}).next);
        res.json({ ok: true });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not change the password.' });
      }
    });
  }

  return { verify, change, clear, isCustom, mount, MIN_LENGTH };
}

module.exports = { create, crossSiteWrite, clientIp, MIN_LENGTH, DOC };
