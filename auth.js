// Passkey (WebAuthn) auth, with the password kept as a fallback.
//
// Two things worth knowing before changing anything here:
//
// 1. The RP ID is derived from the request's own hostname rather than
//    hardcoded. A passkey is bound to the domain it was registered on, and
//    this app is reachable both at its *.run.app URL and (once DNS lands) at
//    footballapp.strongtechnicalconsulting.com. Deriving it means a passkey
//    registered on either host keeps working on that host; hardcoding one
//    would have broken the other.
// 2. Accounts are per-email and anyone may register one, but claiming a
//    PRIVILEGED address (one the app treats as an owner) additionally
//    requires the site password. Self-asserted email proves nothing on its
//    own - without that gate, registering the owner's address would hand you
//    the owner's access. Adding a second device to an existing ordinary
//    account needs a live session for that same account, for the same reason.
//
// This file diverged from the single-account copy shared with the other apps
// on this domain when this app went multi-user. Don't sync it back wholesale.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - it's a personal app
const CHALLENGE_TTL_SECONDS = 300;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function readToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 1) return null;
  const body = token.slice(0, idx);
  const got = Buffer.from(token.slice(idx + 1));
  const want = Buffer.from(sign(body, secret));
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  const prior = res.getHeader('Set-Cookie');
  const list = prior ? (Array.isArray(prior) ? prior.slice() : [prior]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

// Cloud Run terminates TLS, so the scheme is always https here.
function rpInfo(req) {
  const rpID = req.hostname;
  return { rpID, origin: `https://${rpID}` };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Deliberately loose - this is a sanity check on a self-asserted label, not
// proof of anything. The password gate below is what actually protects the
// addresses that matter.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param opts.db                     Firestore instance
 * @param opts.collection             collection holding credentials
 * @param opts.usersCollection        collection holding user records
 * @param opts.rpName                 display name shown in the OS prompt
 * @param opts.sessionSecret          HMAC secret for session + challenge cookies
 * @param opts.passwordOk             async (req) -> bool, true if the site password was supplied
 * @param opts.needsPasswordForEmail  (email) -> bool, true for privileged addresses
 * @param opts.isResearchEmail        (email) -> bool, reported to the page as canResearch
 */
function createPasskeyAuth(opts) {
  const { db, collection, rpName, sessionSecret } = opts;
  const usersCollection = opts.usersCollection || 'users';
  const passwordOk = opts.passwordOk || (async () => false);
  const needsPasswordForEmail = opts.needsPasswordForEmail || (() => false);
  const isResearchEmail = opts.isResearchEmail || (() => false);

  // The signed-in user, or null. The uid IS the normalized email - one
  // account per address, and it reads plainly in Firestore.
  function currentUser(req) {
    if (!sessionSecret) return null;
    const payload = readToken(parseCookies(req).session, sessionSecret);
    if (!payload || !payload.sub) return null;
    return { uid: payload.sub, email: payload.email || payload.sub };
  }

  function hasSession(req) {
    return !!currentUser(req);
  }

  // `via` records HOW the session was proved. See the same note in
  // santa-rosa-beach-trip/auth.js: a password-proved session must not be
  // enough to change the password, or a stolen cookie takes the account.
  function issueSession(res, user, via = 'password') {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    setCookie(res, 'session', makeToken({ sub: user.uid, email: user.email, exp, via }, sessionSecret), SESSION_TTL_SECONDS);
  }

  function sessionVia(req) {
    const payload = readToken(parseCookies(req).session, sessionSecret);
    if (!payload) return null;
    return payload.via === 'passkey' ? 'passkey' : 'password';
  }

  async function listCredentials() {
    const snap = await db.collection(collection).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function mount(app) {
    // --- registration -------------------------------------------------
    // Open to anyone for a new, ordinary address. Two cases need proof:
    // a privileged address (site password), and an address that already
    // exists (a session for that same account, i.e. "add this device").
    app.post('/api/auth/passkey/register/options', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const email = normalizeEmail(req.body && req.body.email);
        if (!EMAIL_RE.test(email)) {
          return res.status(400).json({ error: 'Enter a valid email address.' });
        }

        const privileged = needsPasswordForEmail(email);
        const havePassword = await passwordOk(req);
        // Deliberately no WWW-Authenticate: the page collects this password in
        // its own field. The browser's Basic dialog would fire at ordinary
        // visitors who have no password and never will, and opening it spends
        // the user activation the WebAuthn call still needs.
        if (privileged && !havePassword) {
          return res.status(401).json({
            error: 'That address is the owner\u2019s - enter the site password to claim it.',
            needsPassword: true,
          });
        }

        const userDoc = await db.collection(usersCollection).doc(email).get();
        if (userDoc.exists && !privileged) {
          const me = currentUser(req);
          if (!me || me.uid !== email) {
            return res.status(409).json({
              error: 'That email is already registered. Sign in with its passkey on this device first, then add another.',
            });
          }
        }

        const existing = await listCredentials();
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: email,
          userDisplayName: email,
          attestationType: 'none',
          excludeCredentials: existing
            .filter((c) => c.rpID === rpID && c.uid === email)
            .map((c) => ({ id: c.id, transports: c.transports || undefined })),
          authenticatorSelection: {
            // Discoverable, so signing in needs no email typed back in - the
            // platform offers the right passkey and the credential tells us
            // which account it is.
            residentKey: 'required',
            userVerification: 'preferred', // Face ID / Touch ID when available
          },
        });
        const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
        setCookie(res, 'reg_challenge', makeToken({ c: options.challenge, u: email, exp }, sessionSecret), CHALLENGE_TTL_SECONDS);
        res.json(options);
      } catch (err) {
        console.error('passkey register/options', err);
        res.status(500).json({ error: 'Could not start passkey registration.' });
      }
    });

    // The verify step can't carry the password - its body is the WebAuthn
    // credential. The options step already demanded whatever proof this
    // address needed, and the signed 5-minute challenge cookie (which names
    // the account) proves this is that same flow.
    app.post('/api/auth/passkey/register/verify', async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const stashed = readToken(parseCookies(req).reg_challenge, sessionSecret);
        if (!stashed || !stashed.u) return res.status(400).json({ error: 'Registration expired - try again.' });
        const email = normalizeEmail(stashed.u);

        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: stashed.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
        if (!verification.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });

        const cred = verification.registrationInfo.credential;
        const now = new Date().toISOString();
        await db.collection(collection).doc(cred.id).set({
          uid: email,
          publicKey: Buffer.from(cred.publicKey).toString('base64'),
          counter: cred.counter,
          transports: cred.transports || [],
          rpID,
          label: (req.body && req.body.label) || 'Passkey',
          createdAt: now,
        });
        await db.collection(usersCollection).doc(email).set({ email, createdAt: now, lastLoginAt: now }, { merge: true });

        clearCookie(res, 'reg_challenge');
        issueSession(res, { uid: email, email });
        res.json({ ok: true, email, canResearch: isResearchEmail(email) });
      } catch (err) {
        console.error('passkey register/verify', err);
        res.status(500).json({ error: 'Passkey registration failed.' });
      }
    });

    // --- login (no password - that's the point) ---
    app.post('/api/auth/passkey/login/options', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const creds = (await listCredentials()).filter((c) => c.rpID === rpID);
        if (!creds.length) return res.status(404).json({ error: 'No passkey registered on this domain yet.' });

        // No allowCredentials: the passkeys are discoverable, so the platform
        // offers the ones it holds and the credential it returns tells us the
        // account. Listing them here would hand every visitor the full set of
        // credential ids, and a count of how many accounts exist.
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: 'preferred',
        });
        const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
        setCookie(res, 'auth_challenge', makeToken({ c: options.challenge, exp }, sessionSecret), CHALLENGE_TTL_SECONDS);
        res.json(options);
      } catch (err) {
        console.error('passkey login/options', err);
        res.status(500).json({ error: 'Could not start passkey sign-in.' });
      }
    });

    app.post('/api/auth/passkey/login/verify', async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const stashed = readToken(parseCookies(req).auth_challenge, sessionSecret);
        if (!stashed) return res.status(400).json({ error: 'Sign-in expired — try again.' });

        const id = req.body && req.body.id;
        if (!id) return res.status(400).json({ error: 'Malformed passkey response.' });
        const doc = await db.collection(collection).doc(id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Unknown passkey.' });
        const stored = doc.data();
        // A passkey is bound to the host it was registered on; one registered
        // elsewhere must not authenticate here.
        if (stored.rpID !== rpID) return res.status(404).json({ error: 'Unknown passkey.' });
        const email = normalizeEmail(stored.uid);
        if (!email) return res.status(409).json({ error: 'That passkey predates accounts - register again.' });

        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: stashed.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id,
            publicKey: Buffer.from(stored.publicKey, 'base64'),
            counter: stored.counter || 0,
            transports: stored.transports || undefined,
          },
        });
        if (!verification.verified) return res.status(401).json({ error: 'Passkey rejected.' });

        // Counter guards against cloned authenticators. Synced passkeys often
        // report 0 throughout, so only persist genuine increases.
        const newCounter = verification.authenticationInfo.newCounter;
        if (typeof newCounter === 'number' && newCounter > (stored.counter || 0)) {
          await doc.ref.update({ counter: newCounter, lastUsedAt: new Date().toISOString() });
        } else {
          await doc.ref.update({ lastUsedAt: new Date().toISOString() });
        }

        await db.collection(usersCollection).doc(email).set({ lastLoginAt: new Date().toISOString() }, { merge: true });
        clearCookie(res, 'auth_challenge');
        issueSession(res, { uid: email, email }, 'passkey');
        res.json({ ok: true, email, canResearch: isResearchEmail(email) });
      } catch (err) {
        console.error('passkey login/verify', err);
        res.status(500).json({ error: 'Passkey sign-in failed.' });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      clearCookie(res, 'session');
      res.json({ ok: true });
    });

    app.get('/api/auth/status', async (req, res) => {
      const { rpID } = rpInfo(req);
      let registered = false;
      try {
        registered = (await listCredentials()).some((c) => c.rpID === rpID);
      } catch (e) { /* treat as none */ }
      const me = currentUser(req);
      res.json({
        signedIn: !!me,
        email: me ? me.email : null,
        // Drives what the page offers: everyone gets a slip, research is the
        // owner's. The server enforces this regardless of what the page does.
        canResearch: !!(me && isResearchEmail(me.email)),
        // HOW the session was proved. The page uses it to decide whether to
        // ask for the current site password before changing it - a Face ID
        // session is proof enough on its own, a password one is not.
        via: me ? sessionVia(req) : null,
        passkeyRegistered: registered,
      });
    });
  }

  return { mount, hasSession, currentUser, issueSession, sessionVia };
}

module.exports = { createPasskeyAuth, parseCookies };
