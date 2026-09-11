import { parseIcs, serializeIcs, serializeVTodos, zonedWallTimeToUtc, type VEvent, type VTodo } from "./ics";
import { fetchAfspraken, fetchHuiswerk, type RAfspraakItem } from "./somtoday-api";
import { getAccessTokenFromBootstrap, getAccessToken, type SomtodayCreds } from "./somtoday-auth";
import { diffAndUpdateSnapshot } from "./snapshot";
import { notify } from "./notify";

export interface Env {
  STATE: KVNamespace;
  SOMTODAY_ICAL_URL?: string;
  SOMTODAY_LEERLING_ID?: string;
  SOMTODAY_REFRESH_TOKEN?: string; // manual bootstrap (recommended)
  SOMTODAY_CLIENT_ID?: string; // "somtoday-leerling-web" (default) or "somtoday-leerling-native" — must match whichever client the refresh token above was actually issued to
  SOMTODAY_USERNAME?: string; // experimental password-login fallback
  SOMTODAY_PASSWORD?: string;
  SOMTODAY_TENANT?: string;
  HOMEWORK_HOUR?: string; // local AST hour, default "16"
  CAL_TOKEN?: string; // optional shared secret to keep the URL private
  NTFY_TOPIC?: string; // ntfy.sh topic for cancellation + sync-failure push notifications
}

const AST_TZ = "America/Curacao"; // fixed UTC-4, no DST

function requireAuth(req: Request, env: Env): Response | null {
  if (!env.CAL_TOKEN) return null;
  const url = new URL(req.url);
  if (url.searchParams.get("token") === env.CAL_TOKEN) return null;
  return new Response("Unauthorized. Add ?token=YOUR_TOKEN to the URL.", { status: 401 });
}

function localWallToUtc(iso: string): Date {
  // Somtoday's beginDatumTijd/eindDatumTijd ("2026-09-07T07:30:00", no
  // offset) is the literal clock number the school schedule uses — e.g.
  // "07:30" for a first lesson, year-round, since school bell times don't
  // shift for Dutch DST. Per the user (who actually attends/watches this
  // schedule from Curacao): that same clock number "07:30" IS the real
  // Curacao time they operate on — not a Dutch local time that needs
  // converting via a real UTC offset. So we read these digits directly as
  // America/Curacao civil time (fixed UTC-4, no DST) rather than
  // interpreting them as Europe/Amsterdam and computing a real conversion.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return new Date(iso);
  const [, y, mo, d, h, mi, s] = m;
  return zonedWallTimeToUtc(+y, +mo, +d, +h, +mi, +s, AST_TZ);
}

function afspraakToVEvent(item: RAfspraakItem, cancelled = false): VEvent {
  const changeNote = (item.statusNotifications || []).map((n) => n.omschrijving).filter(Boolean).join("; ");
  const prefix = cancelled ? "[CANCELLED] " : changeNote ? "[GEWIJZIGD] " : "";
  const descParts = [
    item.vak?.naam ? `Vak: ${item.vak.naam}` : "",
    item.docentNamen?.length ? `Docent: ${item.docentNamen.join(", ")}` : "",
    item.locatie ? `Lokaal: ${item.locatie}` : "",
    changeNote ? `Wijziging: ${changeNote}` : "",
    cancelled ? "Deze les is uitgevallen (verdwenen uit het Somtoday-rooster)." : "",
    item.omschrijving && item.omschrijving !== item.titel ? item.omschrijving : "",
  ].filter(Boolean);

  return {
    uid: `${item.uniqueIdentifier}@somtoday-fix`,
    summary: `${prefix}${item.titel}`,
    description: descParts.join("\n"),
    location: item.locatie,
    start: localWallToUtc(item.beginDatumTijd),
    end: localWallToUtc(item.eindDatumTijd),
    status: cancelled ? "CANCELLED" : "CONFIRMED",
    raw: {},
  };
}

async function resolveAccessToken(env: Env): Promise<string> {
  if (env.SOMTODAY_REFRESH_TOKEN) {
    return getAccessTokenFromBootstrap(env.STATE, env.SOMTODAY_REFRESH_TOKEN, env.SOMTODAY_CLIENT_ID);
  }
  if (env.SOMTODAY_USERNAME && env.SOMTODAY_PASSWORD && env.SOMTODAY_TENANT) {
    const creds: SomtodayCreds = {
      username: env.SOMTODAY_USERNAME,
      password: env.SOMTODAY_PASSWORD,
      tenantUuid: env.SOMTODAY_TENANT,
    };
    return getAccessToken(env.STATE, creds);
  }
  throw new Error("No Somtoday auth configured (SOMTODAY_REFRESH_TOKEN, or USERNAME+PASSWORD+TENANT).");
}

/** Core sync: fetch + diff + serialize + cache the "last known good" ICS in
 * KV. Shared by the on-demand fetch handler and the cron `scheduled()`
 * handler below, so a background cron run (with no calendar app waiting on
 * it) keeps the cancellation-diff snapshot warm even between your app's own
 * polls, and refreshes the access token on its own schedule too. */
/** Push a notification for each newly-cancelled lesson, deduped so a lesson
 * flagged in-place via isUitgevallen (which stays true on every subsequent
 * fetch until the lesson's time passes) only fires once. The snapshot-diff
 * path (items that vanish entirely) is naturally one-shot already — see
 * snapshot.ts, a vanished UID is deleted from the index the moment it's
 * reported, so it can't be reported twice. */
async function notifyCancellations(env: Env, current: RAfspraakItem[], cancelled: { titel: string; vak?: string; beginDatumTijd: string }[]): Promise<void> {
  if (!env.NTFY_TOPIC) return;

  for (const item of current) {
    if (item.isUitgevallen !== true) continue;
    const flagKey = `notified:${item.uniqueIdentifier}`;
    if (await env.STATE.get(flagKey)) continue;
    await env.STATE.put(flagKey, "1", { expirationTtl: 4 * 24 * 3600 });
    await notify(
      env.NTFY_TOPIC,
      "Lesson cancelled",
      `${item.vak?.naam ?? item.titel} — ${item.beginDatumTijd.replace("T", " ")}`,
      { priority: "high", tags: ["x"] }
    );
  }

  for (const c of cancelled) {
    await notify(
      env.NTFY_TOPIC,
      "Lesson cancelled",
      `${c.vak ?? c.titel} — ${c.beginDatumTijd.replace("T", " ")}`,
      { priority: "high", tags: ["x"] }
    );
  }
}

const FAIL_STREAK_KEY = "sync_fail_streak";
const FAIL_ALERTED_KEY = "sync_alerted";
const FAIL_ALERT_THRESHOLD = 2; // consecutive failed cron runs before paging you (avoids noise from one-off blips)

async function reportSyncOutcome(env: Env, ok: boolean, errMessage?: string): Promise<void> {
  if (!env.NTFY_TOPIC) return;
  if (ok) {
    const wasAlerted = await env.STATE.get(FAIL_ALERTED_KEY);
    if (wasAlerted) {
      await notify(env.NTFY_TOPIC, "Somtoday sync recovered", "Back to syncing normally.", { priority: "default", tags: ["white_check_mark"] });
    }
    await env.STATE.delete(FAIL_STREAK_KEY);
    await env.STATE.delete(FAIL_ALERTED_KEY);
    return;
  }
  const streak = (Number(await env.STATE.get(FAIL_STREAK_KEY)) || 0) + 1;
  await env.STATE.put(FAIL_STREAK_KEY, String(streak), { expirationTtl: 7 * 24 * 3600 });
  if (streak >= FAIL_ALERT_THRESHOLD && !(await env.STATE.get(FAIL_ALERTED_KEY))) {
    await env.STATE.put(FAIL_ALERTED_KEY, "1", { expirationTtl: 7 * 24 * 3600 });
    await notify(
      env.NTFY_TOPIC,
      "Somtoday sync is failing",
      `Failed ${streak} syncs in a row. Last error: ${errMessage ?? "unknown"}`,
      { priority: "urgent", tags: ["warning"] }
    );
  }
}

async function syncAndCache(env: Env): Promise<string> {
  try {
    const token = await resolveAccessToken(env);
    const items = await fetchAfspraken(env.SOMTODAY_LEERLING_ID!, token, new Date());
    const { current, cancelled } = await diffAndUpdateSnapshot(env.STATE, items);

    const events: VEvent[] = [
      // isUitgevallen is a confirmed, direct cancellation flag when present;
      // the snapshot diff (below) is a backstop for lessons that vanish from
      // the response entirely rather than being flagged in place.
      ...current.map((i) => afspraakToVEvent(i, i.isUitgevallen === true)),
      ...cancelled.map((c) =>
        afspraakToVEvent(
          { uniqueIdentifier: c.uid, afspraakItemType: "ROOSTER", titel: c.titel, locatie: c.locatie,
            beginDatumTijd: c.beginDatumTijd, eindDatumTijd: c.eindDatumTijd,
            vak: c.vak ? { naam: c.vak } : undefined },
          true
        )
      ),
    ];

    const body = serializeIcs(events, { calname: "Somtoday (AST)" });
    await env.STATE.put("last_good_ics", body, { expirationTtl: 7 * 24 * 3600 });

    await notifyCancellations(env, current, cancelled.map((c) => ({ titel: c.titel, vak: c.vak, beginDatumTijd: c.beginDatumTijd })));
    await reportSyncOutcome(env, true);
    return body;
  } catch (err) {
    await reportSyncOutcome(env, false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function handleCalendar(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Mode A: authenticated Somtoday API — real cancellations + homework.
  if (env.SOMTODAY_LEERLING_ID && (env.SOMTODAY_REFRESH_TOKEN || env.SOMTODAY_USERNAME)) {
    try {
      const body = await syncAndCache(env);
      return new Response(body, {
        headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch (err) {
      // Degrade gracefully: serve the last known-good calendar (if any) with
      // a warning event, instead of a hard failure — token refresh issues
      // shouldn't nuke your whole calendar mid-week. Guard env.STATE itself
      // being missing (e.g. a misconfigured binding) so this fallback path
      // can never itself throw an uncaught exception.
      const cached = env.STATE ? await env.STATE.get("last_good_ics") : null;
      if (cached) {
        const warning = serializeIcs(
          [{
            uid: `warning-${Date.now()}@somtoday-fix`,
            summary: "[Somtoday-fix] Sync failing — showing cached schedule",
            description: String(err instanceof Error ? err.message : err),
            start: new Date(),
            end: new Date(Date.now() + 15 * 60 * 1000),
            status: "CONFIRMED",
            raw: {},
          }],
          { calname: "warning" }
        );
        const merged = cached.replace("END:VCALENDAR", "") +
          warning.split("BEGIN:VEVENT")[1].replace("END:VCALENDAR", "") + "END:VCALENDAR\r\n";
        return new Response(merged, { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
      }
      return new Response(`Somtoday sync error: ${err instanceof Error ? err.message : err}`, { status: 502 });
    }
  }

  // Mode B: plain iCal passthrough with timezone correction only (no
  // cancellation/homework data available in this feed — see README).
  const feedUrl = url.searchParams.get("url") || env.SOMTODAY_ICAL_URL;
  if (!feedUrl) {
    return new Response(
      "Missing ?url=<somtoday ical feed> and no SOMTODAY_LEERLING_ID configured for API mode.",
      { status: 400 }
    );
  }
  const upstream = await fetch(feedUrl);
  if (!upstream.ok) return new Response("Failed to fetch upstream iCal", { status: 502 });
  const text = await upstream.text();
  const { events } = parseIcs(text);
  const body = serializeIcs(events, { calname: "Somtoday (AST, no cancellations)" });
  return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
}

async function handleHomework(req: Request, env: Env): Promise<Response> {
  if (!env.SOMTODAY_LEERLING_ID) {
    return new Response("Homework feed requires authenticated API mode (SOMTODAY_LEERLING_ID + token).", { status: 400 });
  }
  const hour = Number(env.HOMEWORK_HOUR ?? "16");
  const token = await resolveAccessToken(env);
  const huiswerk = await fetchHuiswerk(env.SOMTODAY_LEERLING_ID, token, new Date());

  const todos: VTodo[] = huiswerk.map((hw) => {
    // Due = the day BEFORE the linked lesson, at `hour` AST.
    // hw.datumTijd carries an explicit offset (e.g. "...+02:00"), so the
    // native Date parser already gets the correct UTC instant.
    const lessonDate = hw.datumTijd ? new Date(hw.datumTijd) : new Date();
    const dueLocal = new Date(lessonDate);
    dueLocal.setUTCDate(dueLocal.getUTCDate() - 1);
    const y = dueLocal.getUTCFullYear(), mo = dueLocal.getUTCMonth() + 1, d = dueLocal.getUTCDate();
    const due = zonedWallTimeToUtc(y, mo, d, hour, 0, 0, AST_TZ);

    const typeTag = hw.huiswerkType && hw.huiswerkType !== "HUISWERK" ? ` [${hw.huiswerkType}]` : "";
    const plainDesc = hw.omschrijving?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    return {
      uid: `${hw.uniqueIdentifier}@somtoday-fix-hw`,
      summary: `Homework: ${hw.vak?.naam || "?"} - ${hw.onderwerp || "opdracht"}${typeTag}`,
      description: plainDesc,
      due,
    };
  });

  const body = serializeVTodos(todos, { calname: "Somtoday Huiswerk" });
  return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const authFail = requireAuth(req, env);
    if (authFail) return authFail;

    if (url.pathname === "/calendar.ics") return handleCalendar(req, env);
    if (url.pathname === "/homework.ics") return handleHomework(req, env);
    if (url.pathname === "/") {
      return new Response(
        "somtoday-fix worker.\n\nEndpoints:\n  /calendar.ics\n  /homework.ics\n\nSee README for setup.",
        { headers: { "Content-Type": "text/plain" } }
      );
    }
    return new Response("Not found", { status: 404 });
  },

  /** Cron entry point (see wrangler.toml `[triggers]`). Runs the sync on a
   * fixed schedule regardless of whether any calendar app happens to be
   * polling right now — this is what makes cancellation detection reliable
   * and keeps the Somtoday login refreshed automatically 24/7. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.SOMTODAY_LEERLING_ID || !(env.SOMTODAY_REFRESH_TOKEN || env.SOMTODAY_USERNAME)) return;
    ctx.waitUntil(
      syncAndCache(env).catch((err) => {
        console.error("scheduled sync failed:", err instanceof Error ? err.message : err);
      })
    );
  },
};
