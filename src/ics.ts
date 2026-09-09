// Minimal dependency-free ICS (RFC 5545) parsing + serialization.
// Somtoday's feed is simple enough (no nested VALARM, no multi-value RRULE we
// need to preserve) that a hand-rolled parser is safer on Workers than a
// heavy npm ical library that assumes Node's Buffer/fs.

export interface VEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  /** Always stored as an absolute UTC Date internally. */
  start: Date;
  end: Date;
  /** True if the source line had a bare TZID (floating local time, no Z). */
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  raw: Record<string, string>;
}

export interface VTodo {
  uid: string;
  summary: string;
  description?: string;
  due: Date;
}

/** Unfold ICS continuation lines (a line starting with a space/tab is a
 * continuation of the previous line) and split on CRLF/LF. */
function unfold(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

/** Split "NAME;PARAM=X:VALUE" into { name, params, value }. */
function splitLine(line: string): { name: string; params: Record<string, string>; value: string } {
  const colonIdx = line.indexOf(":");
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse an ICS DATE-TIME value into an absolute UTC Date.
 * - Trailing "Z" -> already UTC.
 * - Otherwise treat as wall-clock time in `fallbackTz` (IANA name) and
 *   compute the correct UTC instant for that civil time, honoring DST. */
function parseDateTime(value: string, tzid: string | undefined, fallbackTz: string): Date {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) throw new Error(`Unparseable ICS date-time: ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z") {
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const tz = tzid || fallbackTz;
  return zonedWallTimeToUtc(+y, +mo, +d, +h, +mi, +s, tz);
}

/** Convert a civil (wall-clock) date/time in an IANA timezone to a UTC Date,
 * using Intl for correct DST handling without any timezone database deps. */
function zonedWallTimeToUtc(
  y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string
): Date {
  // Guess: treat the wall time as if it were UTC, then measure the offset
  // that timeZone actually has at that instant, and correct once. This
  // converges in one step for all real-world timezones (no half-hour DST
  // transitions that would need iteration).
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMs = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs);
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local = utc + offset. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second
  );
  return asUtc - instant.getTime();
}

export function parseIcs(text: string, fallbackTz = "Europe/Amsterdam"): { events: VEvent[]; calname?: string } {
  const lines = unfold(text);
  const events: VEvent[] = [];
  let cur: Record<string, string> | null = null;
  let curTzids: Record<string, string> = {};
  let calname: string | undefined;

  for (const line of lines) {
    const { name, params, value } = splitLine(line);

    if (name === "X-WR-CALNAME") calname = unescapeText(value);

    if (name === "BEGIN" && value === "VEVENT") {
      cur = {};
      curTzids = {};
      continue;
    }
    if (name === "END" && value === "VEVENT") {
      if (cur) {
        try {
          const start = parseDateTime(cur.DTSTART, curTzids.DTSTART, fallbackTz);
          const end = parseDateTime(cur.DTEND, curTzids.DTEND, fallbackTz);
          events.push({
            uid: cur.UID || crypto.randomUUID(),
            summary: unescapeText(cur.SUMMARY || ""),
            description: cur.DESCRIPTION ? unescapeText(cur.DESCRIPTION) : undefined,
            location: cur.LOCATION ? unescapeText(cur.LOCATION) : undefined,
            start,
            end,
            status: (cur.STATUS as VEvent["status"]) || "CONFIRMED",
            raw: cur,
          });
        } catch {
          // Skip malformed events rather than failing the whole feed.
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    if (name === "DTSTART" || name === "DTEND") {
      cur[name] = value;
      if (params.TZID) curTzids[name] = params.TZID;
    } else if (name === "SUMMARY" || name === "DESCRIPTION" || name === "LOCATION" ||
               name === "UID" || name === "STATUS" || name === "COMMENT") {
      cur[name] = value;
    }
  }

  return { events, calname };
}

function fmtUtc(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Fold a line at 75 octets per RFC 5545 so strict clients don't choke on
 * long SUMMARY/DESCRIPTION values. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length > 0) {
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

export function serializeIcs(events: VEvent[], opts: { calname: string; prodid?: string }): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${opts.prodid || "-//somtoday-fix//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calname)}`,
    "X-PUBLISHED-TTL:PT15M",
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(fold(`UID:${ev.uid}`));
    lines.push(fold(`DTSTAMP:${fmtUtc(new Date())}`));
    lines.push(fold(`DTSTART:${fmtUtc(ev.start)}`));
    lines.push(fold(`DTEND:${fmtUtc(ev.end)}`));
    lines.push(fold(`SUMMARY:${escapeText(ev.summary)}`));
    if (ev.location) lines.push(fold(`LOCATION:${escapeText(ev.location)}`));
    if (ev.description) lines.push(fold(`DESCRIPTION:${escapeText(ev.description)}`));
    lines.push(`STATUS:${ev.status || "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function serializeVTodos(todos: VTodo[], opts: { calname: string; prodid?: string }): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${opts.prodid || "-//somtoday-fix//EN"}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(opts.calname)}`,
  ];

  for (const t of todos) {
    lines.push("BEGIN:VTODO");
    lines.push(fold(`UID:${t.uid}`));
    lines.push(fold(`DTSTAMP:${fmtUtc(new Date())}`));
    lines.push(fold(`DUE:${fmtUtc(t.due)}`));
    lines.push(fold(`SUMMARY:${escapeText(t.summary)}`));
    if (t.description) lines.push(fold(`DESCRIPTION:${escapeText(t.description)}`));
    lines.push("STATUS:NEEDS-ACTION");
    lines.push("END:VTODO");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export { tzOffsetMs, zonedWallTimeToUtc };
