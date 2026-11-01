import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createBankDeposit, findBankDeposit, getUndepositedFunds } from '@/lib/netsuite';
import { switchIsOn } from '@/lib/books/switches';
import { saveOwnBankDeposit } from '@/lib/books/own-bank-deposits';
import { chicagoDate } from '@/lib/books/own-invoices';
import { BOOKS_COMPANIES, type BooksCompany } from '@/lib/books/journal';
import { logAudit } from '@/lib/audit';
import { OLDEST_DAYS } from '@/lib/receive-payment';
import {
  MAX_LINES, accountName, bankDepositExternalId, formatCents, netsuiteBankDeposit, workOutBankDeposit,
  type BankAccount, type WaitingItem,
} from '@/lib/bank-deposit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = 'Bank deposits are switched off until they move into FleetSuite during 2027.';

/** A press still being made this long after it was sent never heard back: NetSuite made it or never will. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireFeature>>;
interface Gate { auth: Auth; on: boolean }

const isSuperAdmin = (auth: Auth) => getProfileRoles(auth.profile).includes('super_admin');
const forbidden = () => NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });

/**
 * Anyone with Invoicing who can see prices, once bank deposits are switched on (Books → Switches); until then only
 * super admins, to see what a bank deposit would send.
 */
async function access(req: NextRequest): Promise<Gate & { error?: NextResponse }> {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return { auth, on: false, error: forbidden() };
  const on = await switchIsOn(service, 'bank_deposits');
  if (!on && !isSuperAdmin(auth)) return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  return { auth, on };
}

/** A payment or deposit in a press, as made_bank_deposits keeps it. */
interface PressLine {
  netsuite_id: string;
  kind: 'payment' | 'deposit';
  number: string;
  date: string;
  customer_name: string;
  reference: string | null;
  cents: number;
}

/** A press of Make deposit as made_bank_deposits keeps it. */
interface PressRow {
  id: string;
  company: string;
  subsidiary_netsuite_id: string;
  bank_account_netsuite_id: string;
  bank_account_name: string | null;
  deposit_date: string;
  memo: string | null;
  lines: PressLine[];
  total_cents: number;
  status: 'open' | 'sending' | 'made';
  sent_by: string | null;
  sent_at: string | null;
  netsuite_deposit_id: string | null;
  netsuite_number: string | null;
  error: string | null;
  created_at: string;
}

const PRESS_COLUMNS = 'id, company, subsidiary_netsuite_id, bank_account_netsuite_id, bank_account_name, deposit_date, memo, lines, '
  + 'total_cents, status, sent_by, sent_at, netsuite_deposit_id, netsuite_number, error, created_at';

const messageOf = (err: unknown) => String((err as any)?.message || err);

const DAY_MS = 86_400_000;
/** The oldest day a payment waiting in Undeposited Funds is read from: a year back, as far back as a bank deposit goes. */
const sinceOf = (today: string) => new Date(Date.parse(`${today}T00:00:00Z`) - OLDEST_DAYS * DAY_MS).toISOString().slice(0, 10);

async function readPress(id: string): Promise<PressRow | null> {
  const { data, error } = await service.from('made_bank_deposits').select(PRESS_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PressRow | null) ?? null;
}

interface Company { code: BooksCompany; name: string; id: string; subsidiaryId: string }

/** The companies Books has a NetSuite subsidiary for, in Books' order. */
async function readCompanies(): Promise<Company[]> {
  const { data, error } = await service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id').eq('active', true).order('code');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; code: string; name: string; netsuite_subsidiary_id: string | null }>;
  return BOOKS_COMPANIES.flatMap((code) => {
    const row = rows.find((r) => r.code === code);
    return row && /^\d+$/.test(row.netsuite_subsidiary_id ?? '')
      ? [{ code, name: row.name, id: row.id, subsidiaryId: row.netsuite_subsidiary_id as string }]
      : [];
  });
}

/** The company's bank accounts, as Books' chart of accounts has them from NetSuite: active, posting, in its subsidiary. */
async function readAccounts(company: Company): Promise<BankAccount[]> {
  const { data, error } = await service.from('gl_accounts')
    .select('netsuite_account_id, number, name, company_id, netsuite_subsidiary_ids')
    .eq('account_type', 'bank').eq('active', true).eq('is_summary', false).not('netsuite_account_id', 'is', null)
    .order('number').order('netsuite_account_id').limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    netsuite_account_id: string; number: string | null; name: string; company_id: string | null; netsuite_subsidiary_ids: string[] | null;
  }>;
  return rows
    .filter((r) => /^\d+$/.test(r.netsuite_account_id)
      && (r.netsuite_subsidiary_ids ? r.netsuite_subsidiary_ids.includes(company.subsidiaryId) : r.company_id === company.id))
    .map((r) => ({ netsuiteId: r.netsuite_account_id, number: r.number, name: r.name }));
}

/** What NetSuite has waiting in Undeposited Funds for the company now. */
async function readWaiting(company: Company, today: string): Promise<WaitingItem[]> {
  return getUndepositedFunds(company.subsidiaryId, { since: sinceOf(today) });
}

/** The payments and deposits another press is depositing now, other than the press `except`. */
async function readHeld(company: Company, except: string | null): Promise<Set<string>> {
  let q = service.from('made_bank_deposits').select('id, lines').eq('company', company.code).eq('status', 'sending');
  if (except) q = q.neq('id', except);
  const { data, error } = await q.order('created_at').order('id').limit(200);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ lines: PressLine[] }>).flatMap((r) => (r.lines ?? []).map((l) => l.netsuite_id)));
}

const companyNamed = (companies: Company[], code: string | null) =>
  companies.find((c) => c.code === code) ?? (code ? null : companies[0] ?? null);

/**
 * GET /api/invoices/bank-deposit?status=1 — whether bank deposits are on, and whether this person can use them.
 * GET /api/invoices/bank-deposit?company=<BMG|1084> — the company's bank accounts and what NetSuite has waiting in
 * Undeposited Funds for it now; the first company when none is named.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('status')) {
    const auth = await requireFeature(req, 'invoicing');
    if (auth.error) return auth.error;
    if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) return NextResponse.json({ on: false, canUse: false });
    const on = await switchIsOn(service, 'bank_deposits');
    return NextResponse.json({ on, canUse: on || isSuperAdmin(auth) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const companies = await readCompanies();
    const company = companyNamed(companies, (req.nextUrl.searchParams.get('company') || '').trim() || null);
    if (!company) return NextResponse.json({ error: "Books has no company by that name with a NetSuite subsidiary." }, { status: 404 });
    const today = chicagoDate();
    const [accounts, held] = await Promise.all([readAccounts(company), readHeld(company, null)]);
    let waiting: WaitingItem[];
    try {
      waiting = await readWaiting(company, today);
    } catch (err) {
      return NextResponse.json({ error: `Couldn't read what's waiting in Undeposited Funds from NetSuite (${messageOf(err)}).` }, { status: 502 });
    }
    return NextResponse.json({
      today,
      companies: companies.map((c) => ({ code: c.code, name: c.name })),
      company: company.code,
      accounts,
      waiting,
      held: [...held],
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what it would send; nothing goes to NetSuite.`,
    });
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

const Schema = z.object({
  // Made by the page when it opens: the same form pressed twice is one bank deposit.
  requestId: z.string().uuid(),
  company: z.string().max(12),
  accountId: z.string().regex(/^\d{1,20}$/),
  date: z.string().max(20),
  memo: z.string().max(2000).default(''),
  lineIds: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(MAX_LINES * 2),
  // What the page had the ticked ones come to.
  expectedCents: z.number().int().min(0),
});

/**
 * POST /api/invoices/bank-deposit — make the bank deposit: worked out again from what NetSuite has waiting in
 * Undeposited Funds now, never taken from the page, made in NetSuite once under the press's External ID, and kept in
 * Books' own copy. Pressed again, it says what became of the press: made, still being made, or, once that's been a
 * while, what NetSuite has. Refused while bank deposits are switched off, for everyone.
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
    return await make(body, gate);
  } catch (err) {
    return NextResponse.json({ error: messageOf(err) }, { status: 500 });
  }
}

type Body = z.infer<typeof Schema>;

async function letGo(id: string, error: string) {
  await service.rpc('made_bank_deposit_let_go', { p: { id, error } });
}

const alreadyMade = (r: PressRow) => NextResponse.json({
  success: true, already: true, depositId: r.netsuite_deposit_id, number: r.netsuite_number, totalCents: r.total_cents,
});

async function make(body: Body, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  const company = companyNamed(await readCompanies(), body.company.trim() || null);
  if (!company || company.code !== body.company.trim()) {
    return NextResponse.json({ error: 'Books has no company by that name with a NetSuite subsidiary. Nothing was sent.' }, { status: 400 });
  }
  const today = chicagoDate();
  const [accounts, held] = await Promise.all([readAccounts(company), readHeld(company, body.requestId)]);
  let waiting: WaitingItem[];
  try {
    waiting = await readWaiting(company, today);
  } catch (err) {
    return NextResponse.json({
      error: `Couldn't read what's waiting in Undeposited Funds from NetSuite (${messageOf(err)}). Nothing was sent.`,
    }, { status: 502 });
  }

  const worked = workOutBankDeposit(body, waiting, accounts, { today, held });
  if (worked.problems.length > 0 || !worked.account) {
    return NextResponse.json({ error: `${worked.problems.join(' ')} Nothing was sent.`, problems: worked.problems }, { status: 400 });
  }

  // One bank deposit per press, and no payment in two: take the claim, or say what became of the press.
  const { data, error } = await service.rpc('made_bank_deposit_claim', {
    p: {
      id: body.requestId, by: auth.user.id, company: company.code, subsidiary_netsuite_id: company.subsidiaryId,
      bank_account_netsuite_id: worked.account.netsuiteId, bank_account_name: accountName(worked.account),
      deposit_date: worked.date, memo: worked.memo,
      lines: worked.lines.map((l) => ({
        netsuite_id: l.netsuiteId, kind: l.kind, number: l.number, date: l.date, customer_name: l.customerName,
        reference: l.reference, cents: l.cents,
      })),
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as {
    state: 'made' | 'sending' | 'held' | 'claimed'; deposit?: PressRow; held?: string[]; netsuite_deposit_id?: string; netsuite_number?: string | null;
  };
  if (claim.state === 'made') {
    // Made by a press of the same form just now.
    const made = await readPress(body.requestId);
    return made ? alreadyMade(made) : NextResponse.json({ success: true, already: true, depositId: claim.netsuite_deposit_id, number: claim.netsuite_number ?? null });
  }
  if (claim.state === 'held') {
    const numbers = worked.lines.filter((l) => claim.held?.includes(l.netsuiteId)).map((l) => l.number);
    return NextResponse.json({
      error: `${numbers.join(', ') || 'Some of these'} ${numbers.length === 1 ? 'is' : 'are'} in a bank deposit being made now. Nothing was sent.`,
    }, { status: 409 });
  }
  if (!claim.deposit) return NextResponse.json({ error: "FleetSuite couldn't make this bank deposit. Nothing was sent. Try again." }, { status: 500 });
  if (claim.state === 'sending') return askNetSuite(claim.deposit, gate);
  const press = claim.deposit;
  const externalId = bankDepositExternalId(press.id);

  // NetSuite never takes two bank deposits under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findBankDeposit(externalId);
    if (there) return finish(press, gate, there, { already: true });
  } catch (err) {
    const why = `Couldn't check NetSuite for this bank deposit (${messageOf(err)}).`;
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} Nothing was sent. Try again.` }, { status: 502 });
  }

  const result = await createBankDeposit(netsuiteBankDeposit(worked, { pressId: press.id, subsidiaryId: company.subsidiaryId }));
  if (!result.success || !result.depositId) {
    const why = result.error || "NetSuite didn't make the bank deposit.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('made_bank_deposits').update({ error: why.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', press.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(press.id, why);
    return NextResponse.json({ error: `${why} No bank deposit was made.` }, { status: 502 });
  }

  let there: Awaited<ReturnType<typeof findBankDeposit>> = null;
  try {
    there = await findBankDeposit(externalId);
  } catch {
    // Its number and total are for showing and checking; NetSuite's id is what's kept.
  }
  return finish(press, gate, there ?? { depositId: result.depositId, number: '', totalCents: null }, {});
}

/** A press that's being made, or that NetSuite didn't answer about: once it's been a while, ask NetSuite what became of it. */
async function askNetSuite(press: PressRow, gate: Gate): Promise<NextResponse> {
  const age = Date.now() - Date.parse(press.sent_at ?? '');
  if (!(age > STALE_MS)) {
    return NextResponse.json({
      error: press.error
        ? `NetSuite didn't say whether it made this bank deposit (${press.error}). Press Ask NetSuite in a few minutes and FleetSuite will find out.`
        : "It's being made in NetSuite now. Don't press again: reload in a minute to see it.",
      ...(press.error ? { unsure: true } : {}),
    }, { status: 409 });
  }
  let there: Awaited<ReturnType<typeof findBankDeposit>>;
  try {
    there = await findBankDeposit(bankDepositExternalId(press.id));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't ask NetSuite what became of this bank deposit (${messageOf(err)}). Try again.`, unsure: true }, { status: 502 });
  }
  if (there) return finish(press, gate, there, { already: true });
  const why = 'NetSuite has no bank deposit from this press, so none was made.';
  await letGo(press.id, why);
  return NextResponse.json({ error: `${why} Check what's waiting and press Make deposit again.` }, { status: 409 });
}

/**
 * The bank deposit is in NetSuite: keep its id on the press, keep Books' copy, and say so. When NetSuite's total isn't
 * what FleetSuite sent, Books keeps no copy and says to look at it in NetSuite.
 */
async function finish(
  press: PressRow, { auth }: Gate, there: { depositId: string; number: string; totalCents: number | null }, opts: { already?: boolean },
): Promise<NextResponse> {
  const { depositId } = there;
  const number = there.number || null;
  const { error } = await service.rpc('made_bank_deposit_made', { p: { id: press.id, netsuite_deposit_id: depositId, netsuite_number: number } });
  if (error) console.error(`[bank deposits] press ${press.id} made as NetSuite deposit ${depositId} but not kept: ${error.message}`);

  const date = String(press.deposit_date).slice(0, 10);
  const differs = there.totalCents !== null && there.totalCents !== press.total_cents;
  // Books' own copy of the bank deposit (never fails it).
  const books = differs
    ? { saved: false, reason: `NetSuite's bank deposit comes to ${formatCents(there.totalCents ?? 0)}, not the ${formatCents(press.total_cents)} FleetSuite sent: look at it in NetSuite` }
    : await saveOwnBankDeposit(service, {
      netsuiteId: depositId, netsuiteNumber: number, company: press.company as BooksCompany, bankAccountNetsuiteId: press.bank_account_netsuite_id,
      date, memo: press.memo, totalCents: press.total_cents, madeFromId: press.id, madeBy: press.sent_by ?? auth.user.id,
      lines: (press.lines ?? []).map((l) => ({ netsuiteId: l.netsuite_id, kind: l.kind, number: l.number, customerName: l.customer_name, cents: l.cents })),
    });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'made_bank_deposits',
    recordId: press.id,
    action: 'create',
    detail: {
      netsuite_deposit_id: depositId, netsuite_number: number, company: press.company, bank_account: press.bank_account_name,
      date, payments: (press.lines ?? []).map((l) => l.number), total: formatCents(press.total_cents),
      ...(differs ? { netsuite_total: formatCents(there.totalCents ?? 0) } : {}), found_in_netsuite: !!opts.already,
    },
  });

  return NextResponse.json({
    success: true,
    ...(opts.already ? { already: true } : {}),
    depositId,
    number,
    totalCents: press.total_cents,
    ...(books.saved || books.reason === 'already saved' ? {} : { booksWarning: `Books didn't keep its copy (${books.reason}). The bank deposit is in NetSuite.` }),
  });
}
