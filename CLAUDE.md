# For Claude: bootstrapping this environment

See `docs/gcp-deployment.md` for the full picture (project, Firestore, auth
model, deploy pipeline, known issues). This file is just the "how do I
authenticate to GCP without asking the user to re-upload a key" bootstrap.

Related repos (same GCP project, same domain, split out for organization —
each project Erik builds gets its own repo):
- `eRock35/eriks-projects` — the landing/hub page at the root domain
- `eRock35/santa-rosa-beach-trip` — **private**, the vacation app (real PII)

## GCP auth — if `GCP_SERVICE_ACCOUNT_KEY_JSON` is set

Check `echo "$GCP_SERVICE_ACCOUNT_KEY_JSON" | head -c 20` at the start of any
session that needs to touch GCP. If it's set, you have everything you need
without asking the user for anything:

```bash
mkdir -p /tmp/gcp && echo "$GCP_SERVICE_ACCOUNT_KEY_JSON" > /tmp/gcp/sa-key.json
chmod 600 /tmp/gcp/sa-key.json
python3 -m venv /tmp/gcp/venv
/tmp/gcp/venv/bin/pip install --quiet pyjwt cryptography requests google-auth
/tmp/gcp/venv/bin/python3 -c "
import google.oauth2.service_account as sa
from google.auth.transport.requests import Request
creds = sa.Credentials.from_service_account_file('/tmp/gcp/sa-key.json', scopes=['https://www.googleapis.com/auth/cloud-platform'])
creds.refresh(Request())
open('/tmp/gcp/token.txt','w').write(creds.token)
print('ok')
"
```

Then every GCP call is `curl -H "Authorization: Bearer $(cat /tmp/gcp/token.txt)" https://<service>.googleapis.com/...`
— the token expires in about an hour, just re-run the refresh step.

The venv step exists because this sandbox's system-level `cryptography`
package is broken (`ModuleNotFoundError: No module named '_cffi_backend'`) —
`google-auth` needs a real `cryptography`, and a fresh venv is the reliable
fix.

Don't use the `gcloud` CLI — `sdk.cloud.google.com` is blocked by this
environment's egress policy. Everything goes through direct REST calls to
`*.googleapis.com`, which the egress proxy does allow.

As of this writing the user has **not** set `GCP_SERVICE_ACCOUNT_KEY_JSON` —
the environment's plain "Environment variables" box is unencrypted and
explicitly warns against secrets, so putting the raw private key there was
declined. There's a separate vault-style "API credentials" section in that
same settings UI that might be usable instead, but whether it exposes raw key
material for local JWT signing (vs. just substituting a bearer token into
requests to a fixed host) hasn't been confirmed — ask the user what it offers
before assuming either way.

## If `GCP_SERVICE_ACCOUNT_KEY_JSON` is NOT set

Ask the user to either figure out the "API credentials" vault option above, or
just re-upload the key file for this session — that's been the working
fallback throughout.

## The board is data, not markup (2026-09-21)

This app's front page - the slate, the best bets, the parlays - was three
`var` arrays inside `public/index.html`. A new week therefore needed a deploy,
which meant it did not happen: the page sat on the September 20 slate for days
while the research sweep dutifully annotated each card to say the game had
already been played. The sweep could ANNOTATE a card; nothing could retire one
or add the next week's.

- `board.js` is the SEED - what a fresh database serves, and what still works
  if `board/current` is deleted. Same bootstrap relationship
  `santa-rosa-beach-trip`'s `schedule.js` has with its stored plan.
- `validate()` runs on the model's PROPOSAL, before anything is written. A
  pick with no odds or a parlay with one leg would render as a broken front
  page needing a deploy to fix, which is the exact problem this ended. It also
  strips angle brackets: these cards are interpolated straight into innerHTML
  and they are written by a model with web search now, not typed by a person.
- `GET /api/board` serves the stored board or the seed, and says which, plus
  `stale` when the week is over. A board from a finished week should admit it
  rather than present played games as Saturday's card.
- `POST /api/research/weekly-board` grades, then builds. Grading is its own
  call and asks for a final score - "Ole Miss 32, LSU 24" - rather than a
  verdict to take on faith. The graded results ride on the new board so the
  card tab opens with how the last one went.
- `boardWeekKey()` is deliberately NOT `currentWeekKey()`. The slip's week
  rolls on Tuesday; the board turns over Sunday or Monday, when the weekend is
  settled. Stamping a Sunday rebuild with the week that just ended would make
  a fresh board look stale the moment it was built.
- Cloud Scheduler `cfb-weekend-settle` (Sun/Mon 10:00 ET) runs it. Its
  `attemptDeadline` is 900s, not the 180s default.

### Two things that cost three failed runs

Both are in `runStructuredResearch`, and both are invisible from the code:

- **`pause_turn`.** `web_search` is a SERVER-side tool: Anthropic runs the
  search loop inside the request, and when it hits its iteration limit the
  turn returns `stop_reason: "pause_turn"` with no answer. Resuming is
  re-sending the conversation with the paused assistant turn appended - no
  "please continue", which would be a new instruction rather than a
  resumption.
- **`max_tokens` covers the searching, not just the answer.** A thorough
  search spends the whole budget and returns `max_tokens` with ZERO characters
  of text. 4096 was never a ceiling on a board; it was a ceiling on looking
  things up. Grading gets 16000, building 32000.

And these calls **stream**. Nothing reads the stream - `finalMessage()`
returns what `create()` would have - but a ten-minute non-streaming call hits
the SDK's HTTP timeout and is then retried twice, which is how one rebuild
spent ten minutes failing three times over.

## My Team, and a board each reader arranges (2026-09-22)

The "My Dawgs" tab was Georgia, hardcoded: a `--uga-red` in the stylesheet, a
`UGA_FALLBACK` in the page, a `fan/uga` document. Right for one fan, wrong for
everyone else.

**The shape that makes 132 teams affordable is a shared cache.** A team's page
lives at `fan/<id>` and is read by everyone who follows that team, so cost
scales with *teams in use* rather than with users — the second Michigan fan
pays nothing. Whoever triggers a refresh spends their own credit, which is why
`POST /api/fan/:team/research` sits behind `requireLoginSilent` +
`requireBudget` + `requireDailyCap` rather than behind `requireResearch`.
`TEAM_FRESH_HOURS` (12) is what stops a second visitor re-buying the same
answer.

- `teams.js` — every FBS team, **static**. A dropdown of 132 names is not worth
  a model call, and a team's name and colours do not change week to week; only
  its record and next game do, and those are what gets researched. Georgia
  keeps the id `uga` rather than `georgia` because that document already holds
  real content and renaming it would throw that away for invisible consistency.
- `teams.validId()` is the **only** way a team id reaches Firestore. Without
  it a typo in a URL creates a `fan/<junk>` row nothing will ever clean up.
- `fan.js` — `board.js` for this tab, and for the same reason: `validate()`
  runs on the model's **proposal**, so a bad run leaves the last good page
  serving rather than replacing it with a broken tab. **No seed, deliberately**
  — a team page can honestly say "nobody has looked this up yet" and offer the
  button, and 130 invented schedules would be worse than an honest gap.
- The choice lives in `prefs/<uid>`, **not** on the slip: the slip is
  week-scoped and is handed back empty every Tuesday, which is right for a slip
  and would silently forget who someone supports.

### The Top 25

`rankings` is its own array on the board, because "who is ranked and what are
they doing Saturday" is a different question from "what should I back". A rank
that is not 1..25 is refused (`"#3"`, `0` and `41` are all a model failing to
give a rank), a second team at the same position is dropped, and a bye is a row
with no game. **Optional**: every board stored before this has none, and
refusing those would blank the front page to add a section to it.

### Arranging it

Pin, hide, move, and hand-written cards live on the **slip** document —
week-scoped, so an arrangement expires with the board it arranged, since card
ids mean different games next week. `boardPrefs()` on the server bounds all of
it: this is a user-writable document the page reads back and draws.

A card never moved keeps its original position *behind* anything that was;
sorting unlisted cards first would reshuffle the board every time one thing
moved.

`POST /api/research/add-game` is open to any member on their own credit now,
for the same reason team research is: the result lands in the **shared** games
collection, so one person paying to cover a game covers it for everyone.

`/api/chat` and `/api/research/custom` are still owner-only. They answer
open-ended questions rather than filling a known shape, and nobody asked for
them to be opened.

## Credit is bought here, not in DataViz (2026-09-22)

The account sheet's "Manage that account — password, Face ID, credit" sent you
to DataViz for the credit half, because DataViz was the only service holding
the Stripe keys. What it sold was never DataViz's: the $5 membership covers
every app on the domain and the balance spends in every app.

The checkout routes are part of the shared account module now, so this app
serves them at `/api/id/billing` and `/api/id/billing/{membership,credit,portal}`
and draws its own section in its own styling. `success_url` is built from this
app's origin, so a purchase started on the board ends on the board.

**The webhook stays on DataViz.** Stripe delivers to one endpoint, and
`STRIPE_WEBHOOK_SECRET` has no reason to be on five services. Only creating a
checkout session spreads.

The section is hidden for someone signed in through this app's own door rather
than the shared account — that sign-in carries no balance, and offering to top
up a balance they do not have is a dead end.

`stripe-secret-key` and `stripe-member-price` were bound to `football-run@` on
2026-09-22 and both env vars are mounted, so this app sells for itself. A
service booted WITHOUT them still behaves: `topUpUrl()` and the billing view's
`elsewhere` field name a service that can sell, so the button is a way out
rather than a dead end.

The key is a **restricted** Stripe key (`rk_live_`), which is what makes it
reasonable for five services to hold one. Replace it only with another
restricted key.

**Nothing has been bought through it yet** — the live account had no Checkout
Session at all as of 2026-09-22 — so the key's *write* permission is unproven.
The first purchase is the test.

## Signing in with the shared account

The account that covers every app on this domain is mounted at `/api/id` and
the account sheet offers it directly, beside this app's own registration
rather than instead of it. The original door stays as the fallback; the shared
one carries research access, credit and the passkey, because those live on the
account rather than in any one app.

## Live scores, a live slip and swing alerts (2026-09-25)

A live layer on top of the board, with no model call anywhere in it:

- **Ticker** at the top of Today's Card: every FBS game live today, plus the
  reader's own games and every game with a Top 25 team (by the feed's rank),
  whatever their state (all of today's when nothing is
  live; "No FBS games today · next kickoff …" when there are none). Ordered
  the reader's team (from `prefs/<uid>`, only a team they actually chose, so
  never a default Georgia; signed-out readers have none), then games on
  their slip, then games with a Top 25 team, then the rest. Live before
  upcoming before final within each group. Tap a game for a sheet with the
  line score, situation, last play, leaders and their slip on that game.
- **Live slip**: "covering by 3" / "needs 4 more to cover (3 to push)",
  "on pace for 61 (over 54.5)", "leading by 7"; parlays leg by leg and
  "2 of 3 legs hitting · 1 to play"; won / lost / push once final. On the
  home view ("Your slip is sweating") and under each play on the Slip tab.
- **Swing alerts**: an in-app banner (no push, no mail - there is no sender)
  when a game that is the reader's has a lead change, a score in the 4th or
  overtime, or goes final, and when a slip leg flips between hitting and
  missing. The first poll alerts nothing, a leg flip rides on the banner for
  the score that caused it, at most three show, and each carries a key naming
  the event so it is never said twice.
- **Game day**: when anything is live the board leads with the scoreboard
  (`body.gameday`), and the card's static intro paragraph steps aside.

### The source is one module, and untrusted

`live.js` owns the upstream: ESPN's public scoreboard JSON
(`site.web.api.espn.com/.../college-football/scoreboard?groups=80&limit=300`),
keyless and **unofficial** - it can change shape or disappear without notice.
Every field is picked out by name, type-checked, bounded and stripped of `<>`
and control characters; the page escapes all of it again with
`LiveCore.esc()`. (`escapeHtml()` escapes quotes too since 2026-09-26, so the
two are now the same rule.) Any failure - network, status, non-JSON, a
body over 6 MB, no `events`, a 6 s timeout - becomes a 200 with
`{available:false, message:"Live scores unavailable"}`. A feed that fails
after a good read serves the last good board, marked stale, for 10 minutes.

**The host is `site.web.api.espn.com`, not `site.api` (2026-09-26).** The
ticker and team facts shipped against `site.api` and **never loaded in
production**: from Google's network it answered 403 to this service's own
User-Agent, to none, to `node` and to a browser's, and admitted only curl's
default. Every test passed, because tests fake ESPN; only the production log
(`[live] scoreboard fetch failed: upstream status 403`) said so. Measured by a
Cloud Build step curling each path from GCP: `site.web.api` answered 200 on
the scoreboard, rankings, team schedule and team list with `Mozilla/5.0`.
`live.fetchEspnJson` is the one reader for both modules: that host and agent
first, and a 403 tried **once** on `site.api` with a curl agent, so ESPN
tightening one host degrades rather than blanks. Anything else is not retried.
**When a live feature "works in tests", read the production log for its
fetch before calling it shipped** - the sandbox cannot reach ESPN, so nothing
here can.

**Swapping to CollegeFootballData** (keyed, documented, rate-limited; check
which of its tiers carries live scoreboard data before relying on it) means replacing
`fetchScoreboard` and `normaliseEvent` to emit the same game shape, and adding
its key as a Secret Manager secret bound to `football-run@`. Nothing
downstream knows where a score came from. The summary endpoint
(`/summary?event=`) is not used: the scoreboard already carries line scores,
leaders and the last play, and one fetch per game per viewer is exactly the
cost the shared cache exists to avoid.

### Cost: one upstream fetch per 20 seconds, however many are watching

`createFeed()` caches the normalised scoreboard in memory for 20 s and shares
one in-flight fetch between concurrent callers; failures are cached for the
same window. It is filled by whichever request finds it stale - **no
`setInterval`, no background refresh**, because this service is billed per
request (see "Billed per request" in `eriks-projects/DEPLOY.md`). The page
polls every 20 s while a game is live and the tab is visible, every 5 min
otherwise, and stops while hidden; a slip edit asks again after 0.8 s.

### Routes

- `GET /api/live` - open. Today's games, ordered for nobody; `no-store`.
- `POST /api/live/slip` `{items:[{id, kind, title, matchup, market, legs}]}` -
  open. The scoreboard ordered for this reader plus `slip` statuses. The page
  sends the plays it is drawing as placed rather than the server reading
  `user-state`: a signed-out slip exists only in the browser, a signed-in one
  may have an edit not yet synced, and it saves a Firestore read per poll.
  Nothing is stored. 30 plays, 12 legs, bounded strings. The reader's team is
  read from `prefs/<uid>` and held in memory for a minute.

### Matching a pick to a game: certain, or nothing

A wrong status is worse than none, so matching is exact-key only. `teamKey()`
folds case, accents (San José), apostrophes (Hawai'i), `&` (Texas A&M) and
"St" -> "State"; `ALIASES` in `live.js` adds the spellings the feed and slips
use ("App State", "UL Monroe", "Pitt", "Vandy"), and letters that name two
schools (OSU, UT, KSU, ISU...) are deliberately absent. A key two teams would
claim is dropped, and the suite asserts there are none. A bet is refused when
it is not a full-game side, total or moneyline (halves, quarters, team totals,
props), when its declared market contradicts what it says, when its side is
not in the named matchup, or when the teams match anything other than exactly
one game. An unmatched play simply shows no live status. Teams outside
`teams.js` (FCS opponents, programs new to FBS) still show on the ticker under
the feed's name; picks on them never match.

### Files

`live.js` (source, normaliser, matching, maths, cache), `public/live-core.js`
(browser + CommonJS: escaping, labels, swing detection, dedupe),
`test/live.js`, fixtures in `test/fixtures/espn-*.json` (hand-written in the
real response shape: a Saturday night, twenty seconds later, all finals, a
Tuesday, and a hostile feed). `test/boot-live.js` boots the app in memory on a
fixture for looking at it in a browser (`LIVE_FIXTURE=live|live-next|finals|
no-games|down`, or `LIVE_FIXTURE_CTL=<file>` to switch while running); it
shifts the fixture's Saturday to today in Eastern time.

## Team facts from ESPN, prose from the model (2026-09-26)

Reported as "the uga record is wrong, they beat Arkansas last week". `fan/uga`
had last been researched 2026-09-19 15:30Z, before the Arkansas kickoff, and a
team page only ever changed when someone tapped the paid research button - so
its record, results, next game and rank froze after every game. On the day of
the Oklahoma game it still said 2-0, "next: at Arkansas", #2.

**The split:** a record, a score, a kickoff and a poll position are facts ESPN
publishes free the moment they change; a model is for the storyline.

- `teamfacts.js` reads two more endpoints from `live.js`'s unofficial family,
  through `live.js`'s own cleaners (`str`, `int`, `isoOrEmpty`, `gameState`,
  now exported): `/teams/{espnId}/schedule?season=YYYY` (every game, result
  when final, home/away/neutral, TV, kickoff, conference flag) and
  `/rankings` (the **AP** poll only - the coaches' poll and the CFP are other
  lists). Record and conference record are counted from the finals (ESPN's
  `vsconf` split is the fallback when games carry no conference flag). "This
  week" is a game in progress, else the next unplayed one. Only the regular
  season is fetched (`seasontype` 3, bowls, is not).
- **ids:** `espn-ids.js` maps every teams.js id to an ESPN id. It is
  GENERATED (`node teamfacts.js --ids <teams.json>`) from ESPN's
  `/teams?groups=80&limit=500` through `live.js`'s `resolveEspnTeam`, and
  `test/teamfacts.js` holds it to "every team maps to exactly one ESPN id or is
  in `UNMAPPED`". The map was first generated from a hand-written fixture
  (the sandbox cannot reach ESPN), then **checked against ESPN on 2026-09-26
  from Cloud Build: all 132 ids correct.** Mind the endpoint if you
  regenerate: `/teams` **ignores `groups=80`** and returns every division,
  cut off at `limit`, so 15 FBS teams (Tennessee, South Carolina, TCU...) were
  simply absent from the 500 it sent - absent, not wrong. Those were checked
  one by one at `/teams/<id>`. A regenerate that loses teams to UNMAPPED is
  that cut-off, not ESPN renumbering; check `/teams/<id>` before editing.
  A wrong id cannot show the wrong team: a schedule whose own `team`
  does not resolve back to the id asked for is refused (logged, no facts).
- **Cache:** 30 minutes in memory and in `teamfacts/<teamId>` (the poll in
  `polls/ap`), `fetchedAt` on each, so a cold instance reads Firestore rather
  than ESPN. Concurrent readers share one fetch; a failure is remembered for
  2 minutes. On failure: last good copy (memory, then Firestore) marked
  `stale`; with none, the model's page as it was. Never a 500, never blank.
  No timer - filled inside the request (billed per request).
  `teams.validId()` is still the only way an id reaches Firestore; the module
  checks it again itself.
- **`GET /api/fan/:team`** returns `teamfacts.overlay(stored, facts, poll)`:
  record, conference record, rank, schedule (with results and opponents' poll
  ranks) and the next game come from ESPN; the model keeps its storyline,
  its rivalry flags (matched by opponent) and its betting line/board link only
  while the next game is still the game it wrote about. `storylineAsOf` dates
  the prose, and when a game finished after it was written, `storylineNote`
  says "Written before the Arkansas game - refresh for a new take", drawn
  beside a Refresh that is the same paid button. `facts: {source, fetchedAt,
  stale, rankSource}` is drawn as a source line in the hero. A team nobody has
  written up still gets its real season, with the prose offered as a button.
  The stored `fan/<id>` is never rewritten by a read.
- **`POST /api/fan/:team/research`** skips its 12-hour cache when a game has
  finished since the page was written, gives the model ESPN's facts as "known,
  do not contradict", and answers through the same overlay.
- **Board Top 25:** `GET /api/board` fills `rankings` from the AP poll when
  the board has none (every board built before that field) or was built before
  the poll's release date, each row with its game this week from the live
  scoreboard, through `board.validateRankings()` (the same 1..25 and
  no-duplicate rules as a model's list). It adds `rankingsFrom: {source:
  'poll', name, week, date, games}`; the page heads the section "AP Top 25 ·
  Week N" and footnotes it as the poll's. With no scoreboard, an empty game is
  a dash, not "Bye".
- **One rank everywhere:** `/api/live` and `/api/live/slip` replace the
  scoreboard's `curatedRank` with the same AP poll (`applyPollRanks`), so a
  team is one number on the ticker and its own page. (ESPN's curatedRank moves
  to the CFP ranking in November; the poll does not.) Without a poll the
  feed's rank stands.

Tests: `test/teamfacts.js` (map completeness, schedule/poll normalisers
against `test/fixtures/espn-schedule-uga.json` / `espn-rankings.json` /
`espn-teams.json`, hostile data, the overlay, the Top 25 fill, cache and
fallback, the routes). `test/harness.js` now makes ESPN unreachable for every
suite unless the suite fakes it. `FACTS_SCENE=1 node test/boot-live.js`
boots Erik's situation (stale `fan/uga`, Georgia at Oklahoma tonight) for a
browser.

## Audit fixes: XSS, research spend, the week, owner-only controls (2026-09-26)

A read-only audit of the live app found these; all fixed the same day.
`test/audit.js` (server) and `test/render.js` (the page) hold them.

- **Stored XSS.** `games` documents went into innerHTML raw (label, summary,
  why, pick...), and board ids containing `"` broke out of `data-*`
  attributes (`board.clean()` only strips `<>`). Now:
  - **Every id** - board games/picks/parlays/results, ranking `gameId`,
    `boardPrefs` hides/pins/order and own cards, slip keys, custom picks,
    games documents - is `board.ID_RE` = `/^[a-z0-9-]{1,60}$/`. A model's id
    is slugged (`board.cleanId`), a user's that does not match is dropped.
  - **`games.js`** is `board.js` for the games collection: `validate()`
    (bounded strings, markup stripped, `tag` enum, confidence 1-4, `pass`
    boolean) runs before every write - add-game, refresh-board, batch-collect
    - and again on read. **The model never picks a document id**:
    `games.idFor()` derives it from the two teams (teams.js ids, e.g.
    `uga-arkansas`) or a slug of the matchup. An id with a "/" used to throw
    after the credit was spent. An answer with no game is a 422 sentence.
  - The page escapes **everything** anyway: `escapeHtml()` now escapes `"`
    and `'`; every card, game, research, slip, review, ask and Top 25 render
    goes through it (`esc()`). The slip and custom picks are cleaned on PUT
    and on GET (`cleanSlip`, `cleanCustomPicks`).
  - `test/render.js` runs the page's own script in a `vm` with a stand-in
    DOM (the page exposes its render functions on `window.__CFB_TEST__` when
    that object exists, and then does not start), draws `<img onerror>` and
    `" autofocus onfocus=` payloads through every render path, and parses the
    HTML for tags, handlers and non-https hrefs.
- **Research paid for finished games.** `cfb-batch-submit` and
  `cfb-saturday-live` researched the whole `games` collection. Both routes
  (and the Refresh button) now research `games.thisWeek()`'s **upcoming**
  games only: the current board's games, games its picks/legs name, and games
  added this week (add-game stamps `weekKey`); a game has "started" by ESPN's
  scoreboard state/kickoff when it is on it, else by the board's own
  "Sat 3:30p ET" (`games.kickoffFor`). A board that is not this week's
  (including the seed) has nothing to research - no model call. Each run
  logs how many it skipped. Scheduler config untouched. `/api/games` serves
  the same list (legacy documents only when they are a board game or were
  added this week), each marked `started`/`final`, and the Games/Research
  tabs draw it (falling back to the board's slate, never to the old
  hardcoded Sep 19 `GAMES_FALLBACK`, which is gone, as is `PICK_GAMES`).
- **One week, turning over at 6 AM Eastern Sunday.** `board.weekKeyAt(ms)`
  is the board's week, the slip's week and the arrangement's week, on the
  server and (same algorithm, `weekKeyAt` in the page, held to agreement over
  200 days by `test/render.js`) in the browser, in Eastern time. The slip
  used to roll Tuesday in the phone's own zone, so plays placed Sunday from
  the new board were wiped Tuesday; 6 AM rather than midnight because a West
  Coast game is still on at 1 AM Eastern (Eastern wall clock, so the
  November change does not move it). Stored slips are read by the week they
  were **saved** in (`slipWeekOf`: `weekKeyAt(updatedAt)`), which keeps old
  Tuesday-keyed Sunday saves readable. In the browser, `expireStaleWeek()`
  also clears `cover-sheet-board-v1` and runs on `visibilitychange`; its
  store key moved to `cfb-week-key-v2`, and on first run a v1 week equal to
  this week or the one before is trusted (one transition week).
- **Staleness.** The header is drawn from the board: "CFB · Week N"
  (Week 1 = the week of the Saturday before Labor Day) and "Lines from
  <generatedAt in ET>"; research time moved to the Games status line. The
  footer's sources line says when the lines were gathered. The "last week's
  board" note shows only when the server says stale (from Sun 6 AM ET) **and
  nothing is live**. `loadBoard()` re-runs on returning to the foreground and
  every 10 minutes. Futures are labelled "Snapshot from Sep 10, 2026 ... not
  live odds" (no free source). Stale copy fixed: Research/Games/Futures/Slip
  intros, "Your slip clears ... Tuesday", "compiled Sep 19", "0 games
  tracked", the "COVER SHEET" summary title, "3-leg parlay" on every parlay,
  and a "++596" combined price.
- **Owner-only controls.** `/api/auth/status` adds `canResearch` (the whole
  of `requireResearch`: allowlist, shared-account grant or site password -
  it reads the shared session itself, since the route is mounted before that
  middleware) and `signedInAnywhere`. "Refresh research", custom research
  and "Sign in with password" show only when `canResearch`. **No API route
  sends `WWW-Authenticate` any more** - every refusal is JSON 401/403, so no
  button can raise the browser's password box. The one exception is
  `/api/login?prompt=1`, which nothing links to: the owner types it.
- **Privacy.** `GET /api/asks` (the owner's own questions) is owner-only. A
  shared slip says the first word of the shared account's `displayName`, or
  "A reader" - never the email local part, which old links now read as too.
- **Performance.** The legacy pollers (games, changelog, status; asks for
  the owner only) run only while Games or Research is on screen in a visible
  page (games once at load for the other tabs). `/api/games`,
  `/api/changelog`, `/api/status` share a 60 s in-memory read
  (`cachedRead`, dropped on every research write). `trust proxy` (share links
  were `http://`), `compression` (new dependency), `Cache-Control` 1 day on
  `/api/teams` and 60 s on `/api/board`.
- **Contrast and taps.** Light `--text-dim`/`--label-2` #56565B,
  `--text-faint` #636366, `--tint` #0060C0, `--positive` #187A33; dark
  `--accent-soft`/`--parlay-soft` darker; solid buttons use `--tint-fill`
  (#0066CC in dark: white on #0A84FF was 3.6:1). Card tools, the switch's
  hit area and "All N games today" are 44px. The results strip stacks title
  over score. "Add a game" and "write your own card" sit below the picks.
- `board.odds()` refuses |n| < 100, like the hand-written cards' `american()`.

### DraftKings links (2026-09-26)

Erik: "add hyperlinks to the DraftKings game to easily trade on it". Every
pick card, own card, game card, research card, Top 25 row with a game, the
ticker's game sheet and every slip play has an "... on DraftKings ↗" link
(new tab, `rel="noopener noreferrer"`), with one line above the first card:
opens DraftKings, the price may differ, 21+ where legal. **One helper**,
`LiveCore.dkLink()` / `dkUrl()` in `public/live-core.js`, used by server and
page: a deep link only when ESPN's odds entry carries one (`odds[].link.href`,
`links[].href`, or the provider's) that is **https on draftkings.com or a
subdomain** - reduced to origin + path, so no tracking or affiliate parameter
survives - otherwise `https://sportsbook.draftkings.com/leagues/football/ncaaf`.
Never a URL built from a guessed event id. The link text names our pick's
line ("Georgia -24.5 on DraftKings ↗"), not the feed's, which may have moved.

**What the live feed actually carries (measured 2026-09-26, 71 games):**
the odds provider is **"Draft Kings"** (it was ESPN BET in our fixtures, so
the feed's line *is* DraftKings' line now), and games carry deep links -
not on the entry, but on each market's sides
(`moneyline|pointSpread|total.home|away|over|under.close|open.link.href`),
in the form of DraftKings' own redirect:
`sportsbook.draftkings.com/gateway?...&preurl=<the event page, encoded>`.
Reduced to origin + path naively, that is a bare `/gateway` going nowhere, so
`dkUrl()` **unwraps a gateway to its `preurl`**, which must itself pass the
same test (https, DraftKings host; a gateway inside a gateway is refused).
The result is the game's event page, `sportsbook.draftkings.com/event/<id>`.
The `outcomes=` parameter (a pre-filled bet slip) is dropped with the query:
it names one side of one market, which is not necessarily the bet on our
card. `GET /api/board`
adds `feed: {<gameId>: {startsAt, state, line, overUnder, lineSource, dkUrl}}`
from the scoreboard; `/api/games` rows and poll Top 25 rows carry `dkUrl`.

### The live score and the line now on every card (2026-09-26)

`POST /api/live/slip` takes `cards` beside `items`: every card on the board,
placed or not, matched to the scoreboard exactly as slip plays are but kept
out of the ticker's ordering. Each card shows its live status ("UGA 24, ARK
14 · 3rd 7:12 · Needs 15 more to cover") and **closing-line value**:
`live.lineNow()` reads the feed's line for the side taken ("UGA -27.5" by
team abbreviation; a line naming neither team is not guessed at) and totals
from `overUnder`: "Picked −24.5 · now −27.5 ✓ better than now" before
kickoff, "closed ... ✓ beat the close" after, labelled with whose line it is.

### Last week graded from ESPN's finals (2026-09-26)

`weekly-board` grades from the scoreboard first: `live.fetchFinals()` reads
`&dates=` for Thursday, Friday and Saturday of the old board's week and
`live.gradeFromFinals()` runs the live slip's own matching and maths over the
finals - win/loss/push with the real final score, `source: 'espn'`. Only
cards it cannot settle (unmatched, not final, props, team totals) go to the
model, and the model cannot overrule a final. Any ESPN failure just leaves
more for the model.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
