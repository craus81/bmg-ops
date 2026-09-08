import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { findLocation, createVendorBill } from '@/lib/netsuite';
import { logAudit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { fetchAllRows } from '@/lib/fetch-all';

/**
 * Tell the installer when their payout advances. The CNI lifecycle was a
 * near-total notification vacuum — installers discovered "Approved / Billed /
 * Paid" only by opening /earnings themselves. Fires in-app + push (the default
 * for this type), deep-linked to their earnings page. Non-fatal.
 */
async function notifyPayoutInstaller(
  payout: { profile_id: string; cni_job_id: string | null; total_amount: number | null; period_start?: string | null; period_end?: string | null },
  toStatus: 'approved' | 'billed' | 'paid',
) {
  try {
    let jobRef = '';
    if (payout.cni_job_id) {
      const { data: job } = await service
        .from('cni_jobs').select('job_number').eq('id', payout.cni_job_id).maybeSingle();
      if (job?.job_number) jobRef = ` for ${job.job_number}`;
    } else if (payout.period_start) {
      jobRef = ` for the ${payout.period_start} – ${payout.period_end || '?'} pay period`;
    }
    const money = payout.total_amount != null ? ` ($${Number(payout.total_amount).toFixed(2)})` : '';
    const copy = {
      approved: { title: 'Payout approved', body: `Your installer payout${jobRef}${money} was approved and is being processed.` },
      billed: { title: 'Payout billed', body: `Your installer payout${jobRef}${money} has been billed — payment is on the way.` },
      paid: { title: 'Payout paid', body: `Your installer payout${jobRef}${money} has been marked paid.` },
    }[toStatus];
    await notify({
      userId: payout.profile_id,
      type: 'cni_payout',
      title: copy.title,
      body: copy.body,
      url: deepLinks.earnings(),
    });
  } catch (e) {
    console.error('payout installer notification failed:', e);
  }
}

// NetSuite internal ids are used directly: this integration's role can't
// query the `account` / `subsidiary` tables via SuiteQL ("Record 'account'
// was not found"), only `location`. Internal ids (not the GL account NUMBER)
// are what the REST Record API needs anyway. Env vars override.
// "Subcontractors" GL account (#53000) → internal id 223.
const SUBCONTRACTOR_ACCT_ID = process.env.NETSUITE_SUBCONTRACTOR_ACCOUNT_ID || '223';
// "BMG Fleet Installations" subsidiary → internal id 2. NetSuite requires it
// on the bill (it does NOT derive it from the vendor here — the manual UI form
// lists subsidiary as required).
const BILL_SUBSIDIARY_ID = process.env.NETSUITE_SUBSIDIARY_ID || '2';
// Locations the admin can post a bill to (resolved by name — that lookup works).
const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'] as const;

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type JobCredit = {
  id: string; profile_id: string; vin: string | null; amount: number | null;
  share_weight: number; crew_size: number; payout_id: string | null; created_at: string;
};

/**
 * All live credits on a job (via its VINs), split into linked/unlinked.
 * Paginated past the 1000-row cap and chunked so a big job's VIN list never
 * overflows a single .in(); a partial read here would generate payouts that
 * pay people short, so callers get the error and MUST fail closed.
 */
async function jobCredits(cniJobId: string): Promise<{ data: JobCredit[]; error: { message: string } | null }> {
  const { data: vins, error: vinErr } = await fetchAllRows<{ id: string }>((from, to) => service
    .from('cni_job_vins').select('id').eq('job_id', cniJobId).order('id').range(from, to));
  if (vinErr) return { data: [], error: vinErr };
  const all: JobCredit[] = [];
  for (let i = 0; i < vins.length; i += 200) {
    const { data, error } = await fetchAllRows<JobCredit>((from, to) => service
      .from('install_credits')
      .select('id, profile_id, vin, amount, share_weight, crew_size, payout_id, created_at')
      .in('cni_job_vin_id', vins.slice(i, i + 200).map(v => v.id))
      .is('voided_at', null)
      .order('created_at')
      .order('id')
      .range(from, to));
    if (error) return { data: all, error };
    all.push(...data);
  }
  return { data: all, error: null };
}

/** Per-job totals for a cni_period payout's linked credits (memo breakdown). */
async function periodJobBreakdown(payoutId: string): Promise<{ jobNumber: string; total: number }[]> {
  const { data: credits } = await fetchAllRows<{ amount: number | null; cni_job_vin_id: string | null }>((from, to) => service
    .from('install_credits')
    .select('amount, cni_job_vin_id')
    .eq('payout_id', payoutId)
    .order('id').range(from, to));
  const vinIds = [...new Set((credits || []).map(c => c.cni_job_vin_id).filter(Boolean))] as string[];
  const jobByVin = new Map<string, string>();
  for (let i = 0; i < vinIds.length; i += 200) {
    const { data } = await service.from('cni_job_vins').select('id, job_id').in('id', vinIds.slice(i, i + 200));
    for (const v of data || []) jobByVin.set(v.id, v.job_id);
  }
  const jobIds = [...new Set([...jobByVin.values()])];
  const numberByJob = new Map<string, string>();
  for (let i = 0; i < jobIds.length; i += 200) {
    const { data } = await service.from('cni_jobs').select('id, job_number').in('id', jobIds.slice(i, i + 200));
    for (const j of data || []) numberByJob.set(j.id, j.job_number || j.id.slice(0, 8));
  }
  const totals = new Map<string, number>();
  for (const c of credits || []) {
    const jobId = c.cni_job_vin_id ? jobByVin.get(c.cni_job_vin_id) : undefined;
    const label = (jobId && numberByJob.get(jobId)) || 'other';
    totals.set(label, (totals.get(label) || 0) + (c.amount != null ? Number(c.amount) : 0));
  }
  return [...totals.entries()].map(([jobNumber, total]) => ({ jobNumber, total })).sort((a, b) => b.total - a.total);
}

async function nameAndVendorMaps(profileIds: string[]) {
  const names = new Map<string, string>();
  const vendors = new Map<string, string | null>();
  if (profileIds.length === 0) return { names, vendors };
  const [{ data: profiles }, { data: cniProfiles }] = await Promise.all([
    service.from('profiles').select('id, full_name').in('id', profileIds),
    service.from('cni_profiles').select('user_id, netsuite_vendor_id').in('user_id', profileIds),
  ]);
  for (const p of profiles || []) names.set(p.id, p.full_name);
  for (const p of cniProfiles || []) vendors.set(p.user_id, p.netsuite_vendor_id || null);
  return { names, vendors };
}

const GetSchema = z.union([
  z.object({ cniJobId: z.string().uuid() }),
  z.object({ view: z.literal('periods') }),
]);

/**
 * The pay-period console's data (R5-13b/c): cni_period payouts, an aging
 * strip over every unpaid payout stage, and per-installer unlinked CNI
 * credit totals (what a batch would pick up).
 */
async function periodsView() {
  const [payoutsRes, unpaidRes, pendingRes] = await Promise.all([
    service
      .from('payouts')
      .select('id, profile_id, period_start, period_end, total_amount, status, netsuite_bill_id, created_at, approved_at, billed_at, paid_at')
      .eq('kind', 'cni_period')
      .order('created_at', { ascending: false })
      .limit(100),
    fetchAllRows<any>((from, to) => service
      .from('payouts')
      .select('status, created_at, approved_at, billed_at')
      .in('status', ['draft', 'approved', 'billed'])
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('install_credits')
      .select('profile_id, amount, created_at')
      .is('payout_id', null)
      .is('voided_at', null)
      .not('cni_job_vin_id', 'is', null)
      .order('created_at').order('id').range(from, to)),
  ]);

  // Aging per stage: count + days since the oldest entered that stage.
  const now = Date.now();
  const aging: Record<string, { count: number; oldestDays: number }> = {};
  for (const p of unpaidRes.data || []) {
    const anchor = p.status === 'billed' ? (p.billed_at || p.created_at)
      : p.status === 'approved' ? (p.approved_at || p.created_at)
      : p.created_at;
    const days = Math.floor((now - new Date(anchor).getTime()) / 86_400_000);
    const entry = aging[p.status] || { count: 0, oldestDays: 0 };
    entry.count++;
    if (days > entry.oldestDays) entry.oldestDays = days;
    aging[p.status] = entry;
  }

  const pending = new Map<string, { credits: number; total: number; unpriced: number; oldest: string }>();
  for (const c of pendingRes.data || []) {
    const t = pending.get(c.profile_id) || { credits: 0, total: 0, unpriced: 0, oldest: c.created_at };
    t.credits++;
    if (c.amount != null) t.total += Number(c.amount);
    else t.unpriced++;
    if (c.created_at < t.oldest) t.oldest = c.created_at;
    pending.set(c.profile_id, t);
  }

  const profileIds = [...new Set([
    ...(payoutsRes.data || []).map((p: any) => p.profile_id),
    ...pending.keys(),
  ])] as string[];
  const { names, vendors } = await nameAndVendorMaps(profileIds);

  return NextResponse.json({
    payouts: (payoutsRes.data || []).map((p: any) => ({
      ...p,
      total_amount: p.total_amount != null ? Number(p.total_amount) : null,
      profile_name: names.get(p.profile_id) || 'Unknown',
      netsuite_vendor_id: vendors.get(p.profile_id) || null,
    })),
    aging,
    pending: [...pending.entries()].map(([profile_id, t]) => ({
      profile_id,
      profile_name: names.get(profile_id) || 'Unknown',
      netsuite_vendor_id: vendors.get(profile_id) || null,
      ...t,
      total: Math.round(t.total * 100) / 100,
    })).sort((a, b) => b.total - a.total),
  });
}

/**
 * Payout state for one individual-mode CNI job: existing payouts (with their
 * itemized credits) plus what a Generate would pick up — per-person totals of
 * credits not yet on any payout.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;

  if ('view' in q.data) return periodsView();

  const { data: credits, error: creditsErr } = await jobCredits(q.data.cniJobId);
  if (creditsErr) {
    return NextResponse.json({ error: 'Failed to load credits: ' + creditsErr.message }, { status: 500 });
  }

  const { data: payouts } = await service
    .from('payouts')
    .select('id, profile_id, total_amount, status, netsuite_bill_id, approved_at, created_at')
    .eq('kind', 'cni_job')
    .eq('cni_job_id', q.data.cniJobId)
    .order('created_at');

  const profileIds = [...new Set([
    ...credits.map(c => c.profile_id),
    ...(payouts || []).map(p => p.profile_id),
  ])];
  const { names, vendors } = await nameAndVendorMaps(profileIds);

  // What Generate would create: unlinked credits grouped per person.
  const pending = new Map<string, { vehicles: number; total: number; unpriced: number }>();
  for (const c of credits.filter(c => !c.payout_id)) {
    const t = pending.get(c.profile_id) || { vehicles: 0, total: 0, unpriced: 0 };
    t.vehicles++;
    if (c.amount != null) t.total += Number(c.amount);
    else t.unpriced++;
    pending.set(c.profile_id, t);
  }

  return NextResponse.json({
    payouts: (payouts || []).map(p => ({
      ...p,
      total_amount: p.total_amount != null ? Number(p.total_amount) : null,
      profile_name: names.get(p.profile_id) || 'Unknown',
      netsuite_vendor_id: vendors.get(p.profile_id) || null,
      items: credits
        .filter(c => c.payout_id === p.id)
        .map(c => ({ id: c.id, vin: c.vin, amount: c.amount != null ? Number(c.amount) : null, crew_size: c.crew_size, created_at: c.created_at })),
    })),
    pending: [...pending.entries()].map(([profile_id, t]) => ({
      profile_id,
      profile_name: names.get(profile_id) || 'Unknown',
      netsuite_vendor_id: vendors.get(profile_id) || null,
      ...t,
    })),
  });
}

const PostSchema = z.union([
  z.object({ action: z.literal('generate'), cniJobId: z.string().uuid() }),
  z.object({
    action: z.literal('generate_period'),
    profileId: z.string().uuid(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({ action: z.literal('approve'), payoutId: z.string().uuid() }),
  z.object({ action: z.literal('create_bill'), payoutId: z.string().uuid(), location: z.enum(BILL_LOCATIONS) }),
  z.object({ action: z.literal('record_bill'), payoutId: z.string().uuid(), netsuiteBillId: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('mark_paid'), payoutId: z.string().uuid() }),
  z.object({ action: z.literal('delete_draft'), payoutId: z.string().uuid() }),
]);

/**
 * Individual-mode payout lifecycle. Statuses move draft → approved → billed
 * → paid; credits lock the moment they're linked to a payout, and only a
 * draft can be deleted (which unlinks its credits so they can regenerate).
 * create_bill creates the NetSuite vendor bill for an approved payout and
 * stores its id; record_bill stores a manually-created bill id instead.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action === 'generate') {
    const { data: job } = await service
      .from('cni_jobs')
      .select('id, payout_mode, pay_per_vehicle')
      .eq('id', body.cniJobId)
      .single();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.payout_mode !== 'individual') {
      return NextResponse.json({ error: 'Job is in company payout mode — switch it to individual first' }, { status: 400 });
    }

    const { data: allCredits, error: creditsErr } = await jobCredits(body.cniJobId);
    if (creditsErr) {
      // Never generate payouts from a partial read — missing credits mean
      // someone gets paid short.
      return NextResponse.json({ error: 'Failed to load credits: ' + creditsErr.message }, { status: 500 });
    }
    const credits = allCredits.filter(c => !c.payout_id);
    if (credits.length === 0) {
      return NextResponse.json({ error: 'No unassigned credits to pay out' }, { status: 400 });
    }
    const unpriced = credits.filter(c => c.amount == null);
    if (unpriced.length > 0) {
      return NextResponse.json({ error: `${unpriced.length} credit${unpriced.length === 1 ? ' has' : 's have'} no amount — set the job's pay per vehicle and fix splits in Crew & Pay first` }, { status: 400 });
    }

    const byPerson = new Map<string, typeof credits>();
    for (const c of credits) {
      const arr = byPerson.get(c.profile_id) || [];
      arr.push(c);
      byPerson.set(c.profile_id, arr);
    }

    let created = 0;
    for (const [profileId, rows] of byPerson) {
      const total = rows.reduce((s, c) => s + Number(c.amount), 0);
      const { data: payout, error } = await service
        .from('payouts')
        .insert({
          profile_id: profileId,
          kind: 'cni_job',
          cni_job_id: body.cniJobId,
          total_amount: Math.round(total * 100) / 100,
          status: 'draft',
        })
        .select('id')
        .single();
      if (error || !payout) {
        return NextResponse.json({ error: 'Failed to create payout: ' + (error?.message || 'unknown'), created }, { status: 500 });
      }
      const { error: linkErr } = await service
        .from('install_credits')
        .update({ payout_id: payout.id })
        .in('id', rows.map(c => c.id));
      if (linkErr) {
        return NextResponse.json({ error: 'Failed to link credits: ' + linkErr.message, created }, { status: 500 });
      }
      created++;
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'payouts',
      recordId: null,
      action: 'generate',
      detail: { cni_job_id: body.cniJobId, payouts_created: created, credits_linked: credits.length },
    });
    return NextResponse.json({ success: true, created });
  }

  if (body.action === 'generate_period') {
    // R5-13b: one installer's unlinked CNI credits across ALL jobs in the
    // period become ONE payout (kind cni_period) → ONE vendor bill, instead
    // of one bill per job. Field credits (source 'field') stay with the
    // biweekly payroll flow — only CNI-VIN credits batch here.
    const endNext = new Date(new Date(body.periodEnd + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);
    if (!(body.periodStart < endNext)) {
      return NextResponse.json({ error: 'Period end must be on or after period start' }, { status: 400 });
    }
    const { data: credits, error: credErr } = await fetchAllRows<JobCredit & { cni_job_vin_id: string }>((from, to) => service
      .from('install_credits')
      .select('id, profile_id, vin, amount, share_weight, crew_size, payout_id, created_at, cni_job_vin_id')
      .eq('profile_id', body.profileId)
      .is('payout_id', null)
      .is('voided_at', null)
      .not('cni_job_vin_id', 'is', null)
      .gte('created_at', body.periodStart)
      .lt('created_at', endNext)
      .order('created_at').order('id')
      .range(from, to));
    if (credErr) {
      // Never batch from a partial read — missing credits pay people short.
      return NextResponse.json({ error: 'Failed to load credits: ' + credErr.message }, { status: 500 });
    }
    if (!credits || credits.length === 0) {
      return NextResponse.json({ error: 'No unassigned CNI credits for this installer in that period' }, { status: 400 });
    }
    const unpriced = credits.filter(c => c.amount == null);
    if (unpriced.length > 0) {
      return NextResponse.json({ error: `${unpriced.length} credit${unpriced.length === 1 ? ' has' : 's have'} no amount — fix pay/splits on their jobs first` }, { status: 400 });
    }
    const total = Math.round(credits.reduce((s, c) => s + Number(c.amount), 0) * 100) / 100;

    const { data: payoutRow, error: insErr } = await service
      .from('payouts')
      .insert({
        profile_id: body.profileId,
        kind: 'cni_period',
        period_start: body.periodStart,
        period_end: body.periodEnd,
        total_amount: total,
        status: 'draft',
      })
      .select('id')
      .single();
    if (insErr || !payoutRow) {
      return NextResponse.json({ error: 'Failed to create payout: ' + (insErr?.message || 'unknown') }, { status: 500 });
    }
    const { error: linkErr } = await service
      .from('install_credits')
      .update({ payout_id: payoutRow.id })
      .in('id', credits.map(c => c.id));
    if (linkErr) {
      return NextResponse.json({ error: 'Payout created but linking credits failed: ' + linkErr.message }, { status: 500 });
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'payouts',
      recordId: payoutRow.id,
      action: 'generate_period',
      detail: { profile_id: body.profileId, period_start: body.periodStart, period_end: body.periodEnd, total, credits_linked: credits.length },
    });
    return NextResponse.json({ success: true, payoutId: payoutRow.id, total, credits: credits.length });
  }

  // Single-payout transitions.
  const { data: payout } = await service
    .from('payouts')
    .select('id, status, kind, profile_id, cni_job_id, period_start, period_end, total_amount')
    .eq('id', body.payoutId)
    .single();
  if (!payout) return NextResponse.json({ error: 'Payout not found' }, { status: 404 });

  if (body.action === 'create_bill') {
    if (payout.status !== 'approved') {
      return NextResponse.json({ error: `Payout is ${payout.status} — only approved payouts can be billed` }, { status: 400 });
    }
    const amount = payout.total_amount != null ? Number(payout.total_amount) : 0;
    if (!(amount > 0)) {
      return NextResponse.json({ error: 'Payout has no amount to bill' }, { status: 400 });
    }

    // The installer must have a NetSuite vendor record to bill against.
    const { data: cniProfile } = await service
      .from('cni_profiles').select('netsuite_vendor_id').eq('user_id', payout.profile_id).maybeSingle();
    const vendorId = cniProfile?.netsuite_vendor_id?.trim();
    if (!vendorId) {
      return NextResponse.json({ error: 'This installer has no NetSuite vendor ID on file — set it in Vendor IDs first' }, { status: 400 });
    }
    // NetSuite needs the vendor's numeric internal id here. A name (or anything
    // non-numeric) makes the bill create fail with an opaque 500, so reject it
    // up front with an actionable message.
    if (!/^\d+$/.test(vendorId)) {
      return NextResponse.json({ error: `This installer's NetSuite vendor ID is "${vendorId}", which isn't a valid id — it must be the vendor's numeric NetSuite internal id (e.g. 1234), not a name. Fix it on the Vendor IDs page.` }, { status: 400 });
    }

    // NetSuite lookups + bill creation throw on any API/SuiteQL error (or
    // missing config). Catch so the real reason reaches the user instead of a
    // bare 500 the UI can only show as "Payout action failed".
    try {
      const location = await findLocation(body.location);
      if (!location) {
        return NextResponse.json({ error: `Could not find the "${body.location}" location in NetSuite` }, { status: 400 });
      }

      // A memo that ties the bill back to the job(s) for reconciliation.
      const { data: prof } = await service
        .from('profiles').select('full_name').eq('id', payout.profile_id).maybeSingle();
      let memo: string;
      let referenceNo: string;
      if (payout.kind === 'cni_period') {
        // Pay-period batch (R5-13b): ONE bill, per-job breakdown in the
        // memo — never multi-line bills (the create helper posts one line).
        const perJob = await periodJobBreakdown(payout.id);
        const breakdown = perJob.map(j => `${j.jobNumber}: $${j.total.toFixed(2)}`).join(' · ');
        memo = `Installer pay period ${payout.period_start} – ${payout.period_end} — ${prof?.full_name || 'installer'}${breakdown ? ` (${breakdown})` : ''}`.slice(0, 400);
        referenceNo = `PP-${payout.id.slice(0, 8)}`;
      } else {
        const { data: job } = await service
          .from('cni_jobs').select('job_number, title').eq('id', payout.cni_job_id).maybeSingle();
        memo = `Installer pay — ${prof?.full_name || 'installer'}${job?.job_number ? ` — ${job.job_number}` : ''}`;
        // Reference No. (tranId) — required by NetSuite when bills aren't
        // auto-numbered. Unique per vendor: job number + a short payout id.
        referenceNo = `${job?.job_number ? job.job_number + '-' : 'CNI-'}${payout.id.slice(0, 8)}`;
      }

      const bill = await createVendorBill({
        vendorId, accountId: SUBCONTRACTOR_ACCT_ID, amount,
        referenceNo,
        subsidiaryId: BILL_SUBSIDIARY_ID, locationId: location.id,
        memo, lineMemo: memo,
      });
      if (!bill.success) {
        return NextResponse.json({ error: bill.error || 'Failed to create vendor bill' }, { status: 502 });
      }
      const billRef = bill.billNumber || bill.billId || '';

      const { error } = await service
        .from('payouts')
        .update({ status: 'billed', netsuite_bill_id: billRef, billed_by: auth.user.id, billed_at: new Date().toISOString() })
        .eq('id', payout.id);
      if (error) return NextResponse.json({ error: 'Bill created in NetSuite but failed to update payout: ' + error.message }, { status: 500 });
      await logAudit(service, {
        actorId: auth.user.id,
        table: 'payouts',
        recordId: payout.id,
        action: 'create_bill',
        detail: { netsuite_bill_id: billRef, amount, location: body.location, profile_id: payout.profile_id },
      });
      await notifyPayoutInstaller(payout, 'billed');
      return NextResponse.json({ success: true, netsuiteBillId: billRef });
    } catch (e: any) {
      console.error('create_bill error:', e);
      return NextResponse.json({ error: 'Vendor bill failed: ' + (e?.message || 'unknown error') }, { status: 502 });
    }
  }

  if (body.action === 'delete_draft') {
    if (payout.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft payouts can be deleted' }, { status: 400 });
    }
    const { data: unlinked } = await service
      .from('install_credits').update({ payout_id: null }).eq('payout_id', payout.id).select('id');
    const { error } = await service.from('payouts').delete().eq('id', payout.id);
    if (error) return NextResponse.json({ error: 'Failed to delete payout: ' + error.message }, { status: 500 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'payouts',
      recordId: payout.id,
      action: 'delete_draft',
      detail: { profile_id: payout.profile_id, cni_job_id: payout.cni_job_id, total_amount: payout.total_amount, credits_unlinked: unlinked?.length || 0 },
    });
    return NextResponse.json({ success: true });
  }

  const now = new Date().toISOString();
  const transitions: Record<string, { from: string; to: string; extra?: Record<string, unknown> }> = {
    approve: { from: 'draft', to: 'approved', extra: { approved_by: auth.user.id, approved_at: now } },
    record_bill: { from: 'approved', to: 'billed', extra: { netsuite_bill_id: (body as { netsuiteBillId?: string }).netsuiteBillId, billed_by: auth.user.id, billed_at: now } },
    mark_paid: { from: 'billed', to: 'paid', extra: { paid_by: auth.user.id, paid_at: now } },
  };
  const t = transitions[body.action];
  if (payout.status !== t.from) {
    return NextResponse.json({ error: `Payout is ${payout.status} — expected ${t.from}` }, { status: 400 });
  }
  const { error } = await service
    .from('payouts')
    .update({ status: t.to, ...(t.extra || {}) })
    .eq('id', payout.id);
  if (error) return NextResponse.json({ error: 'Failed to update payout: ' + error.message }, { status: 500 });
  await logAudit(service, {
    actorId: auth.user.id,
    table: 'payouts',
    recordId: payout.id,
    action: body.action,
    detail: {
      from: t.from,
      to: t.to,
      total_amount: payout.total_amount,
      ...(body.action === 'record_bill' ? { netsuite_bill_id: (body as { netsuiteBillId?: string }).netsuiteBillId } : {}),
    },
  });
  // Notify the installer at every terminal transition (approved/billed/paid).
  await notifyPayoutInstaller(payout, t.to as 'approved' | 'billed' | 'paid');
  return NextResponse.json({ success: true });
}
