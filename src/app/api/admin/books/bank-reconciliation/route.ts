import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { centralDate } from '@/lib/central-day';
import { MAX_LINE_CENTS } from '@/lib/typed-journal-entries';
import { FIRST_MONTH, LANDLORD } from '@/lib/books/rent-and-mortgage';
import { DOCS_MAX, readBankRec, type BankRecRead } from '@/lib/books/bank-reconciliation-data';
import {
  DOC_PATTERN, MAX_OUTSTANDING, REASON_MAX, formatCents, monthAfter, monthName, monthViews, nextMonth, nextView, recProblems,
  startProblems, startView,
  type RecBooks, type RecStart,
} from '@/lib/books/bank-reconciliation';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });
const refuse = (status: number, error: string, more: Record<string, unknown> = {}) => NextResponse.json({ error, ...more }, { status });

const NO_ACCOUNT = "Pick 1084's bank account on Rent and mortgage's setup first.";
const CAPPED = `1084's bank account has more than ${DOCS_MAX.toLocaleString('en-US')} entries, more than FleetSuite reads at once, so it isn't reconciled here.`;

/** 1084's bank account, as Rent and mortgage's setup picks it, or null while it isn't picked. */
async function readBank(service: SupabaseClient): Promise<string | null> {
  const { data, error } = await service.from('rent_mortgage_setups').select('bank_account').eq('company', LANDLORD).maybeSingle();
  if (error) throw new Error(`Couldn't read Rent and mortgage's setup: ${error.message}`);
  return (data as { bank_account: string | null } | null)?.bank_account ?? null;
}

interface Loaded extends Omit<BankRecRead, 'account'> {
  company: { code: string; name: string };
  account: BankRecRead['account'] | null;
  today: string;
  thisMonth: string;
}

/** Everything 1084's bank reconciliation is worked out from: where it starts, each month saved, and the account's entries (readBankRec). */
async function load(service: SupabaseClient): Promise<Loaded> {
  const today = centralDate(new Date());
  const thisMonth = `${today.slice(0, 7)}-01`;
  const [companyRes, bank] = await Promise.all([
    service.from('gl_companies').select('code, name').eq('code', LANDLORD).maybeSingle(),
    readBank(service),
  ]);
  if (companyRes.error) throw new Error(`Couldn't read the companies: ${companyRes.error.message}`);
  if (!companyRes.data) throw new Error(`Books has no company ${LANDLORD}.`);
  const company = companyRes.data as { code: string; name: string };
  if (!bank) {
    return {
      company, account: null, today, thisMonth, start: null, recs: [], ticks: [], events: [], docs: [], openingCents: 0, notPosted: 0, capped: false,
    };
  }
  return { company, today, thisMonth, ...(await readBankRec(service, { company: LANDLORD, account: bank, thisMonth })) };
}

const booksOf = (l: Loaded & { start: RecStart }): RecBooks => ({
  start: l.start, recs: l.recs, ticks: l.ticks, events: l.events, docs: l.docs, openingCents: l.openingCents,
});

/**
 * GET /api/admin/books/bank-reconciliation — 1084 Cool Springs' bank
 * reconciliation (src/lib/books/bank-reconciliation.ts, docs/books.md
 * "1084's bank reconciliation"): where reconciling its bank account (the one
 * Rent and mortgage's setup picks) starts, held against the books; each
 * month from then through this one, newest first, done, the one to
 * reconcile now, or waiting for it; and the account's entries in FleetSuite's
 * books, for the page to work out what ticking them comes to.
 *
 * POST { action: 'start', seen, firstMonth: 'YYYY-MM', asOf, balanceCents,
 * outstanding } — where reconciling starts, while no month is done;
 * { action: 'save', month, seen, endsOn, endingCents, ticked, finish } — the
 * month to reconcile now, with its statement's last day and ending balance
 * and the entries that cleared on it, each at what the books have for it,
 * never the page's, and done with finish once what cleared comes to the
 * ending balance; { action: 'undo', month, seen, reason } — the last month
 * done, open again. `seen` is when it was saved, as the page saw it.
 *
 * Super admins, the bookkeeper and the CPA see it; the bookkeeper and super
 * admins reconcile. Nothing here moves money or is sent to NetSuite.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const l = await load(service);
    const books = l.start ? booksOf({ ...l, start: l.start }) : null;
    const next = l.start ? nextMonth(l.start, l.recs) : null;
    return NextResponse.json({
      company: l.company,
      account: l.account,
      start: l.start,
      startView: books && startView(books),
      next: next && next <= l.thisMonth ? next : null,
      months: books ? monthViews(books, l.thisMonth) : [],
      recs: l.recs,
      ticks: l.ticks,
      events: l.events,
      docs: l.docs,
      openingCents: l.openingCents,
      notPosted: l.notPosted,
      capped: l.capped,
      can: { keep: booksAllows(auth.access, 'keep') },
      today: l.today,
      thisMonth: l.thisMonth,
      firstMonth: FIRST_MONTH,
    });
  } catch (err) {
    return failed(err);
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');
const stamp = z.string().min(1).max(60);
const amount = z.number().int().min(-MAX_LINE_CENTS).max(MAX_LINE_CENTS);
const entry = z.string().regex(DOC_PATTERN);

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    seen: stamp.nullable(),
    firstMonth: month,
    asOf: date,
    balanceCents: amount,
    outstanding: z.array(entry).max(MAX_OUTSTANDING),
  }),
  z.object({
    action: z.literal('save'),
    month,
    seen: stamp.nullable(),
    endsOn: date,
    endingCents: amount.nullable(),
    ticked: z.array(entry).max(DOCS_MAX),
    finish: z.boolean(),
  }),
  z.object({ action: z.literal('undo'), month, seen: stamp, reason: z.string().max(1000) }),
]);
type Body = z.infer<typeof Schema>;

const entries = (n: number) => (n === 1 ? 'An entry' : `${n} entries`);

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const service = createServiceClient();
  try {
    switch (body.action) {
      case 'start': return await saveStart(service, body, auth.user.id);
      case 'save': return await saveMonth(service, body, auth.user.id);
      case 'undo': return await undoMonth(service, body, auth.user.id);
    }
  } catch (err) {
    return failed(err);
  }
}

async function saveStart(service: SupabaseClient, body: Extract<Body, { action: 'start' }>, me: string) {
  const l = await load(service);
  if (!l.account) return refuse(409, NO_ACCOUNT);
  if (l.capped) return refuse(409, CAPPED);
  const start: RecStart = { firstMonth: `${body.firstMonth}-01`, asOf: body.asOf, balanceCents: body.balanceCents, outstanding: body.outstanding };
  const problems = startProblems(start, { thisMonth: l.thisMonth, docs: l.docs });
  if (problems.length) return refuse(400, problems.join(' '), { problems });

  const { data, error } = await service.rpc('bank_rec_start_save', {
    p: {
      company: LANDLORD, account: l.account.id, seen: body.seen, first_month: start.firstMonth, as_of: start.asOf,
      balance_cents: start.balanceCents, outstanding: start.outstanding, by: me,
    },
  });
  if (error) throw new Error(`Couldn't save where reconciling starts: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; updated_at?: string; let_go?: string[] };
  if (answer.state === 'changed') return refuse(409, 'Where reconciling starts was changed by someone else since you opened it: look at it again.');
  if (answer.state === 'done') {
    return refuse(409, 'A month is reconciled already, so where reconciling starts stays as it is: undo the months reconciled first.');
  }
  if (answer.state !== 'saved') throw new Error(`Couldn't save where reconciling starts: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  const letGo = answer.let_go ?? [];
  await logAudit(service, {
    actorId: me, table: 'bank_rec_starts', recordId: `${LANDLORD} ${l.account.id}`, action: 'start',
    detail: { first_month: start.firstMonth, as_of: start.asOf, outstanding: start.outstanding.length, let_go: letGo },
  });
  return NextResponse.json({ saved: true, updatedAt: answer.updated_at ?? null, letGo });
}

async function saveMonth(service: SupabaseClient, body: Extract<Body, { action: 'save' }>, me: string) {
  const l = await load(service);
  if (!l.account) return refuse(409, NO_ACCOUNT);
  if (l.capped) return refuse(409, CAPPED);
  if (!l.start) return refuse(409, 'Save where reconciling starts first.');
  const m = `${body.month}-01`;
  const name = monthName(m);
  if (m > l.thisMonth) return refuse(400, `${name} hasn't started yet.`);
  const next = nextMonth(l.start, l.recs);
  if (m !== next) {
    return refuse(409, next > l.thisMonth
      ? `Each month is reconciled through ${monthName(l.thisMonth)}.`
      : `${monthName(next)} is the month to reconcile now.`);
  }
  const problems = recProblems({ month: m, endsOn: body.endsOn, endingCents: body.endingCents });
  if (problems.length) return refuse(400, problems.join(' '), { problems });

  // What each entry ticked comes to is what the books have for it now, never what the page saw.
  const ticked = new Set(body.ticked);
  const view = nextView(booksOf({ ...l, start: l.start }), { month: m, endsOn: body.endsOn, endingCents: body.endingCents, ticked });
  const open = new Set(view.items.map((i) => i.doc));
  const cannot = [...ticked].filter((doc) => !open.has(doc)).length;
  if (cannot) {
    return refuse(409, `${entries(cannot)} ticked can't clear on ${name}'s statement now: gone from the books, dated after it, or cleared `
      + 'on a month before. Look at it again.');
  }
  if (body.finish) {
    if (body.endingCents === null) return refuse(400, "Type the statement's ending balance first.");
    if (view.differenceCents !== 0) {
      return refuse(409, `The statement's ending balance and what cleared are ${formatCents(Math.abs(view.differenceCents ?? 0))} apart, so ${name} `
        + "isn't reconciled yet.", { differenceCents: view.differenceCents });
    }
  }

  const ticks = view.items.filter((i) => i.ticked).map((i) => ({ doc: i.doc, cents: i.cents }));
  const { data, error } = await service.rpc('bank_rec_save', {
    p: {
      company: LANDLORD, account: l.account.id, month: m, seen: body.seen, ends_on: body.endsOn, ending_cents: body.endingCents,
      ticks, finish: body.finish, by: me,
    },
  });
  if (error) throw new Error(`Couldn't save ${name}: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; updated_at?: string; next?: string; apart_cents?: number };
  switch (answer.state) {
    case 'saved':
    case 'done':
      break;
    case 'changed': return refuse(409, `${name} was saved by someone else since you opened it: look at it again.`);
    case 'not_next': return refuse(409, `${monthName(answer.next ?? next)} is the month to reconcile now: look at it again.`);
    case 'taken': return refuse(409, 'An entry ticked cleared on a month before already: look at it again.');
    case 'apart': return refuse(409, `${name}'s starting balance changed while it was saved: look at it again.`);
    default: throw new Error(`Couldn't save ${name}: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  const done = answer.state === 'done';
  await logAudit(service, {
    actorId: me, table: 'bank_recs', recordId: `${LANDLORD} ${l.account.id} ${body.month}`, action: done ? 'reconciled' : 'save',
    detail: { month: m, ends_on: body.endsOn, ticked: ticks.length },
  });
  return NextResponse.json({ saved: true, done, updatedAt: answer.updated_at ?? null });
}

async function undoMonth(service: SupabaseClient, body: Extract<Body, { action: 'undo' }>, me: string) {
  const reason = body.reason.trim();
  if (!reason) return refuse(400, 'Say why the month is undone.');
  if (reason.length > REASON_MAX) return refuse(400, `Say why in ${REASON_MAX} characters at most.`);
  const bank = await readBank(service);
  if (!bank) return refuse(409, NO_ACCOUNT);
  const m = `${body.month}-01`;
  const name = monthName(m);

  const { data, error } = await service.rpc('bank_rec_undo', { p: { company: LANDLORD, account: bank, month: m, seen: body.seen, reason, by: me } });
  if (error) throw new Error(`Couldn't undo ${name}: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; updated_at?: string };
  switch (answer.state) {
    case 'undone':
      break;
    case 'not_last': return refuse(409, `${name} isn't the last month reconciled, so it stays as it is.`);
    case 'changed': return refuse(409, `${name} was changed by someone else since you opened it: look at it again.`);
    case 'next_ticked': return refuse(409, `${monthName(monthAfter(m))} has entries ticked: untick them there first, then undo ${name}.`);
    default: throw new Error(`Couldn't undo ${name}: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  await logAudit(service, {
    actorId: me, table: 'bank_recs', recordId: `${LANDLORD} ${bank} ${body.month}`, action: 'undo', detail: { month: m, reason },
  });
  return NextResponse.json({ undone: true, updatedAt: answer.updated_at ?? null });
}
