# Handoff — somtoday-fix

Status as of 2026-09-09: **WORKING END TO END.** Both `/calendar.ics` and
`/homework.ics` confirmed returning real data (65 lesson events, real
homework items with subjects/descriptions) against the live deployed Worker.
The debug endpoint and diagnostic logging added during setup have been
removed. Everything below is historical context for how it got here and
what's still unverified in real-world use (cancellation detection
specifically — hasn't hit a real cancelled lesson yet).

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
  before its linked lesson.
- `/calendar.ics?debug=1` — temporary diagnostic endpoint (see "Cleanup" below).

## THE ONE THING LEFT TO DO

Nothing blocking. `/calendar.ics` and `/homework.ics` are both live and
returning real data as of the last verification. What's left is optional:

1. **Subscribe to the URLs** from Apple Calendar / Google Calendar /
   Reminders, per the repo's `README.md`, if that hasn't been done yet.
2. **Watch for a real cancelled lesson** at some point during the term and
   confirm it shows up correctly as `[CANCELLED]` — this logic has never
   been exercised against real cancellation data, only written against the
   documented/observed field shape.
3. Consider adding the Cron Trigger check from the README (it's already in
   `wrangler.toml`, just confirm it's actually firing every 30 min in the
   Cloudflare dashboard's Trigger Events tab).

## Architecture (file by file)

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
  the school term.

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
