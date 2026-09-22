/**
 * Alert Scoreboard (R6-13) — which notification types are worth sending,
 * and who cannot receive a push at all.
 *
 * WHAT IS AND IS NOT MEASURABLE HERE. The `notifications` table records
 * user_id, type, created_at and read_at. That supports sent counts, read
 * rate and time-to-read. It does NOT record click-through — no column has
 * ever stored whether anyone followed the notification's url — so this
 * report says so rather than quietly relabelling "read" as "clicked". The
 * audit block asked for click-through; adding it means a click endpoint
 * and a column, which is a separate change.
 *
 * BULK DISMISSAL IS AN INFERENCE, AND SAYS SO. Mark-all-read stamps many
 * rows with the same instant, so a read that arrived in a batch of
 * BULK_THRESHOLD or more rows sharing one user and one read_at timestamp
 * is counted as bulk-cleared rather than read. That is a heuristic: a
 * genuinely fast reader clearing five alerts in the same second would
 * score the same, which the page states beside the number instead of
 * presenting it as a measurement.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { getNotificationType, AREA_LABEL, type NotificationArea } from './notification-registry';

type Service = SupabaseClient<any, any, any>;

/** Reads sharing one user and one exact timestamp, at or above this count,
 *  are treated as one mark-all-read rather than that many readings. */
export const BULK_THRESHOLD = 5;

export interface TypeScore {
  type: string;
  label: string;
  area: NotificationArea;
  areaLabel: string;
  /** True when the type is dispatched but missing from the registry — the
   *  scoreboard shows it rather than hiding what it cannot name. */
  unregistered: boolean;
  sent: number;
  read: number;
  bulkCleared: number;
  unread: number;
  /** null when nothing was read, rather than 0 — no reading is not "instant". */
  medianMinutesToRead: number | null;
  /** Share of sends nobody opened individually, 0-1. */
  ignoredRate: number;
}

export interface PushCoverageRow {
  userId: string;
  name: string | null;
  email: string | null;
  browsers: number;
  devices: number;
}

export interface Scoreboard {
  windowDays: number;
  from: string;
  totalSent: number;
  /** Sorted noisiest-ignored first — the ones worth turning down. */
  types: TypeScore[];
  pushCoverage: {
    staff: number;
    withPush: number;
    missing: PushCoverageRow[];
  };
  /** Stated on the page so a reader knows what the numbers cannot show. */
  caveats: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Which reads look like a mark-all-read: key on user + exact read instant,
 * and any group at or over the threshold is one clearing action.
 */
export function bulkReadKeys(
  rows: Array<{ user_id: string; read_at: string | null }>,
  threshold = BULK_THRESHOLD,
): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.read_at) continue;
    const key = `${r.user_id}|${r.read_at}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const bulk = new Set<string>();
  for (const [key, n] of counts) if (n >= threshold) bulk.add(key);
  return bulk;
}

export function scoreRows(
  rows: Array<{ user_id: string; type: string; created_at: string; read_at: string | null }>,
): TypeScore[] {
  const bulk = bulkReadKeys(rows);
  const byType = new Map<string, { sent: number; read: number; bulk: number; latencies: number[] }>();

  for (const r of rows) {
    const t = String(r.type || 'unknown');
    const acc = byType.get(t) || { sent: 0, read: 0, bulk: 0, latencies: [] };
    acc.sent += 1;
    if (r.read_at) {
      if (bulk.has(`${r.user_id}|${r.read_at}`)) {
        acc.bulk += 1;
      } else {
        acc.read += 1;
        const ms = Date.parse(r.read_at) - Date.parse(r.created_at);
        // A negative delta means the clocks or the data disagree; counting
        // it as "read instantly" would flatter the median.
        if (Number.isFinite(ms) && ms >= 0) acc.latencies.push(ms / 60_000);
      }
    }
    byType.set(t, acc);
  }

  const out: TypeScore[] = [];
  for (const [type, acc] of byType) {
    const def = getNotificationType(type);
    const unread = acc.sent - acc.read - acc.bulk;
    out.push({
      type,
      label: def?.label || type,
      area: def?.area || 'system',
      areaLabel: def ? AREA_LABEL[def.area] : 'Unrecognised',
      unregistered: !def,
      sent: acc.sent,
      read: acc.read,
      bulkCleared: acc.bulk,
      unread,
      medianMinutesToRead: median(acc.latencies),
      ignoredRate: acc.sent > 0 ? (acc.bulk + unread) / acc.sent : 0,
    });
  }

  // Noisiest ignored first: volume × how often it goes unread, so a type
  // sent twice and ignored twice does not outrank one sent 900 times and
  // ignored 850.
  return out.sort((a, b) => (b.ignoredRate * b.sent) - (a.ignoredRate * a.sent));
}

export async function loadScoreboard(service: Service, windowDays: number): Promise<Scoreboard> {
  const from = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data: rows } = await fetchAllRows<any>((lo, hi) =>
    service
      .from('notifications')
      .select('user_id, type, created_at, read_at')
      .gte('created_at', from)
      .order('created_at')
      .order('id')
      .range(lo, hi),
  );

  const types = scoreRows(rows || []);

  // Push coverage: staff accounts with no browser subscription AND no
  // native device. Either one means a push can land.
  const { data: staff } = await fetchAllRows<any>((lo, hi) =>
    service
      .from('profiles')
      .select('id, full_name, email, roles, role, status, deactivated')
      .order('full_name')
      .order('id')
      .range(lo, hi),
  );
  const active = (staff || []).filter(p => {
    if (p.deactivated) return false;
    if (p.status && p.status !== 'approved') return false;
    const roles: string[] = (p.roles && p.roles.length ? p.roles : [p.role]).filter(Boolean);
    // Customers and unapproved installers are not who this report is about.
    return roles.some(r => r !== 'customer');
  });

  const [{ data: subs }, { data: devices }] = await Promise.all([
    service.from('push_subscriptions').select('user_id'),
    service.from('native_push_tokens').select('user_id'),
  ]);
  const browserCount = new Map<string, number>();
  for (const s of subs || []) browserCount.set(s.user_id, (browserCount.get(s.user_id) || 0) + 1);
  const deviceCount = new Map<string, number>();
  for (const d of devices || []) deviceCount.set(d.user_id, (deviceCount.get(d.user_id) || 0) + 1);

  const missing: PushCoverageRow[] = active
    .filter(p => !browserCount.get(p.id) && !deviceCount.get(p.id))
    .map(p => ({ userId: p.id, name: p.full_name || null, email: p.email || null, browsers: 0, devices: 0 }));

  return {
    windowDays,
    from,
    totalSent: (rows || []).length,
    types,
    pushCoverage: {
      staff: active.length,
      withPush: active.length - missing.length,
      missing,
    },
    caveats: [
      'Click-through is not measured: nothing records whether anyone followed a notification’s link. "Read" means the in-app row was marked read.',
      `Bulk-cleared is inferred, not recorded: ${BULK_THRESHOLD}+ notifications marked read by one person at the same instant are counted as one mark-all-read rather than that many readings.`,
      'In-app rows only. An alert delivered by push or email but never opened in-app cannot be distinguished here from one that was never sent.',
    ],
  };
}
