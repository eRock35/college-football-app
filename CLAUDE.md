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
  reader's own games whatever their state (all of today's when nothing is
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
(`site.api.espn.com/.../college-football/scoreboard?groups=80&limit=300`),
keyless and **unofficial** - it can change shape or disappear without notice.
Every field is picked out by name, type-checked, bounded and stripped of `<>`
and control characters; the page escapes all of it again with
`LiveCore.esc()` (which escapes quotes - the older `escapeHtml()` does not, so
it is not used for feed data). Any failure - network, status, non-JSON, a
body over 6 MB, no `events`, a 6 s timeout - becomes a 200 with
`{available:false, message:"Live scores unavailable"}`. A feed that fails
after a good read serves the last good board, marked stale, for 10 minutes.

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

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
