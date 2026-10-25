// Migration 435 keeps Books' own copy of each bill and PO receipt FleetSuite
// puts into NetSuite, and gives approved vendor invoices and payouts the claim
// Create Bill in NetSuite takes. This runs migrations 359–363, 384 and
// 401–405 with 435 in an in-memory Postgres (PGlite) as the app's server
// login, saves copies worked out by src/lib/books/own-bills.ts and
// own-receipts.ts, copies made-up NetSuite bills, item receipts and their GL
// lines the way the bills and stock copies have them, and holds what the
// save, pairs and months functions do and return, then checks the pairs end
// to end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

import { billPayload, workOutOwnBill, type MadeBill, type PoCopyLine } from './own-bills';
import { receiptPayload, workOutOwnReceipt, type MadeReceipt } from './own-receipts';
import { checkOwnBills, type BillPairsData } from './own-bill-check';
import { checkOwnReceipts, type ReceiptPairsData } from './own-receipt-check';

const OFALLON = '1';
const RACK = '9001';
const BIN = '9002';
const STRAP = '9003';
const SUBTOTAL = '9100';
/** Subcontractors, the items' inventory account, and the accounts the other sides of the documents post to. */
const SUBCONTRACTORS = '611';
const INVENTORY = '190';
const PAYABLE = '200';
const RECEIVED = '210';
const SUPPLIES = '650';
const ROW_1 = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
const ROW_2 = '1c7b2d4f-6a3e-4d9c-8b8f-2e3d4c5b6a71';
const ROW_3 = '2d8c3e5a-7b4f-4eac-9c9a-3f4e5d6c7b82';
const ROW_4 = '3e9d4f6b-8c5a-4fbd-8dab-4a5f6e7d8c93';

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
    -- What migration 435 points at in the app's own schema.
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql', '435-books-own-bills.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '${RACK}', 'RACK-48', true, '{"display_name": "Ladder rack", "item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${BIN}', 'BIN-10', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${STRAP}', 'STRAP-2', true, '{"item_type": "NonInvtPart"}'),
      ('item', '${SUBTOTAL}', 'Subtotal', true, '{"item_type": "Subtotal"}'),
      ('location', '${OFALLON}', 'O''Fallon', true, '{"subsidiary_id": "2"}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('19000', 'Inventory Asset', 'other_current_asset', '${INVENTORY}'),
      ('61100', 'Subcontractors', 'expense', '${SUBCONTRACTORS}');
    INSERT INTO po_receipts (id, ns_status) VALUES
      ('${ROW_1}', 'posted'), ('${ROW_2}', 'posted'), ('${ROW_3}', 'manual_needed'), ('${ROW_4}', 'manual_done');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const saveBill = (pg: PGlite, p: Record<string, unknown>) => call<{ saved: boolean; lines: number }>(pg, 'gl_own_bill_save', p);
const saveReceipt = (pg: PGlite, p: Record<string, unknown>) => call<{ saved: boolean; lines: number }>(pg, 'gl_own_receipt_save', p);
const billPairs = (pg: PGlite, from: string | null, to: string | null, id: string | null = null) =>
  one<BillPairsData>(pg, 'SELECT gl_own_bill_pairs($1::date, $2::date, $3) AS r', [from, to, id]);
const receiptPairs = (pg: PGlite, from: string | null, to: string | null, key: string | null = null) =>
  one<ReceiptPairsData>(pg, 'SELECT gl_own_receipt_pairs($1::date, $2::date, $3::uuid) AS r', [from, to, key]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
/** Both copies have run since every copy here was made. */
const SINCE = () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  return { bills: later, stock: later, ledger: later };
};

/** What NetSuite posted for a document, in the GL copy: [line, account, cents debit positive]. */
async function gl(pg: PGlite, id: string, type: string, date: string, lines: Array<[string, string, number]>, company = 'BMG') {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $1, $3, $4, 'x', 's')`,
    [id, type, date, month],
  );
  for (const [line, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company],
    );
  }
}

const AT = new Date('2026-10-21T15:00:00Z'); // 10 AM Central

/** An approved CNI vendor invoice's bill: one line to Subcontractors. */
const apBill = (over: Partial<MadeBill> = {}) => billPayload(workOutOwnBill({
  netsuiteId: '8801', netsuiteNumber: 'VI-1042', madeFrom: 'vendor_invoice', madeFromId: 'inv-1', vendorId: 412,
  vendorName: 'Northside Install Co.', referenceNo: 'VI-1042', subsidiaryId: '2', locationId: OFALLON,
  expense: { accountId: SUBCONTRACTORS, amount: 1250, memo: 'Install for job 1042' }, ...over,
} as MadeBill & { netsuiteId: string }, null, AT));

/** FleetSuite's copy of PO453-ACME: 12 racks, and 4 bins of which 1 is billed. */
const PO_LINES: PoCopyLine[] = [
  { line_id: '2', item_netsuite_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '12', quantity_billed: '0', rate: '178.3333', amount: '2140.00' },
  { line_id: '3', item_netsuite_id: BIN, item_number: 'BIN-10', description: null, quantity: '4', quantity_billed: '1', rate: '19.99', amount: '79.96' },
];
const partsMailBill = () => billPayload(workOutOwnBill({
  netsuiteId: '8802', netsuiteNumber: 'INV-5521', madeFrom: 'parts_mail', madeFromId: 'parts-1', vendorId: 77,
  vendorName: 'Acme Truck Racks', referenceNo: 'INV-5521', po: { copyId: 'po-1', netsuiteId: '5001', number: 'PO453-ACME' },
  invoiceTotal: '2199.97', expense: null,
}, PO_LINES, AT));

/** NetSuite's bill as the copy of its bills has it (migration 384). */
const nsBill = (id: string, number: string, vendor: [string, string], total: string, lines: unknown[]) => ({
  netsuite_id: id, tran_type: 'VendBill', tranid: number, trandate: '2026-10-21', vendor_netsuite_id: vendor[0], vendor_name: vendor[1],
  total, status: 'A', status_label: 'Open', voided: false, memo: null, lines, links: [],
});

/** A Receive of 12 racks and 4 bins against PO453-ACME, which NetSuite took as IR-2288. */
const receipt = (over: Partial<MadeReceipt> = {}) => receiptPayload(workOutOwnReceipt({
  rows: [
    { id: ROW_1, lineId: '2', itemId: RACK, itemNumber: 'RACK-48', description: 'Ladder rack', quantity: 12, rate: '178.3333' },
    { id: ROW_2, lineId: '3', itemId: BIN, itemNumber: 'BIN-10', description: null, quantity: 4, rate: 19.99 },
  ],
  netsuiteId: '7101', netsuiteNumber: 'IR-2288', netsuiteError: null,
  po: { netsuiteId: 5001, number: 'PO453-ACME', vendorId: '77', vendorName: 'Acme Truck Racks' },
  receiveDate: '2026-10-21', ...over,
})!);

/** NetSuite's item receipt as the copy of its stock moves hands it over. */
const IR_2288 = {
  netsuite_id: '7101', tran_type: 'ItemRcpt', tranid: 'IR-2288', trandate: '2026-10-21',
  lines: [
    { line_id: '1', company: 'BMG', item_id: RACK, location_id: OFALLON, quantity: '12', moves_stock: true },
    { line_id: '2', company: 'BMG', item_id: BIN, location_id: OFALLON, quantity: '4', moves_stock: true },
  ],
};

describe("migration 435: FleetSuite's own bills and receipts", () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('lets one try at a time claim an approved vendor invoice or payout for its bill', async () => {
    for (const table of ['vendor_invoices', 'payouts']) {
      const id = await one<string>(pg, `INSERT INTO ${table} DEFAULT VALUES RETURNING id AS r`);
      // As src/lib/bill-once.ts asks PostgREST for it: approved, and unclaimed or claimed over 15 minutes ago.
      const claim = async (at: string, cutoff: string) => (await pg.query(
        `UPDATE ${table} SET bill_claimed_at = $2 WHERE id = $1 AND status = 'approved'
           AND (bill_claimed_at IS NULL OR bill_claimed_at < $3) RETURNING id`,
        [id, at, cutoff],
      )).rows.length;
      expect(await claim('2026-10-21T15:00:00Z', '2026-10-21T14:45:00Z'), table).toBe(1);
      expect(await claim('2026-10-21T15:01:00Z', '2026-10-21T14:46:00Z'), table).toBe(0);
      expect(await claim('2026-10-21T15:16:00Z', '2026-10-21T15:01:00Z'), table).toBe(1);
      expect(await one<string>(pg, `SELECT bill_claimed_at::text AS r FROM ${table} WHERE id = $1`, [id])).toBe('2026-10-21 15:16:00+00');
    }
  });

  it('saves a copy of the bill FleetSuite made, once', async () => {
    expect(await saveBill(pg, apBill())).toEqual({ saved: true, lines: 1 });
    const head = (await pg.query<Record<string, unknown>>(
      `SELECT b.netsuite_number, c.code AS company, b.made_from, b.made_from_id, b.vendor_netsuite_id, b.vendor_name, b.reference_no,
              b.bill_date::text AS bill_date, b.location_netsuite_id, b.invoice_total, b.unknowns
       FROM gl_own_bills b JOIN gl_companies c ON c.id = b.company_id WHERE b.netsuite_id = '8801'`,
    )).rows[0];
    expect(head).toEqual({
      netsuite_number: 'VI-1042', company: 'BMG', made_from: 'vendor_invoice', made_from_id: 'inv-1', vendor_netsuite_id: '412',
      vendor_name: 'Northside Install Co.', reference_no: 'VI-1042', bill_date: '2026-10-21', location_netsuite_id: OFALLON,
      invoice_total: null, unknowns: [],
    });
    expect((await pg.query(
      `SELECT line_no, account_netsuite_id, item_netsuite_id, description, amount::text AS amount FROM gl_own_bill_lines WHERE bill_id = '8801'`,
    )).rows).toEqual([{ line_no: 1, account_netsuite_id: SUBCONTRACTORS, item_netsuite_id: null, description: 'Install for job 1042', amount: '1250.00' }]);

    // Saving the same bill again changes nothing.
    expect(await saveBill(pg, apBill({ netsuiteNumber: 'VB-9999', expense: { accountId: '612', amount: 1, memo: null } }))).toEqual({ saved: false, lines: 0 });
    expect(await one(pg, `SELECT netsuite_number AS r FROM gl_own_bills WHERE netsuite_id = '8801'`)).toBe('VI-1042');
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_bill_lines WHERE bill_id = '8801'`)).toBe(1);
  });

  it("keeps a copy for the company whose NetSuite subsidiary it was made in, else the one named, else BMG", async () => {
    const companyOf = async (id: string, p: Record<string, unknown>) => {
      expect(await saveBill(pg, { ...apBill({ netsuiteId: id }), ...p })).toMatchObject({ saved: true });
      return one(pg, `SELECT c.code AS r FROM gl_own_bills b JOIN gl_companies c ON c.id = b.company_id WHERE b.netsuite_id = $1`, [id]);
    };
    expect(await companyOf('8810', { subsidiary_id: '5' })).toBe('1084');
    expect(await companyOf('8811', { subsidiary_id: null, company: '1084' })).toBe('1084');
    expect(await companyOf('8812', { subsidiary_id: '99' })).toBe('BMG');
    expect(await companyOf('8813', { subsidiary_id: null })).toBe('BMG');
    await expect(saveBill(pg, { ...apBill({ netsuiteId: '8814' }), subsidiary_id: null, company: 'XYZ' })).rejects.toThrow(/company XYZ doesn't exist/);
    await pg.exec(`RESET ROLE; DELETE FROM gl_own_bills WHERE netsuite_id IN ('8810', '8811', '8812', '8813'); SET ROLE service_role`);
  });

  it("refuses a bill copy that isn't whole, and keeps nothing of it", async () => {
    const p = apBill({ netsuiteId: '8820' });
    const line = (p.lines as Array<Record<string, unknown>>)[0];
    await expect(saveBill(pg, { ...p, netsuite_id: 'VB-8820' })).rejects.toThrow(/NetSuite's id/);
    await expect(saveBill(pg, { ...p, netsuite_id: null })).rejects.toThrow(/NetSuite's id/);
    await expect(saveBill(pg, { ...p, lines: 'none' })).rejects.toThrow(/must be a list/);
    await expect(saveBill(pg, { ...p, made_from: 'snapped' })).rejects.toThrow(/check/i);
    await expect(saveBill(pg, { ...p, unknowns: ['guesses'] })).rejects.toThrow(/check/i);
    await expect(saveBill(pg, { ...p, vendor_netsuite_id: 'V-412' })).rejects.toThrow(/check/i);
    await expect(saveBill(pg, { ...p, bill_date: null })).rejects.toThrow(/null/i);
    await expect(saveBill(pg, { ...p, lines: [{ ...line, line_no: 0 }] })).rejects.toThrow(/check/i);
    // A line is an expense line or an item line, not both.
    await expect(saveBill(pg, { ...p, lines: [{ ...line, item_netsuite_id: RACK }] })).rejects.toThrow(/check/i);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_bills WHERE netsuite_id = '8820'`)).toBe(0);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_bill_lines WHERE bill_id = '8820'`)).toBe(0);
  });

  it("puts a bill next to NetSuite's, with the companies its ledger books it to", async () => {
    let data = await billPairs(pg, '2026-10-01', '2026-10-31');
    expect(data.bills.map((b) => [b.own.netsuite_id, b.netsuite])).toEqual([['8801', null]]);
    expect(data.accounts).toEqual({ [SUBCONTRACTORS]: { number: '61100', name: 'Subcontractors' } });
    expect(checkOwnBills(data, { bills: null, ledger: null }).bills[0].status).toBe('waiting');

    const lines = [{ line_id: '1', item: null, account: SUBCONTRACTORS, amount: '-1250.00', own_amount: '-1250.00', quantity: null, memo: 'Install for job 1042', tax: false }];
    await call(pg, 'gl_netsuite_bills_apply', { rows: [nsBill('8801', 'VI-1042', ['412', 'Northside Install Co.'], '1250.00', lines)] });
    data = await billPairs(pg, null, null, '8801');
    expect(data.bills[0].netsuite).toEqual({
      number: 'VI-1042', type: 'VendBill', date: '2026-10-21', vendor_id: '412', vendor_name: 'Northside Install Co.', total: '1250.00',
      status: 'Open', voided: false, gone: false, lines, links: [], companies: [],
    });
    expect(data.bills[0].own).toMatchObject({
      netsuite_id: '8801', number: 'VI-1042', company: 'BMG', made_from: 'vendor_invoice', date: '2026-10-21', po_id: null,
      lines: [{ line_no: 1, account_id: SUBCONTRACTORS, item_id: null, item_number: null, description: 'Install for job 1042', quantity: null, rate: null, amount: '1250.00', po_line_id: null }],
    });
    // Before the copy of NetSuite's general ledger has it, its company isn't known.
    expect(checkOwnBills(data, { bills: SINCE().bills, ledger: null }).bills[0].status).toBe('waiting');

    await gl(pg, '8801', 'VendBill', '2026-10-21', [['0', PAYABLE, -125000], ['1', SUBCONTRACTORS, 125000]]);
    data = await billPairs(pg, null, null, '8801');
    expect(data.bills[0].netsuite!.companies).toEqual(['BMG']);
    expect(checkOwnBills(data, SINCE()).bills[0]).toMatchObject({ status: 'matches', fleetsuiteCents: 125000, netsuiteCents: 125000 });
  });

  it("puts a Parts Mail bill's items next to NetSuite's, leaving out its layout lines", async () => {
    expect(await saveBill(pg, partsMailBill())).toEqual({ saved: true, lines: 2 });
    await call(pg, 'gl_netsuite_bills_apply', {
      rows: [nsBill('8802', 'INV-5521', ['77', 'Acme Truck Racks'], '2199.97', [
        { line_id: '1', item: RACK, account: RECEIVED, amount: '2140.00', own_amount: '2140.00', quantity: '12', memo: null, tax: false },
        { line_id: '2', item: BIN, account: RECEIVED, amount: '59.97', own_amount: '59.97', quantity: '3', memo: null, tax: false },
        { line_id: '3', item: SUBTOTAL, account: null, amount: '2199.97', own_amount: null, quantity: null, memo: null, tax: false },
      ])],
    });
    await gl(pg, '8802', 'VendBill', '2026-10-21', [['0', PAYABLE, -219997], ['1', RECEIVED, 214000], ['2', RECEIVED, 5997]]);
    const data = await billPairs(pg, null, null, '8802');
    expect(data.bills[0].own).toMatchObject({
      made_from: 'parts_mail', po_id: '5001', po_number: 'PO453-ACME', invoice_total: '2199.97', location_id: null, unknowns: [],
    });
    expect(data.bills[0].own.lines.map((l) => [l.item_id, l.quantity, l.rate, l.amount, l.po_line_id])).toEqual([
      [RACK, '12.0000', '178.3333', '2140.00', '2'],
      [BIN, '3.0000', '19.9900', '59.97', '3'],
    ]);
    expect(data.items).toEqual({
      [RACK]: { number: 'RACK-48', type: 'InvtPart', display_name: 'Ladder rack' },
      [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: null },
      [SUBTOTAL]: { number: 'Subtotal', type: 'Subtotal', display_name: null },
    });
    expect(checkOwnBills(data, SINCE()).bills[0]).toMatchObject({ status: 'matches', poNumber: 'PO453-ACME', fleetsuiteCents: 219997 });
  });

  it("saves a copy of a Receive once, and one copy of NetSuite's item receipt", async () => {
    expect(await saveReceipt(pg, receipt())).toEqual({ saved: true, lines: 2 });
    const head = (await pg.query<Record<string, unknown>>(
      `SELECT r.netsuite_id, r.netsuite_number, c.code AS company, r.po_netsuite_id, r.po_number, r.vendor_netsuite_id,
              r.receive_date::text AS receive_date, r.netsuite_error, r.unknowns
       FROM gl_own_receipts r JOIN gl_companies c ON c.id = r.company_id WHERE r.receipt_key = $1`, [ROW_1],
    )).rows[0];
    expect(head).toEqual({
      netsuite_id: '7101', netsuite_number: 'IR-2288', company: 'BMG', po_netsuite_id: '5001', po_number: 'PO453-ACME',
      vendor_netsuite_id: '77', receive_date: '2026-10-21', netsuite_error: null, unknowns: [],
    });
    expect((await pg.query(
      `SELECT line_no, item_netsuite_id, quantity::text AS quantity, rate::text AS rate, po_line_id, po_receipt_id FROM gl_own_receipt_lines WHERE receipt_key = $1 ORDER BY line_no`,
      [ROW_1],
    )).rows).toEqual([
      { line_no: 1, item_netsuite_id: RACK, quantity: '12.0000', rate: '178.3333', po_line_id: '2', po_receipt_id: ROW_1 },
      { line_no: 2, item_netsuite_id: BIN, quantity: '4.0000', rate: '19.9900', po_line_id: '3', po_receipt_id: ROW_2 },
    ]);
    // The same Receive again, or another copy of the same item receipt, changes nothing.
    expect(await saveReceipt(pg, receipt({ netsuiteNumber: 'IR-9999' }))).toEqual({ saved: false, lines: 0 });
    expect(await saveReceipt(pg, receipt({ rows: [{ id: ROW_4, lineId: '2', itemId: RACK, itemNumber: 'RACK-48', description: null, quantity: 1, rate: null }] })))
      .toEqual({ saved: false, lines: 0 });
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_receipts WHERE netsuite_id = '7101'`)).toBe(1);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_receipt_lines WHERE receipt_key = $1`, [ROW_4])).toBe(0);
  });

  it("keeps each Receive NetSuite didn't take, with what it said", async () => {
    const refused = (row: string, lineId: string) => receipt({
      rows: [{ id: row, lineId, itemId: RACK, itemNumber: 'RACK-48', description: null, quantity: 2, rate: '178.3333' }],
      netsuiteId: null, netsuiteNumber: null, netsuiteError: 'Invalid line item',
    });
    expect(await saveReceipt(pg, refused(ROW_3, '2'))).toEqual({ saved: true, lines: 1 });
    expect(await saveReceipt(pg, refused(ROW_4, '4'))).toEqual({ saved: true, lines: 1 });
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_receipts WHERE netsuite_id IS NULL AND netsuite_error = 'Invalid line item'`)).toBe(2);
  });

  it("refuses a receipt copy that isn't whole, and keeps nothing of it", async () => {
    const key = '4fae5a7c-9d6b-4ace-9ebc-5b6a7f8e9da4';
    const p: Record<string, unknown> = { ...receipt({ netsuiteId: '7120' }), receipt_key: key };
    const line = (p.lines as Array<Record<string, unknown>>)[0];
    await expect(saveReceipt(pg, { ...p, receipt_key: 'row-1' })).rejects.toThrow(/receipt row/);
    await expect(saveReceipt(pg, { ...p, netsuite_id: 'IR-7120' })).rejects.toThrow(/isn't a number/);
    await expect(saveReceipt(pg, { ...p, lines: 'none' })).rejects.toThrow(/must be a list/);
    await expect(saveReceipt(pg, { ...p, unknowns: ['lines'] })).rejects.toThrow(/check/i);
    await expect(saveReceipt(pg, { ...p, company: 'XYZ' })).rejects.toThrow(/doesn't exist/);
    await expect(saveReceipt(pg, { ...p, receive_date: null })).rejects.toThrow(/null/i);
    await expect(saveReceipt(pg, { ...p, lines: [{ ...line, quantity: 0 }] })).rejects.toThrow(/check/i);
    await expect(saveReceipt(pg, { ...p, lines: [{ ...line, item_netsuite_id: 'RACK-48' }] })).rejects.toThrow(/check/i);
    await expect(saveReceipt(pg, { ...p, lines: [{ ...line, po_receipt_id: 'row-1' }] })).rejects.toThrow(/uuid/i);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_receipts WHERE receipt_key = $1`, [key])).toBe(0);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_receipt_lines WHERE receipt_key = $1`, [key])).toBe(0);
  });

  it("puts a receipt next to NetSuite's item receipt, valued from its ledger, with where Receiving's rows stand", async () => {
    let data = await receiptPairs(pg, null, null, ROW_1);
    expect(data.receipts[0]).toMatchObject({ netsuite: null, in_ledger: false, receiving: { posted: 2, manual_needed: 0, manual_done: 0 } });
    expect(checkOwnReceipts(data, { stock: null, ledger: null }).receipts[0].status).toBe('waiting');

    await call(pg, 'gl_netsuite_stock_apply', { documents: [IR_2288] });
    data = await receiptPairs(pg, null, null, ROW_1);
    expect(data.receipts[0].netsuite).toEqual({
      number: 'IR-2288', type: 'ItemRcpt', date: '2026-10-21', gone: false,
      lines: [
        { line_id: '1', company: 'BMG', item_id: RACK, location_id: OFALLON, quantity: '12', moves_stock: true, value: null },
        { line_id: '2', company: 'BMG', item_id: BIN, location_id: OFALLON, quantity: '4', moves_stock: true, value: null },
      ],
    });
    expect(checkOwnReceipts(data, { stock: SINCE().stock, ledger: null }).receipts[0].status).toBe('waiting');

    await gl(pg, '7101', 'ItemRcpt', '2026-10-21', [['0', RECEIVED, -221996], ['1', INVENTORY, 214000], ['2', INVENTORY, 7996]]);
    data = await receiptPairs(pg, null, null, ROW_1);
    expect(data.receipts[0].in_ledger).toBe(true);
    expect(data.receipts[0].netsuite!.lines.map((l) => l.value)).toEqual(['2140.00', '79.96']);
    expect(data.items).toEqual({
      [RACK]: { number: 'RACK-48', type: 'InvtPart', display_name: 'Ladder rack' },
      [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: null },
    });
    expect(data.locations).toEqual({ [OFALLON]: "O'Fallon" });
    expect(checkOwnReceipts(data, SINCE()).receipts[0]).toMatchObject({
      status: 'matches', number: 'IR-2288', location: "O'Fallon", fleetsuiteCents: 221996, netsuiteCents: 221996,
    });

    // One NetSuite didn't take is on Receiving's list to enter by hand; one entered by hand isn't checked.
    const refused = checkOwnReceipts(await receiptPairs(pg, null, null, ROW_3), SINCE()).receipts[0];
    expect(refused).toMatchObject({ status: 'not_in_netsuite', netsuiteError: 'Invalid line item', receiving: { manualNeeded: 1 } });
    expect(checkOwnReceipts(await receiptPairs(pg, null, null, ROW_4), SINCE()).receipts[0]).toMatchObject({ status: 'incomplete', receiving: { manualDone: 1 } });
  });

  it('marks one NetSuite deleted as gone, and counts by month, newest first', async () => {
    await pg.exec(`RESET ROLE; UPDATE gl_netsuite_stock_documents SET gone_at = now() WHERE netsuite_id = '7101'; SET ROLE service_role`);
    expect(checkOwnReceipts(await receiptPairs(pg, null, null, ROW_1), SINCE()).receipts[0].status).toBe('voided');

    expect(await saveBill(pg, { ...apBill({ netsuiteId: '8790', netsuiteNumber: 'VI-0990', referenceNo: 'VI-0990' }), bill_date: '2026-09-30' }))
      .toEqual({ saved: true, lines: 1 });
    expect(await one(pg, 'SELECT gl_own_bill_months() AS r')).toEqual([
      { month: '2026-10-01', bills: 2 },
      { month: '2026-09-01', bills: 1 },
    ]);
    // Newest first within a month: by date, then NetSuite's id.
    expect((await billPairs(pg, '2026-10-01', '2026-10-31')).bills.map((b) => b.own.netsuite_id)).toEqual(['8802', '8801']);
    expect((await billPairs(pg, '2026-09-01', '2026-09-30')).bills.map((b) => b.own.netsuite_id)).toEqual(['8790']);

    expect(await saveReceipt(pg, { ...receipt({ netsuiteId: null }), receipt_key: '5abf6b8d-ae7c-4bdf-afcd-6c7b8a9fbeb5', receive_date: '2026-09-29' }))
      .toEqual({ saved: true, lines: 2 });
    expect(await one(pg, 'SELECT gl_own_receipt_months() AS r')).toEqual([
      { month: '2026-10-01', receipts: 3 },
      { month: '2026-09-01', receipts: 1 },
    ]);
    // Newest first within a month: by date, then the latest made.
    expect((await receiptPairs(pg, '2026-10-01', '2026-10-31')).receipts.map((r) => r.own.receipt_key)).toEqual([ROW_4, ROW_3, ROW_1]);
  });

  it('values a receipt by what NetSuite posted to the inventory accounts alone', async () => {
    const [first, second] = ['6bc07c9e-bf8d-4ce0-b0de-7d8c9b0acfc6', '7cd18daf-c09e-4df1-81ef-8e9dac1bd0d7'];
    expect(await saveReceipt(pg, receipt({
      rows: [
        { id: first, lineId: '2', itemId: RACK, itemNumber: 'RACK-48', description: null, quantity: 1, rate: '178.3333' },
        { id: second, lineId: '5', itemId: STRAP, itemNumber: 'STRAP-2', description: null, quantity: 5, rate: 3 },
      ],
      netsuiteId: '7130', netsuiteNumber: 'IR-2290', receiveDate: '2026-10-22',
    }))).toEqual({ saved: true, lines: 2 });
    await call(pg, 'gl_netsuite_stock_apply', {
      documents: [{
        netsuite_id: '7130', tran_type: 'ItemRcpt', tranid: 'IR-2290', trandate: '2026-10-22',
        lines: [
          { line_id: '1', company: 'BMG', item_id: RACK, location_id: OFALLON, quantity: '1', moves_stock: true },
          { line_id: '2', company: 'BMG', item_id: STRAP, location_id: OFALLON, quantity: '5', moves_stock: false },
        ],
      }],
    });
    // The straps aren't kept in stock: their line posts to supplies.
    await gl(pg, '7130', 'ItemRcpt', '2026-10-22', [['0', RECEIVED, -19333], ['1', INVENTORY, 17833], ['2', SUPPLIES, 1500]]);
    const data = await receiptPairs(pg, null, null, first);
    expect(data.receipts[0].netsuite!.lines.map((l) => [l.item_id, l.moves_stock, l.value])).toEqual([[RACK, true, '178.33'], [STRAP, false, null]]);
    expect(checkOwnReceipts(data, SINCE()).receipts[0]).toMatchObject({ status: 'matches', fleetsuiteCents: 17833, netsuiteCents: 17833 });
  });

  it("is the service role's alone", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of [
      'public.gl_own_copy_company(jsonb)', 'public.gl_own_bill_save(jsonb)', 'public.gl_own_receipt_save(jsonb)',
      'public.gl_own_bill_pairs(date, date, text)', 'public.gl_own_receipt_pairs(date, date, uuid)',
      'public.gl_own_bill_months()', 'public.gl_own_receipt_months()',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const table of ['gl_own_bills', 'gl_own_bill_lines', 'gl_own_receipts', 'gl_own_receipt_lines']) {
      for (const role of ['anon', 'authenticated']) {
        expect(await one<boolean>(pg, `SELECT has_table_privilege($1::name, '${table}', 'SELECT') AS r`, [role]), `${table} ${role}`).toBe(false);
      }
      expect(await one<boolean>(pg, `SELECT relrowsecurity AS r FROM pg_class WHERE relname = $1`, [table])).toBe(true);
    }
    await pg.exec('SET ROLE service_role');
  });
});
