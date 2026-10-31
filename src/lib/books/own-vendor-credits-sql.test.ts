// Migration 467 switches vendor credits off until January 1, 2027, keeps one
// row per press of Make vendor credit with one vendor credit per vendor's
// credit number, and Books' own copy of each vendor credit FleetSuite makes.
// This runs migration 359 with 466 and 467 in an in-memory Postgres (PGlite)
// as the app's server login, saves copies worked out by
// src/lib/vendor-credit.ts and src/lib/books/own-vendor-credits.ts, and holds
// what gl_own_vendor_credit_save keeps and refuses. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { workOutVendorCredit, type VendorCreditDraft, type VendorCreditFacts } from '@/lib/vendor-credit';
import { ownVendorCreditPayload } from './own-vendor-credits';

const PRESS = 'b0000000-0000-4000-8000-000000000001';

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
    -- What migrations 466 and 467 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const FACTS: VendorCreditFacts = {
  today: '2026-10-31',
  companies: [{ code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }] }],
  accounts: new Map([['610', { id: '610', number: '5100', name: 'Shop supplies', companies: ['BMG'] }]]),
  parts: new Map([['55', { id: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', stock: true, cost: 125.5, onHand: 4 }]]),
  vendor: { id: '4001', name: 'Acme Racks' },
  openBills: [
    { id: '3001', number: 'B-100', date: '2026-09-01', dueDate: null, openCents: 20000 },
    { id: '3002', number: 'B-101', date: '2026-08-15', dueDate: null, openCents: 5000 },
  ],
};
const DRAFT: VendorCreditDraft = {
  company: 'BMG', vendorId: '4001', number: ' VC-77 ', date: '2026-10-30', locationId: '1', reason: 'Returned shelf',
  lines: [
    // 2 × 62.7525 = 125.505, which rounds half to even: $125.50.
    { kind: 'part', itemId: '55', quantity: 2, rate: 62.7525 },
    { kind: 'account', accountId: '610', amount: 20, memo: 'Restock fee back' },
  ],
  applied: [{ billId: '3002', amount: 50 }, { billId: '3001', amount: 25.5 }],
};

const payload = (netsuiteId: string, over: Partial<VendorCreditDraft> = {}) => {
  const draft = { ...DRAFT, ...over };
  const worked = workOutVendorCredit(draft, FACTS);
  expect(worked.problems).toEqual([]);
  return ownVendorCreditPayload({ netsuiteId, draft, worked, vendorName: 'Acme Racks', madeFromId: PRESS, madeBy: null });
};

const save = async (pg: PGlite, p: unknown) =>
  (await pg.query<{ r: { saved: boolean; lines: number } }>('SELECT gl_own_vendor_credit_save($1::jsonb) AS r', [JSON.stringify(p)])).rows[0].r;

const press = (id: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id, company: 'BMG', vendor_netsuite_id: '4001', credit_number: 'VC-77', credit_date: '2026-10-30', reason: 'Returned shelf',
    claimed_at: new Date().toISOString(), netsuite_vendor_credit_id: null, ...over,
  };
  const cols = Object.keys(row);
  return [`INSERT INTO typed_vendor_credits (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row)] as const;
};

describe('migration 467', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts vendor credits switched off, next to credit memos', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    expect((await pg.query(`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'`)).rows).toEqual([{ n: 1 }]);
  });

  it('keeps one row per press, and one press per vendor credit number while it is being made or made', async () => {
    const [sql, args] = press(PRESS);
    await pg.query(sql, [...args]);
    await expect(pg.query(...press(PRESS, { credit_number: 'VC-78' }))).rejects.toThrow(/duplicate key/);
    // The same vendor's number, however it's typed, is held by the first press.
    await expect(pg.query(...press('b0000000-0000-4000-8000-000000000002', { credit_number: ' vc-77 ' }))).rejects.toThrow(/typed_vendor_credits_once/);
    // A press NetSuite refused lets go of the number; another vendor's number is its own.
    await pg.query(...press('b0000000-0000-4000-8000-000000000003', { claimed_at: null, error: 'Invalid item' }));
    await pg.query(...press('b0000000-0000-4000-8000-000000000004', { vendor_netsuite_id: '4777' }));
    // Letting go of the claim frees the number for the next press, and a made one holds it again.
    await pg.query(`UPDATE typed_vendor_credits SET claimed_at = NULL WHERE id = $1`, [PRESS]);
    await pg.query(`UPDATE typed_vendor_credits SET netsuite_vendor_credit_id = '6002' WHERE id = 'b0000000-0000-4000-8000-000000000003'`);
    await expect(pg.query(`UPDATE typed_vendor_credits SET claimed_at = now() WHERE id = $1`, [PRESS])).rejects.toThrow(/typed_vendor_credits_once/);
  });

  it("refuses a press with no number, a number past 40 characters, no reason, or a vendor that isn't NetSuite's id", async () => {
    const id = 'b0000000-0000-4000-8000-000000000005';
    for (const over of [
      { credit_number: '  ' }, { credit_number: 'x'.repeat(41) }, { reason: ' ' }, { vendor_netsuite_id: 'ACME' }, { company: ' ' },
      { location_netsuite_id: "O'Fallon" }, { netsuite_vendor_credit_id: 'VC6002' },
    ]) {
      await expect(pg.query(...press(id, { credit_number: 'VC-90', claimed_at: null, ...over }))).rejects.toThrow(/check/i);
    }
    await pg.query(...press(id, { credit_number: 'x'.repeat(40), claimed_at: null }));
  });

  it('saves the copy whole: its lines, the bills it applied to, and what stays open', async () => {
    const p = payload('6002');
    expect(await save(pg, p)).toEqual({ saved: true, lines: 2 });
    expect((await pg.query(`
      SELECT v.netsuite_id, co.code AS company, v.made_from_id, v.vendor_netsuite_id, v.vendor_name, v.credit_number,
             v.credit_date::text AS credit_date, v.location_netsuite_id, v.reason, v.rule, v.total::text AS total,
             v.applied::text AS applied, v.applied_to
      FROM gl_own_vendor_credits v JOIN gl_companies co ON co.id = v.company_id`)).rows).toEqual([{
      netsuite_id: '6002', company: 'BMG', made_from_id: PRESS, vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', credit_number: 'VC-77',
      credit_date: '2026-10-30', location_netsuite_id: '1', reason: 'Returned shelf', rule: 'vendor_credit@1', total: '145.50', applied: '75.50',
      applied_to: [{ bill_netsuite_id: '3002', bill_number: 'B-101', amount: '50.00' }, { bill_netsuite_id: '3001', bill_number: 'B-100', amount: '25.50' }],
    }]);
    expect((await pg.query(`
      SELECT line_no, kind, account_netsuite_id, item_netsuite_id, item_number, description, quantity::text AS quantity,
             rate::text AS rate, amount::text AS amount
      FROM gl_own_vendor_credit_lines ORDER BY line_no`)).rows).toEqual([
      { line_no: 1, kind: 'part', account_netsuite_id: null, item_netsuite_id: '55', item_number: 'SHELF-1', description: 'Shelf unit', quantity: '2.0000', rate: '62.7525', amount: '125.50' },
      { line_no: 2, kind: 'account', account_netsuite_id: '610', item_netsuite_id: null, item_number: null, description: 'Restock fee back', quantity: null, rate: null, amount: '20.00' },
    ]);
  });

  it('leaves a copy already saved as it is', async () => {
    expect(await save(pg, payload('6002', { lines: [{ kind: 'account', accountId: '610', amount: 99 }], applied: [] }))).toEqual({ saved: false, lines: 0 });
    expect((await pg.query(`SELECT total::text AS total FROM gl_own_vendor_credits WHERE netsuite_id = '6002'`)).rows).toEqual([{ total: '145.50' }]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_vendor_credit_lines WHERE vendor_credit_id = '6002'`)).rows).toEqual([{ n: 2 }]);
  });

  it('saves one applied to no bills, all of it left open on the vendor', async () => {
    expect(await save(pg, payload('6003', { applied: [], lines: [{ kind: 'account', accountId: '610', amount: 12.34 }] }))).toEqual({ saved: true, lines: 1 });
    expect((await pg.query(`SELECT applied::text AS applied, applied_to FROM gl_own_vendor_credits WHERE netsuite_id = '6003'`)).rows)
      .toEqual([{ applied: '0.00', applied_to: [] }]);
  });

  it("refuses a copy that doesn't add up, has no lines, or names its bills wrong", async () => {
    const p = payload('6004');
    await expect(save(pg, { ...p, total: '145.51' })).rejects.toThrow(/lines don't add up to its total/);
    await expect(save(pg, { ...p, lines: [] })).rejects.toThrow(/needs its lines/);
    await expect(save(pg, { ...p, lines: {} })).rejects.toThrow(/needs its lines/);
    await expect(save(pg, { ...p, applied_to: {} })).rejects.toThrow(/must be a list/);
    await expect(save(pg, { ...p, applied: '75.00' })).rejects.toThrow(/bills don't add up to what it applied/);
    await expect(save(pg, { ...p, applied_to: [{ ...p.applied_to[0], bill_netsuite_id: 'B-101' }, p.applied_to[1]] })).rejects.toThrow(/bills don't add up/);
    await expect(save(pg, { ...p, applied: '50.00', applied_to: [p.applied_to[0], { ...p.applied_to[1], amount: '0.00' }] })).rejects.toThrow(/bills don't add up/);
    await expect(save(pg, { ...p, netsuite_id: 'VC6004' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(save(pg, { ...p, netsuite_id: undefined })).rejects.toThrow(/needs NetSuite's id/);
    await expect(save(pg, { ...p, company: 'NOPE' })).rejects.toThrow(/doesn't exist/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_vendor_credits WHERE netsuite_id = '6004'`)).rows).toEqual([{ n: 0 }]);
  });

  it('refuses a copy that applies more than its total, or a line that says one thing and is another', async () => {
    const p = payload('6005');
    const over = { ...p, applied: '200.00', applied_to: [{ bill_netsuite_id: '3001', bill_number: 'B-100', amount: '200.00' }] };
    await expect(save(pg, over)).rejects.toThrow(/check/i);
    const [part, acct] = p.lines;
    await expect(save(pg, { ...p, lines: [{ ...part, item_netsuite_id: null }, acct] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [{ ...part, quantity: 0 }, acct] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [part, { ...acct, item_netsuite_id: '55' }] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [part, { ...acct, kind: 'fee' }] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, total: '125.50', lines: [part, { ...acct, amount: '0.00' }], applied: '0.00', applied_to: [] })).rejects.toThrow(/check/i);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_vendor_credits WHERE netsuite_id = '6005'`)).rows).toEqual([{ n: 0 }]);
  });

  it('lets only the server login near it', async () => {
    await pg.exec('RESET ROLE; SET ROLE authenticated');
    try {
      await expect(pg.query('SELECT * FROM typed_vendor_credits')).rejects.toThrow(/permission denied/);
      await expect(pg.query('SELECT * FROM gl_own_vendor_credits')).rejects.toThrow(/permission denied/);
      await expect(pg.query('SELECT * FROM gl_own_vendor_credit_lines')).rejects.toThrow(/permission denied/);
      await expect(save(pg, payload('6006'))).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec('RESET ROLE; SET ROLE service_role');
    }
  });
});
