import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createCustomerDeposit, findCustomerDeposit, getDepositSalesOrder, type DepositSalesOrder } from '@/lib/netsuite';
import { switchIsOn } from '@/lib/books/switches';
import { saveOwnDeposit } from '@/lib/books/own-deposits';
import { chicagoDate } from '@/lib/books/own-invoices';
import { BOOKS_COMPANIES, type BooksCompany } from '@/lib/books/journal';
import { logAudit } from '@/lib/audit';
import { MAX_PAYMENT_CENTS, netsuiteMemo, sameReference, type PaymentMethod } from '@/lib/receive-payment';
import {
  depositExternalId, depositsOnOrder, formatCents, netsuiteDeposit, workOutDeposit, type DepositOnOrder,
} from '@/lib/take-deposit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = 'Taking deposits is switched off until deposits move into FleetSuite during 2027.';

/** A press still being made this long after it was sent never heard back: NetSuite made it or never will. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;
interface Gate { auth: Auth; on: boolean }

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');
const forbidden = () => NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });

/**
 * Anyone with Invoicing who can see prices, once taking deposits is switched on (Books → Switches); until then only
 * super admins, to see what a deposit would send.
 */
async function access(req: NextRequest): Promise<Gate & { error?: NextResponse }> {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return { auth, on: false, error: forbidden() };
  const on = await switchIsOn(service, 'customer_deposits');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** A press of Take deposit as received_deposits keeps it. */
interface PressRow {
  id: string;
  company: string;
  customer_netsuite_id: string;
  customer_name: string | null;
  sales_order_netsuite_id: string;
  sales_order_number: string | null;
  received_date: string;
  method: PaymentMethod;
  reference: string | null;
  memo: string | null;
  amount_cents: number;
  status: 'open' | 'sending' | 'made';
  sent_by: string | null;
  sent_at: string | null;
  netsuite_deposit_id: string | null;
  netsuite_number: string | null;
  error: string | null;
  created_at: string;
}

const PRESS_COLUMNS = 'id, company, customer_netsuite_id, customer_name, sales_order_netsuite_id, sales_order_number, received_date, '
  + 'method, reference, memo, amount_cents, status, sent_by, sent_at, netsuite_deposit_id, netsuite_number, error, created_at';

const messageOf = (err: unknown) => String((err as any)?.message || err);
const dayOf = (ymd: string) => new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

async function readPress(id: string): Promise<PressRow | null> {
  const { data, error } = await service.from('received_deposits').select(PRESS_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PressRow | null) ?? null;
}

/** The company whose books an order's subsidiary is, or null when Books has none for it. */
async function companyOf(subsidiaryId: string | null): Promise<BooksCompany | null> {
  if (!subsidiaryId) return null;
  const { data, error } = await service.from('gl_companies').select('code').eq('netsuite_subsidiary_id', subsidiaryId).maybeSingle();
  if (error) throw new Error(error.message);
  const code = (data as { code?: string } | null)?.code;
  return (BOOKS_COMPANIES as readonly string[]).includes(code ?? '') ? (code as BooksCompany) : null;
}

/**
 * The deposits on an order already, other than the press `except`: the ones taken in FleetSuite, made or being made,
 * and the ones the books' copy of NetSuite's deposits has on it (copied every two hours), each once.
 */
async function readOnOrder(salesOrderId: string, except: string | null): Promise<DepositOnOrder[]> {
  let taken = service.from('received_deposits').select(PRESS_COLUMNS).eq('sales_order_netsuite_id', salesOrderId).neq('status', 'open');
  if (except) taken = taken.neq('id', except);
  const [ours, copy] = await Promise.all([
    taken.order('created_at').order('id').limit(200),
    service.from('gl_netsuite_deposits').select('netsuite_id, tranid, trandate, total')
      .eq('tran_type', 'CustDep').eq('voided', false).is('gone_at', null).contains('links', [{ netsuite_id: salesOrderId }])
      .order('trandate').order('netsuite_id').limit(200),
  ]);
  if (ours.error) throw new Error(ours.error.message);
  if (copy.error) throw new Error(copy.error.message);
  return depositsOnOrder(
    ((ours.data ?? []) as unknown as PressRow[]).map((r) => ({
      netsuiteId: r.netsuite_deposit_id, number: r.netsuite_number, date: String(r.received_date).slice(0, 10), cents: r.amount_cents,
      inFleetSuite: true, making: r.status === 'sending',
    })),
    ((copy.data ?? []) as Array<{ netsuite_id: string; tranid: string | null; trandate: string; total: number | string }>).map((r) => ({
      netsuiteId: r.netsuite_id, number: r.tranid, date: String(r.trandate).slice(0, 10), cents: Math.round(Number(r.total) * 100),
      inFleetSuite: false, making: false,
    })),
  );
}

/** A check from the customer FleetSuite took already under the same number, as a deposit or a payment, other than this press. */
async function sameCheck(customerId: string, reference: string | null, except: string) {
  const [deposits, payments] = await Promise.all([
    service.from('received_deposits').select('id, reference, received_date, status, netsuite_number, sales_order_number')
      .eq('customer_netsuite_id', customerId).eq('method', 'check').neq('status', 'open').neq('id', except)
      .order('created_at', { ascending: false }).order('id').limit(500),
    service.from('received_payments').select('id, reference, received_date, status, netsuite_number')
      .eq('customer_netsuite_id', customerId).eq('method', 'check').neq('status', 'open')
      .order('created_at', { ascending: false }).order('id').limit(500),
  ]);
  if (deposits.error) throw new Error(deposits.error.message);
  if (payments.error) throw new Error(payments.error.message);
  type Twin = { reference: string | null; received_date: string; status: string; netsuite_number: string | null; sales_order_number?: string | null };
  const deposit = ((deposits.data ?? []) as Twin[]).find((r) => sameReference(r.reference, reference));
  if (deposit) return { ...deposit, as: `as a deposit on ${deposit.sales_order_number || 'a sales order'}` };
  const payment = ((payments.data ?? []) as Twin[]).find((r) => sameReference(r.reference, reference));
  return payment ? { ...payment, as: 'as a payment' } : null;
}

/** The order as the page shows it. */
const orderView = (o: DepositSalesOrder) => ({
  id: o.id, number: o.number, date: o.date, status: o.status, statusName: o.statusName, totalCents: o.totalCents,
});

/**
 * GET /api/sales-orders/deposit?status=1 — whether taking deposits is on, and whether this person can use it.
 * GET /api/sales-orders/deposit?so=<NetSuite id> — the order as NetSuite has it now, its customer and company, and
 * the deposits on it already.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const auth = await requireFeature(req, 'invoicing');
    if (auth.error) return auth.error;
    if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return NextResponse.json({ on: false, canUse: false });
    const on = await switchIsOn(service, 'customer_deposits');
    return NextResponse.json({ on, canUse: on || isSuperAdmin(auth) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  const id = (req.nextUrl.searchParams.get('so') || '').trim();
  if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'Bad sales order id' }, { status: 400 });

  let order: DepositSalesOrder | null;
  try {
    order = await getDepositSalesOrder(id);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't read the sales order from NetSuite (${messageOf(err)}).` }, { status: 502 });
  }
  if (!order) return NextResponse.json({ error: `NetSuite has no sales order with id ${id}.` }, { status: 404 });

  try {
    const [company, onOrder] = await Promise.all([companyOf(order.subsidiaryId), readOnOrder(order.id, null)]);
    return NextResponse.json({
      today: chicagoDate(),
      customer: { id: order.customerId, name: order.customerName },
      company,
      order: orderView(order),
      onOrder,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what it would send; nothing goes to NetSuite.`,
    });
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

const Schema = z.object({
  // Made by the page when it opens: the same form pressed twice is one deposit.
  requestId: z.string().uuid(),
  // The sales order it goes on.
  salesOrderId: z.string().regex(/^\d{1,20}$/),
  date: z.string().max(20),
  method: z.enum(['check', 'ach']),
  reference: z.string().max(200).default(''),
  memo: z.string().max(2000).default(''),
  amountCents: z.number().int().min(0).max(MAX_PAYMENT_CENTS * 10),
});

/**
 * POST /api/sales-orders/deposit — take the deposit: worked out again from the order as NetSuite has it now, never
 * taken from the page, made in NetSuite once under the press's External ID, and kept in Books' own copy. Pressed
 * again, it says what became of the press: made, still being made, or, once that's been a while, what NetSuite has.
 * Refused while taking deposits is switched off, for everyone.
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
    return await take(body, gate);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

type Body = z.infer<typeof Schema>;

async function letGo(id: string, error: string) {
  await service.rpc('received_deposit_let_go', { p: { id, error } });
}

const alreadyMade = (r: PressRow) => NextResponse.json({
  success: true, already: true, depositId: r.netsuite_deposit_id, number: r.netsuite_number, amountCents: r.amount_cents,
});

async function take(body: Body, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  let order: DepositSalesOrder | null;
  try {
    order = await getDepositSalesOrder(body.salesOrderId);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't read the sales order from NetSuite (${messageOf(err)}). Nothing was sent.` }, { status: 502 });
  }
  if (!order) return NextResponse.json({ error: `NetSuite has no sales order with id ${body.salesOrderId}. Nothing was sent.` }, { status: 404 });
  const company = await companyOf(order.subsidiaryId);
  if (!company || !order.subsidiaryId) {
    return NextResponse.json({
      error: `${order.number}'s company isn't in Books, so FleetSuite can't tell whose deposit this is. Nothing was sent.`,
    }, { status: 400 });
  }

  const worked = workOutDeposit(body, order, await readOnOrder(order.id, body.requestId), { today: chicagoDate() });
  if (worked.problems.length > 0) {
    return NextResponse.json({ error: `${worked.problems.join(' ')} Nothing was sent.`, problems: worked.problems }, { status: 400 });
  }
  if (worked.method === 'check') {
    const twin = await sameCheck(order.customerId, worked.reference, body.requestId);
    if (twin) {
      return NextResponse.json({
        error: `Check ${twin.reference} from ${order.customerName} was taken in FleetSuite already, on ${dayOf(twin.received_date)}, ${twin.as}`
          + `${twin.netsuite_number ? ` (${twin.netsuite_number})` : twin.status === 'sending' ? ', and is being made in NetSuite' : ''}. Nothing was sent.`
          + " If it's another check with the same number, add a letter to its number.",
      }, { status: 409 });
    }
  }

  // One deposit per press: take the claim, or say what became of the press.
  const { data, error } = await service.rpc('received_deposit_claim', {
    p: {
      id: body.requestId, by: auth.user.id, company, customer_netsuite_id: order.customerId, customer_name: order.customerName,
      sales_order_netsuite_id: order.id, sales_order_number: order.number, received_date: worked.date, method: worked.method,
      reference: worked.reference, memo: worked.memo, amount_cents: worked.amountCents,
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as { state: 'made' | 'sending' | 'claimed'; deposit?: PressRow; netsuite_deposit_id?: string; netsuite_number?: string | null };
  if (claim.state === 'made') {
    // Made by a press of the same form just now.
    const made = await readPress(body.requestId);
    return made ? alreadyMade(made) : NextResponse.json({ success: true, already: true, depositId: claim.netsuite_deposit_id, number: claim.netsuite_number ?? null });
  }
  if (!claim.deposit) return NextResponse.json({ error: "FleetSuite couldn't take this deposit. Nothing was sent. Try again." }, { status: 500 });
  if (claim.state === 'sending') return askNetSuite(claim.deposit, gate);
  const press = claim.deposit;
  const externalId = depositExternalId(press.id);

  // NetSuite never takes two deposits under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findCustomerDeposit(externalId);
    if (there) return finish(press, gate, there.depositId, there.number || null, { already: true });
  } catch (err) {
    const why = `Couldn't check NetSuite for this deposit (${messageOf(err)}).`;
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Try again.` }, { status: 502 });
  }

  const result = await createCustomerDeposit(netsuiteDeposit(worked, {
    pressId: press.id, customerId: order.customerId, subsidiaryId: order.subsidiaryId, salesOrderId: order.id,
  }));
  if (!result.success || !result.depositId) {
    const why = result.error || "NetSuite didn't make the deposit.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('received_deposits').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', press.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} No deposit was taken.` }, { status: 502 });
  }

  let number: string | null = null;
  try {
    number = (await findCustomerDeposit(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return finish(press, gate, result.depositId, number, {});
}

/** A press that's being made, or that NetSuite didn't answer about: once it's been a while, ask NetSuite what became of it. */
async function askNetSuite(press: PressRow, gate: Gate): Promise<NextResponse> {
  const age = Date.now() - Date.parse(press.sent_at ?? '');
  if (!(age > STALE_MS)) {
    return NextResponse.json({
      error: press.error
        ? `NetSuite didn't say whether it made this deposit (${press.error}). Press Ask NetSuite in a few minutes and FleetSuite will find out.`
        : "It's being made in NetSuite now. Don't press again: reload in a minute to see it.",
      ...(press.error ? { unsure: true } : {}),
    }, { status: 409 });
  }
  let there: Awaited<ReturnType<typeof findCustomerDeposit>>;
  try {
    there = await findCustomerDeposit(depositExternalId(press.id));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't ask NetSuite what became of this deposit (${messageOf(err)}). Try again.`, unsure: true }, { status: 502 });
  }
  if (there) return finish(press, gate, there.depositId, there.number || null, { already: true });
  const why = 'NetSuite has no deposit from this press, so none was taken.';
  await letGo(press.id, why);
  return NextResponse.json({ error: `${why} Check the order and press Take deposit again.` }, { status: 409 });
}

/** The deposit is in NetSuite: keep its id on the press, keep Books' copy, and say so. */
async function finish(
  press: PressRow, { auth }: Gate, depositId: string, number: string | null, opts: { already?: boolean },
): Promise<NextResponse> {
  const { error } = await service.rpc('received_deposit_made', { p: { id: press.id, netsuite_deposit_id: depositId, netsuite_number: number } });
  if (error) console.error(`[deposits] press ${press.id} made as NetSuite deposit ${depositId} but not kept: ${error.message}`);

  const date = String(press.received_date).slice(0, 10);
  // Books' own copy of the deposit (never fails the deposit).
  const books = await saveOwnDeposit(service, {
    netsuiteId: depositId, netsuiteNumber: number, company: press.company as BooksCompany, customerNetsuiteId: press.customer_netsuite_id,
    salesOrderNetsuiteId: press.sales_order_netsuite_id, salesOrderNumber: press.sales_order_number, date, method: press.method,
    reference: press.reference, memo: netsuiteMemo(press.method, press.reference, press.memo), amountCents: press.amount_cents,
    madeFromId: press.id, madeBy: press.sent_by ?? auth.user.id,
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'received_deposits',
    recordId: press.id,
    action: 'create',
    detail: {
      netsuite_deposit_id: depositId, netsuite_number: number, company: press.company, customer: press.customer_name,
      sales_order: press.sales_order_number, date, method: press.method, reference: press.reference,
      total: formatCents(press.amount_cents), found_in_netsuite: !!opts.already,
    },
  });

  return NextResponse.json({
    success: true,
    ...(opts.already ? { already: true } : {}),
    depositId,
    number,
    amountCents: press.amount_cents,
    ...(books.saved || books.reason === 'already saved' ? {} : { booksWarning: `Books didn't keep its copy (${books.reason}). The deposit is in NetSuite.` }),
  });
}
