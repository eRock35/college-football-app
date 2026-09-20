# College Football App — GCP deployment notes

Non-secret setup facts for deploying this app to GCP. Written so a future
Claude Code session in this repo has this context without needing it
re-explained. No secrets live in this file — see "Secrets" below.

The app's actual title/branding is **"College Football App"**, not "Cover
Sheet" — the file/repo name and some internal identifiers (GCP resource
names, localStorage keys, the `erik-projects` Artifact Registry repo) still
say "cover-sheet"/"cover sheet" in places; that's fine, they're internal
plumbing, not user-facing. Don't reintroduce "Cover Sheet" as the page's
displayed name or `<title>` — an earlier pass here did that by mistake (a
hand-rebuilt frontend that didn't match the real Artifact) and it was
corrected. `public/index.html` is now a direct port of the real Claude
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
  - `coversheet.strongtechnicalconsulting.com` → this app (Cloud Run)
  - root `strongtechnicalconsulting.com` → "Erik's Projects" landing/hub page,
    see `eRock35/eriks-projects` (replaces the old 2019 Bootstrap template)

## Database

- Firestore, **Native mode**, named database `cover-sheet` (NOT `(default)`).
- The project's `(default)` Firestore database is legacy **Datastore mode**,
  tied to older App Engine infrastructure — do not touch it, do not point any
  new app at it.
- Client code must pass `databaseId: 'cover-sheet'` explicitly — the
  `@google-cloud/firestore` client defaults to `(default)` if you don't.
- Collections used by `server.js`:
  - `games` — the live game board / today's card (`featured: true` marks
    today's-card items) — **currently empty**, nothing populates it yet
  - `asks` — custom research Q&A + refresh results
  - `changelog` — "Updated" badge feed
  - `uga` — My Dawgs (Georgia-fan tab) content
  - `meta/status` — misc status doc

## Secrets (Secret Manager)

Stored in Secret Manager, **not** in git, **not** in this file:
- `site-login-username`, `site-login-password` — HTTP Basic Auth credentials
  gating any route that spends Anthropic API tokens.
- `anthropic-api-key` — the Anthropic API key.

Injected into Cloud Run as env vars via the Cloud Run Admin API's
secret-env-var mechanism: `SITE_LOGIN_USERNAME`, `SITE_LOGIN_PASSWORD`,
`ANTHROPIC_API_KEY`.

## Auth model

- Public — anyone can view games, build a slip, etc. with no login. Only
  routes that call the Anthropic API (`/api/research/refresh`,
  `/api/research/custom`) are gated behind HTTP Basic Auth.
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

- `server.js` — Express app. Public GET routes for game/research/changelog/
  My-Dawgs data; gated POST routes for research
  (`/api/research/refresh`, `/api/research/custom`).
- `public/index.html` — frontend, **streamlined v1** scope: Today's Card, All
  Games, My Slip (localStorage), Research tab, My Dawgs. Deliberately excludes
  per-pick chat threads and the asks-feed↔My-Dawgs cross-linking that existed
  in the original Claude Artifact version — deferred as a fast-follow, not
  forgotten. Original artifact: `https://claude.ai/artifact/KAiaq3U2A9fFFtZwKadj6T`
- `Dockerfile` — `node:20-slim`, `npm install --omit=dev`, `node server.js` on
  `$PORT` (defaults 8080, matches Cloud Run's convention).

## Deployed (as of 2026-09-20)

Deploy pipeline ran successfully end to end from a pre-split copy of this
source (before the repo move — same code, just wasn't here yet):

- Artifact Registry Docker repo: `erik-projects` in `us-central1`
  (`us-central1-docker.pkg.dev/metal-celerity-236019/erik-projects`) — shared
  across projects hosted on this domain, not renamed per-app
- GCS bucket `metal-celerity-236019-cb-source` — Cloud Build source staging
- Cloud Run service `cover-sheet` in `us-central1`, public
  (`roles/run.invoker` granted to `allUsers`), live at:
  - `https://cover-sheet-u4h4ftn3fa-uc.a.run.app`
  - `https://cover-sheet-717055813878.us-central1.run.app`
  - Cloud Run reports the revision `Ready`, but **this sandbox's egress proxy
    blocks `*.run.app`** the same way it blocks `strongtechnicalconsulting.com`
    — a real browser hit against these URLs has not been confirmed from
    inside a session. Ask the user to check.
  - Env vars: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=cover-sheet`, plus
    the three secret refs above.
- Service name stayed `cover-sheet` on Cloud Run even though the repo is now
  named `college-football-app` — no need to rename the live GCP resource to
  match; it's an internal identifier, not user-facing.

### Known compromise: runtime service account

Cloud Run's `serviceAccount` is currently set to
`cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com` — the
same broad-privilege account used for deploys (Artifact Registry Admin, Cloud
Build Editor, Service Usage Admin, Storage Admin, etc.), **not** a scoped-down
runtime identity. The right fix is a dedicated `cover-sheet-runtime@...`
service account with only `roles/datastore.user` and
`roles/secretmanager.secretAccessor` on the three secrets — but the deployer
account itself lacks `iam.serviceAccounts.create`, so this needs either (a)
the user grants the deployer account `roles/iam.serviceAccountAdmin`, or (b)
the user creates `cover-sheet-runtime@...` by hand and grants those two roles.
Until then, a compromise of the running container has more GCP blast radius
than it should. Fix this before the app is trusted with anything higher
stakes than it already has.

## Still to do

- **Redeploy from this repo** (the live revision was built from the
  pre-split source, which still had vacation routes baked in — not wrong, just
  worth a clean redeploy from this repo's actual `server.js` next time
  anything here changes).
- **Domain mapping**: map `coversheet.strongtechnicalconsulting.com` to the
  `cover-sheet` Cloud Run service (Cloud Run Domain Mappings API) and hand the
  user the DNS records it returns.
- **Runtime service account** — see "Known compromise" above.
- Cloud Scheduler job(s) hitting `/api/research/refresh` on a cadence,
  replicating the old CCR-trigger cadence from the Artifact version.
- Seed the `games` Firestore collection — nothing populates it yet, so
  Today's Card / All Games render empty until something does (manually, or
  via the deferred Cloud Scheduler research job).
