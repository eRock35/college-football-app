// The iPhone app's association file and its "Get the iPhone app" link
// (eriks-projects/mobile/README.md). Apple fetches the file with no cookie
// and follows no redirect, so:
//  - no APPLE_TEAM_ID, or a malformed one: 404, never the page;
//  - set: 200 application/json, no cookie, links open the app everywhere but
//    /api/*, and the app may use the passwords saved for this site;
//  - the Team ID is read per request, so a revision's env is all it takes.
// /ios-app.json answers the TestFlight public link, or null.
const h = require('./harness.js');
h.install();
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'cfb-secret-abcdefghijklmnopq',
  SITE_LOGIN_USERNAME: 'erik', SITE_LOGIN_PASSWORD: 'site-password-here-1',
  FIRESTORE_DATABASE_ID: 'college-football-app', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', PORT: '9233',
});
delete process.env.APPLE_TEAM_ID;
delete process.env.TESTFLIGHT_URL;
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9233';
const PATH = '/.well-known/apple-app-site-association';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const get = (p) => fetch(B + p, { redirect: 'manual' });

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await get('/api/health')).status === 200) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  let r = await get(PATH);
  ok('no APPLE_TEAM_ID: 404', r.status === 404, r.status);
  ok('...and not the page', !(await r.text()).includes('<html'));
  for (const bad of ['abcde12345', 'ABCDE1234', 'ABCDE12345X', 'ABCDE-1234']) {
    process.env.APPLE_TEAM_ID = bad;
    ok(`a malformed Team ID (${bad}): 404`, (await get(PATH)).status === 404);
  }

  process.env.APPLE_TEAM_ID = 'ABCDE12345';
  r = await get(PATH);
  ok('set: 200 with no redirect', r.status === 200, r.status);
  ok('...served as application/json', /^application\/json\b/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('...sets no cookie', !r.headers.get('set-cookie'), r.headers.get('set-cookie'));
  const body = await r.json();
  const id = 'ABCDE12345.com.strongtechnicalconsulting.football';
  const d = body.applinks && body.applinks.details;
  ok('applinks name this app', Array.isArray(d) && d.length === 1 && JSON.stringify(d[0].appIDs) === JSON.stringify([id]), JSON.stringify(d));
  ok('...every path but /api/*', JSON.stringify(d[0].components.map((c) => [c['/'], !!c.exclude])) === JSON.stringify([['/api/*', true], ['*', false]]));
  ok('webcredentials name this app', JSON.stringify(body.webcredentials) === JSON.stringify({ apps: [id] }));
  process.env.APPLE_TEAM_ID = 'ZZZZZ99999';
  ok('read per request', JSON.stringify(await (await get(PATH)).json()).includes('ZZZZZ99999.com.strongtechnicalconsulting.football'));

  r = await get('/ios-app.json');
  ok('no TestFlight link: url null', r.status === 200 && JSON.stringify(await r.json()) === JSON.stringify({ name: 'Football', url: null }));
  process.env.TESTFLIGHT_URL = 'https://testflight.apple.com/join/AbCd1234';
  ok('a TestFlight public link is answered', (await (await get('/ios-app.json')).json()).url === process.env.TESTFLIGHT_URL);
  process.env.TESTFLIGHT_URL = 'https://evil.example/join/AbCd1234';
  ok('anything else is null', (await (await get('/ios-app.json')).json()).url === null);
  const page = await (await get('/')).text();
  ok('the page loads the bar', page.includes('src="/get-app.js" data-src="/ios-app.json"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
