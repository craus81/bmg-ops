import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { findExpenseAccount, findSubsidiary, findLocation, createVendorBill } from '@/lib/netsuite';

// GL account for installer pay (BMG "Subcontractors", acct # 53000).
const SUBCONTRACTOR_ACCT_NUMBER = '53000';
const SUBCONTRACTOR_ACCT_NAME = 'Subcontractors';
// Vendor bills post under this subsidiary.
const BILL_SUBSIDIARY_NAME = 'BMG Fleet Installations';
// Locations the admin can post a bill to.
const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'] as const;

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** All live credits on a job (via its VINs), split into linked/unlinked. */
async function jobCredits(cniJobId: string) {
  const { data: vins } = await service
    .from('cni_job_vins').select('id').eq('job_id', cniJobId);
  if (!vins || vins.length === 0) return [];
  const { data: credits } = await service
    .from('install_credits')
    .select('id, profile_id, vin, amount, share_weight, crew_size, payout_id, created_at')
    .in('cni_job_vin_id', vins.map(v => v.id))
    .is('voided_at', null)
    .order('created_at');
  return credits || [];
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

const GetSchema = z.object({ cniJobId: z.string().uuid() });

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

  const credits = await jobCredits(q.data.cniJobId);

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

    const credits = (await jobCredits(body.cniJobId)).filter(c => !c.payout_id);
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
    return NextResponse.json({ success: true, created });
  }

  // Single-payout transitions.
  const { data: payout } = await service
    .from('payouts')
    .select('id, status, kind, profile_id, cni_job_id, total_amount')
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
    const vendorId = cniProfile?.netsuite_vendor_id;
    if (!vendorId) {
      return NextResponse.json({ error: 'This installer has no NetSuite vendor ID on file — set it in Vendor IDs first' }, { status: 400 });
    }

    // NetSuite lookups + bill creation throw on any API/SuiteQL error (or
    // missing config). Catch so the real reason reaches the user instead of a
    // bare 500 the UI can only show as "Payout action failed".
    try {
      const account = await findExpenseAccount({ number: SUBCONTRACTOR_ACCT_NUMBER, name: SUBCONTRACTOR_ACCT_NAME });
      if (!account) {
        return NextResponse.json({ error: `Could not find the "${SUBCONTRACTOR_ACCT_NAME}" account (#${SUBCONTRACTOR_ACCT_NUMBER}) in NetSuite` }, { status: 400 });
      }

      const subsidiary = await findSubsidiary(BILL_SUBSIDIARY_NAME);
      if (!subsidiary) {
        return NextResponse.json({ error: `Could not find the "${BILL_SUBSIDIARY_NAME}" subsidiary in NetSuite` }, { status: 400 });
      }

      const location = await findLocation(body.location);
      if (!location) {
        return NextResponse.json({ error: `Could not find the "${body.location}" location in NetSuite` }, { status: 400 });
      }

      // A memo that ties the bill back to the job for reconciliation.
      const [{ data: job }, { data: prof }] = await Promise.all([
        service.from('cni_jobs').select('job_number, title').eq('id', payout.cni_job_id).maybeSingle(),
        service.from('profiles').select('full_name').eq('id', payout.profile_id).maybeSingle(),
      ]);
      const memo = `Installer pay — ${prof?.full_name || 'installer'}${job?.job_number ? ` — ${job.job_number}` : ''}`;

      const bill = await createVendorBill({
        vendorId, accountId: account.id, amount,
        subsidiaryId: subsidiary.id, locationId: location.id,
        memo, lineMemo: memo,
      });
      if (!bill.success) {
        return NextResponse.json({ error: bill.error || 'Failed to create vendor bill' }, { status: 502 });
      }
      const billRef = bill.billNumber || bill.billId || '';

      const { error } = await service
        .from('payouts')
        .update({ status: 'billed', netsuite_bill_id: billRef })
        .eq('id', payout.id);
      if (error) return NextResponse.json({ error: 'Bill created in NetSuite but failed to update payout: ' + error.message }, { status: 500 });
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
    await service.from('install_credits').update({ payout_id: null }).eq('payout_id', payout.id);
    const { error } = await service.from('payouts').delete().eq('id', payout.id);
    if (error) return NextResponse.json({ error: 'Failed to delete payout: ' + error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  const transitions: Record<string, { from: string; to: string; extra?: Record<string, unknown> }> = {
    approve: { from: 'draft', to: 'approved', extra: { approved_by: auth.user.id, approved_at: new Date().toISOString() } },
    record_bill: { from: 'approved', to: 'billed', extra: { netsuite_bill_id: (body as { netsuiteBillId?: string }).netsuiteBillId } },
    mark_paid: { from: 'billed', to: 'paid' },
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
  return NextResponse.json({ success: true });
}
