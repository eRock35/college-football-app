/**
 * The browser half of the live layer - the part worth testing without a
 * browser: escaping, labels, and noticing a swing between two polls.
 *
 * Loaded by index.html as a plain script (window.LiveCore) and required by the
 * test suite as a CommonJS module. No DOM, no fetch, no timers in here; the
 * page owns all of those.
 *
 * Everything drawn from the live feed passes through esc(), including into
 * attributes - which is why this escapes quotes and the page's older
 * escapeHtml() (text nodes only) is not used for it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var QUARTER = ['', '1st', '2nd', '3rd', '4th'];

  /** "3rd 7:12", "Half", "Final/OT", "2OT", or the kickoff time for a game
   *  that has not started (formatted by the caller, in the reader's zone). */
  function clockLabel(g, fmtTime) {
    switch (g.state) {
      case 'final': return g.period > 4 ? 'Final/OT' : 'Final';
      case 'half': return 'Half';
      case 'postponed': return 'Postponed';
      case 'canceled': return 'Canceled';
      case 'delayed': return 'Delayed';
      case 'pre': return fmtTime && g.startsAt ? fmtTime(g.startsAt) : 'Today';
      case 'in':
        if (g.period > 4) return g.period === 5 ? 'OT' : (g.period - 4) + 'OT';
        return ((QUARTER[g.period] || '') + (g.clock ? ' ' + g.clock : '')).trim() || 'Live';
      default: return '';
    }
  }

  function hasScore(g) {
    return !!g && g.away && g.home && typeof g.away.score === 'number' && typeof g.home.score === 'number';
  }

  /** 'away' | 'home' | 'tie' | null (no score). */
  function leaderSide(g) {
    if (!hasScore(g)) return null;
    return g.away.score > g.home.score ? 'away' : g.home.score > g.away.score ? 'home' : 'tie';
  }

  /** "LSU 28, Ole Miss 24" - the leader first, the way a person says it. */
  function scoreText(g) {
    if (!hasScore(g)) return g.away.name + ' at ' + g.home.name;
    var first = g.home.score > g.away.score ? g.home : g.away;
    var second = first === g.home ? g.away : g.home;
    return first.name + ' ' + first.score + ', ' + second.name + ' ' + second.score;
  }

  /**
   * What one poll said, reduced to what a swing is measured against.
   * `prev` carries the last side to lead forward, so a lead that passes
   * through a tie between two polls still counts as changing hands.
   */
  function snapshot(resp, prev) {
    var games = {}, legs = {};
    (resp && resp.games || []).forEach(function (g) {
      var before = prev && prev.games[g.id];
      var side = leaderSide(g);
      games[g.id] = {
        id: g.id, state: g.state, live: !!g.live, final: !!g.final, period: g.period, clock: g.clock,
        mine: g.mine || '',
        away: { name: g.away.name, score: g.away.score },
        home: { name: g.home.name, score: g.home.score },
        lastLeader: side === 'away' || side === 'home' ? side : (before ? before.lastLeader : null),
      };
    });
    (resp && resp.slip || []).forEach(function (s) {
      if (s.kind === 'parlay') {
        (s.legs || []).forEach(function (l, i) {
          if (!l.matched) return;
          legs[s.id + '#' + i] = { title: l.market, parlay: s.title, outcome: l.outcome, state: l.state, text: l.text, gameId: l.gameId };
        });
      } else if (s.matched) {
        legs[s.id] = { title: s.title, outcome: s.outcome, state: s.state, text: s.text, gameId: s.gameId };
      }
    });
    return { games: games, legs: legs };
  }

  var LIVE_OUTCOMES = { hitting: 1, missing: 1 };
  var FINAL_OUTCOMES = { won: 'won', lost: 'lost', push: 'pushed' };

  /**
   * The alerts between two snapshots, for games that are the reader's (their
   * team, or on their slip) and for every tracked slip leg:
   *
   *   - a lead change (the side ahead is not the side that was ahead)
   *   - a score in the 4th quarter or overtime
   *   - a game going final (with any slip result on it folded in)
   *   - a leg flipping between hitting and missing
   *
   * The first poll has nothing to compare against and alerts nothing: opening
   * the app on a Saturday night must not replay every final of the day.
   * Each alert carries a `key` naming the event itself (game + score), so the
   * same swing seen again - a second tab, a slow poll - is recognised.
   */
  function detectSwings(prev, next) {
    if (!prev || !next) return [];
    var out = [];
    var finals = {};
    var gameAlerts = {};

    Object.keys(next.games).forEach(function (id) {
      var a = prev.games[id], b = next.games[id];
      if (!a || !b || !b.mine || !hasScore(b)) return;
      var sig = b.away.score + '-' + b.home.score;
      if (b.final && !a.final) {
        var alert = { key: 'final:' + id, kind: 'final', gameId: id, mine: b.mine, title: 'Final', text: scoreText(b) };
        finals[id] = alert;
        out.push(alert);
        return;
      }
      if (!b.live || !hasScore(a)) return;
      var clock = clockLabel(b);
      var before = a.lastLeader, now = leaderSide(b);
      if (before && (now === 'away' || now === 'home') && now !== before) {
        gameAlerts[id] = { key: 'lead:' + id + ':' + sig, kind: 'lead', gameId: id, mine: b.mine, title: 'Lead change',
          text: b[now].name + ' takes the lead — ' + scoreText(b) + ' (' + clock + ')' };
        out.push(gameAlerts[id]);
        return;
      }
      var scoredAway = b.away.score > a.away.score, scoredHome = b.home.score > a.home.score;
      if ((scoredAway || scoredHome) && b.period >= 4) {
        var who = scoredAway && scoredHome ? 'Both teams' : (scoredAway ? b.away.name : b.home.name);
        gameAlerts[id] = { key: 'score:' + id + ':' + sig, kind: 'score', gameId: id, mine: b.mine, title: who + ' score' + (who === 'Both teams' ? '' : 's'),
          text: scoreText(b) + ' (' + clock + ')' };
        out.push(gameAlerts[id]);
      }
    });

    Object.keys(next.legs).forEach(function (k) {
      var a = prev.legs[k], b = next.legs[k];
      if (!a || !b) return;
      var name = b.parlay ? b.title + ' (' + b.parlay + ')' : b.title;
      var g = next.games[b.gameId];
      var sig = g && hasScore(g) ? g.away.score + '-' + g.home.score : '';
      if (b.state === 'final' && a.state !== 'final' && FINAL_OUTCOMES[b.outcome]) {
        var line = name + ' ' + FINAL_OUTCOMES[b.outcome];
        if (finals[b.gameId]) { finals[b.gameId].text += ' · ' + line; return; }
        out.push({ key: 'settled:' + k, kind: 'settled', gameId: b.gameId, title: 'Your slip', text: line + ' — ' + b.text });
        return;
      }
      if (LIVE_OUTCOMES[a.outcome] && LIVE_OUTCOMES[b.outcome] && a.outcome !== b.outcome) {
        // The score that flipped it already has a banner: say it there.
        if (gameAlerts[b.gameId]) { gameAlerts[b.gameId].text += ' · ' + name + ' now ' + b.outcome; return; }
        out.push({ key: 'leg:' + k + ':' + b.outcome + ':' + sig, kind: 'leg', gameId: b.gameId,
          title: b.outcome === 'hitting' ? 'Now hitting' : 'Now missing', text: name + ' — ' + b.text });
      }
    });
    return rank(out);
  }

  var KIND_ORDER = { lead: 0, final: 1, score: 2, settled: 3, leg: 4 };
  // Not `KIND_ORDER[k] || 9`: a lead change is 0, and 0 || 9 filed it last.
  function order(a) { return Object.prototype.hasOwnProperty.call(KIND_ORDER, a.kind) ? KIND_ORDER[a.kind] : 9; }

  /** Most important first: the reader's team, then lead changes and finals
   *  before routine scores and leg flips. The page shows the first three. */
  function rank(alerts) {
    return alerts.slice().sort(function (x, y) {
      return (x.mine === 'team' ? 0 : 1) - (y.mine === 'team' ? 0 : 1)
        || order(x) - order(y);
    });
  }

  /**
   * Keys already shown, so nothing is said twice. Backed by whatever storage
   * the page hands in (sessionStorage in the browser, a plain object in the
   * tests); a storage that throws - private mode, blocked site data - just
   * means memory only.
   */
  function createSeen(storage, storageKey, max) {
    max = max || 300;
    var list = [];
    try {
      var raw = storage && storage.getItem(storageKey);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) list = parsed.filter(function (x) { return typeof x === 'string'; }).slice(-max);
    } catch (e) { list = []; }
    var set = {};
    list.forEach(function (k) { set[k] = true; });
    function save() { try { if (storage) storage.setItem(storageKey, JSON.stringify(list)); } catch (e) { /* memory only */ } }
    return {
      has: function (k) { return !!set[k]; },
      add: function (k) {
        if (set[k]) return;
        set[k] = true; list.push(k);
        while (list.length > max) delete set[list.shift()];
        save();
      },
      /** The alerts not seen before, marked seen. */
      fresh: function (alerts) {
        var self = this;
        return alerts.filter(function (a) { if (self.has(a.key)) return false; self.add(a.key); return true; });
      },
    };
  }

  /* ---------------- DraftKings links (2026-09-26) ----------------
   *
   * Erik: "add hyperlinks to the DraftKings game to easily trade on it". ONE
   * helper decides where every such link goes, server and page alike, so the
   * target changes in one place.
   *
   * A deep link to the game is used only when ESPN's feed carries one for it
   * (an odds entry's link/links href) AND it is https on draftkings.com or a
   * subdomain; its query and fragment are dropped, so no tracking or affiliate
   * parameter rides along. Otherwise the college football page. A DraftKings
   * event URL is never built from a guessed id.
   */
  var DK_FALLBACK = 'https://sportsbook.draftkings.com/leagues/football/ncaaf';

  /** An https DraftKings URL reduced to origin + path, or ''.
   *  ESPN's links are DraftKings' own redirect, `/gateway?...&preurl=<the
   *  event page, encoded>`; reduced naively that is a bare /gateway that goes
   *  nowhere. So a gateway link is unwrapped to its `preurl` - which must
   *  itself pass this test - and one with no usable preurl is no link. */
  function dkUrl(href, depth) {
    if (typeof href !== 'string' || href.length > 1000) return '';
    var m = /^https:\/\/([a-z0-9.-]+)(\/[^?#\s"'<>\\]*)?(?:[?#][^\s]*)?$/i.exec(href.trim());
    if (!m) return '';
    var host = m[1].toLowerCase();
    if (host !== 'draftkings.com' && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.draftkings\.com$/.test(host)) return '';
    var path = m[2] || '/';
    if (/^\/gateway\/?$/i.test(path)) {
      if (depth) return '';
      var q = /[?&]preurl=([^&#\s]*)/i.exec(href);
      if (!q) return '';
      var inner;
      try { inner = decodeURIComponent(q[1]); } catch (e) { return ''; }
      return dkUrl(inner, 1);
    }
    return 'https://' + host + path;
  }

  /** Where a "Bet on DraftKings" link goes and what it says. `line` is the
   *  bet as we show it ("Georgia -24.5"), when there is one. */
  function dkLink(opts) {
    opts = opts || {};
    var deep = dkUrl(opts.url);
    var line = String(opts.line === undefined || opts.line === null ? '' : opts.line).replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      href: deep || DK_FALLBACK,
      deep: !!deep,
      text: (line ? line + ' on DraftKings' : 'Bet on DraftKings') + ' \u2197',
    };
  }

  /** How often to ask again: 20 s while anything today is live, 5 min
   *  otherwise. The page pauses entirely while hidden. */
  function pollDelay(resp) {
    return resp && resp.available && resp.anyLive ? 20000 : 300000;
  }

  return {
    esc: esc, clockLabel: clockLabel, leaderSide: leaderSide, scoreText: scoreText,
    snapshot: snapshot, detectSwings: detectSwings, createSeen: createSeen, pollDelay: pollDelay,
    dkUrl: dkUrl, dkLink: dkLink, DK_FALLBACK: DK_FALLBACK,
  };
});
