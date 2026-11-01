import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { profileHasFeature, requireBooks } from '@/lib/api-auth';
import { booksAllows, type BooksAccess } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { centralDate } from '@/lib/books/mistake-checks';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import {
  JOURNAL_LINE_ACCOUNT_TYPES, MAX_LINE_CENTS, keptLines, linesToKeep, workOutTypedEntry,
  type JournalAccount, type KeptLine, type TypedEntry, type TypedStatus,
} from '@/lib/typed-journal-entries';
import {
  FIRST_MONTH, LANDLORD, NO_SETUP, SETUP_ACCOUNTS, TENANT,
  accountName, bookMonths, fits, monthEntries, monthName, monthViews, monthsFrom, setupProblems, typedProblems,
  type BooksAmount, type EntryKind, type EntryRef, type OpeningAmount, type RentMortgageSetup, type SavedMonth, type SetupAccount,
  type SetupRole, type TypedMonth,
} from '@/lib/books/rent-and-mortgage';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });
const refuse = (status: number, error: string, more: Record<string, unknown> = {}) => NextResponse.json({ error, ...more }, { status });

const OFF = `Journal entries are switched off until ${SWITCH_ON_DATE_TEXT}.`;

/** Each setup account's column in rent_mortgage_setups (migration 492). */
const COLUMN: Record<SetupRole, string> = {
  bankAccount: 'bank_account',
  rentIncomeAccount: 'rent_income_account',
  tenantRentAccount: 'tenant_rent_account',
  mortgageAccount: 'mortgage_account',
  interestAccount: 'interest_account',
  escrowAccount: 'escrow_account',
};

interface SetupRow {
  bank_account: string | null;
  rent_income_account: string | null;
  tenant_rent_account: string | null;
  mortgage_account: string | null;
  interest_account: string | null;
  escrow_account: string | null;
  lender: string | null;
  updated_by: string | null;
  updated_at: string;
}

interface MonthRow {
  month: string;
  rent_date: string | null;
  rent_cents: number | string | null;
  paid_on: string | null;
  principal_cents: number | string | null;
  interest_cents: number | string | null;
  escrow_cents: number | string | null;
  balance_after_cents: number | string | null;
  rent_entry_id: string | null;
  mortgage_entry_id: string | null;
  updated_by: string | null;
  updated_at: string;
}

interface EntryRow {
  id: string;
  status: TypedStatus;
  updated_at: string;
  tran_date: string;
  memo: string | null;
  lines: KeptLine[] | null;
  total_cents: number | string;
  netsuite_number: string | null;
  error: string | null;
}

const MONTH_COLUMNS = 'month, rent_date, rent_cents, paid_on, principal_cents, interest_cents, escrow_cents, balance_after_cents, '
  + 'rent_entry_id, mortgage_entry_id, updated_by, updated_at';
const ENTRY_COLUMNS = 'id, status, updated_at, tran_date, memo, lines, total_cents, netsuite_number, error';

const day = (v: string | null) => (v ? String(v).slice(0, 10) : null);

const setupOf = (r: SetupRow | null): RentMortgageSetup => (r
  ? {
    bankAccount: r.bank_account, rentIncomeAccount: r.rent_income_account, tenantRentAccount: r.tenant_rent_account,
    mortgageAccount: r.mortgage_account, interestAccount: r.interest_account, escrowAccount: r.escrow_account, lender: r.lender,
  }
  : NO_SETUP);

const typedOf = (r: MonthRow): TypedMonth => ({
  month: day(r.month)!,
  rent: r.rent_date ? { date: day(r.rent_date)!, cents: Number(r.rent_cents) } : null,
  statement: r.paid_on
    ? {
      paidOn: day(r.paid_on)!, principalCents: Number(r.principal_cents), interestCents: Number(r.interest_cents),
      escrowCents: Number(r.escrow_cents), balanceAfterCents: Number(r.balance_after_cents),
    }
    : null,
});

const entryOf = (r: EntryRow): EntryRef => ({
  id: r.id, status: r.status, updatedAt: r.updated_at, date: day(r.tran_date)!, memo: r.memo, lines: keptLines(r.lines),
  totalCents: Number(r.total_cents), number: r.netsuite_number, error: r.error,
});

/** The landlord and its tenant as Books has them, and every account by NetSuite's id with the companies a typed line can use it for. */
async function readChart(service: SupabaseClient) {
  const companies = await readCompanies(service);
  const landlord = companies.find((c) => c.code === LANDLORD);
  const tenant = companies.find((c) => c.code === TENANT);
  if (!landlord || !tenant) throw new Error(`Books has no company ${landlord ? TENANT : LANDLORD}.`);
  const accounts = await readAccounts(service, companies, JOURNAL_LINE_ACCOUNT_TYPES);
  return { landlord, tenant, accounts: accounts as Map<string, SetupAccount> };
}

async function readSetup(service: SupabaseClient): Promise<SetupRow | null> {
  const { data, error } = await service.from('rent_mortgage_setups')
    .select('bank_account, rent_income_account, tenant_rent_account, mortgage_account, interest_account, escrow_account, lender, updated_by, updated_at')
    .eq('company', LANDLORD).maybeSingle();
  if (error) throw new Error(`Couldn't read the setup: ${error.message}`);
  return (data as SetupRow | null) ?? null;
}

async function readMonth(service: SupabaseClient, month: string): Promise<MonthRow | null> {
  const { data, error } = await service.from('rent_mortgage_months').select(MONTH_COLUMNS).eq('company', LANDLORD).eq('month', month).maybeSingle();
  if (error) throw new Error(`Couldn't read ${monthName(month)}: ${error.message}`);
  return (data as MonthRow | null) ?? null;
}

async function readEntries(service: SupabaseClient, ids: string[]): Promise<Map<string, EntryRef>> {
  if (!ids.length) return new Map();
  const { data, error } = await service.from('typed_journal_entries').select(ENTRY_COLUMNS).in('id', ids);
  if (error) throw new Error(`Couldn't read the months' entries: ${error.message}`);
  return new Map(((data ?? []) as EntryRow[]).map((r) => [r.id, entryOf(r)]));
}

/** A company's journal per account and month (migration 396). */
async function readTotals(service: SupabaseClient, company: string): Promise<BooksAmount[]> {
  const { data, error } = await service.rpc('gl_books_totals', { p_company: company });
  if (error) throw new Error(`Couldn't read ${company}'s books: ${error.message}`);
  return (data ?? []) as BooksAmount[];
}

/** NetSuite's balances before FleetSuite's books start (migration 361). */
async function readOpening(service: SupabaseClient, company: string): Promise<OpeningAmount[]> {
  const { data, error } = await service.rpc('gl_netsuite_totals', { p_company: company });
  if (error) throw new Error(`Couldn't read where ${company}'s books start: ${error.message}`);
  return ((data ?? {}) as { opening?: OpeningAmount[] }).opening ?? [];
}

async function readNames(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  if (!people.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', people);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name || 'Someone']));
}

/** Whoever's signed in, as requireBooks answers once it lets them in. */
interface SignedIn {
  user: { id: string };
  profile?: unknown;
  access?: BooksAccess;
}

/** Who can make the month's entries, as the general journal has it (src/app/api/journal-entries): Payments, and journal entries on or a super admin. */
async function makeRights(service: SupabaseClient, auth: SignedIn) {
  const keep = booksAllows(auth.access, 'keep');
  const superAdmin = booksAllows(auth.access, 'owner');
  const [payments, on] = await Promise.all([
    keep ? profileHasFeature(auth.user.id, auth.profile, 'vendor_payments') : Promise.resolve(false),
    switchIsOn(service, 'journal_entries'),
  ]);
  const refused = !keep ? "This login reads the books but can't change them."
    : !payments ? "Making the month's entries needs the Payments permission, as the general journal does."
      : !on && !superAdmin ? `${OFF} Until then only a super admin makes the month's entries, to see what they'd make.`
        : null;
  return { keep, on, refused };
}

const thisMonthOf = (today: string) => `${today.slice(0, 7)}-01`;

/**
 * GET /api/admin/books/rent-and-mortgage — 1084 Cool Springs' rent and
 * mortgage month by month, newest first, from January 2025 through this month
 * (Central): what BMG's books and 1084's have for the rent, what 1084's have
 * for the mortgage next to the lender's statement as typed, and the month's
 * two entries (src/lib/books/rent-and-mortgage.ts, docs/books.md "1084's rent
 * and mortgage"). With the setup, the accounts each part of it can pick, and
 * whether this person can change the figures and make the entries.
 *
 * POST { action: 'setup', seen, accounts, lender } — the setup's accounts and
 * the lender's name; { action: 'save', month: 'YYYY-MM', seen, rent,
 * statement } — a month's figures as typed; { action: 'make', month, seen } —
 * the month's entries as drafts in the general journal on Journal entries,
 * worked out from the figures as saved, never the page's. `seen` is when the
 * setup or the month was saved, as the page saw it.
 *
 * Super admins, the bookkeeper and the CPA see it; the bookkeeper and super
 * admins type the figures; making the entries needs Payments too, and while
 * journal entries are switched off only a super admin makes them.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const today = centralDate(new Date());
    const thisMonth = thisMonthOf(today);
    const months = monthsFrom(FIRST_MONTH, thisMonth);
    const [chart, setupRow, savedRes, landlordTotals, tenantTotals, opening, rights] = await Promise.all([
      readChart(service),
      readSetup(service),
      service.from('rent_mortgage_months').select(MONTH_COLUMNS).eq('company', LANDLORD)
        .gte('month', FIRST_MONTH).lte('month', thisMonth).order('month', { ascending: true }),
      readTotals(service, LANDLORD),
      readTotals(service, TENANT),
      readOpening(service, LANDLORD),
      makeRights(service, auth),
    ]);
    if (savedRes.error) throw new Error(`Couldn't read the months: ${savedRes.error.message}`);
    const rows = (savedRes.data ?? []) as unknown as MonthRow[];
    const setup = setupOf(setupRow);
    const [entries, names] = await Promise.all([
      readEntries(service, rows.flatMap((r) => [r.rent_entry_id, r.mortgage_entry_id]).filter((id): id is string => !!id)),
      readNames(service, [setupRow?.updated_by ?? null, ...rows.map((r) => r.updated_by)]),
    ]);
    const saved: SavedMonth[] = rows.map((r) => ({
      ...typedOf(r), rentEntryId: r.rent_entry_id, mortgageEntryId: r.mortgage_entry_id, updatedAt: r.updated_at,
      updatedBy: r.updated_by ? names.get(r.updated_by) ?? 'Someone' : null,
    }));

    const byNumber = (a: SetupAccount, b: SetupAccount) => (a.number || a.name).localeCompare(b.number || b.name, 'en', { numeric: true });
    const named = (id: string | null) => {
      const a = id ? chart.accounts.get(id) : undefined;
      return a ? accountName(a) : id ? `Account ${id}` : null;
    };
    return NextResponse.json({
      landlord: { code: chart.landlord.code, name: chart.landlord.name, subsidiaryId: chart.landlord.subsidiaryId },
      tenant: { code: chart.tenant.code, name: chart.tenant.name },
      setup,
      setupUpdatedAt: setupRow?.updated_at ?? null,
      setupUpdatedBy: setupRow?.updated_by ? names.get(setupRow.updated_by) ?? 'Someone' : null,
      setupNames: Object.fromEntries(SETUP_ACCOUNTS.map((r) => [r.role, named(setup[r.role])])),
      setupProblems: setupProblems(setup, chart.accounts),
      choices: SETUP_ACCOUNTS.map((r) => ({
        role: r.role,
        label: r.label,
        company: r.company,
        optional: !!r.optional,
        accounts: [...chart.accounts.values()].filter((a) => fits(r, a)).sort(byNumber).map((a) => ({ id: a.id, name: accountName(a) })),
      })),
      months: monthViews({
        setup,
        tenantName: chart.tenant.name,
        books: bookMonths({ setup, landlord: landlordTotals, tenant: tenantTotals, opening, months }),
        saved,
        entries,
        thisMonth,
      }),
      today,
      thisMonth,
      firstMonth: FIRST_MONTH,
      can: { keep: rights.keep, make: rights.keep && !rights.refused },
      makeRefused: rights.keep ? rights.refused : null,
      switchedOn: rights.on,
      offText: rights.on ? null : `${OFF} The month's entries are made as drafts to see what they'd make; none is asked for approval or sent to NetSuite.`,
    });
  } catch (err) {
    return failed(err);
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/).nullable();
const cents = (atLeast: number) => z.number().int().min(atLeast).max(MAX_LINE_CENTS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');
const stamp = z.string().min(1).max(60);

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('setup'),
    seen: stamp.nullable(),
    accounts: z.object({
      bankAccount: netsuiteId, rentIncomeAccount: netsuiteId, tenantRentAccount: netsuiteId,
      mortgageAccount: netsuiteId, interestAccount: netsuiteId, escrowAccount: netsuiteId,
    }),
    lender: z.string().max(200).nullable(),
  }),
  z.object({
    action: z.literal('save'),
    month,
    seen: stamp.nullable(),
    rent: z.object({ date, cents: cents(1) }).nullable(),
    statement: z.object({
      paidOn: date, principalCents: cents(0), interestCents: cents(0), escrowCents: cents(0), balanceAfterCents: cents(0),
    }).nullable(),
  }),
  z.object({ action: z.literal('make'), month, seen: stamp }),
]);
type Body = z.infer<typeof Schema>;

/** Where an entry is, for why it stays as it is. */
const WHERE: Record<string, string> = {
  waiting: 'asked for approval',
  sending: 'being made in NetSuite',
  made: 'in NetSuite already',
  other_journal: 'in another journal',
};
const where = (status: string | null | undefined) => WHERE[status ?? ''] ?? `${status ?? 'not a draft'}`;
const ENTRY_NAME: Record<EntryKind, string> = { rent: "The rent's entry", mortgage: "The mortgage payment's entry" };

/** Why a figure an entry books stays as it is: taken back, an entry asked for approval can be changed again. */
const stays = (kind: EntryKind, what: string, status: string | null | undefined) => (status === 'waiting'
  ? `${ENTRY_NAME[kind]} is asked for approval, so ${what} stays as it is: take the entry back on Journal entries to change it.`
  : `${ENTRY_NAME[kind]} is ${where(status)}, so ${what} stays as it is.`);

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const service = createServiceClient();
  try {
    switch (body.action) {
      case 'setup': return await saveSetup(service, body, auth.user.id);
      case 'save': return await saveMonth(service, body, auth.user.id);
      case 'make': return await makeEntries(service, body, auth);
    }
  } catch (err) {
    return failed(err);
  }
}

async function saveSetup(service: SupabaseClient, body: Extract<Body, { action: 'setup' }>, me: string) {
  const lender = (body.lender ?? '').trim() || null;
  const setup: RentMortgageSetup = { ...body.accounts, lender };
  const chart = await readChart(service);
  const problems = setupProblems(setup, chart.accounts);
  if (problems.length) return refuse(400, problems.join(' '), { problems });

  const was = await readSetup(service);
  if ((was?.updated_at ?? null) !== body.seen) {
    return refuse(409, 'The setup was changed by someone else since you opened it: look at it again.');
  }
  const row: Record<string, unknown> = { company: LANDLORD, lender, updated_by: me, updated_at: new Date().toISOString() };
  for (const r of SETUP_ACCOUNTS) row[COLUMN[r.role]] = setup[r.role];
  const { error } = await service.from('rent_mortgage_setups').upsert(row, { onConflict: 'company' });
  if (error) throw new Error(`Couldn't save the setup: ${error.message}`);
  await logAudit(service, {
    actorId: me, table: 'rent_mortgage_setups', recordId: LANDLORD, action: 'setup',
    detail: { accounts: Object.fromEntries(SETUP_ACCOUNTS.map((r) => [COLUMN[r.role], setup[r.role]])), lender },
  });
  return NextResponse.json({ saved: true });
}

/** A month's first day, once it's one the page shows: from January 2025 through this month. */
function monthShown(m: string): { month: string } | { error: NextResponse } {
  const first = `${m}-01`;
  const thisMonth = thisMonthOf(centralDate(new Date()));
  if (first < FIRST_MONTH || first > thisMonth) {
    return { error: refuse(400, `${monthName(first)} isn't one of the months here: they run from ${monthName(FIRST_MONTH)} through ${monthName(thisMonth)}.`) };
  }
  return { month: first };
}

async function saveMonth(service: SupabaseClient, body: Extract<Body, { action: 'save' }>, me: string) {
  const shown = monthShown(body.month);
  if ('error' in shown) return shown.error;
  const { month } = shown;
  const typed: TypedMonth = { month, rent: body.rent, statement: body.statement };
  const problems = typedProblems(typed);
  if (problems.length) return refuse(400, problems.join(' '), { problems });

  const { data, error } = await service.rpc('rent_mortgage_month_save', {
    p: {
      company: LANDLORD, month, seen: body.seen, by: me,
      rent: body.rent && { date: body.rent.date, cents: body.rent.cents },
      statement: body.statement && {
        paid_on: body.statement.paidOn, principal_cents: body.statement.principalCents, interest_cents: body.statement.interestCents,
        escrow_cents: body.statement.escrowCents, balance_after_cents: body.statement.balanceAfterCents,
      },
    },
  });
  if (error) throw new Error(`Couldn't save ${monthName(month)}: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; status?: string; updated_at?: string; unchanged?: boolean };
  if (answer.state === 'changed') return refuse(409, `${monthName(month)} was saved by someone else since you opened it: look at it again.`);
  if (answer.state === 'rent_asked') return refuse(409, stays('rent', 'the rent', answer.status));
  if (answer.state === 'statement_asked') return refuse(409, stays('mortgage', 'the statement', answer.status));
  if (answer.state !== 'saved') throw new Error(`Couldn't save ${monthName(month)}: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  if (!answer.unchanged) {
    await logAudit(service, {
      actorId: me, table: 'rent_mortgage_months', recordId: `${LANDLORD} ${body.month}`, action: 'save',
      detail: { month, rent: !!body.rent, statement: !!body.statement },
    });
  }
  return NextResponse.json({ saved: true, updatedAt: answer.updated_at ?? null, unchanged: !!answer.unchanged });
}

async function makeEntries(service: SupabaseClient, body: Extract<Body, { action: 'make' }>, auth: SignedIn) {
  const rights = await makeRights(service, auth);
  if (rights.refused) return refuse(403, rights.refused, rights.on ? {} : { switchedOff: true });
  const shown = monthShown(body.month);
  if ('error' in shown) return shown.error;
  const { month } = shown;
  const name = monthName(month);

  const row = await readMonth(service, month);
  if (!row) return refuse(409, `Save ${name}'s figures first.`);
  if (row.updated_at !== body.seen) return refuse(409, `${name} was saved by someone else since you opened it: look at it again, then make the entries.`);
  const typed = typedOf(row);
  if (!typed.rent && !typed.statement) return refuse(409, "Type the rent received or the lender's statement first.");

  // An entry asked for approval, being made or made stays as it is; only a draft, or one not made yet, is made from the figures.
  const linked = await readEntries(service, [row.rent_entry_id, row.mortgage_entry_id].filter((id): id is string => !!id));
  const statusOf = (id: string | null) => (id ? linked.get(id)?.status ?? null : null);
  const make: Record<EntryKind, boolean> = {
    rent: !!typed.rent && [null, 'draft'].includes(statusOf(row.rent_entry_id)),
    mortgage: !!typed.statement && [null, 'draft'].includes(statusOf(row.mortgage_entry_id)),
  };
  if (!make.rent && !make.mortgage) return refuse(409, `${name}'s entries are each asked for approval or made already, so they stay as they are.`);

  const [chart, setupRow] = await Promise.all([readChart(service), readSetup(service)]);
  const worked = monthEntries({
    setup: setupOf(setupRow),
    typed: { month, rent: make.rent ? typed.rent : null, statement: make.mortgage ? typed.statement : null },
    tenantName: chart.tenant.name,
  });
  const problems = [...worked.problems];
  const facts = {
    company: { code: chart.landlord.code, name: chart.landlord.name, subsidiaryId: chart.landlord.subsidiaryId },
    accounts: chart.accounts as Map<string, JournalAccount>,
  };
  const entries: Array<[EntryKind, TypedEntry]> = [];
  for (const kind of ['rent', 'mortgage'] as const) {
    const entry = worked[kind];
    if (!entry) continue;
    for (const p of workOutTypedEntry(entry, facts).problems) problems.push(`${ENTRY_NAME[kind]}: ${p}`);
    entries.push([kind, entry]);
  }
  if (problems.length) return refuse(400, problems.join(' '), { problems });

  const made: Array<{ kind: EntryKind; id: string; status: string }> = [];
  const kept: Array<{ kind: EntryKind; id: string; status: string }> = [];
  for (const [kind, entry] of entries) {
    const { data, error } = await service.rpc('rent_mortgage_entry_save', {
      p: {
        company: LANDLORD, month, kind, id: randomUUID(), seen: row.updated_at, by: auth.user.id,
        tran_date: entry.date, memo: entry.memo, lines: linesToKeep(entry.lines),
      },
    });
    if (error) throw new Error(`Couldn't make ${ENTRY_NAME[kind].charAt(0).toLowerCase()}${ENTRY_NAME[kind].slice(1)}: ${error.message}`);
    const answer = (data ?? {}) as { state?: string; id?: string; status?: string };
    if (answer.state === 'saved') made.push({ kind, id: answer.id!, status: answer.status ?? 'draft' });
    else if (answer.state === 'kept') kept.push({ kind, id: answer.id!, status: answer.status ?? '' });
    else if (answer.state === 'changed' || answer.state === 'gone') {
      return refuse(409, `${name} was saved again while its entries were being made: look at it again, then make them.`, { made });
    } else throw new Error(`Couldn't make ${name}'s entries: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  await logAudit(service, {
    actorId: auth.user.id, table: 'rent_mortgage_months', recordId: `${LANDLORD} ${body.month}`, action: 'make_entries',
    detail: { month, made: made.map(({ kind, id }) => ({ kind, id })), kept: kept.map(({ kind, id, status }) => ({ kind, id, status })) },
  });
  return NextResponse.json({ made, kept });
}
