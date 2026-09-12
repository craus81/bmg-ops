/**
 * Email Reach Report (R6-13) — deliverability by kind and by recipient
 * domain, plus the customers we can no longer reach.
 *
 * "Gmail started eating our mail" should show as a spike in a table, not
 * circulate as folklore. email_log already records every send with its
 * Resend delivery outcome; this reads it.
 *
 * WHAT 'sent' MEANS, AND WHY IT IS NOT SUCCESS. A row sits at 'sent' until
 * a webhook moves it. That covers two very different situations — a
 * message genuinely in flight, and one whose webhook never arrived — and
 * neither is a confirmed delivery. So `delivered` counts only rows Resend
 * actually confirmed, `failed` counts bounced/complained/failed, and
 * everything still at 'sent' is reported as PENDING in its own column
 * rather than folded into either. A deliverability report that counted
 * unconfirmed sends as delivered would flatter every rate on the page.
 *
 * RATES ARE OVER CONFIRMED OUTCOMES ONLY. The failure rate divides by
 * (delivered + failed), not by everything sent: including pending rows
 * would move the rate every time a webhook is late, which is noise, not
 * deliverability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

type Service = SupabaseClient<any, any, any>;

/** Outcomes Resend has actually confirmed as failures. */
export const FAILURE_STATES = ['bounced', 'complained', 'failed'];
/** Confirmed success. */
export const DELIVERED_STATES = ['delivered'];
/** Repeated failures to one address before we call it unreachable. */
export const UNREACHABLE_THRESHOLD = 2;

export interface ReachRow {
  key: string;
  label: string;
  delivered: number;
  failed: number;
  /** Still at 'sent' — in flight, or a webhook that never came. Neither. */
  pending: number;
  total: number;
  /** failed / (delivered + failed), or null when nothing is confirmed yet. */
  failureRate: number | null;
}

export interface UnreachableAddress {
  address: string;
  domain: string;
  failures: number;
  lastFailureAt: string;
  lastStatus: string;
  customerId: string | null;
  prospectId: string | null;
  /** The customer's NetSuite id, which is what the customer page is keyed
   *  on. Resolved server-side: there is no route that takes a customers
   *  UUID, so without this the "Fix contact" link would go nowhere. */
  customerNetsuiteId: string | null;
  /** Distinct flows that hit this address, so a one-flow problem is visible. */
  kinds: string[];
}

export interface ReachReport {
  windowDays: number;
  from: string;
  totals: ReachRow;
  byKind: ReachRow[];
  byDomain: ReachRow[];
  unreachable: UnreachableAddress[];
  caveats: string[];
}

const rate = (delivered: number, failed: number): number | null => {
  const confirmed = delivered + failed;
  return confirmed === 0 ? null : failed / confirmed;
};

export function domainOf(address: string): string {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return '(no domain)';
  const d = address.slice(at + 1).trim().toLowerCase();
  return d || '(no domain)';
}

interface Tally { delivered: number; failed: number; pending: number }
const emptyTally = (): Tally => ({ delivered: 0, failed: 0, pending: 0 });

function toRow(key: string, label: string, t: Tally): ReachRow {
  const total = t.delivered + t.failed + t.pending;
  return { key, label, delivered: t.delivered, failed: t.failed, pending: t.pending, total, failureRate: rate(t.delivered, t.failed) };
}

export interface EmailRow {
  kind: string | null;
  recipients: string[] | null;
  delivery_status: string;
  created_at: string;
  customer_id?: string | null;
  prospect_id?: string | null;
  resolved_at?: string | null;
}

/**
 * Roll one window of email_log into the report's three tables.
 *
 * A row with several recipients counts once per ADDRESS in the domain
 * table (that is what a domain question is asking) but once overall in the
 * kind and total tables (one send is one send). Counting a three-recipient
 * email as three sends in the totals would inflate volume and make the
 * per-kind rates disagree with the headline.
 */
export function rollUp(rows: EmailRow[]): Pick<ReachReport, 'totals' | 'byKind' | 'byDomain'> {
  const overall = emptyTally();
  const kinds = new Map<string, Tally>();
  const domains = new Map<string, Tally>();

  const bump = (t: Tally, status: string) => {
    if (FAILURE_STATES.includes(status)) t.failed += 1;
    else if (DELIVERED_STATES.includes(status)) t.delivered += 1;
    else t.pending += 1;
  };

  for (const r of rows) {
    const status = String(r.delivery_status || 'sent');
    bump(overall, status);

    const kind = r.kind || 'other';
    if (!kinds.has(kind)) kinds.set(kind, emptyTally());
    bump(kinds.get(kind)!, status);

    for (const address of r.recipients || []) {
      const d = domainOf(address);
      if (!domains.has(d)) domains.set(d, emptyTally());
      bump(domains.get(d)!, status);
    }
  }

  // Worst first, but only where enough is confirmed to mean anything — a
  // single failed send to a domain is not "100% failure" worth topping the
  // table with.
  const bySeverity = (a: ReachRow, b: ReachRow) => {
    const aScore = (a.failureRate ?? 0) * (a.delivered + a.failed);
    const bScore = (b.failureRate ?? 0) * (b.delivered + b.failed);
    if (bScore !== aScore) return bScore - aScore;
    return b.total - a.total;
  };

  return {
    totals: toRow('all', 'All email', overall),
    byKind: [...kinds.entries()].map(([k, t]) => toRow(k, k.replace(/_/g, ' '), t)).sort(bySeverity),
    byDomain: [...domains.entries()].map(([d, t]) => toRow(d, d, t)).sort(bySeverity),
  };
}

/**
 * Addresses that failed repeatedly and were never marked resolved.
 *
 * A RESOLVED failure is excluded: somebody fixed the contact, and keeping
 * it on a worklist called "unreachable" would send them to fix it twice.
 */
export function findUnreachable(rows: EmailRow[], threshold = UNREACHABLE_THRESHOLD): UnreachableAddress[] {
  const byAddress = new Map<string, {
    failures: number; last: string; lastStatus: string;
    customerId: string | null; prospectId: string | null; kinds: Set<string>;
  }>();

  for (const r of rows) {
    if (!FAILURE_STATES.includes(String(r.delivery_status))) continue;
    if (r.resolved_at) continue;
    for (const raw of r.recipients || []) {
      const address = String(raw || '').trim().toLowerCase();
      if (!address) continue;
      const acc = byAddress.get(address) || {
        failures: 0, last: r.created_at, lastStatus: r.delivery_status,
        customerId: null, prospectId: null, kinds: new Set<string>(),
      };
      acc.failures += 1;
      if (r.created_at > acc.last) { acc.last = r.created_at; acc.lastStatus = r.delivery_status; }
      // Keep the first id we see rather than overwriting: a later automated
      // send with no customer link must not erase the link we already have.
      acc.customerId = acc.customerId || r.customer_id || null;
      acc.prospectId = acc.prospectId || r.prospect_id || null;
      acc.kinds.add(r.kind || 'other');
      byAddress.set(address, acc);
    }
  }

  return [...byAddress.entries()]
    .filter(([, a]) => a.failures >= threshold)
    .map(([address, a]) => ({
      address,
      domain: domainOf(address),
      failures: a.failures,
      lastFailureAt: a.last,
      lastStatus: a.lastStatus,
      customerId: a.customerId,
      prospectId: a.prospectId,
      customerNetsuiteId: null,   // filled in by loadReachReport
      kinds: [...a.kinds].sort(),
    }))
    .sort((x, y) => y.failures - x.failures || y.lastFailureAt.localeCompare(x.lastFailureAt));
}

export async function loadReachReport(service: Service, windowDays: number): Promise<ReachReport> {
  const from = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data } = await fetchAllRows<EmailRow>((lo, hi) =>
    service
      .from('email_log')
      .select('kind, recipients, delivery_status, created_at, customer_id, prospect_id, resolved_at')
      .gte('created_at', from)
      .order('created_at')
      .order('id')
      .range(lo, hi),
  );
  const rows = data || [];
  const unreachable = findUnreachable(rows);

  // Resolve the NetSuite id for each linked customer: /admin/prospects is
  // keyed on it (deepLinks.customerByNetsuiteId), and nothing routes on a
  // customers UUID — so without this the worklist's action would be a dead
  // link, which is the one thing a worklist must not have.
  const customerIds = [...new Set(unreachable.map(u => u.customerId).filter(Boolean) as string[])];
  if (customerIds.length > 0) {
    const byId = new Map<string, string>();
    for (let i = 0; i < customerIds.length; i += 200) {
      const { data: rows2 } = await service
        .from('customers')
        .select('id, netsuite_id')
        .in('id', customerIds.slice(i, i + 200));
      for (const c of rows2 || []) if (c.netsuite_id) byId.set(c.id, String(c.netsuite_id));
    }
    for (const u of unreachable) {
      if (u.customerId) u.customerNetsuiteId = byId.get(u.customerId) || null;
    }
  }

  return {
    windowDays,
    from,
    ...rollUp(rows),
    unreachable,
    caveats: [
      'Rates are over CONFIRMED outcomes only. A message still marked "sent" has had no delivery webhook — in flight, or a webhook that never arrived — and is counted as pending, never as delivered.',
      'One email to three people counts once in the totals and per-kind tables, and once per address in the domain table.',
      'A failure somebody marked resolved on System Health is excluded from the unreachable list — the contact was fixed.',
    ],
  };
}
