/**
 * Daily staff email digest (2026-09-28). Non-urgent alerts queue their email
 * copy in staff_email_digest_queue (see shouldDigestEmail in notify.ts) and
 * the afternoon cron sends each person ONE email listing them. This file is
 * the pure part: grouping queued rows into per-person digests.
 */

export interface DigestQueueRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  created_at: string;
}

export interface DigestItem {
  title: string;
  body: string | null;
  url: string | null;
  at: string;
}

export interface UserDigest {
  userId: string;
  rowIds: string[];
  items: DigestItem[];
}

/** Most items shown in one email; the rest are counted, not listed. */
export const DIGEST_ITEM_CAP = 40;

/**
 * Group queued rows per person, oldest first. Exact repeats (same title and
 * link, e.g. the same reminder queued twice) collapse to one line; every
 * row id is still returned so all of them get marked sent.
 */
export function groupDigests(rows: DigestQueueRow[]): UserDigest[] {
  const byUser = new Map<string, UserDigest & { seen: Set<string> }>();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const r of sorted) {
    let d = byUser.get(r.user_id);
    if (!d) {
      d = { userId: r.user_id, rowIds: [], items: [], seen: new Set() };
      byUser.set(r.user_id, d);
    }
    d.rowIds.push(r.id);
    const key = `${r.title}\u0000${r.url || ''}`;
    if (d.seen.has(key)) continue;
    d.seen.add(key);
    d.items.push({ title: r.title, body: r.body, url: r.url, at: r.created_at });
  }
  return [...byUser.values()].map(({ seen: _seen, ...d }) => d);
}

export function digestSubject(itemCount: number): string {
  return `[BMG Fleet] Today's alerts: ${itemCount} update${itemCount === 1 ? '' : 's'}`;
}
