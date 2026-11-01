import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getCheckNumbersUsed, getChecksNow, getPrintOnCheckAs, getVendorAddresses, setCheckNumber } from '@/lib/netsuite';
import { switchIsOn } from '@/lib/books/switches';
import { companyNamed, readBankAccounts, readBankCompanies } from '@/lib/books/bank-accounts';
import { logAudit } from '@/lib/audit';
import { accountName, keptPayments, type KeptBill } from '@/lib/pay-vendors';
import {
  CHECK_NUMBER_MAX, SPOILED_REASON_MAX, checkNumbersText, checkStateOf, checkToPrint, layoutOf, layoutProblems, nextCheckNumber,
  numberTaken, numberingProblems, printedCheckOf, storedCheck, type CheckLayout, type CheckNow, type PrintedCheck,
} from '@/lib/check-printing';

export const dynamic = 'force-dynamic';
// Numbering sets each check's number in NetSuite one at a time.
export const maxDuration = 300;

const service = createServiceClient();

const OFF = 'Paying vendors is switched off until it moves into FleetSuite during 2027.';

/** How long a check can say its number is being set before FleetSuite asks NetSuite whether it took it. */
const STALE_MS = 5 * 60 * 1000;
/** How long numbering keeps setting numbers in NetSuite before it stops and leaves the rest for the next press. */
const NUMBERING_BUDGET_MS = 150_000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

interface Gate {
  auth: Auth;
  on: boolean;
  error?: NextResponse;
}

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');

/**
 * As the Pay Vendors page: anyone with Payments who can see prices, once paying vendors is switched on (Books →
 * Switches); until then only super admins, who can line up the stock and print a test page, and no check is numbered.
 */
async function access(req: NextRequest): Promise<Gate> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return { auth, on: false, error: NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 }) };
  }
  const on = await switchIsOn(service, 'vendor_payments');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** A payment run, as much of it as its checks need. */
interface RunRow {
  id: string;
  company: string;
  bank_account_netsuite_id: string | null;
  bank_account_name: string | null;
  pay_date: string;
  memo: string | null;
  status: string;
}

/** One vendor's payment in an approved run. */
interface PaymentRow {
  id: string;
  run_id: string;
  position: number;
  vendor_netsuite_id: string;
  vendor_name: string | null;
  method: string;
  bills: KeptBill[] | null;
  total_cents: number | string;
  status: string;
  netsuite_payment_id: string | null;
}

const CHECK_COLUMNS = 'id, company, bank_account_netsuite_id, check_number, run_id, payment_id, netsuite_payment_id, status, printed_as, '
  + 'numbered_by, numbered_at, error, printed_by, printed_at, spoiled_by, spoiled_at, spoiled_reason';

/** A check number FleetSuite gave, as vendor_checks keeps it (migration 489). */
interface CheckRow {
  id: string;
  company: string;
  bank_account_netsuite_id: string;
  check_number: number | string;
  run_id: string;
  payment_id: string;
  netsuite_payment_id: string;
  status: 'numbering' | 'numbered' | 'printed' | 'spoiled' | 'printed_in_netsuite';
  printed_as: unknown;
  numbered_by: string | null;
  numbered_at: string;
  error: string | null;
  printed_by: string | null;
  printed_at: string | null;
  spoiled_by: string | null;
  spoiled_at: string | null;
  spoiled_reason: string | null;
}

const messageOf = (err: unknown) => String((err as any)?.message || err);
const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const dayOf = (v: string) => String(v).slice(0, 10);
const vendorOf = (p: PaymentRow) => p.vendor_name || `Vendor ${p.vendor_netsuite_id}`;
/** The bills a payment pays, as its stubs list them. */
const billsOf = (p: PaymentRow) => keptPayments([p])[0].bills.map((b) => ({ number: b.number, date: b.date, cents: b.cents }));

async function readRun(id: string): Promise<RunRow | null> {
  const { data, error } = await service.from('vendor_payment_runs')
    .select('id, company, bank_account_netsuite_id, bank_account_name, pay_date, memo, status').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RunRow | null) ?? null;
}

/** A run's payments, in the run's order. */
async function readPayments(runId: string): Promise<PaymentRow[]> {
  const { data, error } = await service.from('vendor_payment_run_payments')
    .select('id, run_id, position, vendor_netsuite_id, vendor_name, method, bills, total_cents, status, netsuite_payment_id')
    .eq('run_id', runId).order('position').order('id').limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PaymentRow[];
}

/** Every check number given a run's checks, spoiled ones too, by number. */
async function readChecks(runId: string): Promise<CheckRow[]> {
  const { data, error } = await service.from('vendor_checks').select(CHECK_COLUMNS).eq('run_id', runId)
    .order('check_number').order('id').limit(1000);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CheckRow[];
}

async function readCheck(id: string): Promise<CheckRow | null> {
  const { data, error } = await service.from('vendor_checks').select(CHECK_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CheckRow | null) ?? null;
}

/** Where each of these bank accounts' checks print, by account; the default for one with none set. */
async function readLayouts(accountIds: string[]): Promise<Map<string, CheckLayout>> {
  const ids = [...new Set(accountIds)];
  const { data, error } = ids.length > 0
    ? await service.from('vendor_check_layouts').select('bank_account_netsuite_id, check_position, right_sixteenths, down_sixteenths')
      .in('bank_account_netsuite_id', ids)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  type Kept = { bank_account_netsuite_id: string; check_position: unknown; right_sixteenths: unknown; down_sixteenths: unknown };
  const kept = new Map(((data ?? []) as Kept[]).map((r) => [r.bank_account_netsuite_id, layoutOf(r)]));
  return new Map(ids.map((id) => [id, kept.get(id) ?? layoutOf(null)]));
}

async function readNames(ids: Array<string | null>): Promise<(id: string | null) => string | null> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  const { data, error } = people.length ? await service.from('profiles').select('id, full_name').in('id', people) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const names = new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
  return (id) => (id ? names.get(id) || 'Someone' : null);
}

/** The highest check number used on a bank account, by FleetSuite's checks or in NetSuite's copy. */
async function lastNumber(accountId: string): Promise<number | null> {
  const { data, error } = await service.rpc('vendor_check_last_number', { p_account: accountId });
  if (error) throw new Error(error.message);
  return data === null || data === undefined ? null : Number(data);
}

/**
 * GET /api/pay-vendors/checks?company=<BMG|1084> — the company's bank accounts (the first company when none is named)
 * and where each one's checks print. GET ?run=<id> — an approved run's checks: each vendor paid by check, the check
 * it has (numbering in NetSuite, numbered, printed, or printed from NetSuite) and the ones that didn't print right,
 * where its bank account's checks print, and the number to suggest for the first check in the printer.
 */
export async function GET(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const params = req.nextUrl.searchParams;

  try {
    const runId = params.get('run');
    if (runId !== null) {
      const run = isUuid(runId) ? await readRun(runId) : null;
      if (!run) return NextResponse.json({ error: "There's no such payment run." }, { status: 404 });
      if ((run.status !== 'approved' && run.status !== 'done') || !run.bank_account_netsuite_id) {
        return NextResponse.json({ error: "Its checks print once it's approved." }, { status: 409 });
      }
      const accountId = run.bank_account_netsuite_id;
      const [payments, rows, layouts, last] = await Promise.all([
        readPayments(run.id), readChecks(run.id), readLayouts([accountId]), lastNumber(accountId),
      ]);
      const name = await readNames(rows.flatMap((r) => [r.numbered_by, r.printed_by, r.spoiled_by]));
      const now = Date.now();
      return NextResponse.json({
        run: { id: run.id, company: run.company, accountId, accountName: run.bank_account_name, status: run.status },
        layout: layouts.get(accountId),
        nextNumber: last === null ? null : nextCheckNumber([last]),
        checks: payments.filter((p) => p.method === 'check').map((p) => {
          const mine = rows.filter((r) => r.payment_id === p.id);
          const live = mine.find((r) => r.status !== 'spoiled') ?? null;
          return {
            paymentId: p.id,
            position: p.position,
            vendorId: p.vendor_netsuite_id,
            vendorName: vendorOf(p),
            totalCents: Number(p.total_cents),
            paymentStatus: p.status,
            billPaymentId: p.netsuite_payment_id,
            check: live ? {
              id: live.id,
              number: Number(live.check_number),
              status: live.status,
              error: live.error,
              // Numbering long enough that NetSuite took the number or never will: Ask NetSuite finds out which.
              stale: live.status === 'numbering' && now - Date.parse(live.numbered_at) > STALE_MS,
              numberedBy: name(live.numbered_by),
              numberedAt: live.numbered_at,
              printedBy: name(live.printed_by),
              printedAt: live.printed_at,
              // What's printed on it, to print it again while it isn't marked printed.
              printed: live.status === 'numbered' ? printedCheckOf(Number(live.check_number), live.printed_as) : null,
            } : null,
            spoiled: mine.filter((r) => r.status === 'spoiled').map((r) => ({
              id: r.id, number: Number(r.check_number), reason: r.spoiled_reason, by: name(r.spoiled_by), at: r.spoiled_at,
            })),
          };
        }),
        switchedOn: gate.on,
      });
    }

    const companies = await readBankCompanies(service);
    const company = companyNamed(companies, (params.get('company') || '').trim() || null);
    if (!company) return NextResponse.json({ error: 'Books has no company by that name with a NetSuite subsidiary.' }, { status: 404 });
    const accounts = await readBankAccounts(service, company);
    const layouts = await readLayouts(accounts.map((a) => a.netsuiteId));
    return NextResponse.json({
      company: company.code,
      accounts: accounts.map((a) => ({ netsuiteId: a.netsuiteId, name: accountName(a), layout: layouts.get(a.netsuiteId) })),
      switchedOn: gate.on,
    });
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

const Schema = z.discriminatedUnion('action', [
  // The run's checks to number, and the number printed on the first check in the printer.
  z.object({
    action: z.literal('number'),
    runId: z.string().uuid(),
    first: z.number().int().min(1).max(CHECK_NUMBER_MAX),
    paymentIds: z.array(z.string().uuid()).min(1).max(50),
  }),
  z.object({ action: z.literal('ask'), checkId: z.string().uuid() }),
  z.object({ action: z.literal('printed'), checkIds: z.array(z.string().uuid()).min(1).max(50) }),
  z.object({ action: z.literal('spoiled'), checkId: z.string().uuid(), reason: z.string().trim().min(1).max(SPOILED_REASON_MAX) }),
  z.object({
    action: z.literal('layout'),
    company: z.string().min(1).max(12),
    accountId: z.string().regex(/^\d{1,20}$/),
    position: z.enum(['top', 'middle', 'bottom']),
    // How far, in sixteenths of an inch: layoutProblems says what's wrong with it, in words.
    right: z.number(),
    down: z.number(),
  }),
]);
type Body = z.infer<typeof Schema>;

/**
 * POST /api/pay-vendors/checks — { action: 'number' } gives an approved run's checks the numbers on the stock in the
 * printer, in the run's order, and sets each in NetSuite, taking it off To Be Printed, then answers with what to
 * print; 'ask' asks NetSuite whether it took a number it didn't answer about; 'printed' marks numbered checks
 * printed; 'spoiled' marks a check that didn't print right, keeping its number with why; 'layout' sets where a bank
 * account's checks print. Everything but the layout is refused while paying vendors is switched off.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action !== 'layout' && !gate.on) {
    return NextResponse.json({ error: `${OFF} No check was numbered, and nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });
  }

  try {
    switch (body.action) {
      case 'number': return await numberChecks(body, gate);
      case 'ask': return await askNetSuite(body, gate);
      case 'printed': return await markPrinted(body, gate);
      case 'spoiled': return await markSpoiled(body, gate);
      case 'layout': return await saveLayout(body, gate);
    }
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

/** A run's check that wasn't numbered, and why. */
interface Skipped { paymentId: string; vendorName: string; why: string }

const NOT_KEPT: Record<string, string> = {
  taken: 'a number FleetSuite gave another check on this bank account: look at it in NetSuite',
  has_check: 'and FleetSuite has a check for it already: reload',
};

async function numberChecks(body: Extract<Body, { action: 'number' }>, { auth }: Gate): Promise<NextResponse> {
  const run = await readRun(body.runId);
  if (!run) return NextResponse.json({ error: "There's no such payment run." }, { status: 404 });
  if ((run.status !== 'approved' && run.status !== 'done') || !run.bank_account_netsuite_id) {
    return NextResponse.json({ error: "Its checks print once it's approved. Nothing was numbered." }, { status: 409 });
  }
  const accountId = run.bank_account_netsuite_id;
  const [payments, rows] = await Promise.all([readPayments(run.id), readChecks(run.id)]);
  const wanted = new Set(body.paymentIds);
  const picked = payments.filter((p) => wanted.has(p.id));
  if (picked.length !== wanted.size || picked.some((p) => p.method !== 'check' || p.status !== 'made' || !p.netsuite_payment_id)) {
    return NextResponse.json({ error: "Only this run's checks made in NetSuite are numbered and printed. Nothing was numbered." }, { status: 400 });
  }
  const live = picked.map((p) => rows.find((r) => r.payment_id === p.id && r.status !== 'spoiled')).filter((r): r is CheckRow => !!r);
  if (live.length > 0) {
    return NextResponse.json({
      error: `This run has ${checkNumbersText(live.map((r) => Number(r.check_number)))} for some of these already: reload. Nothing was numbered.`,
    }, { status: 409 });
  }

  // NetSuite's bill payments now: each still To Be Printed, for what FleetSuite made it; none numbered when it can't say.
  let now: Map<string, CheckNow>;
  try {
    now = await getChecksNow(picked.map((p) => p.netsuite_payment_id as string));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't read these checks' bill payments from NetSuite (${messageOf(err)}). Nothing was numbered.` }, { status: 502 });
  }
  const toNumber: PaymentRow[] = [];
  const skipped: Skipped[] = [];
  const inNetSuite: Array<{ paymentId: string; vendorName: string; number: number }> = [];
  // In the run's order, as they're read.
  for (const p of picked) {
    const spoiled = rows.filter((r) => r.payment_id === p.id && r.status === 'spoiled').map((r) => Number(r.check_number));
    const state = checkStateOf({ vendorId: p.vendor_netsuite_id, cents: Number(p.total_cents) }, now.get(p.netsuite_payment_id as string), spoiled);
    if (state.state === 'to_print') {
      toNumber.push(p);
    } else if (state.state === 'refuse') {
      skipped.push({ paymentId: p.id, vendorName: vendorOf(p), why: state.why });
    } else {
      // Printed from NetSuite's Print Checks before FleetSuite got to it: keep NetSuite's number.
      const { data, error } = await service.rpc('vendor_check_printed_in_netsuite', {
        p: { run_id: run.id, payment_id: p.id, number: state.number, by: auth.user.id },
      });
      const kept = (data as { state?: string } | null)?.state;
      if (!error && kept === 'kept') inNetSuite.push({ paymentId: p.id, vendorName: vendorOf(p), number: state.number });
      else {
        skipped.push({
          paymentId: p.id, vendorName: vendorOf(p),
          why: `NetSuite printed it as check ${state.number}, ${error ? `and FleetSuite couldn't note that (${error.message})` : NOT_KEPT[kept ?? ''] ?? `and it's ${kept}`}.`,
        });
      }
    }
  }
  const nothingNumbered = (status: number, error?: string) => NextResponse.json({
    ...(error ? { error } : { success: true }), numbered: [], skipped, inNetSuite, stopped: null, warnings: [],
  }, { status });
  if (toNumber.length === 0) {
    await audit(auth.user.id, run, 'number_checks', { numbered: [], printed_in_netsuite: inNetSuite.map((c) => c.number), skipped: skipped.length });
    return nothingNumbered(200);
  }

  // The numbers on the stock, in order from the first, each unused on the bank account here and in NetSuite.
  const numbers = toNumber.map((_, i) => body.first + i);
  const past = numberingProblems(body.first, toNumber.length, new Set());
  if (past.length > 0) return nothingNumbered(400, `${past[0]} Nothing was numbered.`);
  const { data: usedHere, error: usedError } = await service.rpc('vendor_check_numbers_used', {
    p_account: accountId, p_from: numbers[0], p_to: numbers[numbers.length - 1],
  });
  if (usedError) return nothingNumbered(500, usedError.message);
  let usedThere: number[];
  try {
    usedThere = await getCheckNumbersUsed(accountId, numbers);
  } catch (err) {
    return nothingNumbered(502, `Couldn't check NetSuite for checks with these numbers (${messageOf(err)}). Nothing was numbered.`);
  }
  const problems = numberingProblems(body.first, toNumber.length, new Set([...((usedHere as number[] | null) ?? []).map(Number), ...usedThere]));
  if (problems.length > 0) return nothingNumbered(409, `${problems[0]} Nothing was numbered.`);

  // What's printed: made out to NetSuite's Print on Check As for each vendor, with its address for the window.
  const vendorIds = toNumber.map((p) => p.vendor_netsuite_id);
  let printAs: Map<string, string>;
  try {
    printAs = await getPrintOnCheckAs(vendorIds);
  } catch (err) {
    return nothingNumbered(502, `Couldn't read the names NetSuite prints on these vendors' checks (${messageOf(err)}). Nothing was numbered.`);
  }
  const addresses = await getVendorAddresses(vendorIds);
  const checks = toNumber.map((p, i) => checkToPrint({
    number: numbers[i], date: dayOf(run.pay_date), vendorName: vendorOf(p), printOnCheckAs: printAs.get(p.vendor_netsuite_id),
    address: addresses.map[p.vendor_netsuite_id], cents: Number(p.total_cents), memo: run.memo, accountName: run.bank_account_name || '',
    bills: billsOf(p),
  }));
  const warnings = toNumber.filter((p) => !addresses.map[p.vendor_netsuite_id])
    .map((p) => `NetSuite has no address for ${vendorOf(p)}: its check shows only the name in the envelope's window.`);

  const { data: claimData, error: claimError } = await service.rpc('vendor_checks_claim', {
    p: {
      run_id: run.id, by: auth.user.id,
      checks: toNumber.map((p, i) => ({ payment_id: p.id, number: numbers[i], printed_as: storedCheck(checks[i]) })),
    },
  });
  if (claimError) return nothingNumbered(500, claimError.message);
  const claim = claimData as { state: string; checks?: Array<{ id: string; payment_id: string; number: number }>; numbers?: number[] };
  if (claim.state !== 'claimed' || !claim.checks) {
    const why: Record<string, string> = {
      taken: `${checkNumbersText((claim.numbers ?? []).map(Number))} ${(claim.numbers ?? []).length === 1 ? 'was' : 'were'} used just now on this bank account.`,
      has_check: 'Some of these were numbered just now: reload.',
      not_made: "Only this run's checks made in NetSuite are numbered and printed.",
      gone: "Its checks print once it's approved.",
    };
    return nothingNumbered(409, `${why[claim.state] ?? `It's ${claim.state}.`} Nothing was numbered.`);
  }

  // Each number set in NetSuite in order, stopping at the first it doesn't take, so the checks printed run on from
  // the first number with none missed. The ones after it are let go, to number next.
  const numbered: Array<{ id: string; paymentId: string; check: PrintedCheck }> = [];
  let stopped: { paymentId: string; vendorName: string; number: number; why: string; unsure: boolean } | null = null;
  const started = Date.now();
  let i = 0;
  for (; i < claim.checks.length; i++) {
    const c = claim.checks[i];
    const p = toNumber.find((x) => x.id === c.payment_id) as PaymentRow;
    if (Date.now() - started > NUMBERING_BUDGET_MS) {
      stopped = { paymentId: p.id, vendorName: vendorOf(p), number: c.number, why: 'FleetSuite stopped here to answer in time: number the rest next.', unsure: false };
      break;
    }
    const result = await setCheckNumber(p.netsuite_payment_id as string, c.number);
    if (result.success) {
      const { data, error } = await service.rpc('vendor_check_numbered', { p: { id: c.id } });
      if (error || !(data as { numbered?: boolean } | null)?.numbered) {
        // NetSuite has the number; Ask NetSuite brings FleetSuite's note of it into line.
        stopped = {
          paymentId: p.id, vendorName: vendorOf(p), number: c.number, unsure: true,
          why: `NetSuite took it, and FleetSuite couldn't note that${error ? ` (${error.message})` : ''}.`,
        };
        i++;
        break;
      }
      numbered.push({ id: c.id, paymentId: p.id, check: checks[toNumber.indexOf(p)] });
      continue;
    }
    const why = result.error || "NetSuite didn't take the number.";
    if (result.unsure) {
      // NetSuite may have taken it: the number stays held until NetSuite is asked.
      await service.from('vendor_checks').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', c.id).eq('status', 'numbering');
      stopped = { paymentId: p.id, vendorName: vendorOf(p), number: c.number, why, unsure: true };
      i++;
      break;
    }
    stopped = { paymentId: p.id, vendorName: vendorOf(p), number: c.number, why, unsure: false };
    break;
  }
  // What wasn't sent, or NetSuite refused, is let go.
  for (const c of claim.checks.slice(i)) await service.rpc('vendor_check_let_go', { p: { id: c.id } });

  await audit(auth.user.id, run, 'number_checks', {
    numbered: numbered.map((n) => n.check.number), printed_in_netsuite: inNetSuite.map((c) => c.number), skipped: skipped.length,
    ...(stopped ? { stopped_at: stopped.number, stopped_why: stopped.why, unsure: stopped.unsure } : {}),
  });
  return NextResponse.json({
    success: true,
    numbered: numbered.map((n) => ({ id: n.id, paymentId: n.paymentId, number: n.check.number, check: n.check })),
    skipped,
    inNetSuite,
    stopped,
    warnings,
  });
}

async function askNetSuite(body: Extract<Body, { action: 'ask' }>, { auth }: Gate): Promise<NextResponse> {
  const row = await readCheck(body.checkId);
  if (!row) return NextResponse.json({ error: "There's no such check: its number was let go. Number it again." }, { status: 404 });
  const number = Number(row.check_number);
  if (row.status !== 'numbering') return NextResponse.json({ success: true, already: true, status: row.status, number });
  if (!(Date.now() - Date.parse(row.numbered_at) > STALE_MS)) {
    return NextResponse.json({
      error: row.error
        ? `NetSuite didn't say whether it took check ${number} (${row.error}). Ask again in a few minutes.`
        : `FleetSuite is setting check ${number} in NetSuite now. Reload in a minute.`,
    }, { status: 409 });
  }
  let now: Map<string, CheckNow>;
  try {
    now = await getChecksNow([row.netsuite_payment_id]);
  } catch (err) {
    return NextResponse.json({ error: `Couldn't ask NetSuite about check ${number} (${messageOf(err)}). Try again.` }, { status: 502 });
  }
  const run = await readRun(row.run_id);
  if (numberTaken(number, now.get(row.netsuite_payment_id))) {
    const { error } = await service.rpc('vendor_check_numbered', { p: { id: row.id } });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (run) await audit(auth.user.id, run, 'number_checks', { numbered: [number], found_in_netsuite: true });
    return NextResponse.json({ success: true, numbered: true, number, check: printedCheckOf(number, row.printed_as) });
  }
  await service.rpc('vendor_check_let_go', { p: { id: row.id } });
  if (run) await audit(auth.user.id, run, 'let_go_check', { number });
  return NextResponse.json({
    error: `NetSuite doesn't have check ${number} on this bill payment, so FleetSuite let the number go. Number it again.`,
  }, { status: 409 });
}

async function markPrinted(body: Extract<Body, { action: 'printed' }>, { auth }: Gate): Promise<NextResponse> {
  const ids = [...new Set(body.checkIds)];
  const { data: found, error: readError } = await service.from('vendor_checks').select(CHECK_COLUMNS).in('id', ids);
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const rows = (found ?? []) as unknown as CheckRow[];
  if (rows.length !== ids.length) return NextResponse.json({ error: "Some of these checks aren't there any more: reload." }, { status: 404 });
  const { data, error } = await service.rpc('vendor_checks_printed', { p: { ids, by: auth.user.id } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const printed = Number((data as { printed?: number } | null)?.printed ?? 0);
  const run = await readRun(rows[0].run_id);
  if (run && printed > 0) {
    await audit(auth.user.id, run, 'print_checks', { printed: rows.filter((r) => r.status === 'numbered').map((r) => Number(r.check_number)) });
  }
  return NextResponse.json({ success: true, printed });
}

async function markSpoiled(body: Extract<Body, { action: 'spoiled' }>, { auth }: Gate): Promise<NextResponse> {
  const row = await readCheck(body.checkId);
  if (!row) return NextResponse.json({ error: "There's no such check: reload." }, { status: 404 });
  const { data, error } = await service.rpc('vendor_check_spoil', { p: { id: row.id, by: auth.user.id, reason: body.reason } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const state = (data as { state?: string } | null)?.state;
  if (state !== 'spoiled') {
    const why: Record<string, string> = {
      numbering: "Its number isn't set in NetSuite yet: ask NetSuite first.",
      printed_in_netsuite: 'It was printed from NetSuite: void or print it again there.',
      already_spoiled: "It's marked as not printed right already.",
      gone: "There's no such check: reload.",
    };
    return NextResponse.json({ error: why[state ?? ''] ?? `It's ${state}.` }, { status: 409 });
  }
  const run = await readRun(row.run_id);
  if (run) await audit(auth.user.id, run, 'spoil_check', { number: Number(row.check_number), reason: body.reason });
  return NextResponse.json({ success: true });
}

async function saveLayout(body: Extract<Body, { action: 'layout' }>, { auth }: Gate): Promise<NextResponse> {
  const company = (await readBankCompanies(service)).find((c) => c.code === body.company);
  if (!company) return NextResponse.json({ error: `Books has no company ${body.company} with a NetSuite subsidiary.` }, { status: 400 });
  const account = (await readBankAccounts(service, company)).find((a) => a.netsuiteId === body.accountId);
  if (!account) return NextResponse.json({ error: "That isn't one of the company's bank accounts." }, { status: 400 });
  const layout: CheckLayout = { position: body.position, right: body.right, down: body.down };
  const problems = layoutProblems(layout);
  if (problems.length > 0) return NextResponse.json({ error: problems[0] }, { status: 400 });
  const { error } = await service.from('vendor_check_layouts').upsert({
    bank_account_netsuite_id: account.netsuiteId, company: company.code, check_position: layout.position, right_sixteenths: layout.right,
    down_sixteenths: layout.down, updated_by: auth.user.id, updated_at: new Date().toISOString(),
  }, { onConflict: 'bank_account_netsuite_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'vendor_check_layouts', recordId: account.netsuiteId, action: 'update',
    detail: { company: company.code, bank_account: accountName(account), position: layout.position, right: layout.right, down: layout.down },
  });
  return NextResponse.json({ success: true, layout });
}

/** An audit entry on the run: who numbered, printed or spoiled which checks. No amounts, and no alerts. */
async function audit(actorId: string, run: RunRow, action: string, detail: Record<string, unknown>) {
  await logAudit(service, {
    actorId, table: 'vendor_payment_runs', recordId: run.id, action,
    detail: { company: run.company, bank_account: run.bank_account_name, ...detail },
  });
}
