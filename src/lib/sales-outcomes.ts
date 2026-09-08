import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Win/Loss funnel & quote outcomes (R5-9): the read side of forensics the
 * app already forces reps and customers to record — lead_source on every
 * prospect, structured lost reasons on deals (m263), the customer's own
 * rejection words on estimates/proofs (m082/m084), reminder counts
 * (m244/m154), and the approval channel. Extends the sales-performance
 * report (never forks it): these loaders ride the same route + page.
 *
 * Reminder effectiveness is derivable ONLY from approval_reminder_count as
 * it stands at decision time — there is no per-reminder event log. The
 * reminder crons stop nudging once a record is decided, so for decided
 * rows the count IS the at-decision value. Estimates + graphics proofs
 * only; wrap quotes have no reminder columns at all and are excluded.
 */

// ── Outcomes: sent → approved/rejected/pending, identical columns for
//    estimates and graphics proofs ──

export interface OutcomeRow {
  sentAt: string;
  outcome: 'approved' | 'rejected' | 'pending';
  /** When the decision landed; null for pending or legacy rows missing the stamp. */
  decidedAt: string | null;
  /** approval_reminder_count at decision (see header note). */
  reminders: number;
  channel: string | null; // email_link | sms_link
}

export interface OutcomeSummary {
  sent: number;
  approved: number;
  rejected: number;
  pending: number;
  medianDaysToDecision: number | null;
  /** Among approvals: how many landed with 0 / 1 / 2 / 3+ reminders sent —
   *  the direct evidence on the hard-coded 3-day/max-3 cadence. */
  remindersAtApproval: { none: number; one: number; two: number; threePlus: number };
  /** Among approvals with a recorded channel. */
  channels: { email: number; sms: number };
}

export function summarizeOutcomes(rows: OutcomeRow[]): OutcomeSummary {
  const approvedRows = rows.filter(r => r.outcome === 'approved');
  const decisionDays = rows
    .filter(r => r.outcome !== 'pending' && r.decidedAt)
    .map(r => (new Date(r.decidedAt!).getTime() - new Date(r.sentAt).getTime()) / 86_400_000)
    .filter(d => d >= 0)
    .sort((a, b) => a - b);
  const mid = Math.floor(decisionDays.length / 2);
  const median = decisionDays.length === 0 ? null
    : decisionDays.length % 2 ? decisionDays[mid] : (decisionDays[mid - 1] + decisionDays[mid]) / 2;

  const reminders = { none: 0, one: 0, two: 0, threePlus: 0 };
  for (const r of approvedRows) {
    if (r.reminders <= 0) reminders.none++;
    else if (r.reminders === 1) reminders.one++;
    else if (r.reminders === 2) reminders.two++;
    else reminders.threePlus++;
  }

  return {
    sent: rows.length,
    approved: approvedRows.length,
    rejected: rows.filter(r => r.outcome === 'rejected').length,
    pending: rows.filter(r => r.outcome === 'pending').length,
    medianDaysToDecision: median == null ? null : Math.round(median * 10) / 10,
    remindersAtApproval: reminders,
    channels: {
      email: approvedRows.filter(r => r.channel === 'email_link').length,
      sms: approvedRows.filter(r => r.channel === 'sms_link').length,
    },
  };
}

/** Approval precedence: an approved record is approved even if an earlier
 *  rejection exists (the revise-and-resend flow ends in approval). */
export async function loadOutcomeRows(
  service: SupabaseClient,
  start: string,
  endNext: string,
): Promise<{ estimates: OutcomeRow[]; proofs: OutcomeRow[] }> {
  const [estRes, proofRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('estimates')
      .select('sent_for_approval_at, status, customer_approved_at, customer_rejected_at, approval_reminder_count, customer_approved_via')
      .gte('sent_for_approval_at', start)
      .lt('sent_for_approval_at', endNext)
      .order('sent_for_approval_at').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('graphics_jobs')
      .select('sent_for_approval_at, customer_approved, customer_approved_at, customer_rejected_at, approval_reminder_count, customer_approved_via')
      .gte('sent_for_approval_at', start)
      .lt('sent_for_approval_at', endNext)
      .order('sent_for_approval_at').order('id')
      .range(from, to)),
  ]);
  if (estRes.error) throw new Error('outcomes estimates: ' + estRes.error.message);
  if (proofRes.error) throw new Error('outcomes proofs: ' + proofRes.error.message);

  const estimates: OutcomeRow[] = (estRes.data || []).map((e: any) => {
    const approved = !!e.customer_approved_at || e.status === 'accepted';
    const rejected = !approved && !!e.customer_rejected_at;
    return {
      sentAt: e.sent_for_approval_at,
      outcome: approved ? 'approved' as const : rejected ? 'rejected' as const : 'pending' as const,
      decidedAt: approved ? e.customer_approved_at : rejected ? e.customer_rejected_at : null,
      reminders: Number(e.approval_reminder_count) || 0,
      channel: e.customer_approved_via || null,
    };
  });
  const proofs: OutcomeRow[] = (proofRes.data || []).map((j: any) => {
    const approved = j.customer_approved === true;
    const rejected = !approved && !!j.customer_rejected_at;
    return {
      sentAt: j.sent_for_approval_at,
      outcome: approved ? 'approved' as const : rejected ? 'rejected' as const : 'pending' as const,
      decidedAt: approved ? j.customer_approved_at : rejected ? j.customer_rejected_at : null,
      reminders: Number(j.approval_reminder_count) || 0,
      channel: j.customer_approved_via || null,
    };
  });
  return { estimates, proofs };
}

// ── Funnel: leads created → quoted → won/lost, by lead source ──

/** Bucket the free-text lead_source (m059): trimmed/lowercased; 'other'
 *  resolves to the rep's written lead_source_other; blank → not recorded. */
export function normalizeLeadSource(source: string | null, other: string | null): string {
  const s = (source || '').trim().toLowerCase();
  if (!s) return '(not recorded)';
  if (s === 'other') {
    const o = (other || '').trim().toLowerCase();
    return o ? o : 'other';
  }
  return s;
}

export interface FunnelBucket {
  source: string;
  leads: number;
  /** Leads that got at least one deal. */
  withDeal: number;
  /** Leads with a deal that moved past 'lead' stage. */
  quoted: number;
  won: number;
  lost: number;
  wonValue: number;
  /** won ÷ leads — the "is the Chamber membership paying for itself" number. */
  conversion: number | null;
  avgDealSize: number | null;
}

export interface LeadFunnel {
  totals: Omit<FunnelBucket, 'source'>;
  bySource: FunnelBucket[]; // most leads first
  /** Deal-grain per rep for deals CREATED in the range. */
  byRep: { repId: string; deals: number; value: number; won: number; wonValue: number; lost: number }[];
}

interface ProspectFacts { withDeal: boolean; quoted: boolean; won: boolean; lost: boolean; wonValue: number; wonDeals: number }

function emptyBucket(): Omit<FunnelBucket, 'source'> & { wonDeals: number } {
  return { leads: 0, withDeal: 0, quoted: 0, won: 0, lost: 0, wonValue: 0, conversion: null, avgDealSize: null, wonDeals: 0 };
}

function finishBucket<T extends ReturnType<typeof emptyBucket>>(b: T): T {
  b.conversion = b.leads > 0 ? Math.round((b.won / b.leads) * 100) / 100 : null;
  b.avgDealSize = b.wonDeals > 0 ? Math.round(b.wonValue / b.wonDeals) : null;
  return b;
}

/** Cohort funnel: prospects CREATED in [start, endNext) followed to wherever
 *  their deals stand today. */
export async function loadLeadFunnel(
  service: SupabaseClient,
  start: string,
  endNext: string,
): Promise<LeadFunnel> {
  const { data: prospects, error: pErr } = await fetchAllRows<any>((from, to) => service
    .from('prospects')
    .select('id, lead_source, lead_source_other')
    .gte('created_at', start)
    .lt('created_at', endNext)
    .order('created_at').order('id')
    .range(from, to));
  if (pErr) throw new Error('funnel prospects: ' + pErr.message);

  const cohort = prospects || [];
  const factsById = new Map<string, ProspectFacts>();
  const ids = cohort.map((p: any) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: opps, error: oErr } = await service
      .from('prospect_opportunities')
      .select('prospect_id, stage, value')
      .in('prospect_id', ids.slice(i, i + 200));
    if (oErr) throw new Error('funnel deals: ' + oErr.message);
    for (const o of opps || []) {
      let f = factsById.get(o.prospect_id);
      if (!f) { f = { withDeal: false, quoted: false, won: false, lost: false, wonValue: 0, wonDeals: 0 }; factsById.set(o.prospect_id, f); }
      f.withDeal = true;
      if (o.stage !== 'lead') f.quoted = true;
      if (o.stage === 'won') { f.won = true; f.wonValue += Number(o.value) || 0; f.wonDeals++; }
      if (o.stage === 'lost') f.lost = true;
    }
  }

  const totals = emptyBucket();
  const bySource = new Map<string, ReturnType<typeof emptyBucket>>();
  for (const p of cohort) {
    const source = normalizeLeadSource(p.lead_source, p.lead_source_other);
    let bucket = bySource.get(source);
    if (!bucket) { bucket = emptyBucket(); bySource.set(source, bucket); }
    const f = factsById.get(p.id);
    for (const b of [totals, bucket]) {
      b.leads++;
      if (f?.withDeal) b.withDeal++;
      if (f?.quoted) b.quoted++;
      if (f?.won) { b.won++; b.wonValue += f.wonValue; b.wonDeals += f.wonDeals; }
      else if (f?.lost) b.lost++;
    }
  }

  // Deal-grain per rep: deals created in the range, wherever they stand now.
  const { data: rangeDeals, error: dErr } = await fetchAllRows<any>((from, to) => service
    .from('prospect_opportunities')
    .select('created_by, stage, value')
    .gte('created_at', start)
    .lt('created_at', endNext)
    .order('created_at').order('id')
    .range(from, to));
  if (dErr) throw new Error('funnel rep deals: ' + dErr.message);
  const byRep = new Map<string, { deals: number; value: number; won: number; wonValue: number; lost: number }>();
  for (const d of rangeDeals || []) {
    const key = d.created_by || 'unassigned';
    let r = byRep.get(key);
    if (!r) { r = { deals: 0, value: 0, won: 0, wonValue: 0, lost: 0 }; byRep.set(key, r); }
    r.deals++;
    r.value += Number(d.value) || 0;
    if (d.stage === 'won') { r.won++; r.wonValue += Number(d.value) || 0; }
    if (d.stage === 'lost') r.lost++;
  }

  const strip = (b: ReturnType<typeof emptyBucket>): Omit<FunnelBucket, 'source'> => ({
    leads: b.leads, withDeal: b.withDeal, quoted: b.quoted, won: b.won, lost: b.lost,
    wonValue: b.wonValue, conversion: b.conversion, avgDealSize: b.avgDealSize,
  });
  return {
    totals: strip(finishBucket(totals)),
    bySource: [...bySource.entries()]
      .map(([source, b]) => ({ source, ...strip(finishBucket(b)) }))
      .sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source)),
    byRep: [...byRep.entries()]
      .map(([repId, r]) => ({ repId, ...r }))
      .sort((a, b) => b.value - a.value),
  };
}

// ── Lost reasons: structured deal reasons + the customer's own words ──

export interface LostDealRow {
  id: string;
  prospectId: string;
  title: string;
  customer: string;
  value: number;
  reason: string | null;
  note: string | null;
  at: string | null;
}

export interface RejectedQuoteRow {
  kind: 'estimate' | 'wrap';
  id: string;
  number: string;
  customer: string;
  total: number;
  /** The customer's own written rejection words. */
  reason: string | null;
  at: string;
}

export interface LostReasons {
  reasonCounts: { reason: string; count: number; value: number }[];
  deals: LostDealRow[];
  rejections: RejectedQuoteRow[];
}

export async function loadLostReasons(
  service: SupabaseClient,
  start: string,
  endNext: string,
): Promise<LostReasons> {
  const [dealRes, estRes, wrapRes] = await Promise.all([
    // closed_at is stamped on won/lost since R3-18; legacy lost rows without
    // it fall back to their updated_at for windowing.
    fetchAllRows<any>((from, to) => service
      .from('prospect_opportunities')
      .select('id, prospect_id, title, value, lost_reason, lost_note, closed_at, updated_at, prospects(company_name)')
      .eq('stage', 'lost')
      .or(`and(closed_at.gte.${start},closed_at.lt.${endNext}),and(closed_at.is.null,updated_at.gte.${start},updated_at.lt.${endNext})`)
      .order('updated_at').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('estimates')
      .select('id, estimate_number, customer_name, grand_total, customer_rejection_reason, customer_rejected_at')
      .gte('customer_rejected_at', start)
      .lt('customer_rejected_at', endNext)
      .order('customer_rejected_at').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('wrap_quotes')
      .select('id, quote_number, customer, total, customer_rejection_reason, rejected_at')
      .gte('rejected_at', start)
      .lt('rejected_at', endNext)
      .order('rejected_at').order('id')
      .range(from, to)),
  ]);
  if (dealRes.error) throw new Error('lost deals: ' + dealRes.error.message);
  if (estRes.error) throw new Error('lost estimates: ' + estRes.error.message);
  if (wrapRes.error) throw new Error('lost wraps: ' + wrapRes.error.message);

  const deals: LostDealRow[] = (dealRes.data || []).map((d: any) => ({
    id: d.id,
    prospectId: d.prospect_id,
    title: d.title || 'Untitled deal',
    customer: d.prospects?.company_name || '—',
    value: Number(d.value) || 0,
    reason: d.lost_reason,
    note: d.lost_note,
    at: d.closed_at || d.updated_at,
  }));

  const counts = new Map<string, { count: number; value: number }>();
  for (const d of deals) {
    const key = d.reason || '(no reason recorded)';
    const c = counts.get(key) || { count: 0, value: 0 };
    c.count++;
    c.value += d.value;
    counts.set(key, c);
  }

  const rejections: RejectedQuoteRow[] = [
    ...(estRes.data || []).map((e: any) => ({
      kind: 'estimate' as const,
      id: e.id,
      number: e.estimate_number || '—',
      customer: e.customer_name || '—',
      total: Number(e.grand_total) || 0,
      reason: e.customer_rejection_reason,
      at: e.customer_rejected_at,
    })),
    ...(wrapRes.data || []).map((w: any) => ({
      kind: 'wrap' as const,
      id: w.id,
      number: w.quote_number || '—',
      customer: (w.customer as any)?.name || '—',
      total: Number(w.total) || 0,
      reason: w.customer_rejection_reason,
      at: w.rejected_at,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    reasonCounts: [...counts.entries()]
      .map(([reason, c]) => ({ reason, ...c }))
      .sort((a, b) => b.count - a.count || b.value - a.value),
    deals: deals.sort((a, b) => (b.at || '').localeCompare(a.at || '')),
    rejections,
  };
}
