/**
 * Brag cards (2026-09-26): the picture a share link unfurls into, and the
 * image the share sheet hands to Messages or Instagram.
 *
 * Drawn on the SERVER from data the server graded - never an image the
 * browser uploads. A share link lives on this domain, and letting a request
 * choose the picture behind it would make it a place to host anything.
 *
 * SVG built here, rasterised by resvg (a Rust renderer with prebuilt
 * binaries, no system libraries) with Inter bundled in fonts/ (SIL OFL, its
 * licence beside it). System fonts are not loaded: the container has none
 * worth having, and a card must look the same in the sandbox and in Cloud
 * Run. The fonts are Inter's Latin subset, so text outside it (emoji, most
 * symbols) would draw as a blank - which is why nothing here uses them and
 * every mark is a shape.
 *
 * 1200x630, the size every unfurler (iMessage, X, Slack, LinkedIn) crops
 * least. No model call.
 */

const path = require('path');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { Resvg = null; }

const FONT_FILES = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'Inter-Black.ttf'].map((f) => path.join(__dirname, 'fonts', f));
const W = 1200;
const H = 630;
const C = {
  bg: '#05070D', bg2: '#0C1B33', text: '#FFFFFF', dim: '#A1A1AA', faint: '#71717A',
  win: '#30D158', loss: '#FF453A', push: '#A1A1AA', accent: '#0A84FF', gold: '#FFD60A', line: '#1F2937',
};
const SITE = 'footballapp.strongtechnicalconsulting.com';

/** Text for an SVG text node or attribute. Control characters dropped. */
function x(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Roughly fit `s` in `px` at `size` (Inter averages ~0.56em a character). */
function fit(s, size, px, weight = 400) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  const per = size * (weight >= 700 ? 0.6 : 0.54);
  const max = Math.max(4, Math.floor(px / per));
  return str.length <= max ? str : `${str.slice(0, max - 1).trimEnd()}…`;
}

function text(xp, y, s, { size = 32, weight = 400, fill = C.text, anchor = 'start', px = 1080, spacing = 0 } = {}) {
  return `<text x="${xp}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
    ` text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${x(fit(s, size, px, weight))}</text>`;
}

/** A headline number, shrunk to fit its width rather than cut short. */
function big(xp, y, s, maxSize, px, fill = C.text) {
  const str = String(s);
  const size = Math.min(maxSize, Math.floor(px / (str.length * 0.62)));
  return `<text x="${xp}" y="${y}" font-family="Inter" font-size="${size}" font-weight="900" fill="${fill}" letter-spacing="-3">${x(str)}</text>`;
}

function frame(inner, { accent = C.accent } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${C.bg2}"/><stop offset="0.65" stop-color="${C.bg}"/></linearGradient>` +
    `<radialGradient id="glow" cx="0.92" cy="0.05" r="0.6"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>` +
    `<stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>` +
    // A football's laces, as the mark: a rounded bar and four stitches.
    `<g transform="translate(60 52)"><rect x="0" y="6" width="44" height="24" rx="12" fill="none" stroke="${C.text}" stroke-width="3"/>` +
    `<line x1="12" y1="18" x2="32" y2="18" stroke="${C.text}" stroke-width="3"/>` +
    [16, 22, 28].map((lx) => `<line x1="${lx}" y1="13" x2="${lx}" y2="23" stroke="${C.text}" stroke-width="2.5"/>`).join('') + '</g>' +
    text(118, 82, 'College Football', { size: 26, weight: 700 }) +
    inner +
    `<line x1="60" y1="${H - 74}" x2="${W - 60}" y2="${H - 74}" stroke="${C.line}" stroke-width="2"/>` +
    text(60, H - 34, SITE, { size: 24, fill: C.faint }) +
    text(W - 60, H - 34, 'Free to play. No bets placed.', { size: 24, fill: C.faint, anchor: 'end', px: 520 }) +
    '</svg>';
}

/** "7-3" or "7-3-1". */
function wlp(r) {
  if (!r) return '0-0';
  return `${r.w || 0}-${r.l || 0}${r.p ? `-${r.p}` : ''}`;
}

function pct(r) {
  const d = (r.w || 0) + (r.l || 0);
  return d ? Math.round(((r.w || 0) / d) * 100) : null;
}

function outcomeMark(xp, y, outcome) {
  const col = outcome === 'win' ? C.win : outcome === 'loss' ? C.loss : C.push;
  const r = 13;
  let mark;
  if (outcome === 'win') mark = `<path d="M${xp - 6} ${y} l4 5 l8 -10" fill="none" stroke="#000" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  else if (outcome === 'loss') mark = `<path d="M${xp - 5} ${y - 5} l10 10 M${xp + 5} ${y - 5} l-10 10" stroke="#000" stroke-width="3.2" stroke-linecap="round"/>`;
  else mark = `<line x1="${xp - 6}" y1="${y}" x2="${xp + 6}" y2="${y}" stroke="#000" stroke-width="3.2" stroke-linecap="round"/>`;
  return `<circle cx="${xp}" cy="${y}" r="${r}" fill="${col}"/>${mark}`;
}

function pill(xp, y, label, { fill = '#FFFFFF14', stroke = '#FFFFFF33', color = C.text, size = 22 } = {}) {
  const w = Math.min(420, Math.round(String(label).length * size * 0.58) + 36);
  return { w, svg: `<rect x="${xp}" y="${y - size - 8}" width="${w}" height="${size + 22}" rx="${(size + 22) / 2}" fill="${fill}" stroke="${stroke}"/>` +
    text(xp + 18, y + 2, label, { size, weight: 700, fill: color, px: w - 30 }) };
}

/**
 * A reader's week.
 *   { by, weekLabel, calls: {w,l,p}, slip: {w,l,p,net}|null, rows: [{label, outcome}],
 *     badges: [name], vsReaders: 'Readers went 58%' }
 */
function weekSvg(d) {
  const calls = d.calls || { w: 0, l: 0, p: 0 };
  const p = pct(calls);
  const accent = calls.w >= calls.l ? C.win : C.loss;
  let out = text(60, 176, `${d.by || 'A reader'}’s calls · ${d.weekLabel || 'this week'}`, { size: 34, weight: 700, fill: C.dim, px: 1080 });
  const decided = (calls.w || 0) + (calls.l || 0) + (calls.p || 0);
  if (!decided && calls.pending) {
    // Nothing final yet: the calls are the story, not a 0-0.
    out += big(56, 316, `${calls.pending} call${calls.pending === 1 ? '' : 's'}`, 132, 600);
    out += text(60, 384, 'Locked in. Think they\u2019re wrong?', { size: 32, weight: 700, fill: C.accent, px: 640 });
  } else {
    out += big(56, 330, wlp(calls), 168, 600);
    if (p !== null) out += text(60, 384, `${p}% against the spread`, { size: 32, weight: 700, fill: accent, px: 560 });
  }
  if (d.slip && (d.slip.w || d.slip.l)) {
    const net = Number(d.slip.net) || 0;
    out += text(60, 432, `Slip ${wlp(d.slip)} · ${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(0)}`, { size: 30, weight: 700, fill: net >= 0 ? C.win : C.loss, px: 560 });
  } else if (d.vsReaders) {
    out += text(60, 432, d.vsReaders, { size: 28, fill: C.dim, px: 560 });
  }
  // The calls themselves, right-hand column.
  const rows = (d.rows || []).slice(0, 6);
  rows.forEach((r, i) => {
    const y = 176 + 58 + i * 50;
    out += outcomeMark(700, y - 10, r.outcome) + text(726, y, r.label, { size: 28, weight: 700, px: 420 });
  });
  const more = (d.rows || []).length - rows.length;
  if (more > 0) out += text(726, 176 + 58 + rows.length * 50, `+${more} more`, { size: 24, fill: C.faint, px: 400 });
  // Badges as pills along the bottom.
  let bx = 60;
  for (const b of (d.badges || []).slice(0, 4)) {
    const pl = pill(bx, 500, b, { fill: '#FFD60A1F', stroke: '#FFD60A66', color: C.gold });
    if (bx + pl.w > W - 60) break;
    out += pl.svg;
    bx += pl.w + 14;
  }
  return frame(out, { accent });
}

/** A reader's season: calls, slip, streak, badges. */
function seasonSvg(d) {
  const calls = d.calls || { w: 0, l: 0, p: 0 };
  const p = pct(calls);
  let out = text(60, 176, `${d.by || 'A reader'}’s season`, { size: 34, weight: 700, fill: C.dim });
  out += big(56, 330, wlp(calls), 168, 680);
  out += text(60, 384, p === null ? 'calls against the spread' : `${p}% of calls against the spread`, { size: 32, weight: 700, fill: C.win, px: 640 });
  if (d.streak && d.streak.count >= 2) {
    out += text(60, 432, `${d.streak.count} straight ${d.streak.kind === 'win' ? 'wins' : 'losses'}`, { size: 30, weight: 700, fill: d.streak.kind === 'win' ? C.gold : C.dim, px: 600 });
  }
  const earned = d.badges || [];
  out += text(780, 176, `${earned.length} badge${earned.length === 1 ? '' : 's'}`, { size: 30, weight: 700, fill: C.gold, px: 360 });
  earned.slice(0, 6).forEach((b, i) => {
    out += pill(780, 236 + i * 52, b, { fill: '#FFD60A1F', stroke: '#FFD60A55', color: C.text, size: 22 }).svg;
  });
  return frame(out, { accent: C.gold });
}

/** A shared slip: up to five plays and what it pays. */
function slipSvg(d) {
  const items = (d.items || []).slice(0, 5);
  let out = text(60, 176, `${d.by || 'A reader'}’s slip${d.weekLabel ? ` · ${d.weekLabel}` : ''}`, { size: 34, weight: 700, fill: C.dim });
  items.forEach((it, i) => {
    const y = 240 + i * 56;
    const odds = Number(it.odds);
    out += `<rect x="60" y="${y - 34}" width="6" height="40" rx="3" fill="${it.kind === 'parlay' ? C.gold : C.accent}"/>`;
    out += text(84, y, it.title, { size: 32, weight: 700, px: 760 });
    if (Number.isFinite(odds) && Math.abs(odds) >= 100) out += text(W - 60, y, odds > 0 ? `+${odds}` : String(odds), { size: 30, weight: 700, fill: C.dim, anchor: 'end', px: 200 });
  });
  const more = (d.items || []).length - items.length;
  if (more > 0) out += text(84, 240 + items.length * 56, `+${more} more`, { size: 26, fill: C.faint });
  if (d.totalRisk > 0) {
    out += text(60, 520, `$${Math.round(d.totalRisk)} to win $${Math.round(d.totalToWin)}`, { size: 36, weight: 900, fill: C.win, px: 900 });
  }
  return frame(out);
}

/** The app itself, for any link to it: the board's season and this week. */
function appSvg(d) {
  let out = text(60, 190, d.headline || 'This week’s card, live scores and your calls', { size: 52, weight: 900, px: 1080 });
  out += text(60, 246, d.sub || 'Call every game, see where the crowd is, and track your record.', { size: 30, fill: C.dim, px: 1080 });
  const rec = d.record;
  if (rec && (rec.w || rec.l)) {
    out += big(60, 400, wlp(rec), 120, 560);
    out += text(60, 450, `The board’s picks this season${typeof rec.units === 'number' ? ` · ${rec.units >= 0 ? '+' : ''}${rec.units}u` : ''}`, { size: 30, weight: 700, fill: C.win, px: 700 });
  }
  (d.games || []).slice(0, 4).forEach((g, i) => {
    out += text(W - 60, 340 + i * 44, g, { size: 26, weight: 700, fill: i ? C.dim : C.text, anchor: 'end', px: 460 });
  });
  return frame(out);
}

/** An SVG to a PNG buffer, or null when the renderer is not installed. */
function png(svg) {
  if (!Resvg) return null;
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } });
  return r.render().asPng();
}

/** A small in-memory cache of rendered cards: a brag is immutable, and a
 *  link pasted into a group chat is fetched by every client in it. */
function createCache(max = 200) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v || null; },
    set(k, v) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
  };
}

module.exports = { weekSvg, seasonSvg, slipSvg, appSvg, png, createCache, wlp, pct, x, fit, W, H, SITE };
