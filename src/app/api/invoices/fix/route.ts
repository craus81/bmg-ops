import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getInvoiceRecord, patchInvoice } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { saveFixedOwnInvoice, type FixedSaveResult } from '@/lib/books/own-invoices';
import { parseRate } from '@/lib/books/own-invoice-check';
import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { formatCents } from '@/lib/credit-memo';
import { logAudit } from '@/lib/audit';
import {
  MAX_ADDED, fixAllows, invoiceFacts, ownCopyLines, parseFixInvoice, planInvoiceFix, termDays,
  type FixFacts, type FixInvoice, type FixItem,
} from '@/lib/invoice-fix';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Fixing invoices is switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');

/**
 * Anyone with Invoicing who can see prices, once fixing invoices is switched on (Books → Switches); until then only
 * super admins, to see what a fix would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return { auth, on: false, error: NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 }) };
  }
  const on = await switchIsOn(service, 'invoice_fixes');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** The invoice as NetSuite has it now, its tax code's rate filled in from the lists copy when the invoice lacks one. */
async function readInvoice(id: string): Promise<{ invoice: FixInvoice } | { error: string; status: number }> {
  const res = await getInvoiceRecord(id);
  if (!res.success) return { error: res.notFound ? `NetSuite has no invoice with id ${id}.` : res.error, status: res.notFound ? 404 : 502 };
  let invoice = parseFixInvoice(res.record);
  if ((invoice.taxRate === null || invoice.taxRateFrom === 'worked_out') && invoice.taxItemId) {
    const { data } = await service
      .from('gl_netsuite_lists').select('details').eq('kind', 'tax_code').eq('netsuite_id', invoice.taxItemId).maybeSingle();
    const rate = parseRate((data as { details?: Record<string, unknown> } | null)?.details?.rate as string | undefined);
    if (rate !== null && rate > 0) invoice = parseFixInvoice(res.record, { taxCodeRate: rate });
  }
  return { invoice };
}

/** What the fix is planned against, short: anything different means the invoice changed while the page was open. */
const signatureOf = (invoice: FixInvoice) => createHash('sha256').update(invoiceFacts(invoice)).digest('hex').slice(0, 32);

/** What FleetSuite knows that a fix of the invoice is worked out with, apart from the items of lines added. */
async function readFacts(invoice: FixInvoice): Promise<Omit<FixFacts, 'items'>> {
  const [credits, terms, customers] = await Promise.all([
    service.from('invoice_credit_memos').select('id, netsuite_credit_memo_id, claimed_at').eq('invoice_netsuite_id', invoice.id),
    invoice.termsId
      ? service.from('gl_netsuite_lists').select('details').eq('kind', 'term').eq('netsuite_id', invoice.termsId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    invoice.customerId
      ? service.from('customers').select('tax_exempt').eq('netsuite_id', invoice.customerId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const res of [credits, terms, customers]) if (res.error) throw new Error(res.error.message);

  const creditedHere = ((credits.data ?? []) as Array<{ netsuite_credit_memo_id: string | null; claimed_at: string | null }>)
    .some((c) => c.netsuite_credit_memo_id || c.claimed_at);
  // No terms is due the day it's billed, as in NetSuite; terms due on a day of the month FleetSuite can't work out.
  const termsDays = invoice.termsId ? termDays((terms.data as { details?: Record<string, unknown> | null } | null)?.details) : 0;
  const matched = (customers.data ?? []) as Array<{ tax_exempt: boolean | null }>;
  const untaxed: FixFacts['untaxed'] = invoice.locationId === KNOWN_LOCATION_IDS.socialcircle ? 'georgia'
    : matched.length > 0 && matched.every((c) => c.tax_exempt === true) ? 'exempt_customer'
      : null;
  return { allows: fixAllows(invoice, { creditedHere }), termsDays, untaxed };
}

const ITEM_COLUMNS = 'netsuite_id, item_number, display_name, description, item_type, taxable_override';

/** The items of the lines added, as the parts catalog has them. */
async function readItems(ids: string[]): Promise<Map<string, FixItem>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await service.from('netsuite_parts').select(ITEM_COLUMNS).in('netsuite_id', unique);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{
    netsuite_id: string | number; item_number: string | null; display_name: string | null; description: string | null;
    item_type: string | null; taxable_override: boolean | null;
  }>).map((p) => [String(p.netsuite_id), {
    itemId: String(p.netsuite_id),
    itemNumber: p.item_number || '',
    itemType: p.item_type ?? null,
    taxableOverride: p.taxable_override ?? null,
    description: p.description || p.display_name || '',
  }]));
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

/**
 * GET /api/invoices/fix?status=1 — whether fixing invoices is on, and whether this person can use it.
 * GET /api/invoices/fix?invoice=<NetSuite id> — the invoice as NetSuite has it now, what a fix can change, what it's
 * planned against, the fixes FleetSuite made to it, and whether Books has its own copy of it.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const auth = await requireFeature(req, 'invoicing');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'invoice_fixes');
    const money = await profileCanSeeMoney(auth.user.id, auth.profile);
    return NextResponse.json({ on, canUse: money && (on || isSuperAdmin(auth)) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  const id = (req.nextUrl.searchParams.get('invoice') || '').trim();
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad invoice id' }, { status: 400 });

  try {
    const read = await readInvoice(id);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    const { invoice } = read;
    const [facts, fixes, own] = await Promise.all([
      readFacts(invoice),
      service.from('invoice_fixes')
        .select('id, reason, changes, status, error, total_before_cents, total_after_cents, own_copy, created_by, created_at')
        .eq('invoice_netsuite_id', id)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(20),
      service.from('gl_own_invoices').select('version, fixed_at').eq('netsuite_id', id).maybeSingle(),
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
      invoice,
      allows: facts.allows,
      termsDays: facts.termsDays,
      untaxed: facts.untaxed,
      signature: signatureOf(invoice),
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

const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one fix.
  requestId: z.string().uuid(),
  invoiceId: z.string().regex(/^\d+$/),
  // What the page planned against (GET's signature). NetSuite's invoice can change while the page is open: then
  // nothing is sent.
  signature: z.string().min(1).max(100),
  reason: z.string().max(1000),
  header: z.object({
    date: z.string().max(20).optional(),
    poNumber: z.string().max(200).optional(),
    memo: z.string().max(2000).optional(),
    vin: z.string().max(40).optional(),
  }).optional(),
  lines: z.array(z.object({
    line: z.number().int().min(0),
    quantity: z.number().optional(),
    price: z.number().optional(),
    amount: z.number().optional(),
    description: z.string().max(5000).optional(),
    remove: z.boolean().optional(),
  })).max(500).optional(),
  add: z.array(z.object({
    itemId: z.string().regex(/^\d+$/),
    quantity: z.number(),
    price: z.number(),
    description: z.string().max(5000).optional(),
  })).max(MAX_ADDED).optional(),
});

/**
 * POST /api/invoices/fix — fix the invoice in NetSuite, and make the next version of Books' own copy of it. What
 * changes and what NetSuite is sent are worked out here from the invoice as NetSuite has it now, never taken from the
 * page. Refused while fixing invoices is switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  let invoice: FixInvoice;
  let facts: FixFacts;
  try {
    const read = await readInvoice(body.invoiceId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    invoice = read.invoice;
    if (signatureOf(invoice) !== body.signature) {
      return NextResponse.json({
        error: `Invoice ${invoice.number} changed in NetSuite since this page opened. Nothing was sent. Reload it and make the fix again.`,
        stale: true,
      }, { status: 409 });
    }
    const [known, items] = await Promise.all([readFacts(invoice), readItems((body.add ?? []).map((a) => a.itemId))]);
    facts = { ...known, items };
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }

  const plan = planInvoiceFix(invoice, body, facts);
  if (plan.problems.length > 0) return NextResponse.json({ error: plan.problems.join(' '), problems: plan.problems }, { status: 400 });

  // One send per form, and one fix of an invoice at a time: take the claim, or say what's in the way.
  const claim = await service.rpc('invoice_fix_claim', {
    p: {
      id: body.requestId,
      invoice_netsuite_id: invoice.id,
      invoice_number: invoice.number || null,
      customer_netsuite_id: invoice.customerId,
      customer_name: invoice.customerName || null,
      reason: body.reason.trim(),
      changes: plan.changes,
      patch: plan.body,
      replace_lines: plan.replace,
      total_before_cents: invoice.totalCents,
      total_expected_cents: plan.fixed.totalCents,
      by: auth.user.id,
    },
  });
  if (claim.error) return NextResponse.json({ error: claim.error.message }, { status: 500 });
  const claimed = claim.data as { claimed?: boolean; state?: string } | null;
  if (!claimed?.claimed) {
    if (claimed?.state === 'fixed') {
      return NextResponse.json({ success: true, already: true, invoiceNumber: invoice.number, changes: plan.changes });
    }
    return NextResponse.json({
      error: claimed?.state === 'sending'
        ? "This fix is being sent now. Don't press again: reload the invoice in a minute to see it."
        : `Another fix of invoice ${invoice.number} is being sent now. Reload it in a minute and check it before fixing it again.`,
    }, { status: 409 });
  }

  const finish = (p: Record<string, unknown>) => service.rpc('invoice_fix_finish', { p: { id: body.requestId, ...p } });

  const result = await patchInvoice(invoice.id, plan.body, { replace: plan.replace });
  if (!result.success) {
    const error = result.error || "NetSuite didn't answer";
    await finish({ status: result.unsure ? 'unsure' : 'refused', error });
    // NetSuite's own words, without the full stop they may end with, so the sentence reads on.
    const said = error.replace(/[.\s]+$/, '');
    return NextResponse.json(result.unsure
      ? {
        error: `${said}, so FleetSuite can't tell whether the fix went in. Reload the invoice: if the change is there, it went in; if it isn't, fix it again.`,
        unsure: true,
      }
      : { error: `NetSuite didn't take the fix: ${said}. Nothing changed.` }, { status: 502 });
  }

  // NetSuite works the sales tax out again: its total is the one to show.
  const after = await readInvoice(invoice.id).catch(() => null);
  const totalAfterCents = after && 'invoice' in after ? after.invoice.totalCents : null;

  // Books' own copy follows the fix (never fails the fix, which is in NetSuite).
  const own: FixedSaveResult = plan.fixed.date
    ? await saveFixedOwnInvoice(service, {
      netsuiteId: invoice.id,
      fixed: { date: plan.fixed.date, poNumber: plan.fixed.poNumber, memo: plan.fixed.memo, vin: plan.fixed.vin, lines: ownCopyLines(plan.fixed) },
      fixId: body.requestId,
      by: auth.user.id,
    })
    : { saved: false, reason: 'NetSuite gave the invoice no date' };
  const ownVersion = own.saved && typeof own.version === 'number' ? own.version : null;
  const ownCopy = ownVersion !== null ? 'fixed' : own.none ? 'none' : 'not_saved';
  const done = await finish({ status: 'fixed', total_after_cents: totalAfterCents, own_copy: ownCopy, own_copy_version: ownVersion });
  // The fix is in NetSuite either way; a row left sending shows as unsure after five minutes.
  if (done.error) console.error(`[invoice fix] ${body.requestId} went in but wasn't marked fixed: ${done.error.message}`);

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'invoice_fixes',
    recordId: body.requestId,
    action: 'fix',
    detail: {
      netsuite_invoice_id: invoice.id,
      invoice: invoice.number,
      customer: invoice.customerName,
      changes: plan.changes,
      replace: plan.replace,
      total_before: formatCents(invoice.totalCents),
      total_after: totalAfterCents === null ? null : formatCents(totalAfterCents),
      own_copy: ownCopy,
    },
  });

  return NextResponse.json({
    success: true,
    invoiceNumber: invoice.number,
    changes: plan.changes,
    totalBeforeCents: invoice.totalCents,
    totalAfterCents,
    ownCopy,
    ...(ownCopy === 'not_saved'
      ? { warning: `Books' own copy of the invoice didn't follow (${own.reason || 'it said nothing back'}). The fix is in NetSuite.` }
      : {}),
  });
}
