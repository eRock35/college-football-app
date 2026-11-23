// The 2026-11 redesign, held in place. Reads public/index.html as text: the
// chrome (one nav, the same tab ids), the task paths the home screen promises,
// and the house rules (system fonts, five type sizes, motion only for people
// who have not asked for less, no shadows on things that do not float).
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>\n'), html.indexOf('</style>', html.indexOf('<style>\n')));
const body = html.slice(html.indexOf('</style>', html.indexOf('<style>\n')), html.indexOf('<script src="/live-core.js">'));

/* ---- navigation ---- */
const nav = body.slice(body.indexOf('<nav class="tabbar"'), body.indexOf('</nav>'));
const tabIds = [...nav.matchAll(/<button class="tab" role="tab"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
ok('one nav, with every section it always had', JSON.stringify(tabIds) === JSON.stringify(['tab-card', 'tab-games', 'tab-slip', 'tab-research', 'tab-futures', 'tab-uga']), JSON.stringify(tabIds));
ok('...and exactly one <nav> on the page', (body.match(/<nav\b/g) || []).length === 1);
ok('each tab still controls its panel', tabIds.every((id) => new RegExp('<section role="tabpanel" id="panel-' + id.slice(4) + '" aria-labelledby="' + id + '"').test(body)));
ok('the phone bar is five: Research and Futures step behind More', /@media \(max-width:899px\)\{[^}]*#tab-research, #tab-futures\{display:none;\}/.test(css));
const more = body.slice(body.indexOf('id="more-sheet"'), body.indexOf('id="dyn-sheet"'));
const moreTargets = [...more.matchAll(/data-tab-target="([^"]+)"/g)].map((m) => m[1]);
ok('...and More offers exactly those two', JSON.stringify(moreTargets) === JSON.stringify(['tab-research', 'tab-futures']), JSON.stringify(moreTargets));
ok('More lights up for the sections behind it', /more-active', tabEl\.id === 'tab-futures' \|\| tabEl\.id === 'tab-research'\)/.test(html));
ok('nav icons are 1.5px line icons', !/stroke-width="1\.8"/.test(nav) && /stroke-width="1\.5"/.test(nav));
ok('the nav label shows only on the current item (phone)', /\.tab \.tab-label\{position:absolute; width:1px; height:1px;/.test(css) && /\.tab\[aria-selected="true"\] \.tab-label[^{]*\{position:static/.test(css));
ok('the shared left-rail stylesheet is no longer loaded', !/desktop\.css/.test(html) && !/<body class="dk"/.test(html));

/* ---- task paths from Home ---- */
const home = body.slice(body.indexOf('id="panel-card"'), body.indexOf('id="panel-games"'));
for (const [what, id] of [['live scores', 'live-root'], ['Call it', 'calls-list'], ['your record', 'calls-you'], ['the board\'s season', 'season-chip'],
  ['last week', 'results-strip'], ['the Top 25', 'top25-toggle'], ['the picks', 'card-list'], ['add a game', 'card-search-input']]) {
  ok('Home carries ' + what, home.includes('id="' + id + '"'));
}
ok('a signed-out visitor gets a welcome that says what this is', /<section class="hero" id="hero"[^>]*hidden>/.test(home) && home.includes('id="hero-call"') && home.includes('id="hero-signin"'));
ok('...shown only when signed out through neither door', /heroSignedOut = !state\.signedIn && !state\.signedInAnywhere;/.test(html));
ok('the account button is in the bar on every tab', /<header class="topbar">[\s\S]*id="auth-chip"[\s\S]*<\/header>/.test(body));
ok('a stale board keeps its played picks behind a button', html.includes('id="old-board-toggle"') && /block\.hidden = show && !showOldBoard;/.test(html));
ok('last week is one row until opened, ungraded rows counted', html.includes('id="results-toggle"') && html.includes("' not graded'"));

/* ---- house rules ---- */
ok('no font is bundled or downloaded by the page', !/@font-face|fonts\.googleapis|\.woff|\.ttf/.test(html));
const sizes = new Set([...html.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]));
ok('five type sizes (13, 15, 16, 20, 28)', [...sizes].every((v) => ['13', '15', '16', '20', '28'].includes(v)), [...sizes].join(','));
const motionAt = css.indexOf('@media (prefers-reduced-motion: no-preference){');
const before = css.slice(0, motionAt);
ok('there is a no-preference motion block', motionAt > 0);
ok('...and no transition or animation outside it', !/(^|[;{\s])(transition|animation)(-[a-z]+)?\s*:/.test(before.replace(/\/\*[\s\S]*?\*\//g, '')),
  (before.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^\n]*(transition|animation)(-[a-z]+)?\s*:[^\n]*/) || [''])[0].trim().slice(0, 120));
ok('the page is white, and black in the dark', /--bg:#FFFFFF;/.test(css) && /--bg:#000000;/.test(css));
ok('no gradients', !/gradient\(/.test(css));
const shadows = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/box-shadow:([^;}]+)/g)].map((m) => m[1].trim())
  .filter((v) => !/^none$|^var\(--shadow\)$|var\(--lift\)|^inset |^0 0 0 /.test(v));
ok('shadows only on things that float (--lift), rings and inset stripes aside', shadows.length === 0, shadows.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
