/**
 * The board: this week's slate, the best bets on it, and last week's results.
 *
 * It used to be three `var` arrays inside public/index.html, which meant the
 * only way to put a new week's games in front of anyone was a deploy. That is
 * why the app sat on the September 20 slate for days with finished games on
 * the front page - the research sweep could annotate a card ("this game has
 * already been played"), but nothing could ever retire one or add next week's.
 *
 * Now the board lives in Firestore at `board/current` and this module is the
 * SEED: what a fresh database serves, and what still works if the document is
 * deleted. Same bootstrap relationship the vacation app's schedule.js has with
 * its stored plan, and for the same reason - "restore the original" can never
 * drift from what a fresh install shows.
 *
 * validate() runs on the model's PROPOSAL, before anything is written, not
 * only on read. A board comes out of a model with web search, and a pick with
 * no odds or a parlay with no legs renders as a broken front page that needs a
 * deploy to fix - which is the exact problem this file exists to end.
 */

const SEED = {
  "games": [
    {
      "id": "uga-ark",
      "label": "Georgia at Arkansas",
      "time": "Sat 12:00p ET · ABC",
      "kicker": "#2 Georgia (-24.5) at Arkansas"
    },
    {
      "id": "unc-clem",
      "label": "North Carolina at Clemson",
      "time": "Sat 12:00p ET · ESPN",
      "kicker": "North Carolina at Clemson (-3.5)"
    },
    {
      "id": "lsu-om",
      "label": "LSU at Ole Miss",
      "time": "Sat 7:30p ET",
      "kicker": "#7 LSU (-2.5) at #8 Ole Miss"
    },
    {
      "id": "fsu-bama",
      "label": "Florida State at Alabama",
      "time": "Sat 3:30p ET · ABC",
      "kicker": "Florida State at #10 Alabama (-20)"
    },
    {
      "id": "msu-nd",
      "label": "Michigan State at Notre Dame",
      "time": "Sat 7:30p ET",
      "kicker": "Michigan State at Notre Dame (-29.5)"
    },
    {
      "id": "nm-ou",
      "label": "New Mexico at Oklahoma",
      "time": "Sat 7:30p ET · ESPN2",
      "kicker": "New Mexico at #24 Oklahoma (-22.5)"
    },
    {
      "id": "ks-osu",
      "label": "Kent State at Ohio State",
      "time": "Sat 12:00p ET",
      "kicker": "Kent State at #6 Ohio State (-52.5)"
    },
    {
      "id": "msst-sc",
      "label": "Mississippi State at South Carolina",
      "time": "Sat 7:00p ET · ESPN",
      "kicker": "Mississippi State at South Carolina (-4)"
    },
    {
      "id": "fla-aub",
      "label": "Florida at Auburn",
      "time": "Sat 7:00p ET · ESPN",
      "kicker": "Florida (-2.5) at Auburn"
    }
  ],
  "picks": [
    {
      "id": "georgia-spread",
      "type": "straight",
      "title": "Georgia -24.5",
      "matchup": "Georgia at Arkansas",
      "time": "Sat 12:00p ET · ABC",
      "market": "Spread · Georgia -24.5",
      "odds": -115,
      "confidence": 4,
      "thesis": "Georgia is unbeaten against the number as a 24.5+ point favorite this year; Arkansas hasn’t covered a single line yet.",
      "why": "Georgia is 2-0 against the spread as a favorite of 24.5 points or more this season, while Arkansas is 0-for-the-year against the number — the Razorbacks haven’t covered once. This is the widest roster gap on the ranked-vs-unranked slate: Kirby Smart’s defensive front against a Razorback offensive line still finding itself under a rebuilt staff. Georgia has also gone over its own total in every game so far, a sign Smart isn’t dialing back the offense once the score gets lopsided.",
      "risk": "If Georgia is up 35-plus by the third quarter, backups could see extended run and shave the final margin below the number on a backdoor cover."
    },
    {
      "id": "clemson-spread",
      "type": "straight",
      "title": "Clemson -3.5",
      "matchup": "North Carolina at Clemson",
      "time": "Sat 12:00p ET · ESPN",
      "market": "Spread · Clemson -3.5",
      "odds": -110,
      "confidence": 3,
      "thesis": "A 3.5-point home number for a blue blood says the market still isn’t sure what Clemson looks like without Cade Klubnik — we think the Tigers’ talent gap clears it anyway.",
      "why": "North Carolina opened 2-0, but that start came against a light non-conference slate, and this is the Tar Heels’ first real road test. Clemson is 1-1 and still working out life without Klubnik at quarterback, which is exactly why the number sits at only 3.5 instead of the double digits a healthy Clemson team would usually lay at home. We’re backing the Tigers’ defensive talent and home-field structure to be enough of an edge to cover a number this modest, even in a transition year.",
      "risk": "If Clemson’s new starter turns the ball over early, this is the kind of number that flips fast — treat it as the moderate-confidence play of the day, not a lock."
    },
    {
      "id": "lsu-om-under",
      "type": "straight",
      "title": "Under 58.5",
      "matchup": "LSU at Ole Miss",
      "time": "Sat 7:30p ET",
      "market": "Total · Under 58.5",
      "odds": -110,
      "confidence": 3,
      "thesis": "LSU QB Sam Leavitt went doubtful-to-questionable on a sore throwing shoulder and the total hasn’t come down to match the uncertainty.",
      "why": "LSU’s Sam Leavitt was listed doubtful mid-week with soreness in his throwing shoulder, was limited in practice, then upgraded to questionable after Friday’s walkthrough. The spread whipsawed on the news — LSU eased from around -3 to -1 the moment the report broke, then climbed back to roughly -2.5 as books decided the market had overreacted on the point spread. The total, though, is still sitting at a number that assumes a full-strength LSU passing game. If Leavitt plays hurt, or hands off to Elon transfer Landen Clark, LSU’s offense is far more likely to lean on the run and control the clock than to trade scores with Lane Kiffin’s Ole Miss attack the way a healthy Leavitt would.",
      "risk": "If Leavitt is a full go and LSU’s offense looks normal in warmups, this number loses its edge — check the final injury report before kickoff."
    },
    {
      "id": "fla-aub-dog",
      "type": "straight",
      "title": "Auburn +2.5",
      "matchup": "Florida at Auburn",
      "time": "Sat 7:00p ET · ESPN",
      "market": "Spread · Auburn +2.5 (or ML +115)",
      "odds": 115,
      "confidence": 2,
      "thesis": "A true coinflip getting bet one-sided — Florida is drawing roughly 70% of spread tickets, but the number hasn’t moved off -2.5 all week, and Florida enters banged up.",
      "why": "Florida carries real injury uncertainty into Jordan-Hare: WR Eric Singleton Jr. and DE Emmanuel Oyebadejo are both questionable with ankle injuries and were “very, very limited” in practice. Auburn (2-0) has its own weapon in dual-threat QB Byrum Brown, productive both throwing and running. A line that hasn’t budged despite Florida taking roughly 70% of tickets usually means the money on the other side is bigger per bet than its ticket count suggests — the book isn’t worried about the public lean.",
      "risk": "This is a genuine coinflip, not a screaming value play — a moderate-confidence single-possession lean, not a lock. Confirm Florida’s injury report is unchanged before kickoff."
    },
    {
      "id": "notre-dame-spread",
      "type": "straight",
      "title": "Notre Dame -29.5",
      "matchup": "Michigan State at Notre Dame",
      "time": "Sat 7:30p ET",
      "market": "Spread · Notre Dame -29.5",
      "odds": -110,
      "confidence": 4,
      "thesis": "The number hasn’t moved a point all week despite the public splitting tickets close to 50/50 — a sign the book, not the crowd, has this one right.",
      "why": "Notre Dame opened around -29.5/-30 and it hasn’t budged, even with spread tickets reportedly running close to even. Books rarely hold a number that steady against balanced public money unless they’re confident in it. Michigan State is a respectable program but overmatched here on both sides of the ball.",
      "risk": "If Notre Dame is up 40-plus by the third quarter, backups could see extended run and shave the final margin on a backdoor cover."
    },
    {
      "id": "oklahoma-spread",
      "type": "straight",
      "title": "Oklahoma -22.5",
      "matchup": "New Mexico at Oklahoma",
      "time": "Sat 7:30p ET · ESPN2",
      "market": "Spread · Oklahoma -22.5",
      "odds": -110,
      "confidence": 4,
      "thesis": "A get-right spot for QB John Mateer after a rough outing against Michigan, against a defense several levels below what he just faced.",
      "why": "Mateer threw for 414 yards and 4 TDs in his first two games before managing just 189 yards with an interception against Michigan. New Mexico’s defense is a significant step down in class from a Big Ten opponent, setting up a bounce-back game for Oklahoma’s passing attack.",
      "risk": "If Oklahoma’s offense sputters again the way it did against Michigan, this number could tighten — check pregame warmup reports on Mateer before locking this in."
    },
    {
      "id": "msst-sc-over",
      "type": "straight",
      "title": "Over 58.5",
      "matchup": "Mississippi State at South Carolina",
      "time": "Sat 7:00p ET · ESPN",
      "market": "Total · Over 58.5",
      "odds": -110,
      "confidence": 3,
      "thesis": "The tightest spread on tonight’s board (South Carolina -4) paired with a 58.5 total says the market expects a track meet, not a defensive struggle.",
      "why": "A 4-point home number combined with a 58.5 total suggests both offenses are expected to move the ball — this isn’t a game where one side is projected to dominate defensively. Both teams have shown they’ll trade scores rather than play it close to the vest.",
      "risk": "If either defense forces a couple of early turnovers and shortens the game, the total can dry up fast — this is a moderate-confidence total, not a lock."
    }
  ],
  "parlays": [
    {
      "id": "blowout-board",
      "title": "Blowout Board",
      "confidence": 4,
      "thesis": "Three ranked home teams against overmatched or rebuilding visitors — each number is closer to “expect it” than “hope for it.”",
      "legs": [
        {
          "game": "Florida State at Alabama",
          "market": "Alabama -20",
          "odds": -110
        },
        {
          "game": "New Mexico at Oklahoma",
          "market": "Oklahoma -22.5",
          "odds": -110
        },
        {
          "game": "Michigan State at Notre Dame",
          "market": "Notre Dame -29.5",
          "odds": -110
        }
      ],
      "why": "Alabama is a -2000 moneyline favorite against a Florida State front it should control from the opening snap. Oklahoma gets a bounce-back spot for John Mateer (414 yards, 4 TDs through two games) after he was held to 189 yards with a pick against Michigan — New Mexico’s defense isn’t in that class. And Notre Dame’s -29.5 hasn’t moved a point since it opened despite the betting public splitting tickets roughly 50/50, which usually means the book — not the crowd — has this number right.",
      "risk": "All three favorites are laying huge numbers, so this parlay’s biggest risk is correlated: if one starter is pulled early for a lopsided score, that leg’s cover gets shaky late. Treat this as the higher-conviction, lower-payout of the two parlays."
    },
    {
      "id": "scoreboard-overs",
      "title": "Scoreboard Overs",
      "confidence": 3,
      "thesis": "Three mismatches where the favorite’s starters stay in and stay productive — stacked totals instead of stacked spreads.",
      "legs": [
        {
          "game": "Georgia at Arkansas",
          "market": "Over 54.5",
          "odds": -105
        },
        {
          "game": "Kent State at Ohio State",
          "market": "Over 59.5",
          "odds": -110
        },
        {
          "game": "Mississippi State at South Carolina",
          "market": "Over 58.5",
          "odds": -110
        }
      ],
      "why": "Georgia has gone over its own total in every game this season. Ohio State’s Jeremiah Smith is averaging over 150 receiving yards a game through two weeks and has climbed to the No. 2 spot on the Heisman board (+700) — Kent State’s defense isn’t built to keep Columbus under 60. South Carolina-Mississippi State carries the same 58.5 total as the LSU-Ole Miss game we’re fading on the under, but this one pairs two offenses that have both shown they’ll trade scores rather than a passing game in doubt.",
      "risk": "If any one favorite is comfortably ahead by halftime, running clock in the fourth quarter can cap a total that looked good on paper. This is the more speculative of the two parlays."
    },
    {
      "id": "night-slate-mix",
      "title": "Night Slate Mix",
      "confidence": 3,
      "thesis": "Two blowout favorites you can trust plus one real underdog-value lean — all from games that hadn’t kicked off when this was built.",
      "legs": [
        {
          "game": "Michigan State at Notre Dame",
          "market": "Notre Dame -29.5",
          "odds": -110
        },
        {
          "game": "New Mexico at Oklahoma",
          "market": "Oklahoma -22.5",
          "odds": -110
        },
        {
          "game": "Florida at Auburn",
          "market": "Auburn +2.5",
          "odds": 115
        }
      ],
      "why": "Notre Dame’s -29.5 hasn’t moved a point all week despite the betting public splitting tickets close to 50/50 — a sign the book, not the crowd, has this number right. Oklahoma is a get-right spot for QB John Mateer after a rough outing against Michigan, against a New Mexico defense that’s a big step down in class. The wrinkle is Auburn +2.5: Florida is drawing roughly 70% of the tickets on a line that hasn’t budged, and Florida has real injury uncertainty (WR Eric Singleton Jr. and DE Emmanuel Oyebadejo both questionable) — the kind of split that usually means the sharper money is on the other side.",
      "risk": "Mixing two big favorites with a true coinflip means this parlay lives or dies on Auburn — the blowout legs should be safe, but a single missed leg kills the whole ticket. Treat this as the speculative one, not the safe one."
    }
  ]
};

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const MAX = { id: 60, short: 120, line: 400, prose: 2000 };

/**
 * Every string on the board, trimmed, capped, and with angle brackets gone.
 *
 * The cards were hand-written constants until this file existed, and the page
 * interpolates their fields straight into innerHTML - which was fine for text
 * a person typed and is not fine for text a model with web search produces
 * from pages it found. Stripping `<` and `>` here, once, at the only door the
 * board comes through, beats remembering to escape at a dozen call sites.
 * The alternative - storing entities - would double-escape wherever the page
 * does escape, and betting copy has no legitimate use for a tag.
 */
const clean = (v, cap) => String(v === undefined || v === null ? '' : v)
  .replace(/[<>]/g, '')
  .trim()
  .slice(0, cap);

/** American odds as a number. '-110', -110 and '+115' are all the same bet;
 *  'even' and '' are not numbers and must not reach the payout maths, which
 *  turns a NaN into a blank stake box with nothing to explain it. */
function odds(value) {
  const n = Number(String(value).replace(/^\+/, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function confidence(value) {
  const n = Math.round(Number(value));
  return n >= 1 && n <= 4 ? n : 3;   // a missing dot count is not worth refusing a board over
}

function game(raw, i) {
  const label = clean(raw && raw.label, MAX.short);
  if (!label) throw new Error(`game ${i + 1} has no label`);
  return {
    id: clean(raw.id, MAX.id) || `game-${i + 1}`,
    label,
    time: clean(raw.time, MAX.short),
    kicker: clean(raw.kicker, MAX.short) || label,
  };
}

function pick(raw, i) {
  const title = clean(raw && raw.title, MAX.short);
  if (!title) throw new Error(`pick ${i + 1} has no title`);
  const price = odds(raw.odds);
  if (price === null) throw new Error(`pick "${title}" has no usable odds`);
  return {
    id: clean(raw.id, MAX.id) || `pick-${i + 1}`,
    type: 'straight',
    title,
    matchup: clean(raw.matchup, MAX.short),
    time: clean(raw.time, MAX.short),
    market: clean(raw.market, MAX.short),
    odds: price,
    confidence: confidence(raw.confidence),
    thesis: clean(raw.thesis, MAX.line),
    why: clean(raw.why, MAX.prose),
    risk: clean(raw.risk, MAX.prose),
  };
}

function parlay(raw, i) {
  const title = clean(raw && raw.title, MAX.short);
  if (!title) throw new Error(`parlay ${i + 1} has no title`);
  const legs = (Array.isArray(raw.legs) ? raw.legs : []).map((leg, j) => {
    const price = odds(leg && leg.odds);
    if (price === null) throw new Error(`leg ${j + 1} of "${title}" has no usable odds`);
    return { game: clean(leg.game, MAX.short), market: clean(leg.market, MAX.short), odds: price };
  });
  // A parlay is a combination. One leg is a straight bet wearing a costume,
  // and zero legs multiplies out to a payout of exactly the stake.
  if (legs.length < 2) throw new Error(`parlay "${title}" needs at least two legs`);
  return {
    id: clean(raw.id, MAX.id) || `parlay-${i + 1}`,
    title,
    confidence: confidence(raw.confidence),
    thesis: clean(raw.thesis, MAX.line),
    legs,
    why: clean(raw.why, MAX.prose),
    risk: clean(raw.risk, MAX.prose),
  };
}

/**
 * One row of the Top 25: a ranked team and who it plays this week.
 *
 * This is the poll, not the best bets - "who is ranked, and what are they
 * doing on Saturday" is the question the board could not answer, and it is a
 * different question from "what should I bet". A ranked team on a bye is a
 * real row with no game, so `game` is optional and a blank one renders as a
 * bye rather than as a missing field.
 */
function ranked(raw, i) {
  const team = clean(raw && raw.team, MAX.short);
  if (!team) throw new Error(`ranking ${i + 1} has no team`);
  const n = Math.round(Number(raw.rank));
  // A poll position is 1..25. A model that returns "#3" or 0 or 41 is not
  // giving a rank, and a list that cannot be ordered is not a poll.
  if (!(n >= 1 && n <= 25)) throw new Error(`ranking for "${team}" has no usable position`);
  return {
    rank: n,
    team,
    record: clean(raw.record, 24),
    game: clean(raw.game, MAX.short),
    time: clean(raw.time, MAX.short),
    line: clean(raw.line, MAX.short),
    // Ties a row to a card on the slate, so "who plays this week" and "what to
    // bet" agree about which game they mean.
    gameId: clean(raw.gameId, MAX.id),
  };
}

const OUTCOMES = new Set(['win', 'loss', 'push', 'void']);

/** How last week's bet finished. Unlike the rest of the board this is a claim
 *  about the past, so an outcome the model invents a name for ("covered",
 *  "cashed") is dropped rather than shown - a result strip that says something
 *  is worse than one that says nothing. */
function result(raw, i) {
  const title = clean(raw && raw.title, MAX.short);
  if (!title) throw new Error(`result ${i + 1} has no title`);
  const outcome = clean(raw.outcome, 10).toLowerCase();
  return {
    id: clean(raw.id, MAX.id) || `result-${i + 1}`,
    title,
    matchup: clean(raw.matchup, MAX.short),
    market: clean(raw.market, MAX.short),
    finalScore: clean(raw.finalScore, MAX.short),
    outcome: OUTCOMES.has(outcome) ? outcome : '',
    note: clean(raw.note, MAX.line),
  };
}

/**
 * Returns a clean board, or throws with a reason a human can act on.
 *
 * Games and picks are both required: a board with a slate and no bets is a
 * schedule, and a board with bets and no slate has nothing to bet on. Results
 * are optional - the first board of a season has no last week.
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('board is not an object');
  const games = (Array.isArray(raw.games) ? raw.games : []).map(game);
  const picks = (Array.isArray(raw.picks) ? raw.picks : []).map(pick);
  const parlays = (Array.isArray(raw.parlays) ? raw.parlays : []).map(parlay);
  const results = (Array.isArray(raw.results) ? raw.results : []).map(result);

  // The poll, sorted and de-duplicated. Optional: every board stored before
  // this existed has none, and refusing those would blank the front page to
  // add a section to it. Two teams at #7 is a poll nobody can read, so the
  // later one is dropped rather than shown.
  const seenRank = new Set();
  const rankings = (Array.isArray(raw.rankings) ? raw.rankings : [])
    .map(ranked)
    .filter((r) => (seenRank.has(r.rank) ? false : seenRank.add(r.rank)))
    .sort((a, b) => a.rank - b.rank);

  if (!games.length) throw new Error('board has no games');
  if (!picks.length) throw new Error('board has no picks');

  // Ids address a card from the slip, the payout table and the share link.
  // Two cards answering to one id means adding either one to a slip picks
  // whichever the filter happens to reach first.
  const seen = new Set();
  for (const row of [...games, ...picks, ...parlays, ...results]) {
    if (seen.has(row.id)) throw new Error(`duplicate id "${row.id}"`);
    seen.add(row.id);
  }

  return {
    weekKey: clean(raw.weekKey, MAX.id),
    generatedAt: clean(raw.generatedAt, MAX.id) || new Date().toISOString(),
    games, picks, parlays, results, rankings,
  };
}

/** The seed, validated - so a typo in this file fails the test suite rather
 *  than the front page. */
function seed() {
  return validate({ ...SEED, weekKey: '', generatedAt: '2026-09-19T00:00:00.000Z' });
}

module.exports = { seed, validate, SEED };
