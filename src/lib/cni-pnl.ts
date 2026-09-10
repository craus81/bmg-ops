import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * CNI Job P&L (R6-8) — what a job actually made, on the console where the
 * coordinator is already standing.
 *
 * Three honesty rules, because a margin figure is the easiest number in the
 * app to quote and the easiest to get quietly wrong:
 *
 *  1. A VEHICLE WITH NO BILLED AMOUNT ON FILE IS NOT A VEHICLE THAT EARNED
 *     ZERO. It is a vehicle we have not billed or cannot see, and it is
 *     counted and named rather than folded into the total as a 0. Same for
 *     an unpriced install credit: the count is reported, never summed as
 *     nothing.
 *  2. MATERIALS AND SHIPPING ARE NOT COSTED AGAINST A CNI JOB anywhere in
 *     this app -- cni_jobs.material_delivered is a boolean, not an amount.
 *     So the margin here is BEFORE materials, and it says so. Quietly
 *     labelling revenue-minus-installer-cost as "margin" would overstate
 *     every job by the cost of the vinyl on it.
 *  3. PENDING AP IS NOT COMMITTED COST. An invoice still being recorded or
 *     submitted can change; only approved-and-beyond counts against budget,
 *     with the pending figure shown beside it so nobody is surprised later.
 */

export type PayoutMode = 'company' | 'individual';

export interface PnlInput {
  budget: number | null;
  payoutMode: PayoutMode;
  vinsTotal: number;
  vinsCompleted: number;
  revenue: {
    amount: number;
    /** Completed VINs that carried a billed amount. */
    vinsCounted: number;
    /** Completed VINs with no billed amount on file — unknown, not zero. */
    vinsMissing: number;
  };
  installerCost: {
    /** Approved and beyond: committed. */
    approved: number;
    /** Recorded or submitted: real, but not yet committed. */
    pending: number;
    /** Individual-mode credits with no rate priced yet. Counted, not summed. */
    unpricedCredits: number;
  };
}

export interface CniPnl extends PnlInput {
  /** Revenue − committed installer cost. BEFORE materials and shipping.
   *  Null when no revenue is known at all — there is nothing to subtract from. */
  marginBeforeMaterials: number | null;
  /** Null when revenue is zero: a percentage of nothing is not 0%. */
  marginPct: number | null;
  perVehicle: {
    revenue: number | null;
    installerCost: number | null;
    margin: number | null;
  };
  budgetPct: number | null;
  overBudget: boolean;
  /** Everything the figures above cannot see, in plain words. */
  caveats: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure. */
export function computePnl(input: PnlInput): CniPnl {
  const { revenue, installerCost, vinsCompleted, budget } = input;
  const knownRevenue = revenue.vinsCounted > 0;
  const margin = knownRevenue ? round2(revenue.amount - installerCost.approved) : null;
  const perVehicleRevenue = revenue.vinsCounted > 0 ? round2(revenue.amount / revenue.vinsCounted) : null;
  const perVehicleCost = vinsCompleted > 0 ? round2(installerCost.approved / vinsCompleted) : null;

  const caveats: string[] = [];
  if (revenue.vinsMissing > 0) {
    caveats.push(
      `${revenue.vinsMissing} completed vehicle${revenue.vinsMissing === 1 ? ' has' : 's have'} no billed amount on file, `
      + 'so revenue here is a floor, not a total.',
    );
  }
  if (installerCost.unpricedCredits > 0) {
    caveats.push(
      `${installerCost.unpricedCredits} pay credit${installerCost.unpricedCredits === 1 ? '' : 's'} `
      + 'have no rate set yet, so installer cost will rise once they are priced.',
    );
  }
  if (installerCost.pending > 0) {
    caveats.push(
      `$${installerCost.pending.toFixed(2)} of vendor invoices is recorded or submitted but not approved. `
      + 'It is not counted against margin or budget until it is.',
    );
  }
  caveats.push(
    'Materials and shipping are not costed against a CNI job anywhere in this app, so the real margin is lower than shown.',
  );

  return {
    ...input,
    marginBeforeMaterials: margin,
    marginPct: knownRevenue && revenue.amount !== 0 && margin != null
      ? Math.round((margin / revenue.amount) * 100)
      : null,
    perVehicle: {
      revenue: perVehicleRevenue,
      installerCost: perVehicleCost,
      margin: perVehicleRevenue != null && perVehicleCost != null
        ? round2(perVehicleRevenue - perVehicleCost)
        : null,
    },
    budgetPct: budget != null && budget > 0
      ? Math.round((installerCost.approved / budget) * 100)
      : null,
    // Only COMMITTED cost crosses a budget. A submitted invoice can still
    // change, and crying over-budget on one that later gets corrected is how
    // the alert stops being believed.
    overBudget: budget != null && budget > 0 && installerCost.approved > budget,
    caveats,
  };
}

/* ── loader ──────────────────────────────────────────────────────────── */

/** AP statuses that count as committed cost (migration 148's lifecycle). */
const COMMITTED_AP = ['approved', 'billed', 'paid'];
const PENDING_AP = ['recorded', 'submitted'];

const last8 = (vin: string | null | undefined) =>
  (vin || '').replace(/\s/g, '').toUpperCase().slice(-8);

export interface JobPnl extends CniPnl {
  jobId: string;
  jobNumber: string | null;
  budgetAlertedAt: string | null;
  /** The budget the alert was about. Differs from `budget` once someone has
   *  re-scoped the job, which is what re-arms the warning. */
  budgetAlertedAmount: number | null;
}

export async function loadJobPnl(service: SupabaseClient, jobId: string): Promise<JobPnl | null> {
  const { data: job } = await service
    .from('cni_jobs')
    .select('id, job_number, budget, payout_mode, assigned_company_id, budget_alerted_at, budget_alerted_amount')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return null;

  const { data: vins, error } = await fetchAllRows<any>((from, to) => service
    .from('cni_job_vins')
    .select('id, vin, status, scan_log_id')
    .eq('job_id', jobId)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const vinRows = vins || [];
  const completed = vinRows.filter(v => v.status === 'completed');

  // ── Revenue: the billed amount stamped on each vehicle's scan log. A
  // completed vehicle with no scan link, or a scan with no amount, is
  // UNKNOWN revenue and is counted as such.
  const scanIds = completed.map(v => v.scan_log_id).filter(Boolean) as string[];
  const amountByScan = new Map<string, number>();
  for (let i = 0; i < scanIds.length; i += 200) {
    const { data } = await service
      .from('scan_logs')
      .select('id, invoiced_amount')
      .in('id', scanIds.slice(i, i + 200));
    for (const s of data || []) {
      if (s.invoiced_amount != null) amountByScan.set(s.id, Number(s.invoiced_amount));
    }
  }
  let revenueAmount = 0;
  let vinsCounted = 0;
  for (const v of completed) {
    const amt = v.scan_log_id ? amountByScan.get(v.scan_log_id) : undefined;
    if (amt == null) continue;
    revenueAmount += amt;
    vinsCounted += 1;
  }

  // ── Installer cost, by payout mode.
  let approved = 0;
  let pending = 0;
  let unpricedCredits = 0;

  if (job.payout_mode === 'individual') {
    const vinIds = vinRows.map(v => v.id);
    for (let i = 0; i < vinIds.length; i += 200) {
      const { data } = await service
        .from('install_credits')
        .select('amount, voided_at')
        .in('cni_job_vin_id', vinIds.slice(i, i + 200));
      for (const c of data || []) {
        if (c.voided_at) continue;
        if (c.amount == null) { unpricedCredits += 1; continue; }
        approved += Number(c.amount);
      }
    }
  } else if (job.assigned_company_id) {
    // Company mode: vendor invoice lines reach the job by scan id OR by VIN
    // last-8 (the AP matcher can create a new scan row when part spellings
    // differ). The last-8 fallback is scoped to the assigned company —
    // unscoped it would claim cost from unrelated invoices, the same trap
    // the billing-coverage route documents.
    const wantScans = new Set(scanIds);
    const wantLast8 = new Set(vinRows.map(v => last8(v.vin)).filter(Boolean));

    const { data: invoices } = await service
      .from('vendor_invoices')
      .select('id, status')
      .eq('company_id', job.assigned_company_id);
    const statusById = new Map((invoices || []).map((i: any) => [i.id, i.status as string]));
    const invoiceIds = [...statusById.keys()];

    for (let i = 0; i < invoiceIds.length; i += 200) {
      const { data: lines } = await fetchAllRows<any>((from, to) => service
        .from('vendor_invoice_lines')
        .select('vendor_invoice_id, scan_log_id, vin, amount')
        .in('vendor_invoice_id', invoiceIds.slice(i, i + 200))
        .order('id')
        .range(from, to));
      for (const l of lines || []) {
        const belongs = (l.scan_log_id && wantScans.has(l.scan_log_id)) || wantLast8.has(last8(l.vin));
        if (!belongs || l.amount == null) continue;
        const status = statusById.get(l.vendor_invoice_id) || '';
        if (COMMITTED_AP.includes(status)) approved += Number(l.amount);
        else if (PENDING_AP.includes(status)) pending += Number(l.amount);
      }
    }
  }

  const pnl = computePnl({
    budget: job.budget != null ? Number(job.budget) : null,
    payoutMode: (job.payout_mode as PayoutMode) || 'company',
    vinsTotal: vinRows.length,
    vinsCompleted: completed.length,
    revenue: {
      amount: round2(revenueAmount),
      vinsCounted,
      vinsMissing: completed.length - vinsCounted,
    },
    installerCost: { approved: round2(approved), pending: round2(pending), unpricedCredits },
  });

  return {
    ...pnl,
    jobId: job.id,
    jobNumber: job.job_number || null,
    budgetAlertedAt: job.budget_alerted_at || null,
    budgetAlertedAmount: job.budget_alerted_amount != null ? Number(job.budget_alerted_amount) : null,
  };
}

/* ── the budget-crossing alert (sweep pass 3) ────────────────────────── */

export interface BudgetSweepResult {
  jobsChecked: number;
  alerted: number;
  errors: string[];
}

export interface BudgetSweepDeps {
  notify: (userIds: string[], payload: { type: string; title: string; body: string; url: string }) => Promise<void>;
  staffIds: () => Promise<string[]>;
  adminJobUrl: (jobId: string) => string;
}

/** Statuses where cost is still accruing and a warning can change something.
 *  A closed job is a post-mortem, not an alert. */
const LIVE_STATUSES = [
  'assigned_awaiting_scheduling', 'scheduling_proposed', 'scheduled_pending_confirmation',
  'scheduled_confirmed', 'in_progress', 'completed_pending_review',
];

/**
 * Tell the coordinator the moment committed installer cost crosses a job's
 * budget — mid-job, while there is still something to do about it. Once per
 * job: a job that goes over stays over, and re-alerting daily on a fact
 * everybody knows is how the alert gets muted.
 */
export async function sweepBudgetCrossings(
  service: SupabaseClient,
  deps: BudgetSweepDeps,
  now = new Date().toISOString(),
): Promise<BudgetSweepResult> {
  const { data: allJobs, error } = await fetchAllRows<any>((from, to) => service
    .from('cni_jobs')
    .select('id, job_number, title, budget, budget_alerted_at, budget_alerted_amount, status')
    .in('status', LIVE_STATUSES)
    .not('budget', 'is', null)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  // Quiet only while the alert we already sent was about the CURRENT budget.
  // Raising the budget re-arms the warning with no flag to clear by hand.
  const jobs = (allJobs || []).filter(j =>
    j.budget_alerted_at == null
    || j.budget_alerted_amount == null
    || Number(j.budget_alerted_amount) !== Number(j.budget));

  const result: BudgetSweepResult = { jobsChecked: jobs.length, alerted: 0, errors: [] };
  if (result.jobsChecked === 0) return result;

  const staff = await deps.staffIds().catch(() => [] as string[]);
  for (const j of jobs) {
    let pnl: JobPnl | null = null;
    try {
      pnl = await loadJobPnl(service, j.id);
    } catch (e: any) {
      result.errors.push(`${j.job_number || j.id}: ${e?.message || e}`);
      continue;
    }
    if (!pnl || !pnl.overBudget) continue;

    const { error: stampErr } = await service
      .from('cni_jobs')
      .update({ budget_alerted_at: now, budget_alerted_amount: pnl.budget })
      .eq('id', j.id);
    if (stampErr) { result.errors.push(`${j.job_number || j.id}: ${stampErr.message}`); continue; }

    if (staff.length > 0) {
      const over = round2(pnl.installerCost.approved - (pnl.budget || 0));
      await deps.notify(staff, {
        type: 'cni_budget',
        title: `${j.job_number || j.title || 'A CNI job'} is over budget`,
        body: `Approved installer cost is $${pnl.installerCost.approved.toFixed(2)} against a $${(pnl.budget || 0).toFixed(2)} budget — $${over.toFixed(2)} over, with ${pnl.vinsCompleted} of ${pnl.vinsTotal} vehicles done.`
          + (pnl.installerCost.pending > 0 ? ` A further $${pnl.installerCost.pending.toFixed(2)} is submitted but not yet approved.` : '')
          + ' Materials and shipping are not in that figure.',
        url: deps.adminJobUrl(j.id),
      }).catch((e: any) => result.errors.push(`${j.job_number || j.id} notify: ${e?.message || e}`));
    }
    result.alerted += 1;
  }
  return result;
}
