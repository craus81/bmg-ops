/**
 * Server half of "Brief me" (R6-13): the reads that fill BriefFacts.
 *
 * Split from customer-brief.ts so the shapes and the deterministic
 * rendering stay importable (and unit-testable) without dragging NetSuite
 * and the service-role client along.
 *
 * Every section is gathered in its own try/catch and every one of them can
 * come back `unknown`. Two distinct reasons produce that:
 *
 *   · the query FAILED — NetSuite down, a Supabase error;
 *   · the record ISN'T LINKED — a CRM lead with no synced customer row has
 *     no id to scope vehicles, threads or A/R by.
 *
 * Neither is "zero". Scoping by company NAME would paper over the second
 * one and is exactly how one customer's invoices end up in another's brief,
 * so it is never done: no id, no section.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchOpenArInvoices } from '@/lib/financials-data';
/**
 * "We still have the vehicle" — the SAME list the on-time scorecard and the
 * shop counts use, not a second copy. A brief that disagreed with the board
 * about which vehicles are in the shop would be worse than no brief.
 */
import { OPEN_STATUSES as IN_SHOP_STATUSES } from '@/lib/on-time';
import {
  ageInDays, daysUntil, EMAIL_WINDOW_DAYS, MAX_LISTED, RECENT_ACTIVITY_LIMIT,
  type BriefFacts, type BriefEstimate, type BriefInvoice, type BriefVehicle, type BriefActivity,
} from '@/lib/customer-brief';

const FAILED_DELIVERY = ['bounced', 'complained', 'failed'];

export interface BriefTarget {
  /** prospects.id — the CRM record. */
  prospectId?: string | null;
  /** customers.netsuite_id — the NetSuite internal id of the synced account. */
  netsuiteId?: string | null;
}

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const errText = (e: any): string => {
  const m = e?.message || e?.error?.message || String(e || '');
  return m.length > 160 ? m.slice(0, 157) + '…' : m || 'the query failed';
};

/**
 * Gather everything for one customer. `includeAr` is the caller's financial
 * access, resolved by the route — never by this function and never by the
 * client. Without it the A/R section is `skipped`, which the brief omits
 * entirely rather than reporting as clean.
 */
export async function gatherBriefFacts(
  service: SupabaseClient<any, any, any>,
  target: BriefTarget,
  opts: { includeAr: boolean; now?: number },
): Promise<BriefFacts | null> {
  const now = opts.now ?? Date.now();

  // ── Resolve the two identities ────────────────────────────────────────
  let prospect: any = null;
  if (target.prospectId) {
    const { data } = await service
      .from('prospects')
      .select('id, company_name, contact_name, email, phone, netsuite_id')
      .eq('id', target.prospectId)
      .maybeSingle();
    prospect = data || null;
  }

  // A NetSuite internal id is digits. Enforced here, not just at the route:
  // this value goes into a PostgREST .or() filter, where a stray comma or
  // paren from a bad DB value would silently widen the match to rows that
  // are not this customer's — the sort of thing that puts one company's
  // estimate in another's brief. Anything else reads as "not linked".
  const nsRaw = String(target.netsuiteId || prospect?.netsuite_id || '').trim();
  const nsId = /^\d{1,15}$/.test(nsRaw) ? nsRaw : null;

  let customer: any = null;
  if (nsId) {
    const { data } = await service
      .from('customers')
      .select('id, company_name, email, phone, netsuite_id, entity_id, last_year_spend, ytd_spend, last_order_date')
      .eq('netsuite_id', nsId)
      .maybeSingle();
    customer = data || null;
  }

  if (!prospect && !customer) return null;

  const name = prospect?.company_name || customer?.company_name || 'Unnamed customer';
  const custId: string | null = customer?.id || null;
  const pid: string | null = prospect?.id || null;

  const facts: BriefFacts = {
    customer: {
      name,
      prospectId: pid,
      customerId: custId,
      netsuiteId: nsId,
      entityId: customer?.entity_id || null,
      email: prospect?.email || customer?.email || null,
      phone: prospect?.phone || customer?.phone || null,
    },
    estimates: { status: 'ok', open: [] },
    ar: { status: 'skipped', openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] },
    vehicles: { status: 'ok', inShop: [] },
    emails: { status: 'ok', sent90: null, failed90: null, lastFailure: null },
    threads: { status: 'ok', open: null, unread: null, lastInboundAt: null },
    activities: { status: 'ok', recent: [] },
    spend: { status: 'ok', lastYear: null, ytd: null, lastOrderDate: null },
    generatedAt: new Date(now).toISOString(),
  };

  const NO_LINK = 'this record has no synced NetSuite customer to match against';

  // ── Open estimates ────────────────────────────────────────────────────
  try {
    // Any of the three links an estimate can carry. Built from present ids
    // only — an .or() with an empty value matches far more than intended.
    const ors: string[] = [];
    if (custId) ors.push(`customer_id.eq.${custId}`);
    if (pid) ors.push(`prospect_id.eq.${pid}`);
    if (nsId) ors.push(`customer_netsuite_id.eq.${nsId}`);
    if (ors.length === 0) {
      facts.estimates = { status: 'unknown', reason: NO_LINK, open: [] };
    } else {
      const { data, error } = await service
        .from('estimates')
        .select('id, estimate_number, netsuite_estimate_number, title, status, grand_total, expiration_date, created_at')
        .or(ors.join(','))
        .in('status', ['draft', 'sent'])
        .order('created_at', { ascending: false })
        .limit(MAX_LISTED * 3);
      if (error) throw error;
      facts.estimates.open = (data || []).map((e: any): BriefEstimate => ({
        number: e.netsuite_estimate_number || e.estimate_number || '(no number)',
        title: e.title || null,
        status: e.status,
        ageDays: ageInDays(e.created_at, now) ?? 0,
        total: num(e.grand_total),
        expiresInDays: daysUntil(e.expiration_date, now),
      }));
    }
  } catch (e) {
    facts.estimates = { status: 'unknown', reason: errText(e), open: [] };
  }

  // ── A/R (NetSuite) ────────────────────────────────────────────────────
  if (opts.includeAr) {
    if (!nsId) {
      facts.ar = { status: 'unknown', reason: NO_LINK, openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] };
    } else {
      try {
        const { invoices } = await fetchOpenArInvoices(nsId);
        const openTotal = invoices.reduce((s, i) => s + (i.unpaid || 0), 0);
        const pastDue = invoices.filter(i => i.daysPastDue > 0).reduce((s, i) => s + (i.unpaid || 0), 0);
        const oldest = invoices.reduce((m, i) => Math.max(m, i.daysPastDue || 0), 0);
        facts.ar = {
          status: 'ok',
          openTotal: Math.round(openTotal * 100) / 100,
          pastDue: Math.round(pastDue * 100) / 100,
          oldestDaysPastDue: oldest,
          invoices: invoices
            .filter(i => i.daysPastDue > 0)
            .sort((a, b) => b.daysPastDue - a.daysPastDue)
            .slice(0, MAX_LISTED)
            .map((i): BriefInvoice => ({ number: i.tranid, unpaid: i.unpaid, daysPastDue: i.daysPastDue })),
        };
      } catch (e) {
        facts.ar = { status: 'unknown', reason: errText(e), openTotal: null, pastDue: null, oldestDaysPastDue: null, invoices: [] };
      }
    }
  }

  // ── Vehicles in the shop ──────────────────────────────────────────────
  try {
    if (!custId) {
      facts.vehicles = { status: 'unknown', reason: NO_LINK, inShop: [] };
    } else {
      const { data, error } = await service
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, promised_back_date, created_at')
        .eq('customer_id', custId)
        .in('status', IN_SHOP_STATUSES)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(MAX_LISTED * 3);
      if (error) throw error;
      facts.vehicles.inShop = (data || []).map((v: any): BriefVehicle => {
        const until = daysUntil(v.promised_back_date, now);
        return {
          vin: v.vin || '',
          description: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' '),
          stage: v.status || 'unknown',
          promisedBack: v.promised_back_date || null,
          daysOverdue: until != null && until < 0 ? -until : null,
        };
      });
    }
  } catch (e) {
    facts.vehicles = { status: 'unknown', reason: errText(e), inShop: [] };
  }

  // ── Email delivery ────────────────────────────────────────────────────
  try {
    const ors: string[] = [];
    if (custId) ors.push(`customer_id.eq.${custId}`);
    if (pid) ors.push(`prospect_id.eq.${pid}`);
    if (ors.length === 0) {
      facts.emails = { status: 'unknown', reason: NO_LINK, sent90: null, failed90: null, lastFailure: null };
    } else {
      const since = new Date(now - EMAIL_WINDOW_DAYS * 86_400_000).toISOString();
      const { data, error } = await service
        .from('email_log')
        .select('id, recipients, delivery_status, created_at')
        .or(ors.join(','))
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const rows = data || [];
      const failures = rows.filter((r: any) => FAILED_DELIVERY.includes(r.delivery_status));
      const last = failures[0];
      facts.emails = {
        status: 'ok',
        sent90: rows.length,
        failed90: failures.length,
        lastFailure: last
          ? { to: (last.recipients || [])[0] || '(unknown address)', status: last.delivery_status, at: last.created_at }
          : null,
      };
    }
  } catch (e) {
    facts.emails = { status: 'unknown', reason: errText(e), sent90: null, failed90: null, lastFailure: null };
  }

  // ── Open threads ──────────────────────────────────────────────────────
  try {
    if (!custId) {
      facts.threads = { status: 'unknown', reason: NO_LINK, open: null, unread: null, lastInboundAt: null };
    } else {
      const { data, error } = await service
        .from('customer_threads')
        .select('id, unread_count, last_inbound_at')
        .eq('customer_id', custId)
        .eq('status', 'open')
        .order('last_inbound_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      const rows = data || [];
      facts.threads = {
        status: 'ok',
        open: rows.length,
        unread: rows.reduce((s: number, t: any) => s + (Number(t.unread_count) || 0), 0),
        lastInboundAt: rows.find((t: any) => t.last_inbound_at)?.last_inbound_at || null,
      };
    }
  } catch (e) {
    facts.threads = { status: 'unknown', reason: errText(e), open: null, unread: null, lastInboundAt: null };
  }

  // ── Recent activity ───────────────────────────────────────────────────
  try {
    if (!pid) {
      // Not a failure: a NetSuite-only account has no CRM timeline to read.
      facts.activities = { status: 'unknown', reason: 'no CRM record is linked, so there is no activity timeline', recent: [] };
    } else {
      const { data, error } = await service
        .from('prospect_activities')
        .select('type, summary, created_at')
        .eq('prospect_id', pid)
        .order('created_at', { ascending: false })
        .limit(RECENT_ACTIVITY_LIMIT);
      if (error) throw error;
      facts.activities.recent = (data || []).map((a: any): BriefActivity => ({
        type: a.type,
        summary: a.summary || '',
        at: a.created_at,
      }));
    }
  } catch (e) {
    facts.activities = { status: 'unknown', reason: errText(e), recent: [] };
  }

  // ── Spend (already synced onto customers) ─────────────────────────────
  if (!customer) {
    facts.spend = { status: 'unknown', reason: NO_LINK, lastYear: null, ytd: null, lastOrderDate: null };
  } else {
    facts.spend = {
      status: 'ok',
      lastYear: num(customer.last_year_spend),
      ytd: num(customer.ytd_spend),
      lastOrderDate: customer.last_order_date || null,
    };
  }

  return facts;
}
