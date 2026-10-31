import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { isAdminRole } from '@/lib/features';
import { validateBody, z } from '@/lib/validate';
import { findVendorBill, getOrderLineIds, getVendorBillAmounts, getVendorBillRecord, patchVendorBill } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { saveFixedOwnBill, type FixedBillCopyLine } from '@/lib/books/own-bills';
import type { FixedSaveResult } from '@/lib/books/own-invoices';
import { accountName } from '@/lib/vendor-credit';
import { termDays } from '@/lib/invoice-fix';
import { logAudit } from '@/lib/audit';
import {
  BILL_NUMBER_MAX, MAX_ADDED, billFacts, billFixAllows, billName, formatCents, ownCopyLines, parseFixBill, planBillFix,
  type BillFixFacts, type FixBill, type FixedBill,
} from '@/lib/bill-fix';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Fixing bills is switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

const rolesOf = (auth: Auth) => getProfileRoles(auth.profile);

/**
 * Admins with Parts Ordering who can see prices, once fixing bills is switched on (Books → Switches), as vendor
 * credits are made; until then only super admins, to see what a fix would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return { auth, on: false, error: NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 }) };
  }
  const roles = rolesOf(auth);
  const on = await switchIsOn(service, 'bill_fixes');
  if (!on && !roles.includes('super_admin')) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  if (on && !isAdminRole(roles)) return { auth, on, error: NextResponse.json({ error: 'Bills are fixed by admins.' }, { status: 403 }) };
  return { auth, on };
}

/** The bill as NetSuite has it now, with what SuiteQL says of its money: without that, only its header can be fixed. */
async function readBill(id: string): Promise<{ bill: FixBill } | { error: string; status: number }> {
  const [rec, amounts] = await Promise.all([getVendorBillRecord(id), getVendorBillAmounts(id)]);
  if (!rec.success) return { error: rec.notFound ? `NetSuite has no bill with id ${id}.` : rec.error, status: rec.notFound ? 404 : 502 };
  return {
    bill: parseFixBill(rec.record, amounts.success
      ? { totalCents: amounts.totalCents, owedCents: amounts.owedCents, status: amounts.status, voided: amounts.voided }
      : null),
  };
}

/** What the fix is planned against, short: anything different means the bill changed while the page was open. */
const signatureOf = (bill: FixBill) => createHash('sha256').update(billFacts(bill)).digest('hex').slice(0, 32);

/** What FleetSuite knows that a fix of the bill is worked out with, apart from whether a number typed is taken. */
async function readFacts(bill: FixBill): Promise<Omit<BillFixFacts, 'numberTaken'>> {
  const [credits, terms, companies] = await Promise.all([
    // A vendor credit FleetSuite made, or is making, applied to the bill.
    service.from('typed_vendor_credits').select('id, netsuite_vendor_credit_id, claimed_at').contains('applied', JSON.stringify([{ billId: bill.id }])),
    bill.termsId
      ? service.from('gl_netsuite_lists').select('details').eq('kind', 'term').eq('netsuite_id', bill.termsId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readCompanies(service),
  ]);
  for (const res of [credits, terms]) if (res.error) throw new Error(res.error.message);

  const creditedHere = ((credits.data ?? []) as Array<{ netsuite_vendor_credit_id: string | null; claimed_at: string | null }>)
    .some((c) => c.netsuite_vendor_credit_id || c.claimed_at);
  // No terms is due the day it's dated, as in NetSuite; terms due on a day of the month FleetSuite can't work out.
  const termsDays = bill.termsId ? termDays((terms.data as { details?: Record<string, unknown> | null } | null)?.details) : 0;
  // The accounts an expense line of the bill's company can go to, as Snap a bill offers them.
  const company = companies.find((c) => c.subsidiaryId && c.subsidiaryId === bill.subsidiaryId);
  const accounts = new Map<string, { id: string; name: string }>();
  if (company) {
    for (const a of (await readAccounts(service, companies)).values()) {
      if (a.companies.includes(company.code)) accounts.set(a.id, { id: a.id, name: accountName(a) });
    }
  }
  return { allows: billFixAllows(bill, { creditedHere }), accounts, termsDays };
}

/** The vendor's other bill numbered as typed, when the number changes; throws when NetSuite can't be asked. */
async function numberTaken(bill: FixBill, typed: string | undefined): Promise<string | null> {
  const v = (typed ?? '').trim();
  if (!v || v === bill.number || v.length > BILL_NUMBER_MAX) return null;
  if (!bill.vendorId) throw new Error('NetSuite gave the bill no vendor');
  const found = await findVendorBill(bill.vendorId, v);
  return found && found.billId !== bill.id ? found.billNumber || v : null;
}

/**
 * The fixed bill's lines as Books' own copy takes them, each part's purchase order line named by NetSuite's id for it
 * (the bill names it by its sequence number). A line whose order FleetSuite can't read goes without it.
 */
async function copyLines(fixed: FixedBill): Promise<FixedBillCopyLine[]> {
  const lines = ownCopyLines(fixed);
  const orders = [...new Set(lines.filter((l) => l.orderId && l.orderLine !== null).map((l) => l.orderId!))].slice(0, 5);
  const ids = new Map<string, Map<number, string>>();
  await Promise.all(orders.map(async (order) => {
    try {
      ids.set(order, await getOrderLineIds(order));
    } catch (err: any) {
      console.error(`[bill fix] couldn't read purchase order ${order}'s lines: ${err?.message || err}`);
    }
  }));
  return lines.map(({ orderId, orderLine, ...l }) => ({
    ...l,
    poLineId: orderId && orderLine !== null ? ids.get(orderId)?.get(orderLine) ?? null : null,
  }));
}

interface FixRow {
  id: string;
  reason: string;
  changes: unknown;
  status: 'sending' | 'fixed' | 'refused' | 'unsure';
  error: string | null;
  total_before_cents: number | null;
  total_after_cents: number | null;
  own_copy: 'fixed' | 'none' | 'not_saved' | null;
  created_by: string | null;
  created_at: string;
}

interface CopyBillRow {
  netsuite_id: string;
  tranid: string | null;
  trandate: string;
  vendor_name: string | null;
  total: string | number;
  voided: boolean;
}

/** Bills in the copy of NetSuite's bills numbered, or from a vendor named, with every word typed; the newest with none. */
async function findBills(typed: string) {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let q = service.from('gl_netsuite_bills')
    .select('netsuite_id, tranid, trandate, vendor_name, total, voided')
    .eq('tran_type', 'VendBill')
    .is('gone_at', null);
  if (words.length > 0) {
    const like = `%${words.slice(0, 6).join('%')}%`;
    q = q.or(`tranid.ilike.${like},vendor_name.ilike.${like}`);
  }
  const { data, error } = await q.order('trandate', { ascending: false }).order('netsuite_id', { ascending: false }).limit(15);
  if (error) throw new Error(`couldn't search the copy of NetSuite's bills (${error.message})`);
  return ((data ?? []) as CopyBillRow[]).map((r) => ({
    id: r.netsuite_id,
    number: r.tranid,
    date: r.trandate,
    vendorName: r.vendor_name,
    totalCents: Math.round(Number(r.total) * 100),
    voided: r.voided,
  }));
}

/**
 * GET /api/purchasing/bill-fix?status=1 — whether fixing bills is on, and whether this person can use it.
 * GET ?find=<typed> — bills from the copy of NetSuite's bills by number or vendor, the newest with nothing typed.
 * GET ?bill=<NetSuite id> — the bill as NetSuite has it now, what a fix can change, the accounts its expense lines can
 * go to, what it's planned against, the fixes FleetSuite made to it, and whether Books has its own copy of it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'parts_ordering');
    if (auth.error) return auth.error;
    const roles = rolesOf(auth);
    const on = await switchIsOn(service, 'bill_fixes');
    const money = await profileCanSeeMoney(auth.user.id, auth.profile);
    return NextResponse.json({ on, canUse: money && (on ? isAdminRole(roles) : roles.includes('super_admin')) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    if (params.has('find')) return NextResponse.json({ bills: await findBills(params.get('find') || '') });

    const id = (params.get('bill') || '').trim();
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad bill id' }, { status: 400 });
    const read = await readBill(id);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    const { bill } = read;
    const [facts, fixes, own] = await Promise.all([
      readFacts(bill),
      service.from('bill_fixes')
        .select('id, reason, changes, status, error, total_before_cents, total_after_cents, own_copy, created_by, created_at')
        .eq('bill_netsuite_id', id)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(20),
      service.from('gl_own_bills').select('version, fixed_at').eq('netsuite_id', id).maybeSingle(),
    ]);
    if (fixes.error) throw new Error(fixes.error.message);
    if (own.error) throw new Error(own.error.message);
    const rows = (fixes.data ?? []) as FixRow[];
    const people = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (people.length > 0) {
      const { data } = await service.from('profiles').select('id, full_name').in('id', people);
      for (const p of (data ?? []) as Array<{ id: string; full_name: string | null }>) if (p.full_name) names.set(p.id, p.full_name);
    }
    const copy = own.data as { version: number; fixed_at: string | null } | null;
    return NextResponse.json({
      bill,
      allows: facts.allows,
      termsDays: facts.termsDays,
      accounts: [...facts.accounts.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
      signature: signatureOf(bill),
      fixes: rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        by: r.created_by ? names.get(r.created_by) ?? null : null,
        reason: r.reason,
        changes: Array.isArray(r.changes) ? r.changes.map(String) : [],
        status: r.status,
        error: r.error,
        totalBeforeCents: r.total_before_cents,
        totalAfterCents: r.total_after_cents,
        ownCopy: r.own_copy,
      })),
      ownCopy: copy ? { version: copy.version, fixedAt: copy.fixed_at } : null,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what a fix would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one fix.
  requestId: z.string().uuid(),
  billId: netsuiteId,
  // What the page planned against (GET's signature). NetSuite's bill can change while the page is open: then nothing
  // is sent.
  signature: z.string().min(1).max(100),
  reason: z.string().max(1000),
  header: z.object({
    number: z.string().max(200).optional(),
    date: z.string().max(20).optional(),
    dueDate: z.string().max(20).optional(),
    memo: z.string().max(2000).optional(),
  }).optional(),
  lines: z.array(z.object({
    list: z.enum(['expense', 'item']),
    line: z.number().int().min(0),
    accountId: netsuiteId.optional(),
    amount: z.number().optional(),
    quantity: z.number().optional(),
    rate: z.number().optional(),
    description: z.string().max(5000).optional(),
    remove: z.boolean().optional(),
  })).max(500).optional(),
  add: z.array(z.object({
    accountId: netsuiteId,
    amount: z.number(),
    memo: z.string().max(5000).optional(),
  })).max(MAX_ADDED).optional(),
});

/**
 * POST /api/purchasing/bill-fix — fix the bill in NetSuite, and make the next version of Books' own copy of it. What
 * changes and what NetSuite is sent are worked out here from the bill as NetSuite has it now, never taken from the
 * page. Refused while fixing bills is switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  let bill: FixBill;
  let facts: BillFixFacts;
  try {
    const read = await readBill(body.billId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    bill = read.bill;
    if (signatureOf(bill) !== body.signature) {
      return NextResponse.json({
        error: `${cap(billName(bill))} changed in NetSuite since this page opened. Nothing was sent. Reload it and make the fix again.`,
        stale: true,
      }, { status: 409 });
    }
    let taken: string | null;
    try {
      taken = await numberTaken(bill, body.header?.number);
    } catch (err: any) {
      return NextResponse.json({
        error: `Couldn't ask NetSuite whether another of the vendor's bills is numbered ${(body.header?.number ?? '').trim()}: ${err?.message || err}. Nothing was sent.`,
      }, { status: 502 });
    }
    facts = { ...(await readFacts(bill)), numberTaken: taken };
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }

  const plan = planBillFix(bill, body, facts);
  if (plan.problems.length > 0) return NextResponse.json({ error: plan.problems.join(' '), problems: plan.problems }, { status: 400 });

  // One send per form, and one fix of a bill at a time: take the claim, or say what's in the way.
  const claim = await service.rpc('bill_fix_claim', {
    p: {
      id: body.requestId,
      bill_netsuite_id: bill.id,
      bill_number: bill.number || null,
      vendor_netsuite_id: bill.vendorId,
      vendor_name: bill.vendorName || null,
      reason: body.reason.trim(),
      changes: plan.changes,
      patch: plan.body,
      replace_lists: plan.replace,
      total_before_cents: bill.totalCents,
      total_expected_cents: plan.fixed.totalCents,
      by: auth.user.id,
    },
  });
  if (claim.error) return NextResponse.json({ error: claim.error.message }, { status: 500 });
  const claimed = claim.data as { claimed?: boolean; state?: string } | null;
  if (!claimed?.claimed) {
    if (claimed?.state === 'fixed') {
      return NextResponse.json({ success: true, already: true, billNumber: bill.number, changes: plan.changes });
    }
    return NextResponse.json({
      error: claimed?.state === 'sending'
        ? "This fix is being sent now. Don't press again: reload the bill in a minute to see it."
        : `Another fix of ${billName(bill)} is being sent now. Reload it in a minute and check it before fixing it again.`,
    }, { status: 409 });
  }

  const finish = (p: Record<string, unknown>) => service.rpc('bill_fix_finish', { p: { id: body.requestId, ...p } });

  const result = await patchVendorBill(bill.id, plan.body, { replace: plan.replace });
  if (!result.success) {
    const error = result.error || "NetSuite didn't answer";
    await finish({ status: result.unsure ? 'unsure' : 'refused', error });
    // NetSuite's own words, without the full stop they may end with, so the sentence reads on.
    const said = error.replace(/[.\s]+$/, '');
    return NextResponse.json(result.unsure
      ? {
        error: `${said}, so FleetSuite can't tell whether the fix went in. Reload the bill: if the change is there, it went in; if it isn't, fix it again.`,
        unsure: true,
      }
      : { error: `NetSuite didn't take the fix: ${said}. Nothing changed.` }, { status: 502 });
  }

  // NetSuite's total is the one to show.
  const after = await readBill(bill.id).catch(() => null);
  const totalAfterCents = after && 'bill' in after ? after.bill.totalCents : null;

  // Books' own copy follows the fix (never fails the fix, which is in NetSuite).
  let own: FixedSaveResult;
  if (!plan.fixed.date) own = { saved: false, reason: 'NetSuite gave the bill no date' };
  else {
    const has = await service.from('gl_own_bills').select('netsuite_id').eq('netsuite_id', bill.id).maybeSingle();
    own = !has.error && !has.data
      ? { saved: false, none: true, reason: 'no copy' }
      : await saveFixedOwnBill(service, {
        netsuiteId: bill.id,
        fixed: { number: plan.fixed.number, date: plan.fixed.date, lines: await copyLines(plan.fixed) },
        fixId: body.requestId,
        by: auth.user.id,
      });
  }
  const ownVersion = own.saved && typeof own.version === 'number' ? own.version : null;
  const ownCopy = ownVersion !== null ? 'fixed' : own.none ? 'none' : 'not_saved';
  const done = await finish({ status: 'fixed', total_after_cents: totalAfterCents, own_copy: ownCopy, own_copy_version: ownVersion });
  // The fix is in NetSuite either way; a row left sending shows as unsure after five minutes.
  if (done.error) console.error(`[bill fix] ${body.requestId} went in but wasn't marked fixed: ${done.error.message}`);

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'bill_fixes',
    recordId: body.requestId,
    action: 'fix',
    detail: {
      netsuite_bill_id: bill.id,
      bill: bill.number,
      vendor: bill.vendorName,
      changes: plan.changes,
      replace: plan.replace,
      total_before: bill.totalCents === null ? null : formatCents(bill.totalCents),
      total_after: totalAfterCents === null ? null : formatCents(totalAfterCents),
      own_copy: ownCopy,
    },
  });

  return NextResponse.json({
    success: true,
    billNumber: plan.fixed.number,
    changes: plan.changes,
    totalBeforeCents: bill.totalCents,
    totalAfterCents,
    ownCopy,
    ...(ownCopy === 'not_saved'
      ? { warning: `Books' own copy of the bill didn't follow (${own.reason || 'it said nothing back'}). The fix is in NetSuite.` }
      : {}),
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
