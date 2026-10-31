// Migration 468 switches card charges off until January 1, 2027, keeps each
// Chase card charge once per card however often a download repeats it,
// remembers the account each merchant's charges go to, lets one press of Send
// hold a month's charges at a time, and keeps Books' own copy of each journal
// entry FleetSuite makes. This runs migration 359 with 466, 467 and 468 in an
// in-memory Postgres (PGlite) as the app's server login, adds downloads read
// by src/lib/card-charges.ts the way /api/card-charges does, and saves the
// copy src/lib/books/own-journal-entries.ts works out. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  importRows, keptCharge, readChaseDownload, workOutCardEntry,
  type CardAccount, type CardEntryFacts, type KeptChargeRow,
} from '@/lib/card-charges';
import { ownCardEntryPayload } from './own-journal-entries';

const CARD = '900';
const OTHER_CARD = '901';
const IMPORT = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
const SEND = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;

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
    -- What migrations 466 to 468 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql', '468-card-charges-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const HEAD = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo';
/** January's first download: three charges, money back, a payment to the card, and one charge in February. */
const FIRST = [
  HEAD,
  '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
  '01/05/2027,01/06/2027,WIDGETS MKTPL*AB1CD2,Shopping,Sale,-42.10,',
  '01/07/2027,01/07/2027,ACME HARDWARE #5678,Home,Return,20.00,',
  '01/08/2027,01/08/2027,AUTOMATIC PAYMENT - THANK,,Payment,500.00,',
  '02/02/2027,02/03/2027,BOLT BARN,Home,Sale,-9.99,',
].join('\n');
/** A later download that repeats two of them. */
const LATER = [
  HEAD,
  '01/07/2027,01/07/2027,ACME HARDWARE #5678,Home,Return,20.00,',
  '02/02/2027,02/03/2027,BOLT BARN,Home,Sale,-9.99,',
  '01/20/2027,01/21/2027,ACME HARDWARE #4321,Home,Sale,-15.00,',
  '01/21/2027,01/22/2027,FAST LUBE 22,Automotive,Sale,-30.00,',
].join('\n');
/** And the last of January: a merchant FleetSuite knows, and one it doesn't. */
const LAST = [
  HEAD,
  '01/25/2027,01/26/2027,ACME HARDWARE #9999,Home,Sale,-7.25,',
  '01/26/2027,01/27/2027,NEW SHOP,Shopping,Sale,-3.00,',
].join('\n');

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

/** What /api/card-charges sends card_charges_import for a file. */
function importOf(id: string, file: string, card = CARD) {
  const d = readChaseDownload(file);
  expect(d.problems).toEqual([]);
  return { import_id: id, company: 'BMG', card_account_netsuite_id: card, file_name: 'activity.csv', payments: d.payments, imported_by: null, rows: importRows(d.rows) };
}

const chargeId = async (pg: PGlite, description: string, card = CARD) =>
  (await pg.query<{ id: string }>('SELECT id FROM card_charges WHERE description = $1 AND card_account_netsuite_id = $2', [description, card])).rows[0].id;
const coded = async (pg: PGlite, card = CARD) => (await pg.query<{
  description: string; account_netsuite_id: string | null; memo: string | null; remembered: boolean; send_id: string | null;
}>(`
  SELECT description, account_netsuite_id, memo, remembered, send_id FROM card_charges
  WHERE card_account_netsuite_id = $1 ORDER BY charge_date, description`, [card])).rows;
const rules = async (pg: PGlite) =>
  (await pg.query('SELECT company, merchant_key, account_netsuite_id, times FROM card_merchant_rules ORDER BY merchant_key')).rows;
const claim = (pg: PGlite, send: string, over: Record<string, unknown> = {}) =>
  call(pg, 'card_charges_claim', { send_id: send, company: 'BMG', card_account_netsuite_id: CARD, month: '2027-01-01', max: 250, created_by: null, ...over });

const account = (id: string, number: string, name: string, type = 'expense'): [string, CardAccount] =>
  [id, { id, number, name, type, companies: ['BMG'] }];
const FACTS: CardEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  cardAccount: { id: CARD, number: '2100', name: 'Company card', type: 'credit_card', companies: ['BMG'] },
  accounts: new Map([
    account('610', '5100', 'Shop supplies'), account('620', '5200', 'Freight in', 'cost_of_goods_sold'),
    account('630', '6300', 'Vehicle upkeep'), account('640', '6400', 'Small tools'),
  ]),
};

describe('migration 468', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts card charges switched off, next to credit memos and vendor credits', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    expect((await pg.query(`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'`)).rows).toEqual([{ n: 1 }]);
  });

  it('adds a download once per card: the same file again adds nothing, a later one only what is new', async () => {
    const first = importOf(IMPORT(1), FIRST);
    expect(await call(pg, 'card_charges_import', first)).toEqual({ added: 4, already: 0, remembered: 0, payments: 1, again: false });
    expect(await call(pg, 'card_charges_import', first)).toEqual({ added: 4, already: 0, remembered: 0, payments: 1, again: true });
    expect(await call(pg, 'card_charges_import', importOf(IMPORT(2), LATER))).toEqual({ added: 2, already: 2, remembered: 0, payments: 0, again: false });
    // The same charges on another card are that card's.
    expect(await call(pg, 'card_charges_import', importOf(IMPORT(3), FIRST, OTHER_CARD))).toMatchObject({ added: 4, already: 0 });

    expect((await pg.query('SELECT id, charges, added, already, remembered, payments, file_name FROM card_charge_imports ORDER BY id')).rows).toEqual([
      { id: IMPORT(1), charges: 4, added: 4, already: 0, remembered: 0, payments: 1, file_name: 'activity.csv' },
      { id: IMPORT(2), charges: 4, added: 2, already: 2, remembered: 0, payments: 0, file_name: 'activity.csv' },
      { id: IMPORT(3), charges: 4, added: 4, already: 0, remembered: 0, payments: 1, file_name: 'activity.csv' },
    ]);
    expect((await pg.query(`
      SELECT charge_date::text AS charge_date, post_date::text AS post_date, description, merchant_key, category, chase_type, cents::int AS cents,
             card, chase_memo, import_id
      FROM card_charges WHERE card_account_netsuite_id = $1 ORDER BY charge_date`, [CARD])).rows).toEqual([
      { charge_date: '2027-01-03', post_date: '2027-01-04', description: 'ACME HARDWARE #1234', merchant_key: 'ACME HARDWARE', category: 'Home', chase_type: 'Sale', cents: 12550, card: null, chase_memo: null, import_id: IMPORT(1) },
      { charge_date: '2027-01-05', post_date: '2027-01-06', description: 'WIDGETS MKTPL*AB1CD2', merchant_key: 'WIDGETS MKTPL', category: 'Shopping', chase_type: 'Sale', cents: 4210, card: null, chase_memo: null, import_id: IMPORT(1) },
      { charge_date: '2027-01-07', post_date: '2027-01-07', description: 'ACME HARDWARE #5678', merchant_key: 'ACME HARDWARE', category: 'Home', chase_type: 'Return', cents: -2000, card: null, chase_memo: null, import_id: IMPORT(1) },
      { charge_date: '2027-01-20', post_date: '2027-01-21', description: 'ACME HARDWARE #4321', merchant_key: 'ACME HARDWARE', category: 'Home', chase_type: 'Sale', cents: 1500, card: null, chase_memo: null, import_id: IMPORT(2) },
      { charge_date: '2027-01-21', post_date: '2027-01-22', description: 'FAST LUBE 22', merchant_key: 'FAST LUBE', category: 'Automotive', chase_type: 'Sale', cents: 3000, card: null, chase_memo: null, import_id: IMPORT(2) },
      { charge_date: '2027-02-02', post_date: '2027-02-03', description: 'BOLT BARN', merchant_key: 'BOLT BARN', category: 'Home', chase_type: 'Sale', cents: 999, card: null, chase_memo: null, import_id: IMPORT(1) },
    ]);
    await expect(call(pg, 'card_charges_import', { ...first, import_id: IMPORT(4), rows: {} })).rejects.toThrow(/rows must be a list/);
  });

  it("codes one card's charges, and remembers the account most of each merchant's went to", async () => {
    const changes = [
      { id: await chargeId(pg, 'ACME HARDWARE #1234'), account_netsuite_id: '610', memo: '' },
      { id: await chargeId(pg, 'ACME HARDWARE #5678'), account_netsuite_id: '610', memo: '' },
      { id: await chargeId(pg, 'ACME HARDWARE #4321'), account_netsuite_id: '640', memo: '' },
      { id: await chargeId(pg, 'WIDGETS MKTPL*AB1CD2'), account_netsuite_id: '620', memo: '  Shelf bins ' },
      { id: await chargeId(pg, 'FAST LUBE 22'), account_netsuite_id: '630', memo: '' },
      // Another card's charge isn't this card's to code.
      { id: await chargeId(pg, 'ACME HARDWARE #1234', OTHER_CARD), account_netsuite_id: '610', memo: '' },
    ];
    expect(await call(pg, 'card_charges_code', { card_account_netsuite_id: CARD, by: null, changes })).toEqual({ coded: 5, held: 1 });
    expect(await coded(pg)).toEqual([
      { description: 'ACME HARDWARE #1234', account_netsuite_id: '610', memo: null, remembered: false, send_id: null },
      { description: 'WIDGETS MKTPL*AB1CD2', account_netsuite_id: '620', memo: 'Shelf bins', remembered: false, send_id: null },
      { description: 'ACME HARDWARE #5678', account_netsuite_id: '610', memo: null, remembered: false, send_id: null },
      { description: 'ACME HARDWARE #4321', account_netsuite_id: '640', memo: null, remembered: false, send_id: null },
      { description: 'FAST LUBE 22', account_netsuite_id: '630', memo: null, remembered: false, send_id: null },
      { description: 'BOLT BARN', account_netsuite_id: null, memo: null, remembered: false, send_id: null },
    ]);
    expect((await coded(pg, OTHER_CARD)).every((c) => c.account_netsuite_id === null)).toBe(true);
    expect(await rules(pg)).toEqual([
      { company: 'BMG', merchant_key: 'ACME HARDWARE', account_netsuite_id: '610', times: 2 },
      { company: 'BMG', merchant_key: 'FAST LUBE', account_netsuite_id: '630', times: 1 },
      { company: 'BMG', merchant_key: 'WIDGETS MKTPL', account_netsuite_id: '620', times: 1 },
    ]);

    // The other card's charges are the same company's merchants: the account they last went to is the one remembered.
    const other = async (description: string, accountId: string | null) => call(pg, 'card_charges_code', {
      card_account_netsuite_id: OTHER_CARD, by: null, changes: [{ id: await chargeId(pg, description, OTHER_CARD), account_netsuite_id: accountId, memo: '' }],
    });
    expect(await other('ACME HARDWARE #1234', '640')).toEqual({ coded: 1, held: 0 });
    expect((await rules(pg))[0]).toEqual({ company: 'BMG', merchant_key: 'ACME HARDWARE', account_netsuite_id: '640', times: 1 });
    // Taking a charge's account off forgets nothing.
    expect(await other('ACME HARDWARE #1234', null)).toEqual({ coded: 1, held: 0 });
    expect((await rules(pg))[0]).toMatchObject({ account_netsuite_id: '640', times: 1 });
    // Coded to it again, it counts on.
    expect(await call(pg, 'card_charges_code', {
      card_account_netsuite_id: CARD, changes: [{ id: await chargeId(pg, 'ACME HARDWARE #4321'), account_netsuite_id: '640' }],
    })).toEqual({ coded: 1, held: 0 });
    expect((await rules(pg))[0]).toMatchObject({ account_netsuite_id: '640', times: 2 });
    await expect(call(pg, 'card_charges_code', { card_account_netsuite_id: CARD, changes: {} })).rejects.toThrow(/changes must be a list/);
  });

  it("brings a remembered merchant's new charges in coded, not another company's, and a person's coding makes them theirs", async () => {
    await pg.query(`INSERT INTO card_merchant_rules (company, merchant_key, account_netsuite_id) VALUES ('1084', 'NEW SHOP', '699')`);
    expect(await call(pg, 'card_charges_import', importOf(IMPORT(5), LAST))).toEqual({ added: 2, already: 0, remembered: 1, payments: 0, again: false });
    const last = (await coded(pg)).slice(-3, -1);
    expect(last).toEqual([
      { description: 'ACME HARDWARE #9999', account_netsuite_id: '640', memo: null, remembered: true, send_id: null },
      { description: 'NEW SHOP', account_netsuite_id: null, memo: null, remembered: false, send_id: null },
    ]);
    expect((await pg.query(`SELECT remembered FROM card_charge_imports WHERE id = $1`, [IMPORT(5)])).rows).toEqual([{ remembered: 1 }]);
    expect(await call(pg, 'card_charges_code', {
      card_account_netsuite_id: CARD, changes: [{ id: await chargeId(pg, 'ACME HARDWARE #9999'), account_netsuite_id: '640' }],
    })).toEqual({ coded: 1, held: 0 });
    expect((await coded(pg)).find((c) => c.description === 'ACME HARDWARE #9999')).toMatchObject({ account_netsuite_id: '640', remembered: false });
  });

  it("won't send a month with a charge that has no account, and keeps nothing of the press", async () => {
    expect(await claim(pg, SEND(1))).toEqual({ state: 'uncoded', uncoded: 1 });
    expect((await pg.query('SELECT count(*)::int AS n FROM card_charge_sends')).rows).toEqual([{ n: 0 }]);
    expect(await claim(pg, SEND(1), { month: '2027-02-01' })).toEqual({ state: 'uncoded', uncoded: 1 });
    await expect(claim(pg, SEND(1), { month: '2027-01-15' })).rejects.toThrow(/starts on its first day/);
  });

  it("holds the month's charges for one press, oldest first, until NetSuite makes it or refuses it", async () => {
    // February's charge is coded too, and stays February's.
    expect(await call(pg, 'card_charges_code', {
      card_account_netsuite_id: CARD, changes: [
        { id: await chargeId(pg, 'NEW SHOP'), account_netsuite_id: '610' }, { id: await chargeId(pg, 'BOLT BARN'), account_netsuite_id: '610' },
      ],
    })).toEqual({ coded: 2, held: 0 });

    const r = await claim(pg, SEND(1));
    expect(r.state).toBe('claimed');
    const january = ['ACME HARDWARE #1234', 'WIDGETS MKTPL*AB1CD2', 'ACME HARDWARE #5678', 'ACME HARDWARE #4321', 'FAST LUBE 22', 'ACME HARDWARE #9999', 'NEW SHOP'];
    expect((r.charges as KeptChargeRow[]).map((c) => c.description)).toEqual(january);
    expect((await pg.query(`SELECT company, month::text AS month, claimed_at IS NOT NULL AS claimed, error FROM card_charge_sends WHERE id = $1`, [SEND(1)])).rows)
      .toEqual([{ company: 'BMG', month: '2027-01-01', claimed: true, error: null }]);

    // Pressed again: it's being made. Another press finds nothing left to send, and keeps nothing.
    const again = await claim(pg, SEND(1));
    expect(again.state).toBe('making');
    expect((again.charges as KeptChargeRow[]).map((c) => c.description)).toEqual(january);
    expect(await claim(pg, SEND(2))).toEqual({ state: 'nothing' });
    expect((await pg.query('SELECT id FROM card_charge_sends')).rows).toEqual([{ id: SEND(1) }]);
    // A held charge can't be coded, and the press is for its own card and month.
    expect(await call(pg, 'card_charges_code', {
      card_account_netsuite_id: CARD, changes: [{ id: await chargeId(pg, 'NEW SHOP'), account_netsuite_id: '620' }],
    })).toEqual({ coded: 0, held: 1 });
    await expect(claim(pg, SEND(1), { month: '2027-02-01' })).rejects.toThrow(/another card or month/);
    await expect(claim(pg, SEND(1), { card_account_netsuite_id: OTHER_CARD })).rejects.toThrow(/another card or month/);

    // NetSuite refused it: the charges are free, and the press keeps why.
    expect(await call(pg, 'card_charges_let_go', { send_id: SEND(1), error: ' Invalid account 640 ' })).toEqual({ let_go: 7 });
    expect((await pg.query(`SELECT claimed_at, error FROM card_charge_sends WHERE id = $1`, [SEND(1)])).rows).toEqual([{ claimed_at: null, error: 'Invalid account 640' }]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM card_charges WHERE send_id IS NOT NULL`)).rows).toEqual([{ n: 0 }]);
    expect(await call(pg, 'card_charges_let_go', { send_id: SEND(3), error: '' })).toEqual({ let_go: 0 });

    // The same press tried again takes them again.
    const retried = await claim(pg, SEND(1));
    expect(retried.state).toBe('claimed');
    expect(retried.charges).toHaveLength(7);
    expect((await pg.query(`SELECT error FROM card_charge_sends WHERE id = $1`, [SEND(1)])).rows).toEqual([{ error: null }]);
  });

  it('says what a press made once NetSuite made it, and keeps its charges for good', async () => {
    await pg.query(`
      UPDATE card_charge_sends SET netsuite_journal_id = '7002', netsuite_number = 'JE-501', charge_count = 7, net_cents = 20285, total_cents = 24285,
        tran_date = '2027-01-26' WHERE id = $1`, [SEND(1)]);
    expect(await claim(pg, SEND(1))).toEqual({
      state: 'made', netsuite_journal_id: '7002', netsuite_number: 'JE-501', charge_count: 7, total_cents: 24285, net_cents: 20285,
    });
    expect(await call(pg, 'card_charges_let_go', { send_id: SEND(1), error: 'late' })).toEqual({ let_go: 0 });
    expect((await pg.query(`SELECT count(*)::int AS n FROM card_charges WHERE send_id = $1`, [SEND(1)])).rows).toEqual([{ n: 7 }]);
    expect((await pg.query(`SELECT claimed_at IS NOT NULL AS claimed, error FROM card_charge_sends WHERE id = $1`, [SEND(1)])).rows).toEqual([{ claimed: true, error: null }]);
  });

  it('takes the oldest charges up to the most one journal entry takes, and leaves the rest for the next', async () => {
    const changes = await Promise.all(['ACME HARDWARE #1234', 'WIDGETS MKTPL*AB1CD2', 'ACME HARDWARE #5678'].map(async (d) =>
      ({ id: await chargeId(pg, d, OTHER_CARD), account_netsuite_id: '610' })));
    expect(await call(pg, 'card_charges_code', { card_account_netsuite_id: OTHER_CARD, changes })).toEqual({ coded: 3, held: 0 });
    const r = await claim(pg, SEND(4), { card_account_netsuite_id: OTHER_CARD, max: 2 });
    expect((r.charges as KeptChargeRow[]).map((c) => c.description)).toEqual(['ACME HARDWARE #1234', 'WIDGETS MKTPL*AB1CD2']);
    const next = await claim(pg, SEND(5), { card_account_netsuite_id: OTHER_CARD, max: 2 });
    expect((next.charges as KeptChargeRow[]).map((c) => c.description)).toEqual(['ACME HARDWARE #5678']);
  });

  it("saves Books' copy of the journal entry whole, as FleetSuite worked it out from the charges it sent", async () => {
    const held = (await pg.query<KeptChargeRow>(`
      SELECT id, charge_date::text AS charge_date, post_date::text AS post_date, description, merchant_key, category, chase_type, cents, card,
             account_netsuite_id, memo, remembered
      FROM card_charges WHERE send_id = $1`, [SEND(1)])).rows;
    const worked = workOutCardEntry(held.map(keptCharge), FACTS);
    expect(worked).toMatchObject({ problems: [], month: '2027-01', date: '2027-01-26', chargeCount: 7, netCents: 20285, totalCents: 24285 });
    const p = ownCardEntryPayload({ netsuiteId: '7002', netsuiteNumber: 'JE-501', company: 'BMG', worked, madeFromId: SEND(1), madeBy: null });
    expect(await call(pg, 'gl_own_journal_entry_save', p)).toEqual({ saved: true, lines: 14 });

    expect((await pg.query(`
      SELECT j.netsuite_id, co.code AS company, j.source, j.made_from_id, j.netsuite_number, j.tran_date::text AS tran_date, j.memo, j.rule,
             j.total::text AS total, j.made_by
      FROM gl_own_journal_entries j JOIN gl_companies co ON co.id = j.company_id`)).rows).toEqual([{
      netsuite_id: '7002', company: 'BMG', source: 'card_charges', made_from_id: SEND(1), netsuite_number: 'JE-501', tran_date: '2027-01-26',
      memo: '2100 Company card charges, January 2027, from FleetSuite', rule: 'card_charges@1', total: '242.85', made_by: null,
    }]);
    const lines = (await pg.query<{ line_no: number; account_netsuite_id: string; debit: string; credit: string; memo: string; card_charge_id: string }>(`
      SELECT line_no, account_netsuite_id, debit::text AS debit, credit::text AS credit, memo, card_charge_id
      FROM gl_own_journal_entry_lines WHERE journal_entry_id = '7002' ORDER BY line_no`)).rows;
    expect(lines.slice(0, 6).map((l) => [l.line_no, l.account_netsuite_id, l.debit, l.credit, l.memo])).toEqual([
      [1, '610', '125.50', '0.00', 'ACME HARDWARE #1234 · Jan 3'],
      [2, CARD, '0.00', '125.50', 'ACME HARDWARE #1234 · Jan 3'],
      [3, '620', '42.10', '0.00', 'WIDGETS MKTPL*AB1CD2 · Jan 5 · Shelf bins'],
      [4, CARD, '0.00', '42.10', 'WIDGETS MKTPL*AB1CD2 · Jan 5 · Shelf bins'],
      [5, '610', '0.00', '20.00', 'ACME HARDWARE #5678 · Jan 7'],
      [6, CARD, '20.00', '0.00', 'ACME HARDWARE #5678 · Jan 7'],
    ]);
    expect(lines[0].card_charge_id).toBe(await chargeId(pg, 'ACME HARDWARE #1234'));
    expect(lines.reduce((s, l) => s + Number(l.debit) * 100 - Number(l.credit) * 100, 0)).toBeCloseTo(0, 6);

    // Saving it again changes nothing.
    expect(await call(pg, 'gl_own_journal_entry_save', { ...p, total: '125.50', lines: p.lines.slice(0, 2) })).toEqual({ saved: false, lines: 0 });
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_journal_entry_lines WHERE journal_entry_id = '7002'`)).rows).toEqual([{ n: 14 }]);
  });

  it("refuses a copy that doesn't balance, has one line, or says the wrong thing", async () => {
    const line = (line_no: number, account_netsuite_id: string, debit: string | null, credit: string | null) =>
      ({ line_no, account_netsuite_id, debit, credit, memo: 'ACME', card_charge_id: null });
    const p = {
      netsuite_id: '7003', company: 'BMG', source: 'card_charges', made_from_id: SEND(2), netsuite_number: null, tran_date: '2027-02-02',
      memo: 'Company card charges', rule: 'card_charges@1', total: '9.99', made_by: null,
      lines: [line(1, '610', '9.99', null), line(2, CARD, null, '9.99')],
    };
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, total: '10.00' })).rejects.toThrow(/don't match its total/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, lines: [line(1, '610', '9.99', null), line(2, CARD, null, '9.98')] })).rejects.toThrow(/don't match/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, lines: [p.lines[0]] })).rejects.toThrow(/two lines or more/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, lines: {} })).rejects.toThrow(/two lines or more/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, netsuite_id: 'JE7003' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, netsuite_id: undefined })).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, company: 'NOPE' })).rejects.toThrow(/doesn't exist/);
    // Lines that are both sides or neither, a source it doesn't know, or nothing at all.
    await expect(call(pg, 'gl_own_journal_entry_save', {
      ...p, total: '19.98', lines: [line(1, '610', '9.99', '9.99'), line(2, CARD, '9.99', '9.99')],
    })).rejects.toThrow(/check/i);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, lines: [...p.lines, line(3, '620', null, null)] })).rejects.toThrow(/check/i);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, source: 'payroll' })).rejects.toThrow(/check/i);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, total: '0.00', lines: [line(1, '610', '0.00', null), line(2, CARD, null, '0.00')] }))
      .rejects.toThrow(/check/i);
    await expect(call(pg, 'gl_own_journal_entry_save', { ...p, lines: [line(1, 'Shop', '9.99', null), line(2, CARD, null, '9.99')] })).rejects.toThrow(/check/i);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_journal_entries WHERE netsuite_id = '7003'`)).rows).toEqual([{ n: 0 }]);
  });

  it("refuses a charge, a send or an own copy that breaks the rules", async () => {
    let made = 0;
    const charge = (over: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        import_id: IMPORT(1), company: 'BMG', card_account_netsuite_id: CARD, charge_date: '2027-03-01', description: 'ACME', merchant_key: 'ACME',
        cents: 100, fingerprint: `x-${(made += 1)}`, ...over,
      };
      const cols = Object.keys(row);
      return pg.query(`INSERT INTO card_charges (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    };
    for (const over of [{ cents: 0 }, { description: ' ' }, { description: 'x'.repeat(201) }, { card_account_netsuite_id: 'Card' },
      { account_netsuite_id: 'Shop' }, { memo: 'm'.repeat(301) }, { fingerprint: ' ' }, { company: ' ' }]) {
      await expect(charge(over)).rejects.toThrow(/check/i);
    }
    await charge({ fingerprint: 'same' });
    await expect(charge({ fingerprint: 'same' })).rejects.toThrow(/duplicate key/);
    await charge({ fingerprint: 'same', card_account_netsuite_id: OTHER_CARD });
    await expect(charge({ import_id: 'a0000000-0000-4000-8000-000000000099' })).rejects.toThrow(/foreign key/);

    const send = (over: Record<string, unknown>) => {
      const row: Record<string, unknown> = { id: SEND(9), company: 'BMG', card_account_netsuite_id: CARD, month: '2027-03-01', ...over };
      const cols = Object.keys(row);
      return pg.query(`INSERT INTO card_charge_sends (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    };
    for (const over of [{ month: '2027-03-02' }, { netsuite_journal_id: 'JE-501' }, { total_cents: -1 }, { charge_count: -1 }]) {
      await expect(send(over)).rejects.toThrow(/check/i);
    }
    // A press that holds charges can't be taken away.
    await expect(pg.query(`DELETE FROM card_charge_sends WHERE id = $1`, [SEND(1)])).rejects.toThrow(/foreign key/);
    // Nor is there an own copy of a journal entry of $0.
    await expect(pg.query(`INSERT INTO gl_own_journal_entries (netsuite_id, company_id, source, tran_date, rule, total)
      SELECT '7009', id, 'card_charges', '2027-03-01', 'card_charges@1', 0 FROM gl_companies WHERE code = 'BMG'`))
      .rejects.toThrow(/gl_own_journal_entries_total_check/);
  });

  it('lets only the server login near it', async () => {
    await pg.exec('RESET ROLE; SET ROLE authenticated');
    try {
      for (const t of ['card_charge_imports', 'card_charge_sends', 'card_charges', 'card_merchant_rules', 'gl_own_journal_entries', 'gl_own_journal_entry_lines']) {
        await expect(pg.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
      }
      await expect(call(pg, 'card_charges_import', importOf(IMPORT(6), LAST))).rejects.toThrow(/permission denied/);
      await expect(call(pg, 'card_charges_code', { card_account_netsuite_id: CARD, changes: [] })).rejects.toThrow(/permission denied/);
      await expect(claim(pg, SEND(6))).rejects.toThrow(/permission denied/);
      await expect(call(pg, 'card_charges_let_go', { send_id: SEND(1) })).rejects.toThrow(/permission denied/);
      await expect(call(pg, 'gl_own_journal_entry_save', {})).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec('RESET ROLE; SET ROLE service_role');
    }
  });
});
