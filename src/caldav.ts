// Minimal CalDAV client for writing homework as real VTODO items into an
// iCloud Reminders list, authenticated via an Apple ID app-specific
// password (appleid.apple.com -> Sign-In and Security -> App-Specific
// Passwords). This is a genuinely different integration point than the
// calendar.ics "Subscribed Calendar" mechanism: iCloud exposes Reminders
// lists over CalDAV to any client (Fantastical, Things, etc. all sync this
// way), so items written here appear exactly like something typed directly
// into Reminders.app — a real checkbox, a real due date.
//
// The Workers runtime has no XML DOM parser, so PROPFIND multistatus
// responses are picked apart with small regex helpers instead of a real
// parser — brittle in the general case, but iCloud's responses are
// consistent enough for the handful of tags we actually need.

const CALDAV_BASE = "https://caldav.icloud.com";

// iCloud's CalDAV server (and/or Cloudflare's edge in front of it) appears to
// reject requests that carry no User-Agent, or an unrecognized one, with a
// bare 400 — Workers' fetch() sends no User-Agent by default. A generic
// browser-shaped UA is confirmed to get through where the default doesn't.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function authHeader(appleId: string, appPassword: string): string {
  return "Basic " + btoa(`${appleId}:${appPassword}`);
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

function extractOne(xml: string, tag: string): string | null {
  return extractAll(xml, tag)[0] ?? null;
}

/** Split a multistatus response into per-<response> chunks. */
function splitResponses(xml: string): string[] {
  return extractAll(xml, "response");
}

async function propfind(
  url: string, appleId: string, appPassword: string, depth: "0" | "1", body: string
): Promise<string> {
  // Cloudflare Workers' fetch sends a plain string body as
  // Transfer-Encoding: chunked (no Content-Length) by default. iCloud's
  // CalDAV/WebDAV server rejects chunked PROPFIND bodies with a bare 400 —
  // confirmed by comparing an identical request made via curl (which sends
  // Content-Length and succeeds) against the same request from inside this
  // Worker (fails every time). Encoding the body as a fixed-size buffer
  // gives fetch() a known length upfront, so it sends Content-Length
  // instead of chunking.
  const bytes = new TextEncoder().encode(body);
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(appleId, appPassword),
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "User-Agent": USER_AGENT,
    },
    body: bytes,
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`CalDAV PROPFIND ${url} -> ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

export interface CalDavTarget {
  collectionUrl: string; // absolute URL of the VTODO-capable calendar collection to write into
}

/** Discover the iCloud Reminders list matching `listName` (case-insensitive).
 * You must create this list once in Reminders.app yourself — we deliberately
 * don't create lists (MKCALENDAR) here, so you never end up with a
 * surprise list you didn't ask for. Result is cached in KV for 30 days so
 * we don't re-walk the discovery chain on every 30-minute cron tick. */
export async function discoverReminderList(
  kv: KVNamespace, appleId: string, appPassword: string, listName: string
): Promise<CalDavTarget> {
  const cacheKey = `caldav_collection:${listName.toLowerCase()}`;
  const cached = await kv.get<CalDavTarget>(cacheKey, "json");
  if (cached) return cached;

  // 1. Current user principal.
  const principalXml = await propfind(
    `${CALDAV_BASE}/`, appleId, appPassword, "0",
    `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:">
<A:prop><A:current-user-principal/></A:prop>
</A:propfind>`
  );
  const principalHref = extractOne(principalXml, "href");
  if (!principalHref) throw new Error("CalDAV: could not discover current-user-principal");

  // 2. Calendar home set.
  const homeXml = await propfind(
    `${CALDAV_BASE}${principalHref}`, appleId, appPassword, "0",
    `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<A:prop><C:calendar-home-set/></A:prop>
</A:propfind>`
  );
  const homeHref = extractOne(homeXml, "href");
  if (!homeHref) throw new Error("CalDAV: could not discover calendar-home-set");

  // 3. List calendar collections under the home set; find the one whose
  //    displayname matches and which supports VTODO.
  const listXml = await propfind(
    `${CALDAV_BASE}${homeHref}`, appleId, appPassword, "1",
    `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<A:prop>
<A:displayname/>
<C:supported-calendar-component-set/>
</A:prop>
</A:propfind>`
  );

  let match: string | null = null;
  for (const chunk of splitResponses(listXml)) {
    const href = extractOne(chunk, "href");
    const displayname = extractOne(chunk, "displayname");
    const supportsVTodo = /VTODO/i.test(chunk);
    if (href && displayname && supportsVTodo && displayname.toLowerCase() === listName.toLowerCase()) {
      match = href;
      break;
    }
  }
  if (!match) {
    throw new Error(
      `CalDAV: no Reminders list named "${listName}" found for ${appleId}. Create it once in ` +
      `Reminders.app (on the iCloud account that owns this Apple ID) and it'll be picked up automatically.`
    );
  }

  const target: CalDavTarget = { collectionUrl: `${CALDAV_BASE}${match}` };
  await kv.put(cacheKey, JSON.stringify(target), { expirationTtl: 30 * 24 * 3600 });
  return target;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function buildVTodoIcs(uid: string, summary: string, description: string | undefined, due: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//somtoday-fix//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DUE:${formatUtc(due)}`,
    `SUMMARY:${icsEscape(summary)}`,
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Create a VTODO if one doesn't already exist at this UID. Deliberately
 * never overwrites an existing item: once created, you own it in
 * Reminders.app — check it off, edit it, whatever — and we won't stomp on
 * a completed item by re-PUTting STATUS:NEEDS-ACTION over it later. */
export async function ensureReminder(
  target: CalDavTarget, appleId: string, appPassword: string,
  uid: string, summary: string, description: string | undefined, due: Date
): Promise<"created" | "exists"> {
  const url = `${target.collectionUrl}${uid}.ics`;
  const head = await fetch(url, {
    method: "HEAD",
    headers: { Authorization: authHeader(appleId, appPassword), "User-Agent": USER_AGENT },
  });
  if (head.status === 200) return "exists";

  const bodyBytes = new TextEncoder().encode(buildVTodoIcs(uid, summary, description, due));
  const put = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader(appleId, appPassword),
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Length": String(bodyBytes.byteLength),
      "If-None-Match": "*",
      "User-Agent": USER_AGENT,
    },
    body: bodyBytes,
  });
  if (put.ok) return "created";
  if (put.status === 412) return "exists"; // lost the create race to another run — fine
  throw new Error(`CalDAV PUT ${url} -> ${put.status}: ${await put.text()}`);
}
