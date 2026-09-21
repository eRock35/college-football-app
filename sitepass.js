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

    app.post(`${path}/change`, async (req, res) => {
      try {
        // canChange is where the host decides what counts as proof: the
        // current password, or a session that was itself proved by Face ID.
        // A plain session must NOT be enough, or a borrowed one could take
        // the account permanently.
        if (!(await canChange(req))) {
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

module.exports = { create, MIN_LENGTH, DOC };
