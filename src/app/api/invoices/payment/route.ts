import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createCustomerPayment, findCustomerPayment, getInvoicesOpen, getPaymentInvoices, type PaymentInvoices } from '@/lib/netsuite';
import { switchIsOn } from '@/lib/books/switches';
import { saveOwnPayment } from '@/lib/books/own-payments';
import { chicagoDate } from '@/lib/books/own-invoices';
import { BOOKS_COMPANIES, type BooksCompany } from '@/lib/books/journal';
import { logAudit } from '@/lib/audit';
import {
  MAX_APPLIED, MAX_PAYMENT_CENTS, appliedAsSent, appliedToKeep, formatCents, keptApplied, netsuiteMemo, netsuitePayment,
  paymentExternalId, sameReference, workOutPayment, type PaymentMethod,
} from '@/lib/receive-payment';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = 'Receiving payments is switched off until payments move into FleetSuite during 2027.';

/** A press still being made this long after it was sent never heard back: NetSuite made it or never will. */
const STALE_MS = 5 * 60 * 1000;

/** How far back the page lists the payments FleetSuite received from the customer. */
const EARLIER_DAYS = 60;

type Auth = Awaited<ReturnType<typeof requireFeature>>;
interface Gate { auth: Auth; on: boolean }

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');
const forbidden = () => NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });

/**
 * Anyone with Invoicing who can see prices, once receiving payments is switched on (Books → Switches); until then
 * only super admins, to see what a payment would send.
 */
async function access(req: NextRequest): Promise<Gate & { error?: NextResponse }> {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return { auth, on: false, error: forbidden() };
  const on = await switchIsOn(service, 'customer_payments');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** A press of Receive payment as received_payments keeps it. */
interface PressRow {
  id: string;
  company: string;
  customer_netsuite_id: string;
  customer_name: string | null;
  received_date: string;
  method: PaymentMethod;
  reference: string | null;
  memo: string | null;
  amount_cents: number;
  applied: unknown;
  status: 'open' | 'sending' | 'made';
  sent_by: string | null;
  sent_at: string | null;
  netsuite_payment_id: string | null;
  netsuite_number: string | null;
  error: string | null;
  warning: string | null;
  created_at: string;
}

const PRESS_COLUMNS = 'id, company, customer_netsuite_id, customer_name, received_date, method, reference, memo, amount_cents, applied, '
  + 'status, sent_by, sent_at, netsuite_payment_id, netsuite_number, error, warning, created_at';

const messageOf = (err: unknown) => String((err as any)?.message || err);
const dayOf = (ymd: string) => new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

async function readPress(id: string): Promise<PressRow | null> {
  const { data, error } = await service.from('received_payments').select(PRESS_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PressRow | null) ?? null;
}

/** The company whose books an invoice's subsidiary is, or null when Books has none for it. */
async function companyOf(subsidiaryId: string | null): Promise<BooksCompany | null> {
  if (!subsidiaryId) return null;
  const { data, error } = await service.from('gl_companies').select('code').eq('netsuite_subsidiary_id', subsidiaryId).maybeSingle();
  if (error) throw new Error(error.message);
  const code = (data as { code?: string } | null)?.code;
  return (BOOKS_COMPANIES as readonly string[]).includes(code ?? '') ? (code as BooksCompany) : null;
}

/** Payments FleetSuite received from the customer lately, newest first: made, or being made. */
async function readEarlier(customerId: string): Promise<PressRow[]> {
  const since = new Date(Date.now() - EARLIER_DAYS * 86_400_000).toISOString();
  const { data, error } = await service
    .from('received_payments').select(PRESS_COLUMNS)
    .eq('customer_netsuite_id', customerId).neq('status', 'open').gte('created_at', since)
    .order('created_at', { ascending: false }).order('id').limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PressRow[];
}

/** A check from the customer FleetSuite received already under the same number, made or being made, other than this press. */
async function sameCheck(customerId: string, reference: string | null, except: string): Promise<PressRow | null> {
  const { data, error } = await service
    .from('received_payments').select(PRESS_COLUMNS)
    .eq('customer_netsuite_id', customerId).eq('method', 'check').neq('status', 'open').neq('id', except)
    .order('created_at', { ascending: false }).order('id').limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as PressRow[]).find((r) => sameReference(r.reference, reference)) ?? null;
}

const earlierView = (r: PressRow) => ({
  id: r.id,
  paymentId: r.netsuite_payment_id,
  number: r.netsuite_number,
  date: String(r.received_date).slice(0, 10),
  method: r.method,
  reference: r.reference,
  amountCents: r.amount_cents,
  invoices: keptApplied(r.applied).map((a) => a.number || `Invoice ${a.invoiceId}`),
  making: r.status === 'sending',
  warning: r.warning,
  at: r.created_at,
});

/**
 * GET /api/invoices/payment?status=1 — whether receiving payments is on, and whether this person can use it.
 * GET /api/invoices/payment?invoice=<NetSuite id> — the invoice's customer, that customer's open invoices in its
 * company as NetSuite has them now, and the payments FleetSuite received from the customer lately.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const auth = await requireFeature(req, 'invoicing');
    if (auth.error) return auth.error;
    if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return NextResponse.json({ on: false, canUse: false });
    const on = await switchIsOn(service, 'customer_payments');
    return NextResponse.json({ on, canUse: on || isSuperAdmin(auth) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  const id = (req.nextUrl.searchParams.get('invoice') || '').trim();
  if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'Bad invoice id' }, { status: 400 });

  let read: PaymentInvoices;
  try {
    read = await getPaymentInvoices(id);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't read the invoices from NetSuite (${messageOf(err)}).` }, { status: 502 });
  }
  if (!read.invoice) return NextResponse.json({ error: `NetSuite has no invoice with id ${id}.` }, { status: 404 });

  try {
    const [company, earlier] = await Promise.all([companyOf(read.invoice.subsidiaryId), readEarlier(read.invoice.customerId)]);
    return NextResponse.json({
      today: chicagoDate(),
      customer: { id: read.invoice.customerId, name: read.invoice.customerName },
      company,
      invoice: { id: read.invoice.id, number: read.invoice.number, openCents: read.invoice.openCents },
      open: read.open,
      elsewhere: read.elsewhere,
      earlier: earlier.map(earlierView),
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what it would send; nothing goes to NetSuite.`,
    });
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

const Schema = z.object({
  // Made by the page when it opens: the same form pressed twice is one payment.
  requestId: z.string().uuid(),
  // The invoice Payment was pressed on, whose customer it is.
  invoiceId: z.string().regex(/^\d{1,20}$/),
  date: z.string().max(20),
  method: z.enum(['check', 'ach']),
  reference: z.string().max(200).default(''),
  memo: z.string().max(2000).default(''),
  amountCents: z.number().int().min(0).max(MAX_PAYMENT_CENTS * 10),
  applied: z.array(z.object({
    invoiceId: z.string().regex(/^\d{1,20}$/),
    cents: z.number().int().min(0).max(MAX_PAYMENT_CENTS * 10),
  })).max(MAX_APPLIED * 2),
});

/**
 * POST /api/invoices/payment — receive the payment: worked out again from what NetSuite has open now, never taken
 * from the page, made in NetSuite once under the press's External ID, and kept in Books' own copy. Pressed again,
 * it says what became of the press: made, still being made, or, once that's been a while, what NetSuite has.
 * Refused while receiving payments is switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    const before = await readPress(body.requestId);
    if (before?.status === 'made') return alreadyMade(before);
    if (before?.status === 'sending') return await askNetSuite(before, gate);
    return await receive(body, gate);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

type Body = z.infer<typeof Schema>;

async function letGo(id: string, error: string) {
  await service.rpc('received_payment_let_go', { p: { id, error } });
}

const alreadyMade = (r: PressRow) => NextResponse.json({
  success: true, already: true, paymentId: r.netsuite_payment_id, number: r.netsuite_number, amountCents: r.amount_cents,
  ...(r.warning ? { warning: r.warning } : {}),
});

async function receive(body: Body, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  let read: PaymentInvoices;
  try {
    read = await getPaymentInvoices(body.invoiceId);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't read the invoices from NetSuite (${messageOf(err)}). Nothing was sent.` }, { status: 502 });
  }
  const invoice = read.invoice;
  if (!invoice) return NextResponse.json({ error: `NetSuite has no invoice with id ${body.invoiceId}. Nothing was sent.` }, { status: 404 });
  const company = await companyOf(invoice.subsidiaryId);
  if (!company || !invoice.subsidiaryId) {
    return NextResponse.json({
      error: `Invoice ${invoice.number}'s company isn't in Books, so FleetSuite can't tell whose payment this is. Nothing was sent.`,
    }, { status: 400 });
  }

  const worked = workOutPayment(body, read.open, { today: chicagoDate() });
  if (worked.problems.length > 0) {
    return NextResponse.json({ error: `${worked.problems.join(' ')} Nothing was sent.`, problems: worked.problems }, { status: 400 });
  }
  if (worked.method === 'check') {
    const twin = await sameCheck(invoice.customerId, worked.reference, body.requestId);
    if (twin) {
      return NextResponse.json({
        error: `Check ${twin.reference} from ${invoice.customerName} was received in FleetSuite already, on ${dayOf(twin.received_date)}`
          + `${twin.netsuite_number ? ` (${twin.netsuite_number})` : twin.status === 'sending' ? ', and is being made in NetSuite' : ''}. Nothing was sent.`
          + " If it's another check with the same number, add a letter to its number.",
      }, { status: 409 });
    }
  }

  // One payment per press: take the claim, or say what became of the press.
  const { data, error } = await service.rpc('received_payment_claim', {
    p: {
      id: body.requestId, by: auth.user.id, company, customer_netsuite_id: invoice.customerId, customer_name: invoice.customerName,
      started_from_invoice_id: invoice.id, received_date: worked.date, method: worked.method, reference: worked.reference,
      memo: worked.memo, amount_cents: worked.amountCents, applied: appliedToKeep(worked.applied),
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as { state: 'made' | 'sending' | 'claimed'; payment?: PressRow; netsuite_payment_id?: string; netsuite_number?: string | null };
  if (claim.state === 'made') {
    // Made by a press of the same form just now.
    const made = await readPress(body.requestId);
    return made ? alreadyMade(made) : NextResponse.json({ success: true, already: true, paymentId: claim.netsuite_payment_id, number: claim.netsuite_number ?? null });
  }
  if (!claim.payment) return NextResponse.json({ error: "FleetSuite couldn't take this payment. Nothing was sent. Try again." }, { status: 500 });
  if (claim.state === 'sending') return askNetSuite(claim.payment, gate);
  const press = claim.payment;
  const externalId = paymentExternalId(press.id);

  // NetSuite never takes two payments under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findCustomerPayment(externalId);
    if (there) return finish(press, gate, there.paymentId, there.number || null, { already: true });
  } catch (err) {
    const why = `Couldn't check NetSuite for this payment (${messageOf(err)}).`;
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Try again.` }, { status: 502 });
  }

  const result = await createCustomerPayment(netsuitePayment(worked, { pressId: press.id, customerId: invoice.customerId, subsidiaryId: invoice.subsidiaryId }));
  if (!result.success || !result.paymentId) {
    const why = result.error || "NetSuite didn't make the payment.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('received_payments').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', press.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} Nothing was paid.` }, { status: 502 });
  }

  // Each invoice should now have open what it had less what this paid on it.
  let warning: string | null;
  try {
    warning = appliedAsSent(worked.applied, await getInvoicesOpen(worked.applied.map((a) => a.invoiceId)));
  } catch (err) {
    warning = `FleetSuite couldn't read the invoices back from NetSuite to check how it applied the payment (${messageOf(err)}). Look at the payment in NetSuite.`;
  }
  let number: string | null = null;
  try {
    number = (await findCustomerPayment(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return finish(press, gate, result.paymentId, number, { warning });
}

/** A press that's being made, or that NetSuite didn't answer about: once it's been a while, ask NetSuite what became of it. */
async function askNetSuite(press: PressRow, gate: Gate): Promise<NextResponse> {
  const age = Date.now() - Date.parse(press.sent_at ?? '');
  if (!(age > STALE_MS)) {
    return NextResponse.json({
      error: press.error
        ? `NetSuite didn't say whether it made this payment (${press.error}). Press Ask NetSuite in a few minutes and FleetSuite will find out.`
        : "It's being made in NetSuite now. Don't press again: reload in a minute to see it.",
      ...(press.error ? { unsure: true } : {}),
    }, { status: 409 });
  }
  let there: Awaited<ReturnType<typeof findCustomerPayment>>;
  try {
    there = await findCustomerPayment(paymentExternalId(press.id));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't ask NetSuite what became of this payment (${messageOf(err)}). Try again.`, unsure: true }, { status: 502 });
  }
  if (there) return finish(press, gate, there.paymentId, there.number || null, { already: true });
  const why = 'NetSuite has no payment from this press, so nothing was paid.';
  await letGo(press.id, why);
  return NextResponse.json({ error: `${why} Check the invoices and press Receive payment again.` }, { status: 409 });
}

/** The payment is in NetSuite: keep its id on the press, keep Books' copy, and say so. */
async function finish(
  press: PressRow, { auth }: Gate, paymentId: string, number: string | null, opts: { already?: boolean; warning?: string | null },
): Promise<NextResponse> {
  const warning = opts.warning ?? null;
  const { error } = await service.rpc('received_payment_made', { p: { id: press.id, netsuite_payment_id: paymentId, netsuite_number: number, warning } });
  if (error) console.error(`[payments] press ${press.id} made as NetSuite payment ${paymentId} but not kept: ${error.message}`);

  const applied = keptApplied(press.applied);
  const date = String(press.received_date).slice(0, 10);
  // Books' own copy of the payment (never fails the payment).
  const books = await saveOwnPayment(service, {
    netsuiteId: paymentId, netsuiteNumber: number, company: press.company as BooksCompany, customerNetsuiteId: press.customer_netsuite_id,
    date, method: press.method, reference: press.reference, memo: netsuiteMemo(press.method, press.reference, press.memo),
    amountCents: press.amount_cents, applied, madeFromId: press.id, madeBy: press.sent_by ?? auth.user.id,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'received_payments',
    recordId: press.id,
    action: 'create',
    detail: {
      netsuite_payment_id: paymentId, netsuite_number: number, company: press.company, customer: press.customer_name, date,
      method: press.method, reference: press.reference, total: formatCents(press.amount_cents), invoices: applied.length,
      found_in_netsuite: !!opts.already, applied_as_sent: !warning,
    },
  });

  return NextResponse.json({
    success: true,
    ...(opts.already ? { already: true } : {}),
    paymentId,
    number,
    amountCents: press.amount_cents,
    ...(warning ? { warning } : {}),
    ...(books.saved || books.reason === 'already saved' ? {} : { booksWarning: `Books didn't keep its copy (${books.reason}). The payment is in NetSuite.` }),
  });
}
