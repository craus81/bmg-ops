// Migration 469 switches journal entries typed in FleetSuite off until
// January 1, 2027, keeps each entry's lines as typed, moves it from draft to
// asked for approval to approved and made, and back to a draft when it's
// taken back or sent back, and keeps Books' own copy of each one made. This
// runs migration 359 with 466 to 469 in an in-memory Postgres (PGlite) as the
// app's server login, saves lines src/lib/typed-journal-entries.ts keeps the
// way /api/journal-entries does, and saves the copy
// src/lib/books/own-journal-entries.ts works out. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keptLines, linesToKeep, workOutTypedEntry, type KeptLine, type TypedEntryFacts, type TypedLine } from '@/lib/typed-journal-entries';
import { ownTypedEntryPayload } from './own-journal-entries';

const ENTRY = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
const ASKER = 'a0000000-0000-4000-8000-000000000001';
const APPROVER = 'a0000000-0000-4000-8000-000000000002';

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- What migrations 466 to 469 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${ASKER}'), ('${APPROVER}');
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql',
    '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

const line = (accountId: string | null, debitCents: number, creditCents: number, memo: string | null = null): TypedLine =>
  ({ accountId, debitCents, creditCents, memo });
/** January's depreciation, typed: $1,250.00 to depreciation, split over two trucks, against accumulated depreciation. */
const LINES = [line('610', 80000, 0, ' Shop truck '), line('610', 45000, 0, 'Box van'), line('150', 0, 125000, '  ')];
const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, company: 'BMG', tran_date: '2027-01-31', memo: ' January depreciation ', lines: linesToKeep(LINES), by: ASKER, ...over,
});

type Row = { status: string; updated_at: string; asked_at: string | null; lines: KeptLine[] } & Record<string, unknown>;
const row = async (pg: PGlite, id: string) =>
  (await pg.query<Row>(`SELECT *, tran_date::text AS tran_date, updated_at::text AS updated_at, asked_at::text AS asked_at
    FROM typed_journal_entries WHERE id = $1`, [id])).rows[0];
/** The draft as the page last read it, asked for approval. */
const ask = async (pg: PGlite, id: string, by: string | null = ASKER) =>
  call(pg, 'typed_journal_entry_ask', { id, by, updated_at: (await row(pg, id)).updated_at });
/** The ask as the approver saw it, approved. */
const claim = async (pg: PGlite, id: string, approver: string | null = APPROVER) =>
  call(pg, 'typed_journal_entry_claim', { id, approver, asked_at: (await row(pg, id)).asked_at });

const FACTS: TypedEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  accounts: new Map([
    ['610', { id: '610', number: '6100', name: 'Depreciation', type: 'expense', companies: ['BMG'] }],
    ['150', { id: '150', number: '1590', name: 'Accumulated depreciation', type: 'fixed_asset', companies: ['BMG'] }],
  ]),
};

describe('migration 469', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts journal entries switched off, next to the other three, and lets Books keep typed ones', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    for (const table of ['books_switches', 'gl_own_journal_entries']) {
      const checks = (await pg.query<{ def: string }>(`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%piece%' OR pg_get_constraintdef(oid) LIKE '%source%')`, [`public.${table}`])).rows;
      expect(checks).toHaveLength(1);
    }
  });

  it('saves a draft as typed, its memos trimmed and its total its debits, and changes it while it is one', async () => {
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(1)))).toMatchObject({ saved: true, status: 'draft' });
    const saved = await row(pg, ENTRY(1));
    expect(saved).toMatchObject({
      company: 'BMG', tran_date: '2027-01-31', memo: 'January depreciation', total_cents: 125000, status: 'draft',
      created_by: ASKER, updated_by: ASKER, asked_by: null, asked_at: null, approved_at: null, netsuite_journal_id: null,
    });
    expect(saved.lines).toEqual([
      { account_netsuite_id: '610', debit_cents: 80000, credit_cents: 0, memo: 'Shop truck' },
      { account_netsuite_id: '610', debit_cents: 45000, credit_cents: 0, memo: 'Box van' },
      { account_netsuite_id: '150', debit_cents: 0, credit_cents: 125000, memo: null },
    ]);
    expect(keptLines(saved.lines)).toEqual([line('610', 80000, 0, 'Shop truck'), line('610', 45000, 0, 'Box van'), line('150', 0, 125000)]);

    // The database keeps lines as it's given them only once each memo is trimmed, a blank one none.
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(5), { lines: [
      { account_netsuite_id: '610', debit_cents: 100, credit_cents: 0, memo: ' Box van ' },
      { account_netsuite_id: '150', debit_cents: 0, credit_cents: 100, memo: '   ' },
      { account_netsuite_id: null, debit_cents: 0, credit_cents: 0 },
    ] }));
    expect((await row(pg, ENTRY(5))).lines).toEqual([
      { account_netsuite_id: '610', debit_cents: 100, credit_cents: 0, memo: 'Box van' },
      { account_netsuite_id: '150', debit_cents: 0, credit_cents: 100, memo: null },
      { account_netsuite_id: null, debit_cents: 0, credit_cents: 0, memo: null },
    ]);

    // Half typed is still a draft worth keeping: no account yet, no memo, nothing balanced.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(1), {
      memo: '', by: APPROVER, lines: [{ account_netsuite_id: null, debit_cents: 500, credit_cents: 0, memo: null }],
    }))).toMatchObject({ saved: true, status: 'draft' });
    expect(await row(pg, ENTRY(1))).toMatchObject({ memo: null, total_cents: 500, created_by: ASKER, updated_by: APPROVER });
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(1)));
  });

  it("refuses lines that aren't a list of accounts and whole cents of $0 or more", async () => {
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { lines: {} }))).rejects.toThrow(/must be a list/);
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), {
      lines: Array.from({ length: 201 }, () => ({ account_netsuite_id: '610', debit_cents: 1, credit_cents: 0 })),
    }))).rejects.toThrow(/200 lines at most/);
    const good = { account_netsuite_id: '610', debit_cents: 100, credit_cents: 0, memo: null };
    for (const bad of [
      'a line', { ...good, account_netsuite_id: 'Shop' }, { ...good, account_netsuite_id: 610 }, { ...good, debit_cents: '100' },
      { ...good, credit_cents: null }, { ...good, debit_cents: -1 }, { ...good, credit_cents: 0.5 }, { ...good, debit_cents: 10000000001 },
      { ...good, memo: 'm'.repeat(301) },
    ]) {
      await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { lines: [good, bad] }))).rejects.toThrow(/each line is an account/);
    }
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { company: ' ' }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { memo: 'm'.repeat(301) }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { tran_date: null }))).rejects.toThrow(/null value/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM typed_journal_entries WHERE id = $1`, [ENTRY(9)])).rows).toEqual([{ n: 0 }]);
  });

  it('asks for approval only of a whole, balanced draft, as the asker saw it', async () => {
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(2)));
    const asSeen = (await row(pg, ENTRY(2))).updated_at;
    // Saved again after the page read it, the ask the page makes is refused.
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { memo: 'January depreciation, again' }));
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(2), by: ASKER, updated_at: asSeen })).toEqual({ state: 'changed' });
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(2), by: ASKER, updated_at: '2027-01-31T00:00:00Z' })).toEqual({ state: 'changed' });
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(2), by: ASKER })).toEqual({ state: 'changed' });
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(8), by: ASKER, updated_at: asSeen })).toEqual({ state: 'gone' });

    for (const lines of [
      [line('610', 125000, 0)],
      [line('610', 125000, 0), line('150', 0, 124999)],
      [line(null, 125000, 0), line('150', 0, 125000)],
      [line('610', 125000, 125000), line('150', 0, 0)],
    ]) {
      await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { lines: linesToKeep(lines) }));
      await expect(ask(pg, ENTRY(2))).rejects.toThrow(/needs a memo and two lines or more/);
    }
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { memo: '  ' }));
    await expect(ask(pg, ENTRY(2))).rejects.toThrow(/needs a memo/);

    await call(pg, 'typed_journal_entry_save', draft(ENTRY(2)));
    const asked = await ask(pg, ENTRY(2));
    expect(asked).toEqual({ state: 'asked', asked_at: expect.any(String) });
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'waiting', asked_by: ASKER });
    // Asked again, or saved while it waits, it stays as it is.
    expect(await ask(pg, ENTRY(2))).toEqual({ state: 'waiting' });
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { memo: 'Changed' }))).toMatchObject({ saved: false, status: 'waiting' });
    expect(await row(pg, ENTRY(2))).toMatchObject({ memo: 'January depreciation', total_cents: 125000 });
  });

  it('takes an ask back, or sends it back with why, to a draft that can be changed and asked again', async () => {
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(2), by: ASKER })).toEqual({ state: 'taken_back' });
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'draft', asked_by: null, asked_at: null });
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(2), by: ASKER })).toEqual({ state: 'draft' });
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(8) })).toEqual({ state: 'gone' });

    await ask(pg, ENTRY(2));
    await expect(call(pg, 'typed_journal_entry_send_back', { id: ENTRY(2), by: APPROVER, reason: '   ' })).rejects.toThrow(/needs a reason/);
    expect(await call(pg, 'typed_journal_entry_send_back', { id: ENTRY(2), by: APPROVER, reason: ' Split it by truck ' })).toEqual({ state: 'sent_back' });
    expect(await row(pg, ENTRY(2))).toMatchObject({
      status: 'draft', asked_by: null, asked_at: null, returned_by: APPROVER, returned_reason: 'Split it by truck',
    });
    expect(await call(pg, 'typed_journal_entry_send_back', { id: ENTRY(2), by: APPROVER, reason: 'Again' })).toEqual({ state: 'draft' });
    expect(await call(pg, 'typed_journal_entry_send_back', { id: ENTRY(8), reason: 'Gone' })).toEqual({ state: 'gone' });

    // Fixed and asked again, why it went back is cleared.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { memo: 'January depreciation by truck' }))).toMatchObject({ saved: true });
    await ask(pg, ENTRY(2));
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'waiting', returned_by: null, returned_at: null, returned_reason: null });
  });

  it('lets one approval by someone who did not ask make it, of the ask the approver saw', async () => {
    await expect(claim(pg, ENTRY(2), null)).rejects.toThrow(/needs who approved it/);
    expect(await claim(pg, ENTRY(2), ASKER)).toEqual({ state: 'yours' });
    expect(await call(pg, 'typed_journal_entry_claim', { id: ENTRY(2), approver: APPROVER, asked_at: '2027-01-31T00:00:00Z' })).toEqual({ state: 'changed' });
    expect(await call(pg, 'typed_journal_entry_claim', { id: ENTRY(8), approver: APPROVER })).toEqual({ state: 'gone' });
    expect(await call(pg, 'typed_journal_entry_claim', { id: ENTRY(1), approver: APPROVER })).toEqual({ state: 'draft' });

    const claimed = await claim(pg, ENTRY(2));
    expect(claimed).toMatchObject({ state: 'claimed', entry: { id: ENTRY(2), status: 'sending', approved_by: APPROVER, asked_by: ASKER, tran_date: '2027-01-31' } });
    expect(keptLines(claimed.entry.lines)).toEqual(keptLines(linesToKeep(LINES)));
    // A second press while it's being made answers that, with the entry to ask NetSuite about.
    expect(await claim(pg, ENTRY(2))).toMatchObject({ state: 'making', entry: { id: ENTRY(2), status: 'sending' } });
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(2) })).toEqual({ state: 'sending' });
    expect(await call(pg, 'typed_journal_entry_send_back', { id: ENTRY(2), reason: 'Late' })).toEqual({ state: 'sending' });
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(2)))).toMatchObject({ saved: false, status: 'sending' });

    // NetSuite refused it: it waits for approval again, with why.
    expect(await call(pg, 'typed_journal_entry_let_go', { id: ENTRY(2), error: 'NetSuite error (400): Period closed' })).toEqual({ let_go: true });
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'waiting', approved_by: null, approved_at: null, error: 'NetSuite error (400): Period closed' });
    expect(await call(pg, 'typed_journal_entry_let_go', { id: ENTRY(2), error: 'Again' })).toEqual({ let_go: false });
    expect(await claim(pg, ENTRY(2))).toMatchObject({ state: 'claimed' });
    expect(await call(pg, 'typed_journal_entry_let_go', { id: ENTRY(2), error: '  ' })).toEqual({ let_go: true });
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'waiting', error: 'Not made' });

    expect(await claim(pg, ENTRY(2))).toMatchObject({ state: 'claimed' });
    expect(await row(pg, ENTRY(2))).toMatchObject({ error: null });
    await expect(call(pg, 'typed_journal_entry_made', { id: ENTRY(2), netsuite_journal_id: 'JE-510' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'typed_journal_entry_made', { id: ENTRY(2) })).rejects.toThrow(/needs NetSuite's id/);
    expect(await call(pg, 'typed_journal_entry_made', { id: ENTRY(2), netsuite_journal_id: '7010', netsuite_number: ' JE-510 ' })).toEqual({ made: true });
    expect(await row(pg, ENTRY(2))).toMatchObject({ status: 'made', netsuite_journal_id: '7010', netsuite_number: 'JE-510', approved_by: APPROVER });

    // Made once, it stays made.
    expect(await claim(pg, ENTRY(2))).toEqual({ state: 'made', netsuite_journal_id: '7010', netsuite_number: 'JE-510' });
    expect(await call(pg, 'typed_journal_entry_made', { id: ENTRY(2), netsuite_journal_id: '7011' })).toEqual({ made: false });
    expect(await call(pg, 'typed_journal_entry_let_go', { id: ENTRY(2), error: 'Late' })).toEqual({ let_go: false });
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(2)))).toMatchObject({ saved: false, status: 'made' });
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(2) })).toEqual({ state: 'made' });
    expect(await row(pg, ENTRY(2))).toMatchObject({ netsuite_journal_id: '7010', memo: 'January depreciation by truck' });
  });

  it("lets anyone approve an ask whose asker isn't known any more", async () => {
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(3)));
    await ask(pg, ENTRY(3), null);
    expect(await claim(pg, ENTRY(3), ASKER)).toMatchObject({ state: 'claimed' });
  });

  it("saves Books' copy of the journal entry as typed, from the lines as they're kept", async () => {
    const kept = await row(pg, ENTRY(2));
    const worked = workOutTypedEntry({ date: String(kept.tran_date), memo: kept.memo as string, lines: keptLines(kept.lines) }, FACTS);
    expect(worked).toMatchObject({ problems: [], debitCents: 125000, creditCents: 125000 });
    const p = ownTypedEntryPayload({ netsuiteId: '7010', netsuiteNumber: 'JE-510', company: 'BMG', worked, madeFromId: ENTRY(2), madeBy: APPROVER });
    expect(await call(pg, 'gl_own_journal_entry_save', p)).toEqual({ saved: true, lines: 3 });

    expect((await pg.query(`
      SELECT j.netsuite_id, co.code AS company, j.source, j.made_from_id, j.netsuite_number, j.tran_date::text AS tran_date, j.memo, j.rule,
             j.total::text AS total, j.made_by
      FROM gl_own_journal_entries j JOIN gl_companies co ON co.id = j.company_id`)).rows).toEqual([{
      netsuite_id: '7010', company: 'BMG', source: 'typed', made_from_id: ENTRY(2), netsuite_number: 'JE-510', tran_date: '2027-01-31',
      memo: 'January depreciation by truck', rule: 'typed_journal_entry@1', total: '1250.00', made_by: APPROVER,
    }]);
    expect((await pg.query(`
      SELECT line_no, account_netsuite_id, debit::text AS debit, credit::text AS credit, memo, card_charge_id
      FROM gl_own_journal_entry_lines WHERE journal_entry_id = '7010' ORDER BY line_no`)).rows).toEqual([
      { line_no: 1, account_netsuite_id: '610', debit: '800.00', credit: '0.00', memo: 'Shop truck', card_charge_id: null },
      { line_no: 2, account_netsuite_id: '610', debit: '450.00', credit: '0.00', memo: 'Box van', card_charge_id: null },
      { line_no: 3, account_netsuite_id: '150', debit: '0.00', credit: '1250.00', memo: null, card_charge_id: null },
    ]);
    expect(await call(pg, 'gl_own_journal_entry_save', p)).toEqual({ saved: false, lines: 0 });
  });

  it('refuses an entry that says it is somewhere it is not', async () => {
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = { id: ENTRY(7), company: 'BMG', tran_date: '2027-03-31', ...over };
      const cols = Object.keys(r);
      return pg.query(`INSERT INTO typed_journal_entries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    };
    for (const over of [
      { status: 'waiting' }, { status: 'sending', asked_at: '2027-04-01T00:00:00Z' },
      { status: 'made', asked_at: '2027-04-01T00:00:00Z', approved_at: '2027-04-01T00:00:00Z' },
      { netsuite_journal_id: '7012' }, { status: 'gone', asked_at: '2027-04-01T00:00:00Z' }, { total_cents: -1 },
      { netsuite_journal_id: 'JE-512', status: 'made', asked_at: '2027-04-01T00:00:00Z', approved_at: '2027-04-01T00:00:00Z' },
      { lines: {} }, { returned_reason: 'r'.repeat(501) }, { error: 'e'.repeat(2001) },
    ]) {
      await expect(insert(over)).rejects.toThrow(/check/i);
    }
    await expect(insert({ created_by: 'a0000000-0000-4000-8000-000000000009' })).rejects.toThrow(/foreign key/);
    await insert({ status: 'made', asked_at: '2027-04-01T00:00:00Z', approved_at: '2027-04-01T00:00:00Z', netsuite_journal_id: '7012' });
  });

  it('lets only the server login near it', async () => {
    for (const role of ['authenticated', 'anon']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      try {
        await expect(pg.query('SELECT * FROM typed_journal_entries')).rejects.toThrow(/permission denied/);
        for (const fn of ['typed_journal_entry_save', 'typed_journal_entry_ask', 'typed_journal_entry_take_back', 'typed_journal_entry_send_back',
          'typed_journal_entry_claim', 'typed_journal_entry_let_go', 'typed_journal_entry_made']) {
          await expect(call(pg, fn, { id: ENTRY(2) })).rejects.toThrow(/permission denied/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    expect((await pg.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.typed_journal_entries'::regclass`)).rows).toEqual([{ relrowsecurity: true }]);
  });
});
