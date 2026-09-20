# College Football App — GCP deployment notes

Non-secret setup facts for deploying this app to GCP. Written so a future
Claude Code session in this repo has this context without needing it
re-explained. No secrets live in this file — see "Secrets" below.

The app is **"College Football App"** everywhere — page title, Cloud Run
service, container image, Firestore database, and the subdomain. An earlier
pass named things "Cover Sheet" (the app's older name); that was wrong and
has been corrected. Don't reintroduce it. Two legacy exceptions that can't
or shouldn't change: the deployer service account is
`cover-sheet-deployer@...` (GCP service account IDs are immutable), and the
page's `localStorage` keys are still `cover-sheet-slip-v1` etc. — those come
from the original Artifact and are invisible to users; renaming them would
wipe anyone's saved slip for no visible benefit. `public/index.html` is now a direct port of the real Claude
Artifact (`https://claude.ai/artifact/KAiaq3U2A9fFFtZwKadj6T`) — if this app
needs updating from a newer version of that Artifact in the future, re-port
from there rather than hand-editing further away from it.

This app used to live inside `eRock35/COVID19-Vaccine-Spotter-Extension-Python`
(wrong home, unrelated project) — it moved here, to its own repo, along with
the vacation app moving to its own **private** repo
(`eRock35/santa-rosa-beach-trip`, contains real family PII) and a separate
`eRock35/eriks-projects` repo for the landing/hub page. Each thing Erik builds
going forward gets its own repo; this one is just College Football App.

## Project

- GCP project ID: `metal-celerity-236019`
- Region used for everything: `us-central1`
- Service account (deployer): `cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com`
  - Key file lives only as an ephemeral session upload unless the user has set
    `GCP_SERVICE_ACCOUNT_KEY_JSON` as a persistent env var on the Claude Code
    environment ("Erik's World") — as of this writing they have **not** done
    that (the plain "Environment variables" box in that UI is unencrypted and
    explicitly warns against secrets; a separate vault-style "API credentials"
    section might work but hasn't been evaluated for whether it exposes raw
    key material the way local JWT signing needs — check before relying on
    it). Default assumption: re-upload the key file each session.
- Domain: `strongtechnicalconsulting.com` (existing business domain, hosted on
  GCS static website hosting). Plan:
  - `footballapp.strongtechnicalconsulting.com` → this app (Cloud Run)
  - root `strongtechnicalconsulting.com` → "Erik's Projects" landing/hub page,
    served from the `www.strongtechnicalconsulting.com` GCS bucket, source in
    `eRock35/eriks-projects` (replaced the old 2019 Bootstrap template, whose
    `index.html` is archived at `_archive-2019-template/index.html` in that
    same bucket)

## Database

- Firestore, **Native mode**, named database `college-football-app` in
  `us-central1` (NOT `(default)`).
- The project's `(default)` Firestore database is legacy **Datastore mode**,
  tied to older App Engine infrastructure — do not touch it, do not point any
  new app at it.
- Client code must pass `databaseId: 'college-football-app'` explicitly — the
  `@google-cloud/firestore` client defaults to `(default)` if you don't.
- An empty, unused `cover-sheet` database (us-east4) may still exist — it was
  the pre-rename database and holds nothing. Safe to delete in the console.
- Collections/docs used by `server.js`. These shapes are dictated by the
  ported frontend, not designed independently — see `GAMES_FALLBACK` and
  `UGA_FALLBACK` in `public/index.html` for the canonical field lists:
  - `games/<id>` — the live board (`label`, `home`, `away`, `kickoff`, `tag`,
    `ranked`, `market`, `pick`, `pickConfidence`, `summary`, `why`,
    `injuryNote`, `pass`, `passReason`, `lastChecked`). Seeded with the 8
    games from the Artifact's own fallback data.
  - `asks/<auto>` — custom research Q&A (`query`, `askedAt`, `answeredAt`,
    `status`, `answer`, `relatedGameId`)
  - `changelog/<auto>` — drives the "Updated" badge (`gameId`, `changedAt`,
    `note`); only entries from the last 48h count
  - `fan/uga` — single doc, My Dawgs tab content
  - `control/status` — single doc, `lastRunAt` (drives the "last refreshed"
    line in the header)
  - `user-state/slip` — single doc: the cross-device slip (`slip`,
    `customPicks`, `bankroll`, `weekKey`, `updatedAt`)

## Secrets (Secret Manager)

Stored in Secret Manager, **not** in git, **not** in this file:
- `site-login-username`, `site-login-password` — HTTP Basic Auth credentials
  gating any route that spends Anthropic API tokens.
- `anthropic-api-key` — the Anthropic API key.

Injected into Cloud Run as env vars via the Cloud Run Admin API's
secret-env-var mechanism: `SITE_LOGIN_USERNAME`, `SITE_LOGIN_PASSWORD`,
`ANTHROPIC_API_KEY`.

## Auth model

- Public — anyone can view games, build a slip, etc. with no login. Gated
  behind HTTP Basic Auth: the routes that call the Anthropic API
  (`/api/chat`, `/api/research/custom`, `/api/research/add-game`,
  `/api/research/refresh-board`) plus the slip-sync routes (`/api/slip`
  GET/PUT, `/api/login`).
- **Two gate middlewares, deliberately.** `requireLogin` sends a
  `WWW-Authenticate` header, so a 401 makes the browser show its native login
  prompt — right for an action the user just clicked. `requireLoginSilent`
  omits it, and is used on `/api/slip`, which is fetched on page load: with
  the header, every anonymous visitor would get a login popup before seeing
  the page. `/api/login` exists purely so the "Sign in to sync" button has a
  prompting route to hit; once the browser has cached the credentials it
  sends them to the silent routes automatically.

## Slip state

The slip, custom picks and bankroll live in `localStorage` **and**, when
signed in, in `user-state/slip`. Not signed in, everything still works
locally — sync is additive, never a prerequisite.

Both layers expire weekly. A college football week is treated as
Tuesday→Monday (games land Thu–Sat with a Sunday/Monday tail, so Tuesday is
the quiet boundary); state carrying an older `weekKey` is dropped rather than
shown. The client computes the key in local time and the server in US
Eastern, so they can disagree for a few hours around the rollover — harmless
at week granularity, but don't tighten this to day granularity without
reconciling the two.
- Mechanism: plain HTTP Basic Auth on specific Express routes (not a global
  gate, not cookies/sessions) — the browser's native credential caching acts
  as the "login". See `requireLogin` middleware in `server.js`.

## How the deploy pipeline works (no `gcloud` CLI, no local Docker)

This sandbox cannot use the `gcloud` CLI installer (`sdk.cloud.google.com` is
blocked by org egress policy) and has no local Docker daemon. The working
approach, confirmed reachable through the sandbox's egress proxy:
- Auth: a Python venv (`python3 -m venv venv` — the system `cryptography`
  package is broken, breaking `google-auth`; the venv works around it) running
  `google-auth` to mint a short-lived OAuth2 access token from the service
  account key (`https://www.googleapis.com/auth/cloud-platform` scope).
- Every GCP action after that is a direct REST call (`curl` or Python
  `requests`) to `*.googleapis.com` with that bearer token.
- Container builds go through the **Cloud Build API**: tar the app dir, upload
  it to the `metal-celerity-236019-cb-source` GCS bucket, submit a build
  referencing that object (source + a `docker build`/`docker push` step),
  wait for `SUCCESS`, then deploy via Cloud Run Admin API v2.

## App layout

- `server.js` — Express app. Public GET routes (`/api/games`, `/api/asks`,
  `/api/changelog`, `/api/uga`, `/api/status`); gated POST routes
  (`/api/chat`, `/api/research/custom`, `/api/research/add-game`,
  `/api/research/refresh-board`), plus slip sync (`/api/slip`, `/api/login`).
  The research routes ask the model for a JSON object and parse it — see
  `runStructuredResearch`. `/api/chat` deliberately passes **no tools**: the
  prompt the page sends states the model has no live internet access, so
  handing it web search would contradict its own instructions.

## Scheduled research

Weekdays run through the **Batch API at 50% cost**; Saturday and the manual
button stay on the live path. Batches usually land in minutes but are
*allowed* up to 24 hours, so batching is only safe where freshness doesn't
matter — which is exactly why game day is carved out.

- `POST /api/research/batch-submit` — one batch request per tracked game
  (per-game rather than one combined call: batch is built for fan-out, each
  game gets focused research, and one bad response can't poison the rest).
  Records the batch id in `control/batch` and refuses to submit while one is
  already in flight.
- `POST /api/research/batch-collect` — polls `control/batch`; no-ops unless a
  batch is pending and ended. Applies only entries where the model set
  `changed: true`, so a quiet week doesn't churn `lastChecked` on every game
  or spam the changelog.
- `POST /api/research/refresh-board` — the live path, used Saturday.

### Cloud Scheduler jobs (live)

All in `America/New_York`, so they track game days correctly through the
November DST change instead of drifting an hour. Each POSTs to the Cloud Run
URL with an `X-Cron-Key` header.

| Job | Schedule | Path |
|---|---|---|
| `cfb-batch-submit` | `0 8,18 * * 2-5` | `/api/research/batch-submit` |
| `cfb-batch-collect` | `30 * * * 2-6` | `/api/research/batch-collect` |
| `cfb-saturday-live` | `0 9-23 * * 6` | `/api/research/refresh-board` |

Verified end to end: a forced run of `cfb-batch-submit` delivered cleanly
(`lastAttemptTime` recorded, no error code), and the route itself was proven
against real Firestore and the real Batch API — 8 games submitted, batch id
recorded in `control/batch`.

Note on reading job status: a Cloud Scheduler job that has never run reports
`status: {code: -1}` with no `lastAttemptTime`. That is the initial state,
**not** a failure — don't go debugging a job that simply hasn't fired yet.
A successful run clears the code and sets `lastAttemptTime`.

That batch took well over six minutes to process, which is normal (the API
allows up to 24 hours) and is exactly why Saturday stays on the live path.

**Auth:** these take `requireLoginOrCron` — either the normal login (a human
clicking) or `X-Cron-Key` matching the `cron-secret` Secret Manager value.
The cron key is deliberately *not* the site login: a scheduler job config is
readable by anyone with project access, and the site password is something a
person types into a browser prompt.

Verified before building: the Batch API does accept `web_search_20260209` — a
live test batch ran a real search and returned a cited answer in about a
minute.

## Models

Chosen by the user after pricing them out, not defaults:
- **Research routes → `claude-sonnet-5`** ($2/$10 per MTok). This is the
  *cheapest* model that supports `web_search_20260209`; Haiku 4.5 is cheaper
  but only supports the older basic web-search variant, so there is no cost
  saving available on these routes without downgrading the tool.
- **`/api/chat` → `claude-haiku-4-5`** ($1/$5). No tools on this route, so
  Haiku is eligible, and it's discussing research notes already on the page
  rather than reasoning from scratch.

Note Haiku 4.5 has a 200K context (not 1M) and takes `budget_tokens` rather
than adaptive thinking — neither matters here (chat history is capped at 20
messages and no thinking config is set), but they would if this route grows.
- `public/index.html` — a **direct port of the Claude Artifact**, not a
  rewrite. Six tabs: Today's Card, All Games, Research, Futures Watch, My
  Slip, My Dawgs. Only the Artifact-capability wiring was changed:
  - `window.claude.use('db')` → a polling shim (`makeDbShim`) with the same
    `.collection().onSnapshot()` / `.doc().onSnapshot()` surface, backed by
    this app's own REST routes. That's why the rest of the file needed no
    changes.
  - `window.claude.use('comments')` (the original "ping a live Claude session
    to do research" path) → direct `fetch()` calls to the gated routes above.
  - `window.claude.use('sample')` (per-game chat) → a `fetch()` shim with the
    same `(messages, {onText}) -> Promise<{text}>` shape `sendChat()` expects,
    backed by `/api/chat`. No streaming on our side, so `onText` fires once
    with the whole answer. Chat history stays in `localStorage` per game.
- `Dockerfile` — `node:20-slim`, `npm install --omit=dev`, `node server.js` on
  `$PORT` (defaults 8080, matches Cloud Run's convention).

## Deployed (as of 2026-09-20)

Deploy pipeline ran successfully end to end from a pre-split copy of this
source (before the repo move — same code, just wasn't here yet):

- Artifact Registry Docker repo: `erik-projects` in `us-central1`
  (`us-central1-docker.pkg.dev/metal-celerity-236019/erik-projects`) — shared
  across projects hosted on this domain, not renamed per-app
- GCS bucket `metal-celerity-236019-cb-source` — Cloud Build source staging
- Cloud Run service `college-football-app` in `us-central1`, public
  (`roles/run.invoker` granted to `allUsers`), live at:
  - `https://college-football-app-u4h4ftn3fa-uc.a.run.app`
  - `https://college-football-app-717055813878.us-central1.run.app`
  - Cloud Run reports the revision `Ready`, but **this sandbox's egress proxy
    blocks `*.run.app`** the same way it blocks `strongtechnicalconsulting.com`
    — a real browser hit against these URLs has not been confirmed from
    inside a session. Ask the user to check.
  - Env vars: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=college-football-app`, plus
    the three secret refs above.
- Container image: `us-central1-docker.pkg.dev/metal-celerity-236019/erik-projects/college-football-app`
  (the Artifact Registry repo itself stays `erik-projects` — it's shared
  across every project hosted on this domain, not per-app).

### Known compromise: runtime service account

Cloud Run's `serviceAccount` is currently set to
`cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com` — the
same broad-privilege account used for deploys (Artifact Registry Admin, Cloud
Build Editor, Service Usage Admin, Storage Admin, etc.), **not** a scoped-down
runtime identity. The right fix is a dedicated `cover-sheet-runtime@...`
service account (name it `college-football-app-runtime`) with only
`roles/datastore.user` and
`roles/secretmanager.secretAccessor` on the three secrets — but the deployer
account itself lacks `iam.serviceAccounts.create`, so this needs either (a)
the user grants the deployer account `roles/iam.serviceAccountAdmin`, or (b)
the user creates that runtime account by hand and grants those two roles.
Until then, a compromise of the running container has more GCP blast radius
than it should. Fix this before the app is trusted with anything higher
stakes than it already has.

## Still to do

- **Domain mapping**: `footballapp.strongtechnicalconsulting.com` →
  `college-football-app` Cloud Run service. NOTE: a domain mapping can only be
  created by a **verified Google user identity**, not by the deployer service
  account — every API attempt from the service account fails with
  "Caller is not authorized to administer the domain," even though the domain
  is verified to the user's own account. The user must add it via the Cloud
  Run console (Manage Custom Domains → Add Mapping), then add the DNS records
  it returns at their registrar. Root `strongtechnicalconsulting.com` is NOT
  a Cloud Run mapping — it serves the landing page from the
  `www.strongtechnicalconsulting.com` GCS bucket.
- **Runtime service account** — see "Known compromise" above.
- Nothing blocking. (Scheduler jobs are live — see below.)
- The `games` data is seeded from the Artifact's Sep 2026 snapshot. It only
  moves forward when someone hits "Refresh research" or adds a game, until
  the Cloud Scheduler job above exists.
