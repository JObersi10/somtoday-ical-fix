// Cancellation detection by snapshot diffing.
//
// Somtoday does not flag cancelled lessons — they just disappear from the
// afspraakitems list (confirmed live). So "did this lesson get cancelled"
// is not a property of one API response; it's a property of *comparing*
// today's response to the last one we saw. We persist a lightweight
// snapshot of every lesson UID in KV and diff against it on every request.
//
// IMPORTANT: this is stored as ONE combined JSON blob under a single KV key,
// not one key per lesson. An earlier version wrote one `snap:<uid>` key per
// lesson (~65 of them) on every single sync — with a 30-minute cron that's
// ~65 x 48 = ~3120 KV writes/day, which blew straight through Cloudflare
// KV's free-tier 1,000 writes/day limit under completely normal operation
// (confirmed live: calendar sync itself started failing with "KV put()
// limit exceeded for the day"). One write per sync stays comfortably under
// that limit regardless of cron frequency or lesson count.

import type { RAfspraakItem } from "./somtoday-api";

interface SnapshotEntry {
  uid: string;
  titel: string;
  locatie?: string;
  beginDatumTijd: string;
  eindDatumTijd: string;
  vak?: string;
  lastSeenAt: number;
}

const KV_KEY = "snap:all";

export interface DiffResult {
  current: RAfspraakItem[];
  cancelled: SnapshotEntry[];
}

/** Compare the freshly-fetched items against the last stored snapshot,
 * update the snapshot, and return any lessons that disappeared (and whose
 * scheduled time hasn't passed yet — no point flagging old lessons as
 * "cancelled" days after the fact). */
export async function diffAndUpdateSnapshot(
  kv: KVNamespace, items: RAfspraakItem[]
): Promise<DiffResult> {
  const now = Date.now();
  const currentIds = new Set(items.map((i) => i.uniqueIdentifier));

  const prevSnapshot = (await kv.get<Record<string, SnapshotEntry>>(KV_KEY, "json")) || {};

  const cancelled: SnapshotEntry[] = [];
  const next: Record<string, SnapshotEntry> = {};

  for (const [uid, entry] of Object.entries(prevSnapshot)) {
    if (currentIds.has(uid)) {
      next[uid] = entry; // refreshed below by the items loop anyway
      continue;
    }
    // Only flag as cancelled if it was for a future/recent lesson — avoid
    // resurrecting ancient history for a lesson that just aged out.
    const scheduled = new Date(entry.beginDatumTijd + "Z").getTime();
    if (scheduled > now - 3 * 24 * 3600 * 1000) {
      cancelled.push(entry);
    }
  }

  for (const item of items) {
    next[item.uniqueIdentifier] = {
      uid: item.uniqueIdentifier,
      titel: item.titel,
      locatie: item.locatie,
      beginDatumTijd: item.beginDatumTijd,
      eindDatumTijd: item.eindDatumTijd,
      vak: item.vak?.naam,
      lastSeenAt: now,
    };
  }

  // Drop anything older than 45 days so the blob doesn't grow forever —
  // there's no per-key TTL anymore since it's all one key.
  for (const [uid, entry] of Object.entries(next)) {
    if (now - entry.lastSeenAt > 45 * 24 * 3600 * 1000) delete next[uid];
  }

  await kv.put(KV_KEY, JSON.stringify(next));

  return { current: items, cancelled };
}
