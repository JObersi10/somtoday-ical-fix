// Cancellation detection by snapshot diffing.
//
// Somtoday does not flag cancelled lessons — they just disappear from the
// afspraakitems list (confirmed live). So "did this lesson get cancelled"
// is not a property of one API response; it's a property of *comparing*
// today's response to the last one we saw. We persist a lightweight
// snapshot per lesson UID in KV and diff against it on every request.

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

const KV_PREFIX = "snap:";

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

  const listKey = `${KV_PREFIX}index`;
  const prevIndex = (await kv.get<string[]>(listKey, "json")) || [];

  const cancelled: SnapshotEntry[] = [];
  const stillValidIndex: string[] = [];

  for (const uid of prevIndex) {
    if (currentIds.has(uid)) {
      stillValidIndex.push(uid);
      continue;
    }
    const entry = await kv.get<SnapshotEntry>(`${KV_PREFIX}${uid}`, "json");
    if (!entry) continue;
    // Only flag as cancelled if it was for a future/recent lesson — avoid
    // resurrecting ancient history once KV entries roll past their TTL.
    const scheduled = new Date(entry.beginDatumTijd + "Z").getTime();
    if (scheduled > now - 3 * 24 * 3600 * 1000) {
      cancelled.push(entry);
    }
    await kv.delete(`${KV_PREFIX}${uid}`);
  }

  const nextIndex = [...stillValidIndex];
  for (const item of items) {
    const key = `${KV_PREFIX}${item.uniqueIdentifier}`;
    const entry: SnapshotEntry = {
      uid: item.uniqueIdentifier,
      titel: item.titel,
      locatie: item.locatie,
      beginDatumTijd: item.beginDatumTijd,
      eindDatumTijd: item.eindDatumTijd,
      vak: item.vak?.naam,
      lastSeenAt: now,
    };
    // 45-day TTL: plenty for a week-ahead/behind window, self-cleaning.
    await kv.put(key, JSON.stringify(entry), { expirationTtl: 45 * 24 * 3600 });
    if (!nextIndex.includes(item.uniqueIdentifier)) nextIndex.push(item.uniqueIdentifier);
  }

  await kv.put(listKey, JSON.stringify(nextIndex), { expirationTtl: 45 * 24 * 3600 });

  return { current: items, cancelled };
}
