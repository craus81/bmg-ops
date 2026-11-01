import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createCreditMemoFromInvoice, getInvoiceCreditMemos, getInvoiceRecord } from '@/lib/netsuite';
import { configuredCreditItem } from '@/lib/credit-item';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { saveOwnCreditMemo } from '@/lib/books/own-credit-memos';
import { parseRate } from '@/lib/books/sales-tax-rates';
import { logAudit } from '@/lib/audit';
import {
  MAX_ADDED_AMOUNTS, MAX_CREDIT_LINES, earlierCredits, formatCents, keptCreditLines, netsuiteCreditLines, parseInvoiceRecord,
  workOutCreditMemo, type EarlierCreditLine, type InvoiceView,
} from '@/lib/credit-memo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Credit memos are switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');

/**
 * Anyone with Invoicing once credit memos are switched on (Books → Switches); until then only super admins, to see
 * what it would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return { auth, on: false, error: auth.error };
  const on = await switchIsOn(service, 'credit_memos');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** The invoice as NetSuite has it now, its tax code's rate filled in from the lists copy when the invoice lacks one. */
async function readInvoice(id: string): Promise<{ invoice: InvoiceView } | { error: string; status: number }> {
  const res = await getInvoiceRecord(id);
  if (!res.success) return { error: res.notFound ? `NetSuite has no invoice with id ${id}.` : res.error, status: res.notFound ? 404 : 502 };
  let invoice = parseInvoiceRecord(res.record);
  if ((invoice.taxRate === null || invoice.taxRateFrom === 'worked_out') && invoice.taxItemId) {
    const { data } = await service
      .from('gl_netsuite_lists').select('details').eq('kind', 'tax_code').eq('netsuite_id', invoice.taxItemId).maybeSingle();
    const rate = parseRate((data as { details?: Record<string, unknown> } | null)?.details?.rate as string | undefined);
    if (rate !== null && rate > 0) invoice = parseInvoiceRecord(res.record, { taxCodeRate: rate });
  }
  return { invoice };
}

interface EarlierRow {
  id: string;
  netsuite_credit_memo_id: string | null;
  netsuite_credit_memo_number: string | null;
  total_cents: number | null;
  reason: string;
  lines: unknown;
  claimed_at: string | null;
  created_at: string;
}

/**
 * Credit memos FleetSuite already made against the invoice, newest first, with one still being made counted too, so
 * two people can't credit the same thing twice.
 */
async function readEarlier(invoiceId: string, except?: string): Promise<{ rows: EarlierRow[]; lines: EarlierCreditLine[] }> {
  let query = service
    .from('invoice_credit_memos')
    .select('id, netsuite_credit_memo_id, netsuite_credit_memo_number, total_cents, reason, lines, claimed_at, created_at')
    .eq('invoice_netsuite_id', invoiceId);
  if (except) query = query.neq('id', except);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as EarlierRow[]).filter((r) => r.netsuite_credit_memo_id || r.claimed_at);
  const lines = rows.flatMap((r) => (Array.isArray(r.lines) ? r.lines : []).map((l: any): EarlierCreditLine => ({
    invoiceLine: typeof l?.invoiceLine === 'number' ? l.invoiceLine : null,
    cents: Number(l?.cents) || 0,
    quantity: typeof l?.quantity === 'number' ? l.quantity : null,
    backToStock: l?.backToStock === true,
  })));
  return { rows, lines };
}

/**
 * GET /api/invoices/credit-memo?status=1 — whether credit memos are on, and whether this person can use them.
 * GET /api/invoices/credit-memo?invoice=<NetSuite id> — the invoice as NetSuite has it now, the credit memos already
 * made against it, the credit item, and whether a credit memo can be sent.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const auth = await requireFeature(req, 'invoicing');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'credit_memos');
    return NextResponse.json({ on, canUse: on || isSuperAdmin(auth) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  const id = (req.nextUrl.searchParams.get('invoice') || '').trim();
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad invoice id' }, { status: 400 });

  try {
    const [read, earlier, creditItem, netsuite] = await Promise.all([
      readInvoice(id),
      readEarlier(id),
      configuredCreditItem(service),
      getInvoiceCreditMemos(id),
    ]);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    return NextResponse.json({
      invoice: read.invoice,
      earlier: {
        fleetsuite: earlier.rows.map((r) => ({
          id: r.id,
          creditMemoId: r.netsuite_credit_memo_id,
          number: r.netsuite_credit_memo_number,
          totalCents: r.total_cents,
          reason: r.reason,
          at: r.created_at,
          making: !r.netsuite_credit_memo_id,
        })),
        lines: earlier.lines,
        netsuite: netsuite.success ? netsuite.creditMemos : null,
        netsuiteError: netsuite.success ? null : netsuite.error,
      },
      creditItem,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what it would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one credit memo.
  requestId: z.string().uuid(),
  invoiceId: z.string().regex(/^\d+$/),
  reason: z.string().max(999),
  lines: z.array(z.object({
    line: z.number().int().min(0),
    quantity: z.number().min(0).max(1_000_000).optional(),
    price: z.number().min(0).max(10_000_000).optional(),
    amount: z.number().min(0).max(10_000_000).optional(),
    backToStock: z.boolean().optional(),
  })).max(MAX_CREDIT_LINES),
  added: z.array(z.object({
    description: z.string().max(300),
    amount: z.number().min(0).max(10_000_000),
    taxable: z.boolean(),
  })).max(MAX_ADDED_AMOUNTS).default([]),
  // What the page showed. NetSuite's invoice can change while the page is open: then nothing is sent.
  expectedTotalCents: z.number().int(),
});

/**
 * POST /api/invoices/credit-memo — make the credit memo in NetSuite from the invoice, and keep Books' copy. The lines,
 * tax and total are worked out here from the invoice as NetSuite has it now, never taken from the page. Refused while
 * credit memos are switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const reason = body.reason.trim();

  let invoice: InvoiceView;
  let earlier: { rows: EarlierRow[]; lines: EarlierCreditLine[] };
  try {
    const read = await readInvoice(body.invoiceId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    invoice = read.invoice;
    earlier = await readEarlier(body.invoiceId, body.requestId);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
  const creditItem = await configuredCreditItem(service);

  const worked = workOutCreditMemo(invoice, body.lines, body.added, { earlier: earlierCredits(earlier.lines), creditItem, reason });
  if (worked.problems.length > 0) return NextResponse.json({ error: worked.problems.join(' ') }, { status: 400 });
  if (worked.totalCents !== body.expectedTotalCents) {
    return NextResponse.json({
      error: `Invoice ${invoice.number} changed in NetSuite since this page opened: the credit now comes to ${formatCents(worked.totalCents)}, not ${formatCents(body.expectedTotalCents)}. Nothing was sent. Reload and check it.`,
    }, { status: 409 });
  }

  // One credit memo per form: take the claim, or say what the earlier press did.
  const row = {
    id: body.requestId,
    invoice_netsuite_id: invoice.id,
    invoice_number: invoice.number || null,
    customer_netsuite_id: invoice.customerId,
    customer_name: invoice.customerName || null,
    reason,
    lines: keptCreditLines(worked.lines),
    total_cents: worked.totalCents,
    created_by: auth.user.id,
    claimed_at: new Date().toISOString(),
  };
  const { error: insertError } = await service.from('invoice_credit_memos').insert(row);
  if (insertError) {
    if (insertError.code !== '23505') return NextResponse.json({ error: insertError.message }, { status: 500 });
    const { data: before } = await service.from('invoice_credit_memos')
      .select('netsuite_credit_memo_id, netsuite_credit_memo_number, total_cents').eq('id', body.requestId).maybeSingle();
    if (before?.netsuite_credit_memo_id) {
      return NextResponse.json({
        success: true, already: true, creditMemoId: before.netsuite_credit_memo_id,
        creditMemoNumber: before.netsuite_credit_memo_number, totalCents: before.total_cents, invoiceNumber: invoice.number,
      });
    }
    const { data: claimed } = await service.from('invoice_credit_memos')
      .update({ ...row, error: null, updated_at: new Date().toISOString() })
      .eq('id', body.requestId).is('claimed_at', null).is('netsuite_credit_memo_id', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({
        error: "This credit memo is already being made. Don't press again: reload the invoice in a minute to see it.",
      }, { status: 409 });
    }
  }

  const result = await createCreditMemoFromInvoice({
    invoiceId: invoice.id,
    lines: netsuiteCreditLines(worked.lines, { invoiceLocationId: invoice.locationId }),
    memo: reason,
  });

  if (!result.success || !result.creditMemoId) {
    const error = result.error || "NetSuite didn't make the credit memo.";
    // NetSuite refused, so nothing was made: let go of the claim so the same form can try again.
    await service.from('invoice_credit_memos')
      .update({ error: error.slice(0, 2000), claimed_at: null, updated_at: new Date().toISOString() }).eq('id', body.requestId);
    return NextResponse.json({ error }, { status: 502 });
  }

  await service.from('invoice_credit_memos').update({
    netsuite_credit_memo_id: result.creditMemoId,
    netsuite_credit_memo_number: result.creditMemoNumber || null,
    error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', body.requestId);

  // Books' own copy of the credit memo (never fails the credit memo).
  const books = await saveOwnCreditMemo(service, {
    netsuiteId: result.creditMemoId,
    netsuiteNumber: result.creditMemoNumber || null,
    invoice,
    worked,
    reason,
    madeFromId: body.requestId,
    madeBy: auth.user.id,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'invoice_credit_memos',
    recordId: body.requestId,
    action: 'create',
    detail: {
      netsuite_credit_memo_id: result.creditMemoId,
      netsuite_credit_memo_number: result.creditMemoNumber || null,
      invoice: invoice.number,
      customer: invoice.customerName,
      total: formatCents(worked.totalCents),
      lines: worked.lines.length,
      back_to_stock: worked.lines.filter((l) => l.backToStock).length,
    },
  });

  return NextResponse.json({
    success: true,
    creditMemoId: result.creditMemoId,
    creditMemoNumber: result.creditMemoNumber || null,
    totalCents: worked.totalCents,
    invoiceNumber: invoice.number,
    ...(books.saved || books.reason === 'already saved' ? {} : { warning: `Books didn't keep its copy (${books.reason}). The credit memo is in NetSuite.` }),
  });
}
