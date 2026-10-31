// Migration 472 switches fixing bills off until January 1, 2027, keeps one row
// per press of Fix bill (sending, then fixed, refused or unsure; one fix of a
// bill at a time; a send that never finished let go after five minutes), and
// gives Books' own copy of a bill its next version when FleetSuite fixes it,
// keeping the one before, with the version in the pairs the check reads. This
// runs it after the migrations it builds on in an in-memory Postgres (PGlite)
// as the app's server login, with copies src/lib/books/own-bills.ts works out
// the way /api/purchasing/bill-fix does, then checks a fixed copy end to end.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

import { billPayload, fixedOwnBillPayload, workOutOwnBill, type FixedBillCopy, type PoCopyLine } from './own-bills';
import { checkOwnBills, type BillPairsData } from './own-bill-check';

const FIXER = 'a0000000-0000-4000-8000-000000000001';
const FIX = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const RACK = '9001';
const BIN = '9002';
const RECEIVED = '210';
const PAYABLE = '200';
const FREIGHT = '655';

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
    -- What the migrations point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
    INSERT INTO public.profiles (id) VALUES ('${FIXER}');
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql', '407-books-own-invoices.sql',
    '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '445-typed-invoices.sql', '466-credit-memos-in-fleetsuite.sql',
    '467-vendor-credits-in-fleetsuite.sql', '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql',
    '470-inventory-transfers-made-in-fleetsuite.sql', '471-invoices-fixed-in-fleetsuite.sql', '472-bills-fixed-in-fleetsuite.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '${RACK}', 'RACK-48', true, '{"display_name": "Ladder rack", "item_type": "InvtPart"}'),
      ('item', '${BIN}', 'BIN-10', true, '{"item_type": "InvtPart"}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('21000', 'Received not billed', 'other_current_liability', '${RECEIVED}'),
      ('65500', 'Freight in', 'expense', '${FREIGHT}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T = any>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const billPairs = (pg: PGlite, id: string) => one<BillPairsData>(pg, 'SELECT gl_own_bill_pairs(NULL::date, NULL::date, $1) AS r', [id]);

/** A press of Fix bill as /api/purchasing/bill-fix claims it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, bill_netsuite_id: '8802', bill_number: 'INV-5521', vendor_netsuite_id: '77', vendor_name: 'Acme Truck Racks',
  reason: ' Billed twelve, sent ten ', changes: ['RACK-48 quantity 12 → 10'], patch: { item: { items: [{ line: 1, quantity: 10, amount: 1783.33 }] } },
  replace_lists: [], total_before_cents: 219997, total_expected_cents: 188330, by: FIXER, ...over,
});

const fix = async (pg: PGlite, id: string) => (await pg.query<Record<string, any>>(`
  SELECT id, bill_netsuite_id, bill_number, vendor_netsuite_id, vendor_name, reason, changes, replace_lists,
         total_before_cents, total_expected_cents, status, error, total_after_cents, own_copy, own_copy_version, created_by, finished_at
  FROM bill_fixes WHERE id = $1`, [id])).rows[0];

const AT = new Date('2026-10-21T15:00:00Z'); // 10 AM Central

/** FleetSuite's copy of PO453-ACME: 12 racks, and 4 bins of which 1 is billed. */
const PO_LINES: PoCopyLine[] = [
  { line_id: '2', item_netsuite_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '12', quantity_billed: '0', rate: '178.3333', amount: '2140.00' },
  { line_id: '3', item_netsuite_id: BIN, item_number: 'BIN-10', description: null, quantity: '4', quantity_billed: '1', rate: '19.99', amount: '79.96' },
];
const partsMailBill = (netsuiteId = '8802') => billPayload(workOutOwnBill({
  netsuiteId, netsuiteNumber: 'INV-5521', madeFrom: 'parts_mail', madeFromId: 'parts-1', vendorId: 77,
  vendorName: 'Acme Truck Racks', referenceNo: 'INV-5521', po: { copyId: 'po-1', netsuiteId: '5001', number: 'PO453-ACME' },
  invoiceTotal: '2199.97', expense: null,
}, PO_LINES, AT));

/** Ten racks where twelve were billed, the bins as they were, and freight added, as the Fix screen's lines come (ownCopyLines). */
const FIXED: FixedBillCopy = {
  number: 'INV-5521A', date: '2026-10-22',
  lines: [
    { accountId: null, itemId: RACK, itemNumber: 'RACK-48', description: 'Ladder rack', quantity: 10, rate: 178.3333, cents: 178333, poLineId: '2' },
    { accountId: null, itemId: BIN, itemNumber: 'BIN-10', description: null, quantity: 3, rate: 19.99, cents: 5997, poLineId: '3' },
    { accountId: FREIGHT, itemId: null, itemNumber: null, description: 'Freight', quantity: null, rate: null, cents: 4000, poLineId: null },
  ],
};

describe('migration 472', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('starts fixing bills switched off, next to the other six', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bill_fixes', is_on: false, changed_by: null },
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('takes one press at a time for a bill, and says what became of a press', async () => {
    expect(await call(pg, 'bill_fix_claim', press(FIX(1)))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(1))).toMatchObject({
      bill_netsuite_id: '8802', bill_number: 'INV-5521', vendor_netsuite_id: '77', vendor_name: 'Acme Truck Racks',
      reason: 'Billed twelve, sent ten', changes: ['RACK-48 quantity 12 → 10'], replace_lists: [],
      total_before_cents: 219997, total_expected_cents: 188330, status: 'sending', error: null, created_by: FIXER, finished_at: null,
    });
    // The same press again, while it's being sent; and another press on the same bill.
    expect(await call(pg, 'bill_fix_claim', press(FIX(1)))).toEqual({ claimed: false, state: 'sending' });
    expect(await call(pg, 'bill_fix_claim', press(FIX(2)))).toEqual({ claimed: false, state: 'busy' });
    // A fix of another bill goes ahead, taking a line off both its lists.
    expect(await call(pg, 'bill_fix_claim', press(FIX(3), { bill_netsuite_id: '8803', replace_lists: ['expense', 'item'] }))).toEqual({ claimed: true });
    expect((await fix(pg, FIX(3))).replace_lists).toEqual(['expense', 'item']);

    expect(await call(pg, 'bill_fix_finish', { id: FIX(1), status: 'fixed', total_after_cents: 188330, own_copy: 'fixed', own_copy_version: 2 }))
      .toEqual({ finished: true });
    expect(await fix(pg, FIX(1))).toMatchObject({ status: 'fixed', total_after_cents: 188330, own_copy: 'fixed', own_copy_version: 2 });
    expect((await fix(pg, FIX(1))).finished_at).not.toBeNull();
    // Finished once; pressed again, it was fixed.
    expect(await call(pg, 'bill_fix_finish', { id: FIX(1), status: 'refused' })).toEqual({ finished: false });
    expect(await call(pg, 'bill_fix_claim', press(FIX(1)))).toEqual({ claimed: false, state: 'fixed' });
    expect((await fix(pg, FIX(1))).status).toBe('fixed');

    // The bill is free again; a press NetSuite refused can be pressed again, as it's planned then.
    expect(await call(pg, 'bill_fix_claim', press(FIX(2)))).toEqual({ claimed: true });
    expect(await call(pg, 'bill_fix_finish', { id: FIX(2), status: 'refused', error: '  NetSuite error (400): The period is closed. ' }))
      .toEqual({ finished: true });
    expect(await fix(pg, FIX(2))).toMatchObject({ status: 'refused', error: 'NetSuite error (400): The period is closed.' });
    const again = { reason: 'Billed twelve, sent nine', changes: ['RACK-48 quantity 12 → 9'], replace_lists: ['item'], by: null };
    expect(await call(pg, 'bill_fix_claim', press(FIX(2), again))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(2))).toMatchObject({
      status: 'sending', error: null, reason: 'Billed twelve, sent nine', changes: ['RACK-48 quantity 12 → 9'], replace_lists: ['item'],
      created_by: FIXER, finished_at: null, own_copy: null, total_after_cents: null,
    });
    expect(await call(pg, 'bill_fix_claim', press('f0000000-0000-4000-8000-0000000000aa'))).toEqual({ claimed: false, state: 'busy' });
    // NetSuite's words are kept to 2,000 characters.
    const long = `NetSuite took too long to answer. ${'x'.repeat(2500)}`;
    expect(await call(pg, 'bill_fix_finish', { id: FIX(2), status: 'unsure', error: long })).toEqual({ finished: true });
    expect(await fix(pg, FIX(2))).toMatchObject({ status: 'unsure', error: long.slice(0, 2000) });
  });

  it('lets go of a send that never finished after five minutes, as unsure', async () => {
    expect(await call(pg, 'bill_fix_claim', press(FIX(4), { bill_netsuite_id: '8804' }))).toEqual({ claimed: true });
    expect(await call(pg, 'bill_fix_claim', press(FIX(5), { bill_netsuite_id: '8804' }))).toEqual({ claimed: false, state: 'busy' });
    await pg.query(`UPDATE bill_fixes SET sent_at = now() - interval '4 minutes' WHERE id = $1`, [FIX(4)]);
    expect(await call(pg, 'bill_fix_claim', press(FIX(5), { bill_netsuite_id: '8804' }))).toEqual({ claimed: false, state: 'busy' });
    // Another bill's send that old is let go only when that bill is claimed.
    await pg.query(`UPDATE bill_fixes SET sent_at = now() - interval '6 minutes' WHERE id IN ($1, $2)`, [FIX(4), FIX(3)]);
    expect(await call(pg, 'bill_fix_claim', press(FIX(5), { bill_netsuite_id: '8804' }))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(4))).toMatchObject({
      status: 'unsure',
      error: "FleetSuite stopped before NetSuite answered, so it can't tell whether the fix went in. Check the bill in NetSuite.",
    });
    // Its own send that late can't finish it now.
    expect(await call(pg, 'bill_fix_finish', { id: FIX(4), status: 'fixed' })).toEqual({ finished: false });
    // Nor does letting go reach another bill's send.
    expect((await fix(pg, FIX(3))).status).toBe('sending');
  });

  it('refuses a press that names the wrong bill, says nothing, or finishes oddly', async () => {
    await expect(call(pg, 'bill_fix_claim', press(FIX(1), { bill_netsuite_id: '8809' }))).rejects.toThrow(/is a fix of another bill/);
    await expect(call(pg, 'bill_fix_claim', press(FIX(6), { bill_netsuite_id: 'INV-5521' }))).rejects.toThrow(/needs NetSuite's id/);
    for (const over of [
      { reason: '  ' }, { reason: 'r'.repeat(301) }, { changes: [] }, { changes: {} }, { patch: [] }, { replace_lists: ['apply'] },
      { vendor_netsuite_id: 'Acme' },
    ]) {
      await expect(call(pg, 'bill_fix_claim', press(FIX(6), { bill_netsuite_id: '8806', ...over }))).rejects.toThrow(/check/i);
    }
    expect(await call(pg, 'bill_fix_claim', press(FIX(6), { bill_netsuite_id: '8806' }))).toEqual({ claimed: true });
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6), status: 'sending' })).rejects.toThrow(/finishes fixed, refused or unsure/);
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6) })).rejects.toThrow(/not \(nothing\)/);
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'fixed' })).rejects.toThrow(/check/i);
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'none', own_copy_version: 2 })).rejects.toThrow(/check/i);
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'fixed', own_copy_version: 1 })).rejects.toThrow(/check/i);
    await expect(call(pg, 'bill_fix_finish', { id: FIX(6), status: 'refused', own_copy: 'none' })).rejects.toThrow(/check/i);
    expect((await fix(pg, FIX(6))).status).toBe('sending');
    expect(await call(pg, 'bill_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'none' })).toEqual({ finished: true });
  });

  it("makes the next version of Books' own copy from the fix, keeping each one before", async () => {
    expect(await call(pg, 'gl_own_bill_save', partsMailBill())).toEqual({ saved: true, lines: 2 });
    // Another bill's copy, which a fix of this one leaves as it is.
    expect(await call(pg, 'gl_own_bill_save', partsMailBill('8805'))).toEqual({ saved: true, lines: 2 });
    const copy = async (id = '8802') => (await pg.query<Record<string, any>>(`
      SELECT version, netsuite_number, reference_no, bill_date::text AS bill_date, unknowns, made_from, po_number, invoice_total::text AS invoice_total,
             fixed_by, fixed_at IS NOT NULL AS fixed
      FROM gl_own_bills WHERE netsuite_id = $1`, [id])).rows[0];
    expect(await copy()).toMatchObject({ version: 1, netsuite_number: 'INV-5521', bill_date: '2026-10-21', fixed_by: null, fixed: false });
    // A copy that didn't know its prices knows every line once fixed.
    await pg.query(`UPDATE gl_own_bills SET unknowns = '{prices}' WHERE netsuite_id = '8802'`);

    const payload = fixedOwnBillPayload('8802', 1, FIXED, { fixId: FIX(1), by: FIXER });
    expect(await call(pg, 'gl_own_bill_fix', payload)).toEqual({ saved: true, version: 2, lines: 3 });
    expect(await copy()).toEqual({
      version: 2, netsuite_number: 'INV-5521A', reference_no: 'INV-5521A', bill_date: '2026-10-22', unknowns: [], made_from: 'parts_mail',
      po_number: 'PO453-ACME', invoice_total: '2199.97', fixed_by: FIXER, fixed: true,
    });
    expect((await pg.query(`
      SELECT line_no, account_netsuite_id, item_netsuite_id, item_number, description, quantity::text AS quantity, rate::text AS rate,
             amount::text AS amount, po_line_id
      FROM gl_own_bill_lines WHERE bill_id = '8802' ORDER BY line_no`)).rows).toEqual([
      { line_no: 1, account_netsuite_id: null, item_netsuite_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '10.0000', rate: '178.3333', amount: '1783.33', po_line_id: '2' },
      { line_no: 2, account_netsuite_id: null, item_netsuite_id: BIN, item_number: 'BIN-10', description: null, quantity: '3.0000', rate: '19.9900', amount: '59.97', po_line_id: '3' },
      { line_no: 3, account_netsuite_id: FREIGHT, item_netsuite_id: null, item_number: null, description: 'Freight', quantity: null, rate: null, amount: '40.00', po_line_id: null },
    ]);
    expect(await copy('8805')).toMatchObject({ version: 1, netsuite_number: 'INV-5521', bill_date: '2026-10-21', fixed: false });
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_bill_lines WHERE bill_id = '8805'`)).toBe(2);

    const before = (await pg.query<{ version: number; copy: Record<string, any>; replaced_by: string; fix_id: string }>(`
      SELECT version, copy, replaced_by, fix_id FROM gl_own_bill_versions WHERE netsuite_id = '8802' ORDER BY version`)).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ version: 1, replaced_by: FIXER, fix_id: FIX(1) });
    expect(before[0].copy).toMatchObject({ version: 1, netsuite_number: 'INV-5521', bill_date: '2026-10-21', made_from: 'parts_mail' });
    expect(before[0].copy.lines.map((l: Record<string, unknown>) => [l.line_no, l.item_netsuite_id, l.amount, l.po_line_id, 'bill_id' in l]))
      .toEqual([[1, RACK, 2140, '2', false], [2, BIN, 59.97, '3', false]]);

    // A fix worked out from the version before is refused, and nothing changes.
    expect(await call(pg, 'gl_own_bill_fix', payload)).toEqual({ saved: false, reason: 'changed', version: 2 });
    expect((await copy()).version).toBe(2);
    // The next fix makes the version after; a number left off keeps the one it has.
    const next = fixedOwnBillPayload('8802', 2, { ...FIXED, number: '', lines: FIXED.lines.slice(0, 1) }, { fixId: FIX(2), by: null });
    expect(await call(pg, 'gl_own_bill_fix', next)).toEqual({ saved: true, version: 3, lines: 1 });
    expect(await copy()).toMatchObject({ version: 3, netsuite_number: 'INV-5521A', reference_no: 'INV-5521A', fixed_by: null });
    expect((await pg.query('SELECT version FROM gl_own_bill_versions WHERE netsuite_id = $1 ORDER BY version', ['8802'])).rows)
      .toEqual([{ version: 1 }, { version: 2 }]);
    // Saving a copy again never changes one.
    expect(await call(pg, 'gl_own_bill_save', partsMailBill())).toEqual({ saved: false, lines: 0 });
    expect((await copy()).version).toBe(3);
    // A version names a fix FleetSuite has a record of.
    await expect(call(pg, 'gl_own_bill_fix', fixedOwnBillPayload('8805', 1, FIXED, { fixId: 'f0000000-0000-4000-8000-0000000000ff', by: null })))
      .rejects.toThrow(/foreign key/);
    expect(await copy('8805')).toMatchObject({ version: 1, netsuite_number: 'INV-5521', fixed: false });
  });

  it("refuses a copy that doesn't add up, and says when there's no copy to fix", async () => {
    const payload = {
      netsuite_id: '8805', version: 1, bill_date: '2026-10-22', total: '10.00',
      lines: [{ line_no: 1, account_netsuite_id: FREIGHT, amount: '9.99' }],
    };
    await expect(call(pg, 'gl_own_bill_fix', payload)).rejects.toThrow(/don't add up/);
    await expect(call(pg, 'gl_own_bill_fix', { ...payload, lines: [{ line_no: 1, account_netsuite_id: FREIGHT }] })).rejects.toThrow(/needs its amount/);
    await expect(call(pg, 'gl_own_bill_fix', { ...payload, lines: [{ line_no: 1, account_netsuite_id: FREIGHT, amount: '' }] })).rejects.toThrow(/needs its amount/);
    await expect(call(pg, 'gl_own_bill_fix', { ...payload, lines: {} })).rejects.toThrow(/must be a list/);
    await expect(call(pg, 'gl_own_bill_fix', { ...payload, netsuite_id: 'INV-5521' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'gl_own_bill_fix', { ...payload, netsuite_id: null })).rejects.toThrow(/needs NetSuite's id/);
    expect(await call(pg, 'gl_own_bill_fix', { ...payload, netsuite_id: '8999' })).toEqual({ saved: false, reason: 'none' });
    // Nothing of a refused fix stays.
    expect(await one(pg, `SELECT version AS r FROM gl_own_bills WHERE netsuite_id = '8805'`)).toBe(1);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_bill_versions WHERE netsuite_id = '8805'`)).toBe(0);
    expect(await call(pg, 'gl_own_bill_fix', { ...payload, lines: [{ line_no: 1, account_netsuite_id: FREIGHT, amount: '10.00' }] }))
      .toEqual({ saved: true, version: 2, lines: 1 });
  });

  it("gives the check the copy's version, so it says the lines are the bill's as fixed", async () => {
    const data = await billPairs(pg, '8802');
    expect(data.bills[0].own).toMatchObject({ netsuite_id: '8802', version: 3, number: 'INV-5521A', date: '2026-10-22' });
    const fixedAt = Date.parse(data.bills[0].own.fixed_at as string);
    expect(Number.isNaN(fixedAt)).toBe(false);
    // NetSuite's bill as its copy had it before the fix: twelve racks.
    const nsBill = (number: string, total: string, lines: unknown[]) => ({
      netsuite_id: '8802', tran_type: 'VendBill', tranid: number, trandate: '2026-10-22', vendor_netsuite_id: '77', vendor_name: 'Acme Truck Racks',
      total, status: 'A', status_label: 'Open', voided: false, memo: null, lines, links: [],
    });
    await call(pg, 'gl_netsuite_bills_apply', { rows: [nsBill('INV-5521', '2140.00', [
      { line_id: '1', item: RACK, account: RECEIVED, amount: '2140.00', own_amount: '2140.00', quantity: '12', memo: null, tax: false },
    ])] });
    const before = new Date(fixedAt - 60_000).toISOString();
    const after = new Date(fixedAt + 60_000).toISOString();
    const stale = checkOwnBills(await billPairs(pg, '8802'), { bills: before, ledger: after }).bills[0];
    expect(stale).toMatchObject({
      status: 'waiting', summary: "Waiting for the copy of NetSuite's bills to read the bill as FleetSuite fixed it: it runs every two hours.",
    });
    expect(stale.workedOut.some((w) => w.startsWith('Fixed in FleetSuite 2 times, last on '))).toBe(true);
    // Read since, and still not as fixed: it differs.
    expect(checkOwnBills(await billPairs(pg, '8802'), { bills: after, ledger: after }).bills[0].status).toBe('differs');

    // NetSuite's bill as fixed, and its ledger.
    await call(pg, 'gl_netsuite_bills_apply', { rows: [nsBill('INV-5521A', '1783.33', [
      { line_id: '1', item: RACK, account: RECEIVED, amount: '1783.33', own_amount: '1783.33', quantity: '10', memo: null, tax: false },
    ])] });
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ('8802', 'VendBill', 'INV-5521A', '2026-10-22', '2026-10-01', 'x', 's')`,
    );
    for (const [line, account, debit, credit] of [['0', PAYABLE, '0', '1783.33'], ['1', RECEIVED, '1783.33', '0']]) {
      await pg.query(
        `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
         SELECT '8802', $1, id, $2, '2026-10-01', '2026-10-22', $3, $4 FROM gl_companies WHERE code = 'BMG'`,
        [line, account, debit, credit],
      );
    }
    const checked = checkOwnBills(await billPairs(pg, '8802'), { bills: after, ledger: after }).bills[0];
    expect(checked).toMatchObject({ status: 'matches', number: 'INV-5521A', fleetsuiteCents: 178333, netsuiteCents: 178333 });
    expect(checked.workedOut).toEqual([
      // The day the copy was made, not the bill's date as fixed.
      expect.stringMatching(/^Made by Create bill on a Parts Mail invoice on [A-Z][a-z]{2} \d{1,2}, \d{4}, from PO453-ACME\.$/),
      "The vendor's invoice says $2,199.97.",
      expect.stringMatching(/^Fixed in FleetSuite 2 times, last on [A-Z][a-z]{2} \d{1,2}, \d{4}: its number, date and lines are the bill's as FleetSuite fixed it/),
    ]);
  });

  it('refuses a fix that says it is somewhere it is not', async () => {
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = {
        id: FIX(8), bill_netsuite_id: '8808', reason: 'Wrong number', changes: JSON.stringify(['Number B-1 → B-2']), patch: JSON.stringify({ tranId: 'B-2' }),
        ...over,
      };
      const cols = Object.keys(r);
      return pg.query(`INSERT INTO bill_fixes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    };
    const done = { status: 'fixed', finished_at: '2026-12-02T15:00:00Z' };
    for (const over of [
      { status: 'fixed' }, { finished_at: '2026-12-02T15:00:00Z' }, { status: 'gone', finished_at: '2026-12-02T15:00:00Z' },
      { ...done, own_copy: 'fixed' }, { ...done, own_copy: 'none', own_copy_version: 2 }, { ...done, own_copy: 'fixed', own_copy_version: 1 },
      { status: 'refused', finished_at: '2026-12-02T15:00:00Z', own_copy: 'none' }, { ...done, own_copy: 'some' },
      { error: 'e'.repeat(2001) }, { bill_netsuite_id: 'INV-5521' }, { vendor_netsuite_id: 'Acme' }, { replace_lists: '{payments}' },
      { changes: JSON.stringify('Number B-1 → B-2') }, { patch: JSON.stringify(['tranId']) },
    ]) {
      await expect(insert(over)).rejects.toThrow(/check/i);
    }
    await expect(insert({ created_by: 'a0000000-0000-4000-8000-000000000009' })).rejects.toThrow(/foreign key/);
    await insert({});
    // One send of a bill at a time, whoever writes it.
    await expect(insert({ id: FIX(9) })).rejects.toThrow(/duplicate key/);
    await insert({ id: FIX(9), ...done, own_copy: 'fixed', own_copy_version: 2, error: 'e'.repeat(2000) });
    // A version kept belongs to a copy, and to a fix that may be gone.
    await expect(pg.query(`INSERT INTO gl_own_bill_versions (netsuite_id, version, copy) VALUES ('8999', 1, '{}')`)).rejects.toThrow(/foreign key/);
    await expect(pg.query(`INSERT INTO gl_own_bill_versions (netsuite_id, version, copy) VALUES ('8805', 0, '{}')`)).rejects.toThrow(/check/i);
    await expect(pg.query(`INSERT INTO gl_own_bill_versions (netsuite_id, version, copy) VALUES ('8805', 7, '[]')`)).rejects.toThrow(/check/i);
    await expect(pg.query(`UPDATE gl_own_bills SET version = 0 WHERE netsuite_id = '8805'`)).rejects.toThrow(/check/i);
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['bill_fixes', 'gl_own_bill_versions']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of ['bill_fix_claim', 'bill_fix_finish', 'gl_own_bill_fix']) {
          await expect(call(pg, fn, { id: FIX(7) })).rejects.toThrow(/permission denied for function/);
        }
        await expect(billPairs(pg, '8802')).rejects.toThrow(/permission denied for function/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('bill_fixes', 'gl_own_bill_versions') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'bill_fixes', relrowsecurity: true },
      { relname: 'gl_own_bill_versions', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
