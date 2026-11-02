import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { detailDocuments, type AccountDocumentsData } from './report-detail';
import { FIRST_MONTH, accountName, cents } from './rent-and-mortgage';
import type { BankDoc, RecEvent, RecStart, RecTick, SavedRec } from './bank-reconciliation';

/**
 * What a bank account's reconciliation is worked out from (rules in
 * bank-reconciliation.ts, migration 493): where reconciling it starts, each
 * month saved with the entries that cleared on it, each month done or undone,
 * and the account's entries in FleetSuite's books from January 2025 through
 * this month. Books → 1084's bank reconciliation reads it for 1084's account
 * (/api/admin/books/bank-reconciliation), and the year-end package for each
 * account reconciled (readBankRecs in year-end-data.ts).
 */

/** The most entries on the account read at once (gl_books_account_documents takes up to 20,000). */
export const DOCS_MAX = 20000;

interface StartRow {
  first_month: string;
  as_of: string;
  balance_cents: number | string;
  outstanding: string[] | null;
  updated_by: string | null;
  updated_at: string;
}

interface RecRow {
  month: string;
  ends_on: string;
  ending_cents: number | string | null;
  status: 'open' | 'done';
  done_by: string | null;
  done_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

interface EventRow {
  month: string;
  action: 'done' | 'undone';
  reason: string | null;
  actor_id: string | null;
  created_at: string;
}

export interface BankRecRead {
  account: { id: string; name: string };
  start: (RecStart & { updatedAt: string; updatedBy: string | null }) | null;
  recs: SavedRec[];
  ticks: RecTick[];
  events: RecEvent[];
  docs: BankDoc[];
  /** The account's balance where FleetSuite's books start: NetSuite's at the end of 2024. */
  openingCents: number;
  /** Entries NetSuite's copy has on the account that FleetSuite's books haven't posted yet. */
  notPosted: number;
  /** More entries on the account than are read at once. */
  capped: boolean;
}

const day = (v: string) => String(v).slice(0, 10);

async function readNames(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const people = [...new Set(ids.filter((p): p is string => !!p))];
  if (!people.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', people);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name || 'Someone']));
}

/** Everything a company's bank account's reconciliation is worked out from, with each person named. `account` is NetSuite's id. */
export async function readBankRec(
  service: SupabaseClient,
  p: { company: string; account: string; thisMonth: string },
): Promise<BankRecRead> {
  const { company, account: bank } = p;
  const mine = <T>(table: string, columns: string, ...order: string[]) => fetchAllRows<T>((from, to) => {
    let q = service.from(table).select(columns).eq('company', company).eq('account', bank);
    for (const c of order) q = q.order(c);
    return q.range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  });
  const [accountRes, startRes, recsRes, ticksRes, eventsRes, docsRes, totalsRes] = await Promise.all([
    service.from('gl_accounts').select('number, name').eq('netsuite_account_id', bank).maybeSingle(),
    service.from('bank_rec_starts').select('first_month, as_of, balance_cents, outstanding, updated_by, updated_at')
      .eq('company', company).eq('account', bank).maybeSingle(),
    mine<RecRow>('bank_recs', 'month, ends_on, ending_cents, status, done_by, done_at, updated_by, updated_at', 'month'),
    mine<{ doc: string; month: string; cents: number | string }>('bank_rec_ticks', 'doc, month, cents', 'month', 'doc'),
    mine<EventRow & { id: string }>('bank_rec_events', 'id, month, action, reason, actor_id, created_at', 'created_at', 'id'),
    service.rpc('gl_books_account_documents', {
      p_company: company, p_account: bank, p_from: FIRST_MONTH, p_to: p.thisMonth, p_differs: false, p_limit: DOCS_MAX,
    }),
    service.rpc('gl_netsuite_totals', { p_company: company }),
  ]);
  for (const [what, res] of [
    ['the bank account', accountRes], ['where reconciling starts', startRes], ['the months', recsRes], ['what cleared', ticksRes],
    ['what was reconciled', eventsRes], ["the account's entries", docsRes], [`where ${company}'s books start`, totalsRes],
  ] as const) {
    if (res.error) throw new Error(`Couldn't read ${what}: ${res.error.message}`);
  }

  const startRow = startRes.data as StartRow | null;
  const recRows = recsRes.data;
  const eventRows = eventsRes.data;
  const names = await readNames(service, [
    startRow?.updated_by ?? null, ...recRows.flatMap((r) => [r.updated_by, r.done_by]), ...eventRows.map((e) => e.actor_id),
  ]);
  const nameOf = (id: string | null) => (id ? names.get(id) ?? 'Someone' : null);

  const found = docsRes.data as AccountDocumentsData;
  const documents = detailDocuments(found, 1);
  const opening = ((totalsRes.data ?? {}) as { opening?: Array<{ netsuite_account_id: string; debit: string; credit: string }> }).opening ?? [];
  const account = accountRes.data as { number: string | null; name: string } | null;
  return {
    account: { id: bank, name: account ? accountName(account) : `Account ${bank}` },
    start: startRow && {
      firstMonth: day(startRow.first_month), asOf: day(startRow.as_of), balanceCents: Number(startRow.balance_cents),
      outstanding: startRow.outstanding ?? [], updatedAt: startRow.updated_at, updatedBy: nameOf(startRow.updated_by),
    },
    recs: recRows.map((r) => ({
      month: day(r.month), endsOn: day(r.ends_on), endingCents: r.ending_cents === null ? null : Number(r.ending_cents), status: r.status,
      updatedAt: r.updated_at, updatedBy: nameOf(r.updated_by), doneAt: r.done_at, doneBy: nameOf(r.done_by),
    })),
    ticks: ticksRes.data.map((t) => ({ doc: t.doc, month: day(t.month), cents: Number(t.cents) })),
    events: eventRows.map((e) => ({ month: day(e.month), action: e.action, reason: e.reason, by: nameOf(e.actor_id), at: e.created_at })),
    docs: documents.filter((d) => d.fleetsuite !== 0 && d.date).map((d) => ({
      doc: d.doc, date: d.date!, type: d.type, number: d.number, name: d.name, memo: d.memo, cents: d.fleetsuite,
    })),
    openingCents: opening.filter((o) => o.netsuite_account_id === bank).reduce((sum, o) => sum + cents(o.debit) - cents(o.credit), 0),
    notPosted: documents.filter((d) => d.fleetsuite === 0 && d.netsuite !== 0).length,
    capped: found.documents > found.rows.length,
  };
}
