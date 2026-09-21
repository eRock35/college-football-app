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

## Signing in with the shared account

The account that covers every app on this domain is mounted at `/api/id` and
the account sheet offers it directly, beside this app's own registration
rather than instead of it. The original door stays as the fallback; the shared
one carries research access, credit and the passkey, because those live on the
account rather than in any one app.
