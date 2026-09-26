// The page half of the 2026-09-26 audit: hostile board, games, slip, asks
// and live data drawn through the REAL render functions in public/index.html,
// and the HTML they produce checked for anything executable.
//
// No browser and no jsdom: the page's main script runs in a vm context with a
// stand-in `document` that records every innerHTML written. The script
// exposes its render functions on window.__CFB_TEST__ when that object exists
// (and then does not start), which nothing sets in a browser.
//
// The data here is deliberately NOT passed through board.validate(): the
// server strips markup and restricts ids, and this proves the page is safe
// even when something gets past the server.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const board = require(path.join(__dirname, '..', 'board.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };

/* ---------- a stand-in DOM that remembers what was drawn ---------- */
const written = [];
const els = new Map();
function makeEl(id) {
  let html = '';
  const e = {
    id, textContent: '', hidden: false, value: '', title: '', className: '', scrollTop: 0, scrollHeight: 0,
    style: { setProperty() {} }, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get innerHTML() { return html; },
    set innerHTML(v) { html = String(v); written.push({ id, html }); },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeChild() {}, appendChild() {},
    querySelector() { return makeEl(id + '>q'); }, querySelectorAll() { return []; },
    focus() {}, scrollIntoView() {}, getBoundingClientRect() { return { top: 0, width: 0, height: 0 }; },
  };
  return e;
}
const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const store = new Map();
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const document = {
  hidden: false, activeElement: null,
  getElementById: getEl, querySelector: (s) => getEl('qs:' + s), querySelectorAll: () => [],
  addEventListener() {}, createElement: () => makeEl('created'), contains: () => false,
  body: makeEl('body'), documentElement: makeEl('html'),
};
const ctx = {
  document, localStorage: storage, sessionStorage: storage, navigator: {}, location: { hash: '' }, history: { replaceState() {} },
  fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame() {}, matchMedia: () => ({ matches: false }), console, Intl, Date, Math, JSON,
  __CFB_TEST__: {},
};
ctx.window = ctx;
ctx.self = ctx;
vm.createContext(ctx);

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'live-core.js'), 'utf8'), ctx);
const start = html.indexOf('<script src="/live-core.js"></script>\n<script>') + '<script src="/live-core.js"></script>\n<script>'.length;
const main = html.slice(start, html.indexOf('</script>', start));
vm.runInContext(main, ctx, { filename: 'index.html:main' });
const api = ctx.__CFB_TEST__.api;
ok('the page exposes its render functions to the test seam', !!(api && api.renderCards));

/* ---------- executable markup, found by parsing what was drawn ---------- */
const ALLOWED_TAGS = new Set(['div', 'span', 'b', 'strong', 'em', 'i', 'p', 'br', 'a', 'article', 'section', 'button', 'h2', 'h3',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'label', 'textarea', 'select', 'option', 'code', 'pre',
  'svg', 'path', 'circle']);
function problems(s) {
  const out = [];
  const tagRe = /<\s*([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?\s*>/g;
  let m;
  while ((m = tagRe.exec(s))) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) out.push('tag <' + tag + '>');
    const attrRe = /([^\s=\/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      const name = a[1].toLowerCase();
      const val = (a[2] || '').replace(/^["']|["']$/g, '');
      if (/^on/.test(name) || ['autofocus', 'srcdoc', 'formaction', 'src'].includes(name)) out.push(`attr ${name} on <${tag}>`);
      if (name === 'href' && !/^(https:\/\/|#)/.test(val)) out.push('href ' + val);
      if (name === 'style' && /url\(|expression/i.test(val)) out.push('style ' + val);
    }
  }
  // A "<" that did not open a tag the scanner understood is still suspect.
  if (/<\s*(img|script|iframe|svg\s+onload)/i.test(s)) out.push('raw tag text');
  return out;
}

/* ---------- hostile data everywhere the page reads ---------- */
const X = '<img src=x onerror="window.__xss=1">';
const Q = '" autofocus onfocus="window.__xss=2" x="';
const hostileBoard = {
  weekKey: '2026-09-22', generatedAt: '2026-09-21T14:05:00.000Z', stale: false,
  games: [{ id: 'g1' + Q, label: 'Alpha at Beta' + X, time: 'Sat 3:30p ET' + X, kicker: '#1' + X }],
  picks: [{ id: 'p1' + Q, title: 'Beta -3.5' + X, matchup: 'Alpha at Beta' + X, time: 'Sat' + X, market: 'Spread' + X,
    odds: -110, confidence: 3, thesis: 'T' + X, why: 'W' + X, risk: 'R' + X }],
  parlays: [{ id: 'l1' + Q, title: 'Two' + X, confidence: 2, thesis: 't' + X, why: 'w' + X, risk: 'r' + X,
    legs: [{ game: 'Alpha at Beta' + X, market: 'Beta -3.5' + X, odds: -110 }, { game: 'C at D' + Q, market: 'D -7' + Q, odds: 120 }] }],
  results: [{ id: 'r1' + Q, title: 'Old' + X, outcome: 'win', finalScore: '1-0' + X, note: 'n' + X }],
  rankings: [{ rank: 1, team: 'Texas' + X, record: '3-0' + X, game: 'vs X' + X, time: 't' + X, line: 'l' + Q, gameId: 'g1' + Q, dkUrl: 'javascript:alert(1)' }],
  rankingsFrom: { source: 'poll', name: 'AP' + X, week: 'Week 5' + X, date: '2026-09-21', games: true },
  feed: { ['g1' + Q]: { dkUrl: 'https://sportsbook.draftkings.com/event/1"onclick="x', line: 'x' + X } },
};

api.init();
api.setArrangement({ hidden: [], pinned: ['p1' + Q], order: [], own: [{ id: 'own-1' + Q, title: 'Mine' + X, matchup: 'M' + X,
  time: 't' + X, market: 'Spread', odds: -110, thesis: 'th' + X, gameId: 'g1' + Q }] });
api.setSlip({ ['p1' + Q]: { stake: 25, placed: true }, ['l1' + Q]: { stake: 10, placed: true }, ['own-1' + Q]: { stake: 5, placed: true },
  ['game-z' + Q]: { stake: 5, placed: true } },
  { ['z' + Q]: { title: 'Added' + X, matchup: 'Alpha at Beta' + X, time: 't' + X, market: 'm' + X, odds: -110, thesis: 'th' + X,
    why: 'w' + X, risk: 'r' + X, confidence: 3 } });
api.applyBoard(hostileBoard);

const hostileGames = [{ id: 'g1' + Q, label: 'Alpha at Beta' + X, home: 'Beta' + X, away: 'Alpha' + X, kickoff: 'Sat' + X,
  tag: 'top25' + Q, ranked: '#1' + X, market: 'm' + X, pick: 'Beta -3.5' + Q, pickConfidence: 3, summary: 's' + X,
  why: 'w' + X, injuryNote: 'i' + X, pass: false, lastChecked: '2026-09-21T00:00:00Z' + X, dkUrl: 'https://evil.example/' + Q,
  line: 'UGA -3' + X, lineSource: 'ESPN BET' + X },
  { id: 'g2', label: 'Pass game' + X, pass: true, passReason: 'r' + X }];
api.renderGamesGrid(hostileGames);
api.renderResearchList();
api.renderAsksFeed([{ query: 'q' + X, askedAt: '2026-09-21T00:00:00Z', answer: '**bold**' + X + ' [link](javascript:alert(1)) [ok](https://x.example/"onclick=1)', relatedGameId: 'g1' + Q }]);
api.applyLive({
  available: true, anyLive: true, today: '2026-09-26', fetchedAt: '2026-09-26T20:00:00Z',
  games: [{ id: '1' + Q, state: 'in', live: true, final: false, period: 3, clock: '7:12', detail: 'd' + X, startsAt: '2026-09-26T16:00:00Z',
    away: { name: 'A' + X, abbr: 'A' + Q, rank: 2, score: 7, linescores: [7], record: '1-0' + X, color: 'red;background:url(x)' },
    home: { name: 'B' + X, abbr: 'B', rank: null, score: 3, linescores: [3], record: '', color: '#ffffff' },
    tv: ['ESPN' + X], possession: 'away', redZone: true, lastPlay: 'lp' + X, leaders: [{ label: 'Passing' + X, name: 'n' + X, side: 'away', line: 'l' + X }],
    line: 'A -3' + X, overUnder: 50, venue: 'v' + X, dkUrl: 'javascript:alert(1)', mine: 'slip' }],
  slip: [{ id: 'p1' + Q, kind: 'straight', matched: true, state: 'live', outcome: 'hitting' + Q, text: 't' + X, detail: 'd' + X, gameId: '1' + Q, title: 'x' + X }],
  cards: [{ id: 'p1' + Q, kind: 'straight', matched: true, state: 'live', outcome: 'missing' + Q, text: 'Needs 3' + X, detail: 'A 7, B 3' + X,
    lineNow: { kind: 'spread', picked: -3.5, now: -6.5, better: true }, lineSource: 'DK' + X }],
});
api.renderCards();
api.renderSlipTab();
api.paintOwnerControls({ canResearch: false, signedIn: false });

const all = written.map((w) => w.html).join('\n');
const found = [];
for (const w of written) for (const p of problems(w.html)) found.push(`${w.id}: ${p}`);
ok('hostile board, games, slip, asks and live data render with no executable markup', found.length === 0, found.slice(0, 8).join(' | '));
ok('...the image payload is drawn as text', all.includes('&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'));
ok('...the attribute-breaking id is escaped in every attribute', !all.includes('" autofocus') && all.includes('&quot; autofocus onfocus=&quot;'));
ok('...a javascript: link from the feed or a model never becomes an href', !/href="javascript/i.test(all));
ok('...markdown links stay http(s) only', !/<a href="javascript/i.test(all));
ok('the pick card, parlay, own card, added card, games, research and slip all drew', ['card-list', 'games-grid', 'research-list', 'slip-body', 'live-root', 'top25-list', 'results-strip']
  .every((id) => written.some((w) => w.id === id && w.html.length > 50)), [...new Set(written.map((w) => w.id))].join(','));
ok('every DraftKings link opens in a new tab with noopener noreferrer', (all.match(/class="dk-link"[^>]*>/g) || []).every((a) => /target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a)) &&
  (all.match(/class="dk-link"/g) || []).length >= 5, String((all.match(/class="dk-link"/g) || []).length));
ok('...and every one goes to https draftkings.com', (all.match(/class="dk-link" href="([^"]*)"/g) || []).every((a) => /href="https:\/\/(sportsbook\.)?draftkings\.com\//.test(a)));
ok('a card shows the line now beside the line picked', /Picked −3\.5 · closed −6\.5/.test(all) && all.includes('beat the close'));
ok('a parlay says how many legs it has, not always three', all.includes('2-leg parlay') && !all.includes('++'));

/* ---------- escapeHtml escapes quotes ---------- */
ok('escapeHtml escapes quotes as well as tags', api.escapeHtml(`<a href="x" title='y'>&`) === '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');

/* ---------- the week, page and server agreeing ---------- */
let disagree = [];
const t0 = Date.parse('2026-08-20T00:00:00Z');
for (let t = t0; t < t0 + 200 * 86400000; t += 37 * 60000) {
  if (api.weekKeyAt(t) !== board.weekKeyAt(t)) { disagree.push(new Date(t).toISOString()); if (disagree.length > 3) break; }
}
ok('the page and the server agree on the week at every instant for 200 days (incl. both DST changes)', disagree.length === 0, disagree.join(','));
ok('Week 4 is the week of Sep 26, 2026', api.seasonWeekLabel('2026-09-22') === 'Week 4' && api.seasonWeekLabel('2026-09-15') === 'Week 3');

/* ---------- expireStaleWeek: arrangement too, and the one-week migration ---------- */
store.clear();
store.set('cfb-week-key-v1', '2020-01-07');
store.set('cover-sheet-board-v1', '{"hidden":["x"]}');
store.set('cover-sheet-slip-v1', '{"x":{"placed":true}}');
ok('a slip from an old week under the old key is dropped, arrangement included', api.expireStaleWeek() === true &&
  !store.has('cover-sheet-board-v1') && !store.has('cover-sheet-slip-v1'));
store.clear();
const now = api.weekKeyAt(Date.now());
const prevTue = new Date(Date.parse(now + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
store.set('cfb-week-key-v1', prevTue);
store.set('cover-sheet-slip-v1', '{"x":{"placed":true}}');
ok('...but a slip the old scheme filed a week early (placed Sunday or Monday) survives the switch', api.expireStaleWeek() === false && store.has('cover-sheet-slip-v1'));
ok('...and the next run under the new key keeps it', api.expireStaleWeek() === false && store.get('cfb-week-key-v2') === now);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
