# somtoday-fix

Cloudflare Worker that sits between Somtoday and your calendar app: fixes
timezone handling, surfaces real lesson cancellations (which Somtoday just
silently drops from the schedule instead of flagging), and exposes homework
as a VTODO task feed.

## Two modes

**Mode A — authenticated API (recommended, gives you cancellations + homework)**
Talks directly to `api.somtoday.nl`, the same API the Somtoday web app uses.
Needs your `SOMTODAY_LEERLING_ID` and a `SOMTODAY_REFRESH_TOKEN` captured
once from your own logged-in browser session (steps below). The Worker
refreshes the access token automatically in the background (tokens expire
every 60 minutes; this is almost certainly why you keep getting logged out —
nothing was refreshing that token for you before).

**Mode B — plain iCal passthrough (fallback, no cancellations/homework)**
Just fixes timezones on your existing public feed
(`https://elo.somtoday.nl/services/webdav/calendarfeed/...`). Confirmed by
inspecting your feed directly: it contains only room/class/teacher, no
cancellation flags and no homework at all — that data simply isn't in this
feed, so this mode can't produce it no matter what.

If Mode A is configured, it's used; otherwise it falls back to Mode B.

## How cancellation detection actually works

Confirmed against a live capture of your Somtoday session: a cancelled
lesson does **not** get a `CANCELLED` status anywhere in the API — the
lesson entry just disappears from the schedule on the next fetch. So there's
no way to detect "this lesson got cancelled" from a single snapshot. The
Worker keeps a small snapshot of every lesson it has seen in Cloudflare KV,
and on each request diffs the new list against the last one: anything that
vanished (and was scheduled for the near future) gets synthesized back in as
a `[CANCELLED]` event with `STATUS:CANCELLED`, so your calendar app shows it
struck through instead of just deleting the block silently.

This means: **the Worker needs to run periodically** (see "Keeping it fresh"
below) to actually catch a cancellation — if you only ever fetch the feed
once and a lesson was already dropped before that first fetch, there's
nothing to diff against and it just won't appear at all (same as today).

## Homework

Confirmed against a live HAR capture (2026-09-09) of `studiewijzeritemafspraaktoekenningen`
and `studiewijzeritemdagtoekenningen` — both endpoints and their exact
response shape are wired up in `src/somtoday-api.ts`'s `fetchHuiswerk()`,
not guesswork. It pulls the current week plus 5 weeks ahead, dedupes, and
schedules each item as a VTODO due the day before its linked lesson at
`HOMEWORK_HOUR` AST (default 16:00). `huiswerkType` (e.g. `TOETS`) is tagged
in the title when it's not plain `HUISWERK`, and the HTML description is
stripped to plain text.

---

## 1. Deploy (no local setup needed — browser only)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → sign up / log in (free tier is enough).
2. **Workers & Pages → Create → Create Worker.** Give it a name (e.g. `somtoday-fix`), click **Deploy** to get a placeholder live.
3. Click **Edit code** (opens the in-browser editor).
4. Delete the default `index.js`. You need multiple files (`src/index.ts`, `src/ics.ts`, `src/somtoday-api.ts`, `src/somtoday-auth.ts`, `src/snapshot.ts`) — the dashboard's single-file quick editor doesn't support that well, so instead:
   - Click your Worker → **Settings → Bindings** (for the KV step below).
   - For multi-file deploys, it's easier to use the **Cloudflare dashboard's "Deploy from GitHub"** flow, or Wrangler from a Codespaces/StackBlitz browser terminal (still no local install on your machine):
     - Push this project folder to a new GitHub repo (GitHub's web uploader works — no git CLI needed: create repo → "uploading an existing file" → drag the whole folder in).
     - Back in Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick that repo → it detects `wrangler.toml` and deploys automatically.
5. **Create the KV namespace:** Workers & Pages → **KV** → **Create namespace** → name it `STATE`. Copy its ID into `wrangler.toml`'s `kv_namespaces` block (or, if you used the GitHub import, add the binding via **your Worker → Settings → Bindings → Add → KV Namespace**, variable name `STATE`).
6. **Set secrets:** your Worker → **Settings → Variables and Secrets → Add**:
   - `SOMTODAY_LEERLING_ID` (Mode A)
   - `SOMTODAY_REFRESH_TOKEN` (Mode A — see capture steps below)
   - `SOMTODAY_ICAL_URL` = your feed URL, as a **fallback only** (Mode B) — treat this URL as a secret, anyone with it can see your schedule
   - `CAL_TOKEN` (optional) — a random string you make up, so your `/calendar.ics` URL isn't guessable by anyone who finds it
7. Redeploy. Your endpoint is now `https://somtoday-fix.<your-subdomain>.workers.dev/calendar.ics` (add `?token=...` if you set `CAL_TOKEN`).

## 2. Capturing your Somtoday auth token (Mode A)

You do this once in your own browser — I never see your password, and the
Worker never asks for it either:

1. Log into [leerling.somtoday.nl](https://leerling.somtoday.nl) normally.
2. Open DevTools (F12) → **Network** tab → filter `rest/v1`.
3. Click around the schedule (Rooster) to trigger a request like
   `afspraakitems/{leerlingId}/jaar/2026/week/37`.
4. **Your leerling ID** is the number in that URL — copy it into
   `SOMTODAY_LEERLING_ID`.
5. Click that request → **Headers** → find `authorization: Bearer eyJ...` —
   that's your access token (valid ~1 hour, not what you paste in).
6. The **refresh token** isn't in headers. Open DevTools → **Application**
   tab → **IndexedDB** (or **Local Storage**) → look under the
   `somtoday.nl` / `leerling.somtoday.nl` origin for an OIDC/auth entry
   containing `refresh_token`. Copy that value into `SOMTODAY_REFRESH_TOKEN`.
   - If you can't find it there, right-click the same `afspraakitems`
     request → **Save all as HAR with content**, and I can point you at the
     exact spot for your school's login flow — the HAR won't have your
     password in it, only tokens, but still treat it as sensitive and only
     share it with something you trust.
7. Once set, the Worker keeps itself logged in automatically — it refreshes
   the access token in the background every time it's invoked and the old
   one is close to expiring. You should only need to repeat this capture if
   Somtoday revokes the refresh token entirely (e.g. you change your
   password, or go a very long time without the Worker being invoked at
   all).

## 3. Keeping it fresh (so cancellations actually get caught)

Calendar apps typically poll a subscribed `.ics` URL every few hours on
their own schedule — that alone may be enough. For faster/guaranteed
detection, add a **Cron Trigger** so the Worker also runs on a fixed
schedule regardless of when your calendar app happens to poll:

Worker → **Settings → Triggers → Cron Triggers → Add** → e.g. `*/30 * * * *`
(every 30 minutes) hitting `/calendar.ics` internally. (A cron trigger fires
a `scheduled()` handler, not `fetch()` — if you want this, say so and I'll
add a `scheduled` export that just calls the same logic and writes the
snapshot, so cancellations get caught even between your calendar app's own
polls.)

## 4. Subscribing from your calendar app

**Apple Calendar (Mac):** File → New Calendar Subscription → paste your
Worker URL → Subscribe. Set refresh to "Every 15 minutes" or similar in the
subscription settings (Apple defaults to much slower).

**iPhone/iPad:** Settings → Calendar → Accounts → Add Account → Other →
Add Subscribed Calendar → paste the URL.

**Google Calendar:** On the web, left sidebar → "Other calendars" **+** →
"From URL" → paste `.../calendar.ics`. (Google polls subscribed URLs on its
own schedule, typically every 12–24 hours — not configurable. If you need
faster updates than that, Apple Calendar's subscription refresh setting is
more reliable.)

**Outlook:** Add calendar → Subscribe from web → paste the URL.

**Homework as tasks:** the `/homework.ics` endpoint is a VTODO feed. Apple
Reminders can subscribe to it the same way as a calendar subscription
(Reminders → Add List → From URL, or via Calendar's subscription flow which
also picks up VTODOs). Google Tasks and Todoist don't support subscribing to
a raw `.ics` URL directly — for those you'd need a one-way sync script or a
Zapier/IFTTT-style bridge; ask if you want that added.

---

## Local dev (optional — only if you do want a local setup later)

```bash
npm install
npx wrangler kv namespace create STATE   # paste id into wrangler.toml
npx wrangler secret put SOMTODAY_LEERLING_ID
npx wrangler secret put SOMTODAY_REFRESH_TOKEN
npx wrangler deploy
```
