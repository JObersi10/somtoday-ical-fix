# Handoff — somtoday-fix

Status as of 2026-09-11: **Calendar, homework feed, and push notifications
confirmed working. CalDAV → Reminders sync is implemented and deployed but
NOT yet confirmed writing real reminders — see "Still unverified" below
before assuming it's done.** `/calendar.ics` (65 real lessons), `/homework.ics`
(23 real homework items), and push notifications for cancellations + sync
failures are all live, deployed, and verified. Auth now uses the mobile
app's OAuth client (60-day refresh token, see below) instead of the web
client's 8-hour one, which was the actual root cause of "keeps
logging me out."

## What this is

A Cloudflare Worker at repo [JObersi10/somtoday-ical-fix](https://github.com/JObersi10/somtoday-ical-fix),
deployed to `https://somtoday-ical-fix.jadenrayobersi.workers.dev`, auto-deploying
from GitHub via Cloudflare Workers Builds on every push to `main`.

It talks directly to Somtoday's real student REST API (`api.somtoday.nl`) —
not the public iCal feed, which was confirmed to have no homework and no
cancellation data at all. It produces:

- `/calendar.ics` — lesson schedule, timezone-corrected to America/Curacao
  (fixed UTC-4), with cancelled lessons flagged `[CANCELLED]`.
- `/homework.ics` — VTODO feed, one task per homework item, due the day
  before its linked lesson. (Apple's generic calendar-subscription mechanism
  won't surface these in Reminders.app — see below for the real fix.)
- A `scheduled()` cron (every 30 min) that keeps the calendar/homework data
  warm, refreshes the Somtoday token, pushes cancellation/failure
  notifications, and writes real Reminders items via CalDAV.

## Homework in Reminders: real CalDAV (Option B) — implemented, not yet confirmed working (see "Still unverified" below)

iOS/macOS's generic "Subscribed Calendar" feature only ever imports `VEVENT`
into Calendar.app — it does not import `VTODO` into Reminders.app at all.
Confirmed empirically (user subscribed correctly, Calendar accepted it, but
nothing appeared in Reminders). Three options were considered (A: fake it as
VEVENT calendar blocks, B: real CalDAV write, C: user-built Shortcut) — **B
was chosen and implemented**: `src/caldav.ts` is a minimal from-scratch
CalDAV client (Workers has no XML DOM parser, so PROPFIND multistatus
responses are picked apart with regex — brittle in general, consistent
enough for iCloud specifically) that:

1. Discovers the user's actual iCloud Reminders list matching
   `REMINDERS_LIST_NAME` (default `"Homework"`) via PROPFIND against
   `caldav.icloud.com` — the list must already exist (created once by hand
   in Reminders.app); the Worker deliberately never creates lists itself.
2. PUTs a real `VTODO` per homework item, keyed by a stable UID
   (`<uniqueIdentifier>-somtoday-fix-hw.ics`), with `If-None-Match: *` so it
   only ever *creates*, never overwrites — checking an item off in
   Reminders.app sticks, a later cron tick won't resurrect it.

Auth is an **Apple ID app-specific password** (generated at
appleid.apple.com → Sign-In and Security → App-Specific Passwords —
revocable any time, never the real account password), stored as the
`ICLOUD_APP_PASSWORD` secret alongside `ICLOUD_APPLE_ID` and
`REMINDERS_LIST_NAME` (all set 2026-09-11). Runs from `scheduled()` only,
independent of the calendar sync (`ctx.waitUntil` in parallel) — a CalDAV
failure (e.g. a revoked app-specific password) can't block the calendar from
updating, and vice versa.

## Push notifications (ntfy.sh)

`src/notify.ts` posts to `https://ntfy.sh/<NTFY_TOPIC>` — a free,
account-less pub/sub push service. Set `NTFY_TOPIC` to a private-ish random
string (currently `somtoday-jaden-4d9ea36b`, in `wrangler.toml [vars]`), then
install the ntfy app and subscribe to that same topic to receive pushes on
your phone. No API key on either side. Two things trigger a push:

1. **Cancellations** — both the in-place `isUitgevallen` flag (deduped via a
   `notified:<uid>` KV key so it only fires once even though the flag stays
   true on every subsequent fetch) and the snapshot-diff "vanished from the
   schedule" path (naturally one-shot, see `snapshot.ts`).
2. **Sync failures** — `reportSyncOutcome()` in `src/index.ts` tracks a
   consecutive-failure streak per sync type (`cal` for the calendar,
   `reminders` for CalDAV) in KV, and only pages you after
   `FAIL_ALERT_THRESHOLD` (2) consecutive failures — avoids noise from a
   single transient blip — then sends one "recovered" push once it's working
   again. The two trackers are independent (a Reminders outage won't mask a
   calendar outage or vice versa).

## Long-term signed-in confidence — SOLVED via the mobile app's OAuth client

The web client's `client_id` (`somtoday-leerling-web`) issues refresh tokens
with an 8-hour lifetime — confirmed by decoding a real refresh_token JWT's
`iat`/`exp`. That was the actual root cause of "keeps logging me out": no
client was refreshing inside that 8h window. **Fixed 2026-09-11** by
capturing a token from the real Somtoday mobile app instead (via Charles
Proxy with SSL Proxying enabled + the Charles root cert trusted on the
iPhone — plain Wireshark can't see inside TLS without this). The mobile
app's `client_id` (`somtoday-leerling-native`, confirmed from the app's own
bundled JS — it's actually a Capacitor WebView, not truly native) issues
refresh tokens with a **60-day** lifetime instead. `SOMTODAY_CLIENT_ID` in
`wrangler.toml [vars]` now selects the native client, and
`SOMTODAY_REFRESH_TOKEN` holds a token issued to it. Since the cron refreshes
(and rotates) this token every 30 minutes — vastly more often than the
60-day window — this should now be a **one-time setup**, not a recurring
chore, as long as the cron keeps firing. Only failure mode: Cloudflare's cron
silently stops firing for 60 days straight (would need a fresh capture via
the same Charles Proxy process if it ever happens — see git history for the
exact steps, or ask a future session to walk through it again). A
sync-failure push notification (see above) will surface this immediately
either way, rather than you discovering it by opening a stale calendar.

**Gotcha to remember**: after rotating `SOMTODAY_REFRESH_TOKEN`, you must
also delete the `somtoday_tokens` key from the `STATE` KV namespace
(Cloudflare dashboard → Storage & databases → Workers KV → STATE) — otherwise
the Worker keeps serving a cached (now-dead) access token instead of ever
trying the fresh refresh token. This bit us twice across two different token
rotations in this project; always check this first if a secret update
doesn't seem to take effect.

## IMPORTANT: the timezone logic is NOT a real UTC conversion (read this first)

`src/index.ts`'s `localWallToUtc()` used to genuinely convert Somtoday's raw
local-time digits (e.g. `07:30`, no offset — this is Amsterdam civil time in
the API) through `Europe/Amsterdam`'s real UTC offset, landing on the
mathematically correct America/Curacao equivalent (a real ~6-hour shift,
e.g. 07:30 NL becomes 01:30 AST). **That was wrong for this user's actual
situation.** Per direct clarification: Somtoday prints "07:30" as a bell-
schedule number, but the user personally operates on that exact same clock
digit as their real Curacao time (e.g., they say "I start at 7:30am" meaning
7:30 Curacao, not 7:30 Amsterdam converted). So the fix was to **stop doing
real timezone math entirely** for lesson times: `localWallToUtc()` now takes
the raw Somtoday digits and localizes them directly as `America/Curacao`
civil time (fixed UTC-4), via `AST_TZ` instead of `"Europe/Amsterdam"`.
`zonedWallTimeToUtc()` itself (in `src/ics.ts`) is unchanged and still
correct in general — only which timezone we tell it to interpret the raw
digits *as* changed. **Do not "fix" this back to a real Amsterdam→Curacao
conversion without re-confirming with the user first** — it was deliberately
reverted from that to match their real-world need.

- **`src/index.ts`** — the Worker entry point. Routes `/calendar.ics`,
  `/homework.ics`, `/calendar.ics?debug=1`. Contains `syncAndCache()` (the
  core sync logic, shared between the HTTP handler and the cron
  `scheduled()` handler), the ICS event-building logic, and the
  cache-last-good-response fallback for when Somtoday sync fails mid-request.
- **`src/ics.ts`** — hand-rolled ICS (RFC 5545) parser/serializer, no
  external deps. Includes `zonedWallTimeToUtc()`, the core timezone-correction
  function — verified correct for both Europe/Amsterdam winter (UTC+1) and
  summer (UTC+2) DST, and for fixed-offset America/Curacao (UTC-4, no DST).
- **`src/somtoday-api.ts`** — REST client for `api.somtoday.nl`. Endpoints
  and field shapes were all confirmed against **real captured HAR files**
  from the user's own logged-in session, not guessed:
  - `GET /afspraakitems/{leerlingId}/jaar/{year}/week/{week}` — lesson
    schedule. Field `isUitgevallen: boolean` is the real, direct
    cancellation flag (confirmed from a cached app payload in localStorage,
    a slightly different response shape than the live network capture —
    see caveat below).
  - `GET /studiewijzeritemafspraaktoekenningen` and
    `/studiewijzeritemdagtoekenningen` — homework, confirmed live, response
    shape fully mapped in `toekenningToItem()`.
  - **Critical, non-obvious fix**: every request MUST send
    `Accept: application/vnd.topicus.platinum+json; charset=utf-8`.
    Without it, the API returns `200 OK` with a **silently empty** `items`
    array instead of an error — this cost the most debugging time. Confirmed
    from a real captured request header.
- **`src/somtoday-auth.ts`** — OAuth2 token management.
  - `getAccessTokenFromBootstrap()` is the **actually-used** path: takes a
    manually-captured `refresh_token`, exchanges/refreshes it via
    `POST https://somtoday.nl/oauth2/token`, caches the resulting access +
    refresh token pair in KV (`STATE` namespace, key `somtoday_tokens`).
  - Confirmed live: `client_id` for a browser-issued token is
    `somtoday-leerling-web`; token endpoint is `somtoday.nl/oauth2/token`
    (an earlier guess of `inloggen.somtoday.nl/oauth2/token` with
    `client_id somtoday-leerling-native` was wrong and would have failed).
  - Access tokens expire in exactly 3600s (1 hour). Refresh tokens expire in
    exactly 28800s (8 hours) from issuance, confirmed by decoding a real
    refresh_token JWT's `iat`/`exp` claims — this is almost certainly why
    the user kept getting logged out before (nothing was refreshing inside
    that 8h window).
  - **Includes a KV-based lock** (`somtoday_refresh_lock` key) around the
    refresh call — see "What went wrong" below for why this exists.
  - `passwordLogin()` (automated username+password login mimicking the
    browser flow) exists but is **unverified/untested** — it's a fallback
    for schools without SSO, built from the elisaado/somtoday-api-docs
    reference, never actually exercised end-to-end. Don't trust it without
    testing. The manual-bootstrap path (real captured refresh_token) is
    what's actually deployed and working.
- **`src/snapshot.ts`** — KV-based diff logic: stores a lightweight snapshot
  of every lesson UID seen, and flags a lesson `[CANCELLED]` if it vanishes
  from a later fetch without ever showing `isUitgevallen: true`. This is a
  backstop for the `afspraakitems` endpoint specifically, which (per a real
  live capture) does NOT include `isUitgevallen` in its response shape —
  only the cached-app payload format does. So for the endpoint actually in
  use, diffing is the PRIMARY cancellation-detection mechanism, not a
  backstop. (This is worth re-verifying once real cancellation data is
  observed — it hasn't been tested against an actual cancelled lesson yet.)
- **`src/notify.ts`** — thin ntfy.sh push-notification wrapper. Best-effort
  by design: a failed push must never take down the sync it's reporting on.
- **`src/caldav.ts`** — minimal CalDAV client for writing real VTODO items
  into an iCloud Reminders list. See "Homework in Reminders" above.
- **`wrangler.toml`** — deployment config.
  - **Non-obvious TOML bug already fixed**: `kv_namespaces` MUST appear
    before any `[table]` header (`[vars]`, `[triggers]`). Cloudflare
    Workers Builds silently accepted a broken config where it came after
    `[vars]` — TOML parses that as `vars.kv_namespaces`, not the top-level
    binding — and the binding just silently didn't attach. No error
    anywhere, `env.STATE` was simply `undefined` at runtime. Verified with
    Python's `tomllib` that the current file parses correctly.
  - `[vars] SOMTODAY_LEERLING_ID = "7361428924143"` — committed in plaintext
    deliberately. It's the user's own student ID, not a credential (it's
    already visible in every Somtoday API URL). This was necessary because
    dashboard-only "Variable" entries get reset to whatever `wrangler.toml`
    declares on every git-triggered deploy — only dashboard-set **Secrets**
    survive that reset. `SOMTODAY_REFRESH_TOKEN` is NOT here — it lives only
    as a dashboard Secret (Settings → Variables and secrets), correctly.

## What went wrong during setup (read this before touching auth code again)

1. **Cloudflare Workers Builds has TWO separate "variables and secrets"
   panels** for the same Worker: one under Settings (root), one under
   Settings → Builds. The Builds one only affects the *build* environment,
   not the deployed Worker's runtime `env` — a variable set there is
   invisible to `env.X` in the Worker code. Wasted a redeploy cycle
   discovering this. Use the root Settings panel, or (better,
   for anything non-secret) `wrangler.toml`'s `[vars]`.
2. **The TOML ordering bug** described above under `wrangler.toml`.
3. **The token-revocation bug**: while debugging #1 and #2, several rapid
   manual `curl` requests (and a couple of automated polling loops) hit the
   Worker within seconds of each other. Two overlapping invocations both
   read the same stored (soon-to-expire) refresh token from KV and raced to
   redeem it. Somtoday's OAuth server detected the same `refresh_token`
   being used twice — standard OAuth2 refresh-token-rotation replay
   protection — and revoked the entire token chain. Confirmed via a raw
   debug fetch returning `401 Unauthorized, WWW-Authenticate: Bearer
   error="invalid_token", error_description="Token revoked"`. Fixed with a
   short-TTL KV lock (`somtoday_refresh_lock`) so only one refresh happens
   at a time. The already-revoked token was replaced with a freshly
   captured one from the user's browser, and the calendar started returning
   real data immediately after. Should not recur under normal usage
   (infrequent calendar-app polling + a 30-min cron), only under rapid
   manual testing like what caused it here.
4. **Also caused by the lock**: Cloudflare KV rejects `expirationTtl` below
   60 seconds. The lock was initially set to 20s and every single
   `kv.put()` call for it failed with `400 Invalid expiration_ttl`,
   throwing before the actual token refresh ever ran — meaning even after
   pasting a *fresh* refresh token, requests kept failing until this was
   fixed to `expirationTtl: 60`. Found via the (now-removed) debug endpoint
   surfacing the raw KV error message directly.
5. **A stale cached access token masked all of the above for a while**:
   `getAccessTokenFromBootstrap()` checks KV for a cached, not-yet-expired
   access token before ever touching the refresh token. After the
   revocation in #3, the (now-invalid) access token was still cached in KV
   with a future `expires_at`, so the Worker kept returning it — and
   getting `401`s from Somtoday — without ever attempting to use the fresh
   refresh token that had just been pasted in. Had to manually delete the
   `somtoday_tokens` key from the `STATE` KV namespace (Cloudflare
   dashboard → Storage & databases → Workers KV → STATE) to force it to
   actually redeem the new refresh token. If this project ever seems stuck
   returning stale/wrong data despite a secret update, **check and clear
   this KV key first**.

## Cleanup (done)

- The temporary `handleDebug()` function and `?debug=1` route have been
  removed from `src/index.ts`.
- The diagnostic `console.log`/`console.error` lines in
  `src/somtoday-api.ts`'s per-week fetch have been removed.
- `fetchHuiswerk()` has been confirmed working end to end against the live
  Worker (`/homework.ics` returns real homework items with correct subjects
  and descriptions).

## Still unverified (not blocking, just untested in practice)

- Cancellation detection (`isUitgevallen` + snapshot diff) has never been
  observed against a real cancelled lesson. Logic is sound but unverified
  in practice — worth checking back once a real cancellation happens during
  the school term. (The ntfy push for it is now wired up too — unverified in
  practice for the same reason.)
- **The CalDAV → Reminders sync is NOT confirmed working yet — read this
  before assuming it's done.** First attempt (2026-09-11) hit a real bug:
  two dashboard-only Variables (`ICLOUD_APPLE_ID`, `REMINDERS_LIST_NAME`)
  were wiped by the very next git-triggered deploy (the exact gotcha
  documented above under `wrangler.toml`) — fixed by moving them into
  `wrangler.toml [vars]`. After that fix, `discoverReminderList()`'s first
  PROPFIND consistently got a bare `400` from `caldav.icloud.com` when
  called through the Worker, while an *identical* request via curl (from
  outside Cloudflare) succeeded every time. Diagnosed as Cloudflare Workers'
  `fetch()` sending a plain string body as `Transfer-Encoding: chunked`
  (no `Content-Length`) by default, which iCloud's CalDAV server appears to
  reject for PROPFIND/PUT — fixed in `src/caldav.ts` by encoding bodies as a
  `Uint8Array` with an explicit `Content-Length` header (commit `5ab007a`).
  **This fix got exactly one clean confirmed success** (a direct 207
  Multi-Status from a debug endpoint) before further rapid-fire testing
  started getting silent timeouts instead of clean responses — likely
  iCloud rate-limiting/throttling the account or Cloudflare's egress IP
  after many CalDAV requests in a few minutes (same category of mistake as
  the Somtoday OAuth-replay incident earlier in this project: don't hammer
  a live third-party auth/sync endpoint with rapid manual retries). Testing
  was stopped deliberately rather than risk it further. **Next step for a
  future session**: wait at least 15-30 minutes since the last CalDAV
  request (let any rate-limit cool down), then check Reminders.app's
  "Homework" list directly, or hit `/sync-now` once (not repeatedly) and
  read the `reminders` field. If it still fails, check the KV
  `caldav_collection:homework` key (absence means discovery never
  completed) and the raw error message — do not add a debug endpoint and
  loop-test again; test at most once, wait, then decide.

## Reference: real captured data this was built against

- First HAR: `leerling.somtoday.nl` Rooster page, single `afspraakitems`
  request — gave the working schedule endpoint + shape.
- Second HAR: same domain, Huiswerk-adjacent session with 138 requests —
  gave the working homework endpoints + shape, plus `account/me`,
  `mededelingen`, `resultaatpublicatiemomenten` (unused), and the request
  headers that revealed the required `Accept` media type.
- A `localStorage` dump (`CapacitorStorage.<uuid>` key) — gave the real
  token structure (client_id, issuer, 8h refresh lifetime) and a
  differently-shaped cached `afspraak` payload containing `isUitgevallen`.
- `github.com/elisaado/somtoday-api-docs` (third-party, unofficial) — cross-
  checked for the native-app and SSO auth flow shapes; confirmed nothing in
  it implies native tokens are longer-lived than web ones (the user's
  hypothesis), and it doesn't provide any way to obtain a token without
  either credentials or a captured token — i.e., it can't shortcut what
  this project still needs from the user.
