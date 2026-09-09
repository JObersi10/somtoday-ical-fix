// Client for the REAL Somtoday student REST API (api.somtoday.nl), captured
// live from a logged-in leerling.somtoday.nl session on 2026-09-09.
//
// Confirmed from a real response:
//   GET https://api.somtoday.nl/rest/v1/afspraakitems/{leerlingId}/jaar/{year}/week/{week}
//   -> { items: RAfspraakItem[] }
//
// RAfspraakItem fields actually observed:
//   uniqueIdentifier, afspraakItemType ("ROOSTER" | "INDIVIDUEEL" | ...),
//   locatie, beginDatumTijd / eindDatumTijd (LOCAL wall time, NO offset,
//   e.g. "2026-09-07T07:30:00" — this is Europe/Amsterdam civil time, the
//   exact thing that needs zone-correct conversion), beginLesuur/eindLesuur,
//   titel, omschrijving, vak.naam, docentNamen[], statusNotifications[],
//   bijlagen[].
//
// IMPORTANT — confirmed cancellation behavior: a cancelled/dropped lesson
// does NOT get a "CANCELLED" status field. It simply disappears from this
// list on a later fetch. There is no way to detect a cancellation from a
// single snapshot; you need to diff against a previous snapshot (see
// snapshot.ts) to notice a UID vanished. `statusNotifications` is the field
// Somtoday uses for schedule-change info (substitute teacher, room change)
// when a lesson is NOT dropped but modified — kept but not seen populated
// in the sample, so it's treated as opportunistic best-effort text.
//
// Homework (studiewijzeritem*) endpoints were NOT captured live — no
// homework request happened during the capture window. The paths below
// follow the publicly documented (reverse-engineered) SOMtoday REST API
// docs (github.com/elisaado/somtoday-api-docs). If they 404 or come back
// in an unexpected shape for your school tenant, the worker degrades
// gracefully (drops homework from the feed, keeps the lesson calendar
// working) rather than failing the whole request — but the source of truth
// for this piece is genuinely unverified. If it doesn't work, capture a
// HAR while opening the "Huiswerk" tab in Somtoday the same way we did for
// the schedule, and this file can be corrected in one pass.

export interface RAfspraakItem {
  uniqueIdentifier: string;
  afspraakItemType: string;
  locatie?: string;
  beginDatumTijd: string; // local Europe/Amsterdam wall time, no offset
  eindDatumTijd: string;
  titel: string;
  omschrijving?: string;
  vak?: { naam: string; afkorting?: string };
  docentNamen?: string[];
  statusNotifications?: { omschrijving?: string; type?: string }[];
  /** CONFIRMED live (2026-09-09) — this endpoint's sibling response shape
   * (the app's own cached `afspraak` payload) carries `isUitgevallen: bool`
   * directly on each item. This is a real, first-class cancellation flag —
   * better than the snapshot-diff fallback in snapshot.ts, which is kept
   * as a backstop for the (separate, unverified-for-this-field)
   * afspraakitems/{id}/jaar/.../week/... endpoint in case it omits this
   * field for your tenant. */
  isUitgevallen?: boolean;
}

export interface RStudiewijzerItem {
  uniqueIdentifier: string;
  onderwerp?: string;
  omschrijving?: string;
  huiswerkType?: string;
  vak?: { naam: string };
  datumTijd?: string; // ISO with explicit offset — the linked lesson's date
}

// Real shape captured live from studiewijzeritemafspraaktoekenningen /
// studiewijzeritemdagtoekenningen (2026-09-09 HAR):
//   { items: [ { links:[{id}], datumTijd: "2026-09-25T09:00:00.000+02:00",
//                lesgroep: { naam, vak: { naam } },
//                studiewijzerItem: { onderwerp, omschrijving, huiswerkType } } ] }
interface RSWIToekenningRaw {
  links: { id: number }[];
  datumTijd: string;
  lesgroep?: { naam?: string; vak?: { naam?: string } };
  studiewijzerItem?: { onderwerp?: string; omschrijving?: string; huiswerkType?: string };
}

function toekenningToItem(raw: RSWIToekenningRaw): RStudiewijzerItem {
  return {
    uniqueIdentifier: String(raw.links?.[0]?.id ?? crypto.randomUUID()),
    onderwerp: raw.studiewijzerItem?.onderwerp,
    omschrijving: raw.studiewijzerItem?.omschrijving,
    huiswerkType: raw.studiewijzerItem?.huiswerkType,
    vak: raw.lesgroep?.vak?.naam ? { naam: raw.lesgroep.vak.naam } : undefined,
    datumTijd: raw.datumTijd,
  };
}

const API_BASE = "https://api.somtoday.nl/rest/v1";

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

// Somtoday's real API uses a custom media type, confirmed live from the
// app's own requests. Without a matching Accept header, api.somtoday.nl
// returns 200 with a technically-valid but EMPTY items array rather than
// an error — that was the actual cause of the empty calendar, not an auth
// or leerlingId problem (the token and leerlingId were both correct).
const SOMTODAY_MEDIA_TYPE = "application/vnd.topicus.platinum+json; charset=utf-8";

async function apiGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: SOMTODAY_MEDIA_TYPE,
    },
  });
  if (!res.ok) {
    throw new Error(`Somtoday API ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json<T>();
}

/** Fetch appointments for the ISO week containing `around`, plus the week
 * before and after (Somtoday's UI does the same, and homework due
 * "tomorrow" often needs next week's lesson to compute t-1). */
export async function fetchAfspraken(
  leerlingId: string, accessToken: string, around: Date
): Promise<RAfspraakItem[]> {
  const weeks = [-1, 0, 1].map((delta) => {
    const d = new Date(around);
    d.setUTCDate(d.getUTCDate() + delta * 7);
    return isoWeek(d);
  });

  const results = await Promise.all(
    weeks.map(({ year, week }) =>
      apiGet<{ items: RAfspraakItem[] }>(`/afspraakitems/${leerlingId}/jaar/${year}/week/${week}`, accessToken)
        .then((r) => {
          console.log(`afspraakitems jaar/${year}/week/${week}: ${r.items?.length ?? "no items key"} items, leerlingId=${leerlingId}`);
          return r.items;
        })
        .catch((err) => {
          console.error(`afspraakitems jaar/${year}/week/${week} failed:`, err instanceof Error ? err.message : err);
          return [] as RAfspraakItem[];
        })
    )
  );

  const seen = new Set<string>();
  const merged: RAfspraakItem[] = [];
  for (const list of results) {
    for (const item of list) {
      if (!seen.has(item.uniqueIdentifier)) {
        seen.add(item.uniqueIdentifier);
        merged.push(item);
      }
    }
  }
  return merged;
}

/** Homework fetch — endpoints and response shape confirmed live 2026-09-09.
 * Pulls both appointment-linked and day-linked homework across a window of
 * weeks so upcoming due dates are covered. Fails soft per-request: a
 * missing week for one endpoint never takes down the rest. */
export async function fetchHuiswerk(
  leerlingId: string, accessToken: string, around: Date, weeksAhead = 5
): Promise<RStudiewijzerItem[]> {
  const weeks = Array.from({ length: weeksAhead + 1 }, (_, i) => {
    const d = new Date(around);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return isoWeek(d);
  });

  const commonParams =
    `geenDifferentiatieOfGedifferentieerdVoorLeerling=${leerlingId}` +
    `&additional=lesgroep&additional=studiewijzerId`;

  const requests: Promise<RStudiewijzerItem[]>[] = [];
  for (const { year, week } of weeks) {
    for (const endpoint of ["studiewijzeritemafspraaktoekenningen", "studiewijzeritemdagtoekenningen"]) {
      requests.push(
        apiGet<{ items: RSWIToekenningRaw[] }>(
          `/${endpoint}?${commonParams}&jaarWeek=${year}~${week}`, accessToken
        )
          .then((r) => (r.items || []).map(toekenningToItem))
          .catch(() => [] as RStudiewijzerItem[])
      );
    }
  }

  const results = await Promise.all(requests);
  const seen = new Set<string>();
  const out: RStudiewijzerItem[] = [];
  for (const list of results) {
    for (const item of list) {
      if (!seen.has(item.uniqueIdentifier)) {
        seen.add(item.uniqueIdentifier);
        out.push(item);
      }
    }
  }
  return out;
}
