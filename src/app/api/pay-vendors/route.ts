import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createVendorPayment, findVendorPayment, getBillsNow, getOpenBills } from '@/lib/netsuite';
import { switchIsOn } from '@/lib/books/switches';
import { companyNamed, readBankAccounts, readBankCompanies, type BankCompany } from '@/lib/books/bank-accounts';
import { saveOwnBillPayment } from '@/lib/books/own-bill-payments';
import { chicagoDate } from '@/lib/books/own-invoices';
import { isIsoDate, type BooksCompany } from '@/lib/books/journal';
import { logAudit } from '@/lib/audit';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import {
  MAX_BILLS, MAX_PAYMENTS, MAX_PAYMENT_CENTS, MEMO_MAX, REASON_MAX, accountName, billName, formatCents, keptPayments, netsuiteVendorPayment,
  paymentMemo, paymentProblems, paymentsToKeep, runBillIds, vendorPaymentExternalId, workOutRun,
  type BillNow, type KeptBill, type KeptPayment, type OpenBill, type PaymentStatus, type RunPayment, type RunStatus, type WorkedRun,
} from '@/lib/pay-vendors';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = 'Paying vendors is switched off until it moves into FleetSuite during 2027.';

/** How long a payment can say it's being made before FleetSuite asks NetSuite what became of it. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

interface Gate {
  auth: Auth;
  on: boolean;
  /** Super admins approve runs, send them back, and drop a payment from one. */
  superAdmin: boolean;
  error?: NextResponse;
}

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');
const forbidden = () => NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });

/**
 * Anyone with Payments who can see prices, once paying vendors is switched on (Books → Switches); until then only
 * super admins, who can make and save runs to see what they'd pay, and none is asked for approval or sent.
 */
async function access(req: NextRequest): Promise<Gate> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, superAdmin: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return { auth, on: false, superAdmin: false, error: forbidden() };
  const on = await switchIsOn(service, 'vendor_payments');
  const superAdmin = isSuperAdmin(auth);
  if (!on && !superAdmin) return { auth, on, superAdmin, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on, superAdmin };
}

const RUN_COLUMNS = 'id, company, bank_account_netsuite_id, bank_account_name, pay_date, memo, payments, bill_ids, total_cents, status, '
  + 'created_by, created_at, updated_by, updated_at, asked_by, asked_at, returned_by, returned_at, returned_reason, approved_by, approved_at, done_at';

/** A payment run as vendor_payment_runs keeps it. */
interface RunRow {
  id: string;
  company: string;
  bank_account_netsuite_id: string | null;
  bank_account_name: string | null;
  pay_date: string;
  memo: string | null;
  payments: KeptPayment[] | null;
  bill_ids: string[] | null;
  total_cents: number | string;
  status: RunStatus;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  asked_by: string | null;
  asked_at: string | null;
  returned_by: string | null;
  returned_at: string | null;
  returned_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  done_at: string | null;
}

const PAYMENT_COLUMNS = 'id, run_id, position, vendor_netsuite_id, vendor_name, method, bills, bill_ids, total_cents, status, sent_by, sent_at, '
  + 'netsuite_payment_id, netsuite_number, error, dropped_by, dropped_at, dropped_reason, updated_at';

/** One vendor's payment in an approved run, as vendor_payment_run_payments keeps it. */
interface PaymentRow {
  id: string;
  run_id: string;
  position: number;
  vendor_netsuite_id: string;
  vendor_name: string | null;
  method: string;
  bills: KeptBill[] | null;
  bill_ids: string[] | null;
  total_cents: number | string;
  status: PaymentStatus;
  sent_by: string | null;
  sent_at: string | null;
  netsuite_payment_id: string | null;
  netsuite_number: string | null;
  error: string | null;
  dropped_by: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
  updated_at: string;
}

/** The most runs the page lists that aren't paid yet, and that are. */
const OPEN_LIMIT = 200;
const DONE_LIMIT = 25;

const messageOf = (err: unknown) => String((err as any)?.message || err);
const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const dayOf = (v: string) => String(v).slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One payment as the rules take it. */
const paymentOf = (r: PaymentRow): RunPayment => keptPayments([r])[0];

async function readRun(id: string): Promise<RunRow | null> {
  const { data, error } = await service.from('vendor_payment_runs').select(RUN_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RunRow | null) ?? null;
}

async function readPayment(id: string): Promise<PaymentRow | null> {
  const { data, error } = await service.from('vendor_payment_run_payments').select(PAYMENT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PaymentRow | null) ?? null;
}

/** An approved run's payments, in the run's order. */
async function readPayments(runId: string): Promise<PaymentRow[]> {
  const { data, error } = await service.from('vendor_payment_run_payments').select(PAYMENT_COLUMNS).eq('run_id', runId)
    .order('position').order('id').limit(MAX_PAYMENTS);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PaymentRow[];
}

/** The company's runs not paid yet, newest change first, and the last paid. */
async function readRuns(company: BankCompany): Promise<RunRow[]> {
  const [open, done] = await Promise.all([
    service.from('vendor_payment_runs').select(RUN_COLUMNS).eq('company', company.code).neq('status', 'done')
      .order('updated_at', { ascending: false }).order('id').limit(OPEN_LIMIT),
    service.from('vendor_payment_runs').select(RUN_COLUMNS).eq('company', company.code).eq('status', 'done')
      .order('done_at', { ascending: false }).order('id').limit(DONE_LIMIT),
  ]);
  if (open.error) throw new Error(open.error.message);
  if (done.error) throw new Error(done.error.message);
  return [...(open.data ?? []), ...(done.data ?? [])] as unknown as RunRow[];
}

/** The bills of these that another run holds: asked for approval, or with a payment of them not made or dropped yet. */
async function readHeld(ids: readonly string[], except: string | null): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await service.rpc('vendor_payment_bills_held', { p_ids: [...new Set(ids)], p_except: except });
  if (error) throw new Error(error.message);
  return new Set((data as string[] | null) ?? []);
}

async function readNames(ids: Array<string | null>): Promise<(id: string | null) => string | null> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  const { data, error } = people.length ? await service.from('profiles').select('id, full_name').in('id', people) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const names = new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
  return (id) => (id ? names.get(id) || 'Someone' : null);
}

/** A run checked against its company's bank accounts and NetSuite now, as an ask, an approval and a make check it. */
async function checkRun(run: RunRow): Promise<{ worked: WorkedRun; company: BankCompany } | { error: string; status: number }> {
  const company = (await readBankCompanies(service)).find((c) => c.code === run.company);
  if (!company) return { error: `Books has no company ${run.company} with a NetSuite subsidiary.`, status: 400 };
  const payments = keptPayments(run.payments);
  const ids = runBillIds(payments);
  const [accounts, held] = await Promise.all([readBankAccounts(service, company), readHeld(ids, run.id)]);
  let now: Map<string, BillNow>;
  try {
    now = await getBillsNow(ids);
  } catch (err) {
    return { error: `Couldn't check its bills against NetSuite (${messageOf(err)}).`, status: 502 };
  }
  const worked = workOutRun(
    { date: dayOf(run.pay_date), accountId: run.bank_account_netsuite_id ?? '', memo: run.memo ?? '', payments },
    now, accounts, { today: chicagoDate(), held },
  );
  return { worked, company };
}

/** What a run is, for an alert and the approval: its company, day, bank account, vendors, bills and total. */
const describe = (r: RunRow) => {
  const payments = keptPayments(r.payments);
  return `${r.company} payment run dated ${dayOf(r.pay_date)} from ${r.bank_account_name || 'its bank account'}: `
    + `${plural(payments.length, 'vendor')}, ${plural(runBillIds(payments).length, 'bill')}, ${formatCents(Number(r.total_cents))}`
    + `${r.memo ? ` (${r.memo})` : ''}`;
};

/**
 * An alert to these people and to anyone with "Copy me on new alerts" ticked, never to the one who did it. Never
 * throws: the run has moved whatever happens here.
 */
async function tell(ids: Array<string | null | undefined>, actorId: string, alert: { type: string; title: string; body: string; url: string }) {
  try {
    const watchers = await newAlertWatcherIds(service);
    const to = [...new Set([...ids, ...watchers])].filter((p): p is string => !!p && p !== actorId);
    if (to.length > 0) await notifyMany(to, { ...alert, channels: ['in_app', 'push', 'email'] });
  } catch (err) {
    console.error(`[pay-vendors] alert ${alert.type} not sent: ${messageOf(err)}`);
  }
}

/**
 * GET /api/pay-vendors?status=1 — whether paying vendors is on, and whether this person can use it and approve runs.
 * GET /api/pay-vendors?company=<BMG|1084>[&bills=1][&run=<id>] — the company's bank accounts and payment runs (the
 * first company when none is named); with bills=1, or a draft run, the bills NetSuite has open for it now; with a run, that run (and
 * its company), its payments once it's approved, and its bills as NetSuite has them now while it's a draft or asked
 * for. `held` is the bills among those that another run holds.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'vendor_payments');
    if (auth.error) return auth.error;
    if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return NextResponse.json({ on: false, canUse: false, canApprove: false });
    const on = await switchIsOn(service, 'vendor_payments');
    return NextResponse.json({ on, canUse: on || isSuperAdmin(auth), canApprove: on && isSuperAdmin(auth) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const runId = params.get('run');
    const run = isUuid(runId) ? await readRun(runId) : null;
    const companies = await readBankCompanies(service);
    const company = companyNamed(companies, run?.company ?? ((params.get('company') || '').trim() || null));
    if (!company) return NextResponse.json({ error: 'Books has no company by that name with a NetSuite subsidiary.' }, { status: 404 });

    const [accounts, runs, made] = await Promise.all([
      readBankAccounts(service, company),
      readRuns(company),
      run && (run.status === 'approved' || run.status === 'done') ? readPayments(run.id) : Promise.resolve([] as PaymentRow[]),
    ]);

    // What NetSuite has now: the company's open bills, and the run's own bills while it can still change or be approved.
    let bills: OpenBill[] | null = null;
    let billsError: string | null = null;
    // A draft's page ticks from them, so it gets them whether it asks or not.
    if (params.get('bills') || run?.status === 'draft') {
      try {
        bills = await getOpenBills(company.subsidiaryId);
      } catch (err) {
        billsError = `Couldn't read the open bills from NetSuite (${messageOf(err)}).`;
      }
    }
    const runBills = run ? runBillIds(keptPayments(run.payments)) : [];
    let billsNow: Record<string, BillNow> | null = null;
    let checkError: string | null = null;
    if (run && (run.status === 'draft' || run.status === 'waiting') && runBills.length > 0) {
      try {
        billsNow = Object.fromEntries(await getBillsNow(runBills));
      } catch (err) {
        checkError = `Couldn't check its bills against NetSuite (${messageOf(err)}).`;
      }
    }
    const held = await readHeld([...(bills ?? []).map((b) => b.id), ...runBills], run?.id ?? null);

    const name = await readNames([
      ...[...runs, ...(run ? [run] : [])].flatMap((r) => [r.created_by, r.updated_by, r.asked_by, r.returned_by, r.approved_by]),
      ...made.flatMap((p) => [p.sent_by, p.dropped_by]),
    ]);
    const summary = (r: RunRow) => {
      const payments = keptPayments(r.payments);
      return {
        id: r.id,
        company: r.company,
        date: dayOf(r.pay_date),
        accountId: r.bank_account_netsuite_id,
        accountName: r.bank_account_name,
        memo: r.memo,
        status: r.status,
        totalCents: Number(r.total_cents),
        vendorCount: payments.length,
        billCount: runBillIds(payments).length,
        createdBy: name(r.created_by),
        createdById: r.created_by,
        createdAt: r.created_at,
        updatedBy: name(r.updated_by),
        updatedAt: r.updated_at,
        askedBy: name(r.asked_by),
        askedById: r.asked_by,
        askedAt: r.asked_at,
        returnedBy: name(r.returned_by),
        returnedAt: r.returned_at,
        returnedReason: r.returned_reason,
        approvedBy: name(r.approved_by),
        approvedAt: r.approved_at,
        doneAt: r.done_at,
      };
    };
    const now = Date.now();

    return NextResponse.json({
      today: chicagoDate(),
      companies: companies.map((c) => ({ code: c.code, name: c.name })),
      company: company.code,
      accounts,
      bills,
      billsError,
      held: [...held],
      runs: runs.map(summary),
      run: run ? {
        ...summary(run),
        payments: keptPayments(run.payments),
        billsNow,
        checkError,
        made: made.map((p) => ({
          id: p.id,
          position: p.position,
          ...paymentOf(p),
          totalCents: Number(p.total_cents),
          status: p.status,
          sentBy: name(p.sent_by),
          sentAt: p.sent_at,
          // Being made long enough that NetSuite made it or never will: Make asks NetSuite what became of it.
          stale: p.status === 'sending' && now - Date.parse(p.sent_at ?? '') > STALE_MS,
          billPaymentId: p.netsuite_payment_id,
          number: p.netsuite_number,
          error: p.error,
          droppedBy: name(p.dropped_by),
          droppedAt: p.dropped_at,
          droppedReason: p.dropped_reason,
        })),
      } : null,
      me: gate.auth.user.id,
      superAdmin: gate.superAdmin,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can make and save runs to see what they'd pay; none is asked for approval or sent to NetSuite.`,
    });
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const stamp = z.string().min(1).max(60);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    // Made by the page when the run is started.
    id: z.string().uuid(),
    company: z.string().min(1).max(12),
    accountId: netsuiteId.nullable(),
    date: ymd,
    memo: z.string().max(MEMO_MAX).nullable().optional(),
    payments: z.array(z.object({
      vendorId: netsuiteId,
      vendorName: z.string().max(300).nullable().optional(),
      method: z.enum(['check', 'ach']),
      bills: z.array(z.object({
        billId: netsuiteId,
        number: z.string().max(100).nullable().optional(),
        date: ymd.nullable().optional(),
        dueDate: ymd.nullable().optional(),
        // What NetSuite had open on it when it was ticked, for showing; asking checks NetSuite again.
        openCents: z.number().int().min(0).max(100_000_000_000),
        cents: z.number().int().min(0).max(MAX_PAYMENT_CENTS),
      })).max(MAX_BILLS),
    })).max(MAX_PAYMENTS),
  }),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }),
  // updatedAt: the draft as the asker saw it.
  z.object({ action: z.literal('ask'), id: z.string().uuid(), updatedAt: stamp }),
  z.object({ action: z.literal('take_back'), id: z.string().uuid() }),
  z.object({ action: z.literal('send_back'), id: z.string().uuid(), reason: z.string().trim().min(1).max(REASON_MAX) }),
  // askedAt: the ask as the approver saw it.
  z.object({ action: z.literal('approve'), id: z.string().uuid(), askedAt: stamp }),
  // One of an approved run's payments, by its id.
  z.object({ action: z.literal('make'), paymentId: z.string().uuid() }),
  z.object({ action: z.literal('drop'), paymentId: z.string().uuid(), reason: z.string().trim().min(1).max(REASON_MAX) }),
]);
type Body = z.infer<typeof Schema>;

const WHERE_IT_IS: Record<string, string> = {
  draft: "It's a draft now: it was taken back or sent back.",
  waiting: "It's asked for approval: take it back to change it.",
  approved: "It's approved, and its bill payments are being made in NetSuite.",
  done: 'Its bill payments are made or dropped already.',
  gone: "There's no such payment run: it was deleted.",
};
const whereItIs = (status: string) => WHERE_IT_IS[status] ?? `It's ${status}.`;

/**
 * POST /api/pay-vendors — { action: 'save' } saves a draft run, new or changed; 'delete' deletes a draft; 'ask' asks
 * for approval, the run checked against NetSuite first; 'take_back' takes an ask back to a draft; 'send_back' (super
 * admins) sends an ask back with why; 'approve' (super admins who didn't ask) checks it against NetSuite again and
 * approves it, making a payment to be made for each vendor; 'make' makes one of an approved run's payments in NetSuite,
 * once, as a bill payment, and keeps Books' copy; 'drop' (super admins) drops a payment not made yet, leaving its bills
 * open. Asking, approving and making are refused while paying vendors is switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if ((body.action === 'ask' || body.action === 'approve' || body.action === 'make') && !gate.on) {
    return NextResponse.json({
      error: `${OFF} ${body.action === 'ask' ? 'It was saved, and not asked for approval.' : 'Nothing was sent to NetSuite.'}`,
      switchedOff: true,
    }, { status: 403 });
  }
  if ((body.action === 'send_back' || body.action === 'approve' || body.action === 'drop') && !gate.superAdmin) {
    return NextResponse.json({ error: 'Only a super admin approves payment runs, sends them back, or drops a payment from one.' }, { status: 403 });
  }

  try {
    switch (body.action) {
      case 'save': return await save(body, gate);
      case 'delete': return await remove(body, gate);
      case 'ask': return await ask(body, gate);
      case 'take_back': return await takeBack(body, gate);
      case 'send_back': return await sendBack(body, gate);
      case 'approve': return await approve(body, gate);
      case 'make': return await make(body, gate);
      case 'drop': return await drop(body, gate);
    }
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

async function save(body: Extract<Body, { action: 'save' }>, { auth }: Gate) {
  const company = (await readBankCompanies(service)).find((c) => c.code === body.company);
  if (!company) return NextResponse.json({ error: `Books has no company ${body.company} with a NetSuite subsidiary.` }, { status: 400 });
  if (!isIsoDate(body.date)) return NextResponse.json({ error: `${body.date} isn't a day on the calendar.` }, { status: 400 });
  const account = body.accountId ? (await readBankAccounts(service, company)).find((a) => a.netsuiteId === body.accountId) : null;
  if (body.accountId && !account) return NextResponse.json({ error: "That isn't one of the company's bank accounts." }, { status: 400 });

  const { data, error } = await service.rpc('vendor_payment_run_save', {
    p: {
      id: body.id, company: company.code, bank_account_netsuite_id: account?.netsuiteId ?? null,
      bank_account_name: account ? accountName(account) : null, pay_date: body.date, memo: body.memo ?? '', by: auth.user.id,
      payments: paymentsToKeep(body.payments.map((p) => ({
        vendorId: p.vendorId,
        vendorName: p.vendorName ?? null,
        method: p.method,
        bills: p.bills.map((b) => ({
          billId: b.billId, number: b.number ?? null, date: b.date ?? null, dueDate: b.dueDate ?? null, openCents: b.openCents, cents: b.cents,
        })),
      }))),
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { saved: boolean; status: string; updated_at?: string };
  if (!result.saved) return NextResponse.json({ error: `It wasn't saved. ${whereItIs(result.status)}`, status: result.status }, { status: 409 });
  return NextResponse.json({ success: true, updatedAt: result.updated_at });
}

async function remove(body: Extract<Body, { action: 'delete' }>, { auth, superAdmin }: Gate) {
  const run = await readRun(body.id);
  if (!run) return NextResponse.json({ success: true, already: true });
  if (run.status !== 'draft') return NextResponse.json({ error: `Only a draft can be deleted. ${whereItIs(run.status)}` }, { status: 409 });
  if (!superAdmin && run.created_by !== auth.user.id) {
    return NextResponse.json({ error: 'Only whoever started a draft, or a super admin, can delete it.' }, { status: 403 });
  }
  const { data, error } = await service.from('vendor_payment_runs').delete().eq('id', body.id).eq('status', 'draft').select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if ((data ?? []).length === 0) return NextResponse.json({ error: "It wasn't deleted: it was asked for approval just now." }, { status: 409 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_payment_runs', recordId: body.id, action: 'delete',
    detail: { company: run.company, date: dayOf(run.pay_date), total: formatCents(Number(run.total_cents)) },
  });
  return NextResponse.json({ success: true });
}

/** The bills these ids name, as a sentence starts: "Bill 1001 and Bill 1002". */
const billsNamed = (run: RunRow, ids: readonly string[]) => {
  const bills = keptPayments(run.payments).flatMap((p) => p.bills).filter((b) => ids.includes(b.billId));
  const names = bills.length > 0 ? bills.map(billName) : ['Some of its bills'];
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

async function ask(body: Extract<Body, { action: 'ask' }>, { auth }: Gate) {
  const run = await readRun(body.id);
  if (!run) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (run.status !== 'draft') return NextResponse.json({ error: whereItIs(run.status) }, { status: 409 });

  // The same checks approving makes, against what NetSuite has open now, before anyone's asked.
  const checked = await checkRun(run);
  if ('error' in checked) return NextResponse.json({ error: `${checked.error} It wasn't asked for approval.` }, { status: checked.status });
  const { worked } = checked;
  if (worked.problems.length > 0) {
    return NextResponse.json({ error: `${worked.problems[0]} It wasn't asked for approval.`, problems: worked.problems }, { status: 400 });
  }

  const { data, error } = await service.rpc('vendor_payment_run_ask', { p: { id: body.id, by: auth.user.id, updated_at: body.updatedAt } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string; asked_at?: string; held?: string[] };
  if (result.state === 'changed') {
    return NextResponse.json({ error: 'It was changed since you opened it. Reload and check it, then ask again.' }, { status: 409 });
  }
  if (result.state === 'held') {
    const ids = result.held ?? [];
    return NextResponse.json({
      error: `${billsNamed(run, ids)} ${ids.length === 1 ? 'is' : 'are'} in another payment run, waiting for approval or being paid. It wasn't asked for approval.`,
    }, { status: 409 });
  }
  if (result.state !== 'asked') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });

  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_payment_runs', recordId: body.id, action: 'ask_approval',
    detail: {
      company: run.company, date: worked.date, bank_account: run.bank_account_name, vendors: worked.payments.length, bills: worked.billCount,
      total: formatCents(worked.totalCents),
    },
  });
  const approvers = await getSuperAdminIds(auth.user.id);
  await tell(approvers, auth.user.id, {
    type: 'books_payment_run_waiting',
    title: 'A payment run is waiting for approval',
    body: `${describe(run)}. Approve it to make its bill payments in NetSuite, or send it back.`,
    url: deepLinks.payVendors(body.id),
  });
  return NextResponse.json({
    success: true,
    askedAt: result.asked_at,
    ...(approvers.length === 0 ? { warning: "No one else can approve it yet: it needs a super admin who didn't ask." } : {}),
  });
}

async function takeBack(body: Extract<Body, { action: 'take_back' }>, { auth, superAdmin }: Gate) {
  const run = await readRun(body.id);
  if (!run) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (run.status !== 'waiting') return NextResponse.json({ error: whereItIs(run.status) }, { status: 409 });
  if (!superAdmin && run.asked_by !== auth.user.id && run.created_by !== auth.user.id) {
    return NextResponse.json({ error: 'Only whoever started it or asked for it, or a super admin, can take it back.' }, { status: 403 });
  }
  const { data, error } = await service.rpc('vendor_payment_run_take_back', { p: { id: body.id, by: auth.user.id } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== 'taken_back') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });
  await logAudit(service, { actorId: auth.user.id, table: 'vendor_payment_runs', recordId: body.id, action: 'take_back' });
  return NextResponse.json({ success: true });
}

async function sendBack(body: Extract<Body, { action: 'send_back' }>, { auth }: Gate) {
  const run = await readRun(body.id);
  if (!run) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  const { data, error } = await service.rpc('vendor_payment_run_send_back', { p: { id: body.id, by: auth.user.id, reason: body.reason } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string };
  if (result.state !== 'sent_back') return NextResponse.json({ error: whereItIs(result.state) }, { status: 409 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_payment_runs', recordId: body.id, action: 'send_back', detail: { reason: body.reason },
  });
  await tell([run.asked_by, run.created_by], auth.user.id, {
    type: 'books_payment_run_decided',
    title: 'Your payment run was sent back',
    body: `${describe(run)}, sent back to be fixed: ${body.reason}`,
    url: deepLinks.payVendors(body.id),
  });
  return NextResponse.json({ success: true });
}

/** An approved run's payments that are still to be made, by their ids, in the run's order. */
const toMake = (payments: PaymentRow[]) => payments.filter((p) => p.status === 'to_make').map((p) => p.id);

async function approve(body: Extract<Body, { action: 'approve' }>, { auth }: Gate) {
  const run = await readRun(body.id);
  if (!run) return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (run.status === 'approved' || run.status === 'done') {
    return NextResponse.json({ success: true, already: true, toMake: toMake(await readPayments(run.id)) });
  }
  if (run.status === 'draft') return NextResponse.json({ error: `${whereItIs('draft')} Nothing was approved.` }, { status: 409 });
  if (run.asked_by === auth.user.id) {
    return NextResponse.json({ error: "You asked for this one, so a super admin who didn't ask approves it. Nothing was approved." }, { status: 403 });
  }

  // Checked again against what NetSuite has open now: approving it makes its payments.
  const checked = await checkRun(run);
  if ('error' in checked) return NextResponse.json({ error: `${checked.error} It wasn't approved. Try again.` }, { status: checked.status });
  const { worked } = checked;
  if (worked.problems.length > 0) {
    return NextResponse.json({
      error: `${worked.problems.join(' ')} It wasn't approved: send it back to be fixed.`, problems: worked.problems,
    }, { status: 400 });
  }

  const { data, error } = await service.rpc('vendor_payment_run_approve', { p: { id: body.id, approver: auth.user.id, asked_at: body.askedAt } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string };
  if (result.state === 'approved' || result.state === 'done') {
    return NextResponse.json({ success: true, already: true, toMake: toMake(await readPayments(run.id)) });
  }
  if (result.state === 'changed') {
    return NextResponse.json({ error: 'It was taken back or asked for again since you opened it. Reload and check it. Nothing was approved.' }, { status: 409 });
  }
  if (result.state === 'yours') {
    return NextResponse.json({ error: "You asked for this one, so a super admin who didn't ask approves it. Nothing was approved." }, { status: 403 });
  }
  if (result.state !== 'claimed') return NextResponse.json({ error: `${whereItIs(result.state)} Nothing was approved.` }, { status: 409 });

  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_payment_runs', recordId: body.id, action: 'approve',
    detail: {
      company: run.company, date: worked.date, bank_account: run.bank_account_name, vendors: worked.payments.length, bills: worked.billCount,
      total: formatCents(worked.totalCents), asked_by: run.asked_by,
    },
  });
  await tell([run.asked_by, run.created_by], auth.user.id, {
    type: 'books_payment_run_decided',
    title: 'Your payment run was approved',
    body: `${describe(run)}, approved. FleetSuite is making its bill payments in NetSuite.`,
    url: deepLinks.payVendors(body.id),
  });
  return NextResponse.json({ success: true, toMake: toMake(await readPayments(run.id)) });
}

async function letGo(id: string, error: string) {
  await service.rpc('vendor_payment_let_go', { p: { id, error } });
}

const alreadyMade = (p: { netsuite_payment_id: string | null; netsuite_number: string | null; total_cents: number | string }) => NextResponse.json({
  success: true, already: true, billPaymentId: p.netsuite_payment_id, number: p.netsuite_number, totalCents: Number(p.total_cents),
});

async function make(body: Extract<Body, { action: 'make' }>, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  const before = await readPayment(body.paymentId);
  if (!before) return NextResponse.json({ error: "There's no such payment in a payment run." }, { status: 404 });
  if (before.status === 'made') return alreadyMade(before);
  if (before.status === 'dropped') return NextResponse.json({ error: 'It was dropped from the run: its bills are still open in NetSuite.' }, { status: 409 });
  const run = await readRun(before.run_id);
  if (!run || run.status !== 'approved') return NextResponse.json({ error: whereItIs(run?.status ?? 'gone') }, { status: 409 });
  const company = (await readBankCompanies(service)).find((c) => c.code === run.company);
  if (!company || !run.bank_account_netsuite_id) {
    return NextResponse.json({ error: `Books has no company ${run.company} with a NetSuite subsidiary. Nothing was sent.` }, { status: 400 });
  }

  // One bill payment per payment, however often it's pressed: take the claim, or say what became of it.
  const { data, error } = await service.rpc('vendor_payment_claim', { p: { id: before.id, by: auth.user.id } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as { state: 'made' | 'sending' | 'dropped' | 'claimed' | 'gone'; payment?: PaymentRow; netsuite_payment_id?: string; netsuite_number?: string | null };
  if (claim.state === 'made') {
    return alreadyMade({ netsuite_payment_id: claim.netsuite_payment_id ?? null, netsuite_number: claim.netsuite_number ?? null, total_cents: before.total_cents });
  }
  if (claim.state === 'dropped') return NextResponse.json({ error: 'It was dropped from the run: its bills are still open in NetSuite.' }, { status: 409 });
  if (claim.state === 'gone' || !claim.payment) return NextResponse.json({ error: "There's no such payment in a payment run." }, { status: 404 });
  if (claim.state === 'sending') return askNetSuite(claim.payment, run, company, gate);
  const payment = claim.payment;
  const rules = paymentOf(payment);
  const externalId = vendorPaymentExternalId(payment.id);

  // Checked against NetSuite just before it's sent: each bill still open, the vendor's, with at least what it pays.
  let now: Map<string, BillNow>;
  try {
    now = await getBillsNow(rules.bills.map((b) => b.billId));
  } catch (err) {
    const why = `Couldn't check its bills against NetSuite (${messageOf(err)}).`;
    await letGo(payment.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Make it again.` }, { status: 502 });
  }
  const problems = paymentProblems(rules, now);
  if (problems.length > 0) {
    const why = problems.join(' ');
    await letGo(payment.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent: drop it from the run, or fix it in NetSuite and make it again.`, problems }, { status: 400 });
  }

  // NetSuite never takes two bill payments under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findVendorPayment(externalId);
    if (there) return finish(payment, run, company, gate, there, { already: true });
  } catch (err) {
    const why = `Couldn't check NetSuite for this bill payment (${messageOf(err)}).`;
    await letGo(payment.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Make it again.` }, { status: 502 });
  }

  const result = await createVendorPayment(netsuiteVendorPayment(rules, {
    paymentId: payment.id, subsidiaryId: company.subsidiaryId, accountId: run.bank_account_netsuite_id, date: dayOf(run.pay_date), memo: run.memo,
  }));
  if (!result.success || !result.paymentId) {
    const why = result.error || "NetSuite didn't make the bill payment.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('vendor_payment_run_payments').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', payment.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(payment.id, why);
    return NextResponse.json({ error: `${why} No bill payment was made.` }, { status: 502 });
  }

  let there: Awaited<ReturnType<typeof findVendorPayment>> = null;
  try {
    there = await findVendorPayment(externalId);
  } catch {
    // Its number and total are for showing and checking; NetSuite's id is what's kept.
  }
  return finish(payment, run, company, gate, there ?? { paymentId: result.paymentId, number: '', totalCents: null }, {});
}

/** A payment that's being made, or that NetSuite didn't answer about: once it's been a while, ask NetSuite what became of it. */
async function askNetSuite(payment: PaymentRow, run: RunRow, company: BankCompany, gate: Gate): Promise<NextResponse> {
  const age = Date.now() - Date.parse(payment.sent_at ?? '');
  if (!(age > STALE_MS)) {
    return NextResponse.json({
      error: payment.error
        ? `NetSuite didn't say whether it made this bill payment (${payment.error}). Press Ask NetSuite in a few minutes and FleetSuite will find out.`
        : "It's being made in NetSuite now. Don't press again: reload in a minute to see it.",
      ...(payment.error ? { unsure: true } : {}),
    }, { status: 409 });
  }
  let there: Awaited<ReturnType<typeof findVendorPayment>>;
  try {
    there = await findVendorPayment(vendorPaymentExternalId(payment.id));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't ask NetSuite what became of this bill payment (${messageOf(err)}). Try again.`, unsure: true }, { status: 502 });
  }
  if (there) return finish(payment, run, company, gate, there, { already: true });
  const why = 'NetSuite has no bill payment from this press, so none was made.';
  await letGo(payment.id, why);
  return NextResponse.json({ error: `${why} Make it again, or drop it from the run.` }, { status: 409 });
}

/**
 * The bill payment is in NetSuite: keep its id on the payment, keep Books' copy, and say so. When NetSuite's total
 * isn't what FleetSuite sent, Books keeps no copy and says to look at it in NetSuite.
 */
async function finish(
  payment: PaymentRow, run: RunRow, company: BankCompany, { auth }: Gate,
  there: { paymentId: string; number: string; totalCents: number | null }, opts: { already?: boolean },
): Promise<NextResponse> {
  const billPaymentId = there.paymentId;
  const number = there.number || null;
  const { data, error } = await service.rpc('vendor_payment_made', { p: { id: payment.id, netsuite_payment_id: billPaymentId, netsuite_number: number } });
  if (error) console.error(`[pay-vendors] payment ${payment.id} made as NetSuite bill payment ${billPaymentId} but not kept: ${error.message}`);
  const runDone = !!(data as { run_done?: boolean } | null)?.run_done;

  const rules = paymentOf(payment);
  const totalCents = Number(payment.total_cents);
  const differs = there.totalCents !== null && there.totalCents !== totalCents;
  // Books' own copy of the bill payment (never fails it).
  const books = differs
    ? { saved: false, reason: `NetSuite's bill payment comes to ${formatCents(there.totalCents ?? 0)}, not the ${formatCents(totalCents)} FleetSuite sent: look at it in NetSuite` }
    : await saveOwnBillPayment(service, {
      netsuiteId: billPaymentId, netsuiteNumber: number, company: company.code as BooksCompany, vendorNetsuiteId: rules.vendorId,
      vendorName: rules.vendorName, bankAccountNetsuiteId: run.bank_account_netsuite_id ?? '', date: dayOf(run.pay_date), method: rules.method,
      memo: paymentMemo(rules.method, run.memo) || null,
      bills: rules.bills.map((b) => ({ netsuiteId: b.billId, number: b.number, cents: b.cents })), totalCents,
      madeFromRun: run.id, madeFromPayment: payment.id, askedBy: run.asked_by, approvedBy: run.approved_by,
    });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'vendor_payment_run_payments',
    recordId: payment.id,
    action: 'create',
    detail: {
      netsuite_payment_id: billPaymentId, netsuite_number: number, run: run.id, company: run.company, vendor: rules.vendorName ?? rules.vendorId,
      method: rules.method, bank_account: run.bank_account_name, date: dayOf(run.pay_date), bills: rules.bills.map(billName),
      total: formatCents(totalCents), ...(differs ? { netsuite_total: formatCents(there.totalCents ?? 0) } : {}), found_in_netsuite: !!opts.already,
    },
  });

  return NextResponse.json({
    success: true,
    ...(opts.already ? { already: true } : {}),
    billPaymentId,
    number,
    totalCents,
    runDone,
    ...(books.saved || books.reason === 'already saved' ? {} : { booksWarning: `Books didn't keep its copy (${books.reason}). The bill payment is in NetSuite.` }),
  });
}

async function drop(body: Extract<Body, { action: 'drop' }>, { auth }: Gate) {
  const payment = await readPayment(body.paymentId);
  if (!payment) return NextResponse.json({ error: "There's no such payment in a payment run." }, { status: 404 });
  const { data, error } = await service.rpc('vendor_payment_drop', { p: { id: payment.id, by: auth.user.id, reason: body.reason } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { state: string; run_done?: boolean };
  if (result.state !== 'dropped') {
    const why: Record<string, string> = {
      sending: "It's being made in NetSuite now, so it can't be dropped.",
      made: "It's in NetSuite already, so it can't be dropped.",
      already_dropped: 'It was dropped already.',
      gone: "There's no such payment in a payment run.",
    };
    return NextResponse.json({ error: why[result.state] ?? `It's ${result.state}.` }, { status: 409 });
  }
  const rules = paymentOf(payment);
  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_payment_run_payments', recordId: payment.id, action: 'drop',
    detail: { run: payment.run_id, vendor: rules.vendorName ?? rules.vendorId, bills: rules.bills.map(billName), reason: body.reason },
  });
  return NextResponse.json({ success: true, runDone: !!result.run_done });
}
