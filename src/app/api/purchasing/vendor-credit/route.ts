import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireFeature } from '@/lib/api-auth';
import { isAdminRole } from '@/lib/features';
import { validateBody, z } from '@/lib/validate';
import { partNumberRegex } from '@/lib/loose-search';
import { createVendorCredit, findVendorCredit, getBillPostings, getVendorBillAmounts, getVendorBillRecord, getVendorOpenBills } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { readAccounts, readCompanies, readVendor, searchVendors, snapToday } from '@/lib/books/snap-a-bill';
import { saveOwnVendorCredit } from '@/lib/books/own-vendor-credits';
import { logAudit } from '@/lib/audit';
import {
  MAX_APPLIED_BILLS, MAX_VENDOR_CREDIT_LINES, STOCK_LOCATION_ID, creditAllNumber, creditAllOfBill, formatCents, keptApplied,
  keptVendorCreditLines, netsuiteVendorCredit, workOutVendorCredit,
  type CreditAccount, type CreditCompany, type CreditPart, type OpenBill, type VendorCreditDraft,
} from '@/lib/vendor-credit';
import { billName, parseFixBill } from '@/lib/bill-fix';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Vendor credits are switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

const rolesOf = (auth: Auth) => getProfileRoles(auth.profile);

/**
 * Admins with Purchasing once vendor credits are switched on (Books → Switches); until then only super admins, to
 * see what it would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return { auth, on: false, error: auth.error };
  const roles = rolesOf(auth);
  const on = await switchIsOn(service, 'vendor_credits');
  if (!on && !roles.includes('super_admin')) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  if (on && !isAdminRole(roles)) return { auth, on, error: NextResponse.json({ error: 'Vendor credits are made by admins.' }, { status: 403 }) };
  return { auth, on };
}

const companiesOf = (rows: Awaited<ReturnType<typeof readCompanies>>): CreditCompany[] =>
  rows.map((c) => ({ code: c.code, name: c.name, subsidiaryId: c.subsidiaryId, locations: c.locations }));

/** The accounts a line can go to: the ones some company can use. */
async function readCreditAccounts(companies: Awaited<ReturnType<typeof readCompanies>>): Promise<Map<string, CreditAccount>> {
  const all = await readAccounts(service, companies);
  const accounts = new Map<string, CreditAccount>();
  for (const a of all.values()) {
    if (a.companies.length > 0) accounts.set(a.id, { id: a.id, number: a.number, name: a.name, companies: a.companies });
  }
  return accounts;
}

interface PartRow {
  netsuite_id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  item_type: string | null;
  purchase_price: number | string | null;
  vendor_cost: number | string | null;
  quantity_on_hand: number | string | null;
}

const PART_COLUMNS = 'netsuite_id, item_number, display_name, description, item_type, purchase_price, vendor_cost, quantity_on_hand';

const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const partOf = (r: PartRow): CreditPart => ({
  id: String(r.netsuite_id),
  itemNumber: r.item_number,
  description: r.description || r.display_name || null,
  stock: r.item_type === 'InvtPart' || r.item_type === 'Assembly',
  cost: positive(r.vendor_cost) ?? positive(r.purchase_price),
  onHand: r.quantity_on_hand === null || r.quantity_on_hand === undefined ? null : Number(r.quantity_on_hand),
});

async function readParts(ids: string[]): Promise<Map<string, CreditPart>> {
  const parts = new Map<string, CreditPart>();
  if (ids.length === 0) return parts;
  const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS).in('netsuite_id', ids).eq('is_active', true);
  if (error) throw new Error(`couldn't read the parts (${error.message})`);
  for (const r of (data ?? []) as PartRow[]) parts.set(String(r.netsuite_id), partOf(r));
  return parts;
}

/** Up to 25 active parts NetSuite knows, by number, name or description; part numbers match with their dashes ignored. */
async function searchParts(typed: string): Promise<CreditPart[]> {
  const q = typed.trim().replace(/[%,()]/g, ' ').slice(0, 60);
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const re = partNumberRegex(q);
  const { data, error } = await service
    .from('netsuite_parts')
    .select(PART_COLUMNS)
    .eq('is_active', true)
    .not('netsuite_id', 'is', null)
    .or(`item_number.ilike.${like},display_name.ilike.${like},description.ilike.${like}${re ? `,item_number.imatch."${re}"` : ''}`)
    .order('item_number')
    .limit(25);
  if (error) throw new Error(`couldn't search the parts (${error.message})`);
  return ((data ?? []) as PartRow[]).map(partOf);
}

/** The vendor's open bills in NetSuite now, for the company's subsidiary. */
async function readOpenBills(vendorId: string, company: CreditCompany | undefined) {
  const res = await getVendorOpenBills(vendorId, company?.subsidiaryId ?? null);
  if (!res.success) return { bills: null as OpenBill[] | null, credits: null as OpenBill[] | null, error: res.error };
  return { bills: res.bills as OpenBill[], credits: res.credits as OpenBill[], error: null as string | null };
}

/**
 * Credit all of it, from a bill's Fix screen (src/lib/bill-fix.ts): a vendor credit that undoes the bill, filled in
 * from the bill as NetSuite has it now and what it posted, the other way round (creditAllOfBill), applied to it for
 * what's open on it. The person checks it and makes it as any other.
 */
async function readCreditAll(id: string) {
  const [rec, amounts, postings, companyRows] = await Promise.all([
    getVendorBillRecord(id), getVendorBillAmounts(id), getBillPostings(id), readCompanies(service),
  ]);
  if (!rec.success) return { error: rec.notFound ? `NetSuite has no bill with id ${id}.` : rec.error, status: rec.notFound ? 404 : 502 };
  const bill = parseFixBill(rec.record, amounts.success
    ? { totalCents: amounts.totalCents, owedCents: amounts.owedCents, status: amounts.status, voided: amounts.voided }
    : null);
  const name = billName(bill);
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  if (bill.voided) return { error: `${Name} is voided in NetSuite, so there's nothing to credit.`, status: 409 };
  const company = companiesOf(companyRows).find((c) => c.subsidiaryId && c.subsidiaryId === bill.subsidiaryId);
  if (!company) return { error: `${Name} is for a company FleetSuite doesn't keep books for.`, status: 409 };
  const all = postings.success
    ? creditAllOfBill(postings.rows, bill.totalCents, name)
    : { lines: [], why: `Couldn't read what ${name} posted from NetSuite (${postings.error}), so enter its lines by hand.` };
  return {
    prefill: {
      billId: bill.id,
      billNumber: bill.number || null,
      vendor: bill.vendorId ? { id: bill.vendorId, name: bill.vendorName } : null,
      company: company.code,
      locationId: bill.locationId && company.locations.some((l) => l.id === bill.locationId) ? bill.locationId : null,
      number: creditAllNumber(bill.number, bill.id),
      reason: `Undoes ${name}`,
      lines: all.lines.map((l) => ({ accountId: l.accountId, amount: l.cents / 100, memo: l.memo })),
      // What's open on it; nothing when NetSuite couldn't say, and the bill is picked by hand.
      applyCents: bill.owedCents ?? 0,
      why: all.why,
    },
  };
}

interface RecentRow {
  id: string;
  vendor_name: string | null;
  credit_number: string;
  credit_date: string;
  total_cents: number | null;
  netsuite_vendor_credit_id: string | null;
  claimed_at: string | null;
  error: string | null;
  created_at: string;
}

/**
 * GET /api/purchasing/vendor-credit?status=1 — whether vendor credits are on, and whether this person can use them.
 * GET /api/purchasing/vendor-credit — the companies, their locations and accounts, and the vendor credits made lately.
 * GET ?vendors=<typed> — vendors from the copy of NetSuite's list. GET ?parts=<typed> — parts to send back.
 * GET ?vendor=<NetSuite id>&company=<code> — the vendor, and its bills and credits NetSuite has open now.
 * GET ?bill=<NetSuite id> — Credit all of it: the vendor credit that undoes the bill, to check and make.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'parts_ordering');
    if (auth.error) return auth.error;
    const roles = rolesOf(auth);
    const on = await switchIsOn(service, 'vendor_credits');
    return NextResponse.json({ on, canUse: on ? isAdminRole(roles) : roles.includes('super_admin') });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    if (params.has('vendors')) {
      const vendors = await searchVendors(service, params.get('vendors') || '');
      return NextResponse.json({ vendors: vendors.map((v) => ({ id: v.id, name: v.name })) });
    }
    if (params.has('parts')) {
      return NextResponse.json({ parts: await searchParts(params.get('parts') || '') });
    }
    if (params.has('bill')) {
      const billId = (params.get('bill') || '').trim();
      if (!/^\d+$/.test(billId)) return NextResponse.json({ error: 'Bad bill id' }, { status: 400 });
      const all = await readCreditAll(billId);
      if ('error' in all) return NextResponse.json({ error: all.error }, { status: all.status });
      return NextResponse.json(all);
    }
    const vendorId = (params.get('vendor') || '').trim();
    if (vendorId) {
      if (!/^\d+$/.test(vendorId)) return NextResponse.json({ error: 'Bad vendor id' }, { status: 400 });
      const [vendor, companies] = await Promise.all([readVendor(service, vendorId), readCompanies(service)]);
      if (!vendor) return NextResponse.json({ error: "That vendor isn't in FleetSuite's copy of NetSuite's vendors." }, { status: 404 });
      const company = companiesOf(companies).find((c) => c.code === (params.get('company') || ''));
      const open = await readOpenBills(vendorId, company);
      return NextResponse.json({
        vendor: { id: vendor.id, name: vendor.name, expenseAccountId: vendor.expenseAccountId },
        openBills: open.bills,
        openCredits: open.credits,
        openError: open.error,
      });
    }

    const companies = await readCompanies(service);
    const [accounts, recent] = await Promise.all([
      readCreditAccounts(companies),
      service.from('typed_vendor_credits')
        .select('id, vendor_name, credit_number, credit_date, total_cents, netsuite_vendor_credit_id, claimed_at, error, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);
    if (recent.error) throw new Error(recent.error.message);
    return NextResponse.json({
      companies: companiesOf(companies),
      accounts: [...accounts.values()].sort((a, b) => (a.number || a.name).localeCompare(b.number || b.name, 'en', { numeric: true })),
      today: snapToday(),
      stockLocationId: STOCK_LOCATION_ID,
      recent: ((recent.data ?? []) as RecentRow[]).map((r) => ({
        id: r.id,
        vendorName: r.vendor_name,
        number: r.credit_number,
        date: r.credit_date,
        totalCents: r.total_cents,
        vendorCreditId: r.netsuite_vendor_credit_id,
        state: r.netsuite_vendor_credit_id ? 'made' : r.claimed_at ? 'making' : 'refused',
        error: r.netsuite_vendor_credit_id || r.claimed_at ? null : r.error,
        at: r.created_at,
      })),
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what it would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one vendor credit.
  requestId: z.string().uuid(),
  company: z.string().min(1).max(12),
  vendorId: netsuiteId,
  number: z.string().max(200),
  date: z.string().max(10),
  locationId: netsuiteId.nullable(),
  reason: z.string().max(999),
  lines: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('account'), accountId: netsuiteId.nullable(), amount: z.number().min(0).max(10_000_000), memo: z.string().max(300).optional() }),
    z.object({ kind: z.literal('part'), itemId: netsuiteId.nullable(), quantity: z.number().min(0).max(1_000_000), rate: z.number().min(0).max(10_000_000) }),
  ])).max(MAX_VENDOR_CREDIT_LINES),
  applied: z.array(z.object({ billId: netsuiteId, amount: z.number().min(0).max(10_000_000) })).max(MAX_APPLIED_BILLS).default([]),
  // What the page showed: then nothing changed under it.
  expectedTotalCents: z.number().int(),
});

type Claimed = { netsuite_vendor_credit_id: string | null; claimed_at: string | null; total_cents: number | null; vendor_name: string | null; credit_number: string };

/**
 * POST /api/purchasing/vendor-credit — make the vendor credit in NetSuite, and keep Books' copy. The lines, total and
 * what it applies to bills are worked out here from the copies and the vendor's bills as NetSuite has them now, never
 * taken from the page. Refused while vendor credits are switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const draft: VendorCreditDraft = {
    company: body.company, vendorId: body.vendorId, number: body.number, date: body.date, locationId: body.locationId,
    reason: body.reason, lines: body.lines, applied: body.applied,
  };

  let worked: ReturnType<typeof workOutVendorCredit>;
  let vendorName: string | null = null;
  try {
    const partIds = [...new Set(body.lines.flatMap((l) => (l.kind === 'part' && l.itemId ? [l.itemId] : [])))];
    const [companyRows, vendor, parts] = await Promise.all([readCompanies(service), readVendor(service, body.vendorId), readParts(partIds)]);
    const companies = companiesOf(companyRows);
    const accounts = await readCreditAccounts(companyRows);
    vendorName = vendor?.name ?? null;
    let openBills: OpenBill[] | null = [];
    if (body.applied.length > 0) {
      const open = await readOpenBills(body.vendorId, companies.find((c) => c.code === body.company));
      if (open.error) {
        return NextResponse.json({ error: `Couldn't read the vendor's open bills from NetSuite (${open.error}). Nothing was sent.` }, { status: 502 });
      }
      openBills = open.bills;
    }
    worked = workOutVendorCredit(draft, {
      today: snapToday(), companies, accounts, parts, vendor: vendor ? { id: vendor.id, name: vendor.name } : null, openBills,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
  if (worked.problems.length > 0) return NextResponse.json({ error: worked.problems.join(' ') }, { status: 400 });
  if (worked.totalCents !== body.expectedTotalCents) {
    return NextResponse.json({
      error: `The credit now comes to ${formatCents(worked.totalCents)}, not the ${formatCents(body.expectedTotalCents)} the page showed. Nothing was sent. Reload and check it.`,
    }, { status: 409 });
  }
  const number = body.number.trim();

  // The same credit from the vendor is never entered twice: ask NetSuite first, and refuse when it can't say.
  try {
    const there = await findVendorCredit(body.vendorId, number);
    if (there) {
      return NextResponse.json({
        error: `NetSuite already has vendor credit ${there.number || number} from ${vendorName || 'this vendor'}. Nothing was sent.`,
        vendorCreditId: there.vendorCreditId,
      }, { status: 409 });
    }
  } catch (err: any) {
    return NextResponse.json({
      error: `Couldn't check NetSuite for vendor credit ${number} (${err?.message || err}). Nothing was sent. Try again.`,
    }, { status: 502 });
  }

  // One vendor credit per form, and per vendor's credit number: take the claim, or say what the earlier press did.
  const row = {
    id: body.requestId,
    company: body.company,
    vendor_netsuite_id: body.vendorId,
    vendor_name: vendorName,
    credit_number: number,
    credit_date: body.date,
    location_netsuite_id: body.locationId,
    reason: body.reason.trim(),
    lines: keptVendorCreditLines(worked),
    applied: keptApplied(worked),
    total_cents: worked.totalCents,
    applied_cents: worked.appliedCents,
    created_by: auth.user.id,
    claimed_at: new Date().toISOString(),
  };
  const taken = await claim(row);
  if (taken) return taken;

  const result = await createVendorCredit(netsuiteVendorCredit(worked, draft));

  if (!result.success || !result.vendorCreditId) {
    const error = result.error || "NetSuite didn't make the vendor credit.";
    // NetSuite refused, so nothing was made: let go of the claim so the same form can try again.
    await service.from('typed_vendor_credits')
      .update({ error: error.slice(0, 2000), claimed_at: null, updated_at: new Date().toISOString() }).eq('id', body.requestId);
    return NextResponse.json({ error }, { status: 502 });
  }

  await service.from('typed_vendor_credits').update({
    netsuite_vendor_credit_id: result.vendorCreditId,
    error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', body.requestId);

  // Books' own copy of the vendor credit (never fails the vendor credit).
  const books = await saveOwnVendorCredit(service, {
    netsuiteId: result.vendorCreditId, draft, worked, vendorName, madeFromId: body.requestId, madeBy: auth.user.id,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'typed_vendor_credits',
    recordId: body.requestId,
    action: 'create',
    detail: {
      netsuite_vendor_credit_id: result.vendorCreditId,
      vendor: vendorName,
      credit_number: number,
      total: formatCents(worked.totalCents),
      applied: formatCents(worked.appliedCents),
      lines: worked.lines.length,
      parts_back: worked.lines.filter((l) => l.kind === 'part').length,
    },
  });

  return NextResponse.json({
    success: true,
    vendorCreditId: result.vendorCreditId,
    number,
    vendorName,
    totalCents: worked.totalCents,
    appliedCents: worked.appliedCents,
    ...(books.saved || books.reason === 'already saved' ? {} : { warning: `Books didn't keep its copy (${books.reason}). The vendor credit is in NetSuite.` }),
  });
}

/**
 * Takes the claim for this press. Returns the answer to give instead when the press was already made, is being made,
 * or another press holds the vendor's credit number; null when this press holds the claim.
 */
async function claim(row: Record<string, unknown> & { id: string; vendor_netsuite_id: string; credit_number: string }): Promise<NextResponse | null> {
  const { error: insertError } = await service.from('typed_vendor_credits').insert(row);
  if (!insertError) return null;
  if (insertError.code !== '23505') return NextResponse.json({ error: insertError.message }, { status: 500 });

  const { data: before } = await service.from('typed_vendor_credits')
    .select('netsuite_vendor_credit_id, claimed_at, total_cents, vendor_name, credit_number').eq('id', row.id).maybeSingle();
  const same = before as Claimed | null;
  if (same?.netsuite_vendor_credit_id) {
    return NextResponse.json({
      success: true, already: true, vendorCreditId: same.netsuite_vendor_credit_id, number: same.credit_number,
      vendorName: same.vendor_name, totalCents: same.total_cents,
    });
  }
  if (same) {
    // This form tried before and NetSuite refused: take the claim again, unless a press is still making it.
    const { data: claimed, error } = await service.from('typed_vendor_credits')
      .update({ ...row, error: null, updated_at: new Date().toISOString() })
      .eq('id', row.id).is('claimed_at', null).is('netsuite_vendor_credit_id', null)
      .select('id');
    if (!error && claimed && claimed.length > 0) return null;
    if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });
    if (!error) return NextResponse.json({ error: "This vendor credit is already being made. Don't press again: reload in a minute to see it." }, { status: 409 });
  }

  // Another press holds the vendor's credit number.
  const { data: other } = await service.from('typed_vendor_credits')
    .select('netsuite_vendor_credit_id, claimed_at, total_cents, vendor_name, credit_number')
    .eq('vendor_netsuite_id', row.vendor_netsuite_id)
    .neq('id', row.id)
    .ilike('credit_number', row.credit_number.replace(/[\\%_]/g, (c) => `\\${c}`))
    .or('claimed_at.not.is.null,netsuite_vendor_credit_id.not.is.null')
    .limit(1)
    .maybeSingle();
  const held = other as Claimed | null;
  return NextResponse.json({
    error: held?.netsuite_vendor_credit_id
      ? `FleetSuite already made vendor credit ${held.credit_number} from ${held.vendor_name || 'this vendor'}. Nothing was sent.`
      : `Vendor credit ${row.credit_number} from this vendor is being made from another screen right now. Nothing was sent from this one.`,
  }, { status: 409 });
}
