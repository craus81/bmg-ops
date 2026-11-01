// Migration 484 puts each journal entry typed in FleetSuite in one of two
// journals, the general one or the CPA's own adjustments (Books part 53):
// every entry typed before it is in the general journal, a new one starts in
// the journal it's saved in, and an entry stays in the journal it started in.
// This runs migration 359 with 466 to 469 in an in-memory Postgres (PGlite)
// as the app's server login, saves an entry the way /api/journal-entries did
// before, runs 484, and saves the way it does now. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keptLines, linesToKeep, workOutTypedEntry, type TypedEntryFacts, type TypedLine } from '@/lib/typed-journal-entries';
import { ownTypedEntryPayload } from './own-journal-entries';

const ENTRY = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
const CPA = 'a0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000002';

const migration = (file: string) => readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');

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
    INSERT INTO public.profiles (id) VALUES ('${CPA}'), ('${OWNER}');
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql',
    '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql']) {
    await pg.exec(migration(file));
  }
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

const line = (accountId: string, debitCents: number, creditCents: number): TypedLine => ({ accountId, debitCents, creditCents, memo: null });
/** The year's depreciation the CPA books: $9,600.00 to depreciation, against accumulated depreciation. */
const LINES = [line('610', 960000, 0), line('150', 0, 960000)];
const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, company: 'BMG', tran_date: '2026-12-31', memo: '2026 depreciation', lines: linesToKeep(LINES), by: CPA, ...over,
});
const row = async (pg: PGlite, id: string) =>
  (await pg.query<Record<string, any>>(`SELECT *, tran_date::text AS tran_date, updated_at::text AS updated_at, asked_at::text AS asked_at
    FROM typed_journal_entries WHERE id = $1`, [id])).rows[0];

const FACTS: TypedEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  accounts: new Map([
    ['610', { id: '610', number: '6100', name: 'Depreciation', type: 'expense', companies: ['BMG'] }],
    ['150', { id: '150', number: '1590', name: 'Accumulated depreciation', type: 'fixed_asset', companies: ['BMG'] }],
  ]),
};

describe('migration 484', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec('SET ROLE service_role');
    // Typed before the CPA had a journal: saved without saying one.
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(1), { memo: 'November accrual', by: OWNER }));
    await pg.exec('RESET ROLE');
    await pg.exec(migration('484-books-cpa-adjustments-journal.sql'));
    await pg.exec(migration('484-books-cpa-adjustments-journal.sql')); // must be safe to re-run
    await pg.exec('SET ROLE service_role');
  });
  afterAll(async () => { await pg.close(); });

  it('puts every entry typed until now in the general journal, and takes only the two journals', async () => {
    expect(await row(pg, ENTRY(1))).toMatchObject({ journal: 'general', memo: 'November accrual', status: 'draft' });
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.typed_journal_entries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%cpa_adjustments%'`)).rows;
    expect(checks).toHaveLength(1);
    await expect(pg.query(`INSERT INTO typed_journal_entries (id, journal, company, tran_date) VALUES ($1, 'payroll', 'BMG', '2027-01-31')`, [ENTRY(9)]))
      .rejects.toThrow(/check/i);
    await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(9), { journal: 'payroll' }))).rejects.toThrow(/there's no payroll journal/);
    // Saved without saying one, as the route did before part 53, it's the general journal's.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(2), { journal: '' }))).toMatchObject({ saved: true, status: 'draft' });
    expect((await row(pg, ENTRY(2))).journal).toBe('general');
  });

  it('starts a CPA adjustment in its own journal and keeps it there', async () => {
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(3), { journal: 'cpa_adjustments' }))).toMatchObject({ saved: true, status: 'draft' });
    expect(await row(pg, ENTRY(3))).toMatchObject({ journal: 'cpa_adjustments', memo: '2026 depreciation', total_cents: 960000, created_by: CPA });

    // Changed in its own journal, it's saved.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(3), { journal: 'cpa_adjustments', memo: '2026 depreciation, all trucks' })))
      .toMatchObject({ saved: true, status: 'draft' });
    const before = await row(pg, ENTRY(3));
    expect(before.memo).toBe('2026 depreciation, all trucks');

    // Saved as the general journal's, nothing changes, and it says which journal it's in.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(3), { memo: 'Moved', by: OWNER }))).toEqual({
      saved: false, status: 'other_journal', journal: 'cpa_adjustments', updated_at: expect.any(String),
    });
    // And a general entry isn't saved as a CPA adjustment.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(1), { journal: 'cpa_adjustments', memo: 'Mine now' }))).toMatchObject({
      saved: false, status: 'other_journal', journal: 'general',
    });
    expect(await row(pg, ENTRY(3))).toEqual(before);
    expect(await row(pg, ENTRY(1))).toMatchObject({ journal: 'general', memo: 'November accrual', updated_by: OWNER });
  });

  it('asks for, approves and makes a CPA adjustment as any other, and keeps its copy with its memo as NetSuite has it', async () => {
    await call(pg, 'typed_journal_entry_save', draft(ENTRY(4), { journal: 'cpa_adjustments' }));
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(4), by: CPA, updated_at: (await row(pg, ENTRY(4))).updated_at }))
      .toMatchObject({ state: 'asked' });
    expect(await call(pg, 'typed_journal_entry_claim', { id: ENTRY(4), approver: CPA, asked_at: (await row(pg, ENTRY(4))).asked_at }))
      .toEqual({ state: 'yours' });
    const claimed = await call(pg, 'typed_journal_entry_claim', { id: ENTRY(4), approver: OWNER, asked_at: (await row(pg, ENTRY(4))).asked_at });
    expect(claimed).toMatchObject({ state: 'claimed', entry: { journal: 'cpa_adjustments', status: 'sending' } });
    expect(await call(pg, 'typed_journal_entry_made', { id: ENTRY(4), netsuite_journal_id: '7020', netsuite_number: 'JE-520' })).toEqual({ made: true });
    // Once it's made, it isn't changed in either journal.
    expect(await call(pg, 'typed_journal_entry_save', draft(ENTRY(4), { journal: 'cpa_adjustments', memo: 'Later' })))
      .toMatchObject({ saved: false, status: 'made' });

    const kept = await row(pg, ENTRY(4));
    const worked = workOutTypedEntry({ journal: kept.journal, date: kept.tran_date, memo: kept.memo, lines: keptLines(kept.lines) }, FACTS);
    expect(worked).toMatchObject({ problems: [], memo: 'CPA adjustment: 2026 depreciation', debitCents: 960000 });
    const p = ownTypedEntryPayload({ netsuiteId: '7020', netsuiteNumber: 'JE-520', company: 'BMG', worked, madeFromId: ENTRY(4), madeBy: OWNER });
    expect(await call(pg, 'gl_own_journal_entry_save', p)).toEqual({ saved: true, lines: 2 });
    expect((await pg.query(`SELECT source, made_from_id, memo, total::text AS total FROM gl_own_journal_entries WHERE netsuite_id = '7020'`)).rows)
      .toEqual([{ source: 'typed', made_from_id: ENTRY(4), memo: 'CPA adjustment: 2026 depreciation', total: '9600.00' }]);
  });

  it('lets only the server login save one', async () => {
    for (const role of ['authenticated', 'anon']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      try {
        await expect(call(pg, 'typed_journal_entry_save', draft(ENTRY(5), { journal: 'cpa_adjustments' })))
          .rejects.toThrow(/permission denied for function typed_journal_entry_save/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    expect((await pg.query(`SELECT count(*)::int AS n FROM typed_journal_entries WHERE id = $1`, [ENTRY(5)])).rows).toEqual([{ n: 0 }]);
  });
});
