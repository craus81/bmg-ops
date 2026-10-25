// Migration 436 keeps each bill snapped in Books → Snap a bill, from its
// picture to NetSuite, lets Books keep its own copy of a snapped bill, and
// reads what the copies hold about a vendor's earlier bills. This runs the
// migrations own-bills-sql.test.ts runs, with 436, in an in-memory Postgres
// (PGlite) as the app's server login, and holds what gl_snapped_bills takes
// and refuses, the claim Send to NetSuite takes on it, the copy of a sent
// bill next to NetSuite's, and what gl_vendor_bill_history gives
// src/lib/books/snap-a-bill.ts to suggest from.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

import { billPayload, workOutOwnBill } from './own-bills';
import { checkOwnBills, type BillPairsData } from './own-bill-check';
import { suggestLocation, usualAccount, usualCompany, type HistoryBill, type VendorHistory } from './snap-a-bill';

const OFALLON = '1';
const SOCIAL_CIRCLE = '3';
const RACK = '9001';
/** Utilities, late fees, sales tax, the items' received-not-billed account, and accounts payable. */
const UTILITIES = '623';
const LATE_FEES = '681';
const SALES_TAX = '230';
const RECEIVED = '210';
const PAYABLE = '200';
/** A made-up vendor, and another with a name like it. */
const RIVERBEND: [string, string] = ['501', 'Riverbend Electric Co-op'];
const WATER: [string, string] = ['502', 'Riverbend Water District'];
const CRAIG = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PICTURE = '5d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';

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
    '436-books-snap-a-bill.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '${RACK}', 'RACK-48', true, '{"item_type": "InvtPart"}'),
      ('location', '${OFALLON}', 'O''Fallon', true, '{"subsidiary_id": "2"}'),
      ('location', '${SOCIAL_CIRCLE}', 'Social Circle', true, '{"subsidiary_id": "5"}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('62300', 'Utilities', 'expense', '${UTILITIES}'),
      ('68100', 'Late Fees', 'expense', '${LATE_FEES}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const saveBill = (pg: PGlite, p: Record<string, unknown>) => call<{ saved: boolean; lines: number }>(pg, 'gl_own_bill_save', p);
const billPairs = (pg: PGlite, id: string) => one<BillPairsData>(pg, 'SELECT gl_own_bill_pairs(NULL, NULL, $1) AS r', [id]);
const history = (pg: PGlite, vendor: string, number: string | null = null, limit: number | null = 24) =>
  one<VendorHistory>(pg, 'SELECT gl_vendor_bill_history($1::text, $2::text, $3::int) AS r', [vendor, number, limit]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
/** Both copies have run since every copy here was made. */
const SINCE = () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  return { bills: later, ledger: later };
};

/** A snapped bill as the route inserts one, with what's given. */
async function snap(pg: PGlite, given: Record<string, unknown> = {}): Promise<string> {
  const company = await one<string>(pg, `SELECT id AS r FROM gl_companies WHERE code = 'BMG'`);
  const row: Record<string, unknown> = { company_id: company, file_path: `${randomUUID()}.jpg`, file_type: 'image/jpeg', ...given };
  const cols = Object.keys(row);
  return one<string>(
    pg,
    `INSERT INTO gl_snapped_bills (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id AS r`,
    cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])),
  );
}

/** What NetSuite posted for a bill, in the GL copy: [line, account, cents debit positive, location]. */
async function gl(pg: PGlite, id: string, date: string, lines: Array<[string, string, number, string | null]>, company = 'BMG') {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'VendBill', $1, $2, $3, 'x', 's')`,
    [id, date, month],
  );
  for (const [line, account, cents, location] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8 FROM gl_companies WHERE code = $9`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', location, company],
    );
  }
}

/** NetSuite's bill as the copy of its bills has it (migration 384); lines left out when null, as when the copy couldn't read them. */
const nsBill = (id: string, number: string, date: string, vendor: [string, string], total: string, lines: unknown[] | null, over: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: 'VendBill', tranid: number, trandate: date, vendor_netsuite_id: vendor[0], vendor_name: vendor[1],
  total, status: 'A', status_label: 'Open', voided: false, memo: null, ...(lines ? { lines } : {}), links: [], ...over,
});
/** An expense line, signed as NetSuite gives a bill's. */
const expense = (lineId: string, account: string, amount: string, memo: string | null, tax = false) => ({
  line_id: lineId, item: null, account, amount: `-${amount}`, own_amount: `-${amount}`, quantity: null, memo, tax,
});

const AT = new Date('2026-10-21T15:00:00Z'); // 10 AM Central

describe('migration 436: Snap a bill', () => {
  let pg: PGlite;
  let snapped: string;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("keeps a snapped bill as a draft, and refuses one that doesn't add up", async () => {
    snapped = await snap(pg, { file_path: `${PICTURE}.jpg`, file_name: 'IMG_0412.HEIC', made_by: CRAIG });
    expect((await pg.query(
      `SELECT status, lines, due_picked, read_result, netsuite_id, bill_claimed_at, made_by FROM gl_snapped_bills WHERE id = $1`, [snapped],
    )).rows[0]).toEqual({ status: 'draft', lines: [], due_picked: false, read_result: null, netsuite_id: null, bill_claimed_at: null, made_by: CRAIG });

    const now = '2026-10-21T15:00:00Z';
    await expect(snap(pg, { file_path: `${PICTURE}.jpg` })).rejects.toThrow(/duplicate key/);
    for (const [bad, why] of [
      [{ file_path: `../${randomUUID()}.jpg` }, 'a path outside its folder'],
      [{ file_path: `${randomUUID()}.pdf.html` }, 'a page passed off as a PDF'],
      [{ file_path: `${randomUUID()}.heic` }, 'a picture the page should have turned into a JPEG'],
      [{ file_path: `${randomUUID()}.JPG` }, 'a name the route never makes'],
      [{ file_type: 'image/heic' }, "a type the reader can't read"],
      [{ lines: {} }, 'lines that are not a list'],
      [{ read_result: [] }, 'a read that is not an object'],
      [{ vendor_netsuite_id: 'V-501' }, "a vendor that isn't NetSuite's id"],
      [{ location_netsuite_id: "O'Fallon" }, "a location that isn't NetSuite's id"],
      [{ status: 'filed' }, 'a status there is no such thing as'],
      [{ status: 'sent' }, "sent, with no bill in NetSuite"],
      [{ status: 'sent', netsuite_id: '8901' }, 'sent, with no time it was'],
      [{ status: 'sent', netsuite_id: 'VB-8901', sent_at: now }, "a NetSuite bill that isn't NetSuite's id"],
      [{ netsuite_id: '8901', sent_at: now }, 'a draft with a bill in NetSuite'],
      [{ status: 'thrown_away' }, 'thrown away, with no time it was'],
      [{ thrown_away_at: now }, 'a draft with a time it was thrown away'],
      [{ status: 'thrown_away', thrown_away_at: now, netsuite_id: '8901', sent_at: now }, 'thrown away once it was sent'],
    ] as Array<[Record<string, unknown>, string]>) {
      await expect(snap(pg, bad), why).rejects.toThrow(/violates check constraint/);
    }
    await expect(snap(pg, { company_id: randomUUID() })).rejects.toThrow(/foreign key/);
    expect(await one(pg, 'SELECT count(*)::int AS r FROM gl_snapped_bills')).toBe(1);
  });

  it('lets one try at Send at a time claim a draft, and none once it is sent', async () => {
    // As src/lib/bill-once.ts asks PostgREST for it: a draft, and unclaimed or claimed over 15 minutes ago.
    const claim = async (at: string, cutoff: string) => (await pg.query(
      `UPDATE gl_snapped_bills SET bill_claimed_at = $2 WHERE id = $1 AND status = 'draft'
         AND (bill_claimed_at IS NULL OR bill_claimed_at < $3) RETURNING id`,
      [snapped, at, cutoff],
    )).rows.length;
    expect(await claim('2026-10-21T15:00:00Z', '2026-10-21T14:45:00Z')).toBe(1);
    expect(await claim('2026-10-21T15:01:00Z', '2026-10-21T14:46:00Z')).toBe(0);
    expect(await claim('2026-10-21T15:16:00Z', '2026-10-21T15:01:00Z')).toBe(1);

    // As the route stamps it once NetSuite made the bill.
    await pg.query(
      `UPDATE gl_snapped_bills SET status = 'sent', netsuite_id = '8901', netsuite_number = '88213-10', sent_at = $2, sent_by = $3,
         send_error = NULL, bill_claimed_at = NULL WHERE id = $1`,
      [snapped, '2026-10-21T15:16:05Z', CRAIG],
    );
    expect(await claim('2026-10-21T16:00:00Z', '2026-10-21T15:45:00Z')).toBe(0);
    // No other snapped bill can say it's the same NetSuite bill.
    await expect(snap(pg, { status: 'sent', netsuite_id: '8901', sent_at: '2026-10-21T15:20:00Z' })).rejects.toThrow(/duplicate key/);
  });

  it('is the service role\'s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(pg.query('SELECT id FROM gl_snapped_bills')).rejects.toThrow(/permission denied for table gl_snapped_bills/);
      await expect(pg.query(`UPDATE gl_snapped_bills SET status = 'thrown_away' WHERE id = $1`, [snapped]))
        .rejects.toThrow(/permission denied for table gl_snapped_bills/);
      await expect(pg.query(`SELECT gl_vendor_bill_history('501')`)).rejects.toThrow(/permission denied for function gl_vendor_bill_history/);
      await expect(pg.query(`SELECT gl_own_bill_pairs(NULL, NULL, '8901')`)).rejects.toThrow(/permission denied for function gl_own_bill_pairs/);
    }
    await pg.exec('RESET ROLE; SET ROLE service_role');
  });

  it("keeps Books' own copy of a sent bill, says who snapped it, and checks it against NetSuite's", async () => {
    const made = billPayload(workOutOwnBill({
      netsuiteId: '8901', netsuiteNumber: '88213-10', madeFrom: 'snapped', madeFromId: snapped, madeBy: CRAIG,
      vendorId: RIVERBEND[0], vendorName: RIVERBEND[1], referenceNo: '88213-10', subsidiaryId: '2', locationId: OFALLON,
      expenses: [
        { accountId: UTILITIES, amount: 1284.33, memo: 'Electric service, Sep 18 to Oct 17' },
        { accountId: LATE_FEES, amount: 12.5, memo: 'Late payment charge' },
      ],
      billDate: '2026-10-20', invoiceTotal: '1296.83',
    }, null, AT));
    // Other places a bill comes from are still refused.
    await expect(saveBill(pg, { ...made, made_from: 'photo' })).rejects.toThrow(/check/i);
    expect(await saveBill(pg, made)).toEqual({ saved: true, lines: 2 });

    let data = await billPairs(pg, '8901');
    expect(data.bills[0].own).toMatchObject({
      netsuite_id: '8901', number: '88213-10', company: 'BMG', made_from: 'snapped', made_from_id: snapped, made_by: CRAIG,
      vendor_id: RIVERBEND[0], reference_no: '88213-10', date: '2026-10-20', location_id: OFALLON, invoice_total: '1296.83', unknowns: [],
      lines: [
        { line_no: 1, account_id: UTILITIES, item_id: null, description: 'Electric service, Sep 18 to Oct 17', amount: '1284.33' },
        { line_no: 2, account_id: LATE_FEES, item_id: null, description: 'Late payment charge', amount: '12.50' },
      ],
    });
    expect(data.accounts).toEqual({ [UTILITIES]: { number: '62300', name: 'Utilities' }, [LATE_FEES]: { number: '68100', name: 'Late Fees' } });
    expect(checkOwnBills(data, { bills: null, ledger: null }).bills[0].status).toBe('waiting');

    await call(pg, 'gl_netsuite_bills_apply', {
      rows: [nsBill('8901', '88213-10', '2026-10-20', RIVERBEND, '1296.83', [
        expense('1', UTILITIES, '1284.33', 'Electric service, Sep 18 to Oct 17'),
        expense('2', LATE_FEES, '12.50', 'Late payment charge'),
      ])],
    });
    await gl(pg, '8901', '2026-10-20', [['0', PAYABLE, -129683, null], ['1', UTILITIES, 128433, OFALLON], ['2', LATE_FEES, 1250, OFALLON]]);
    data = await billPairs(pg, '8901');
    expect(checkOwnBills(data, SINCE()).bills[0]).toMatchObject({ status: 'matches', fleetsuiteCents: 129683, netsuiteCents: 129683 });
  });

  it("gives a vendor's earlier bills newest first, with what Snap a bill suggests from", async () => {
    await call(pg, 'gl_netsuite_bills_apply', {
      rows: [
        nsBill('8911', 'RB-0920', '2026-09-20', RIVERBEND, '1180.00', [
          expense('1', UTILITIES, '1172.10', 'Electric service, Aug 18 to Sep 17'),
          expense('2', SALES_TAX, '7.90', 'Sales tax', true),
        ]),
        // NetSuite's ids are numbers: 10001 is the later of two bills the same day.
        nsBill('10001', 'RB-0920b', '2026-09-20', RIVERBEND, '64.00', [expense('1', UTILITIES, '64.00', 'Pole light')]),
        nsBill('8912', 'RB-0820', '2026-08-20', RIVERBEND, '1250.00', [
          { line_id: '1', item: RACK, account: RECEIVED, amount: '-50.00', own_amount: '-50.00', quantity: '1', memo: null, tax: false },
          expense('2', UTILITIES, '1200.00', 'Electric service'),
        ]),
        nsBill('8917', 'RB-0720', '2026-07-20', RIVERBEND, '1105.12', null),
        nsBill('8920', '', '2026-05-20', RIVERBEND, '75.00', [expense('1', UTILITIES, '75.00', 'Meter fee')]),
        nsBill('8913', '88213 10', '2025-10-20', RIVERBEND, '1296.83', [expense('1', UTILITIES, '1296.83', 'Electric service')]),
        // Left out: a voided bill, a bill credit, one NetSuite no longer has, and another vendor's with the same number.
        nsBill('8914', 'RB-1021', '2026-10-21', RIVERBEND, '1296.83', [expense('1', UTILITIES, '1296.83', null)], { voided: true }),
        nsBill('8915', '88213-10', '2026-10-01', RIVERBEND, '40.00', [expense('1', UTILITIES, '40.00', 'Outage credit')], { tran_type: 'VendCred' }),
        nsBill('8918', '88213-10', '2026-06-20', RIVERBEND, '980.00', [expense('1', UTILITIES, '980.00', null)]),
        nsBill('8919', '88213-10', '2026-10-19', WATER, '61.20', [expense('1', UTILITIES, '61.20', 'Water')]),
      ],
    });
    await pg.exec(`RESET ROLE; UPDATE gl_netsuite_bills SET gone_at = now() WHERE netsuite_id = '8918'; SET ROLE service_role`);
    await gl(pg, '8911', '2026-09-20', [['0', PAYABLE, -118000, null], ['1', UTILITIES, 117210, OFALLON], ['2', SALES_TAX, 790, OFALLON]]);
    await gl(pg, '10001', '2026-09-20', [['0', PAYABLE, -6400, null], ['1', UTILITIES, 6400, SOCIAL_CIRCLE]], '1084');

    const h = await history(pg, RIVERBEND[0], '88213-10');
    expect(h.bills.map((b) => [b.netsuite_id, b.number, b.date, b.total])).toEqual([
      ['8901', '88213-10', '2026-10-20', '1296.83'],
      ['10001', 'RB-0920b', '2026-09-20', '64.00'],
      ['8911', 'RB-0920', '2026-09-20', '1180.00'],
      ['8912', 'RB-0820', '2026-08-20', '1250.00'],
      ['8917', 'RB-0720', '2026-07-20', '1105.12'],
      ['8920', null, '2026-05-20', '75.00'],
      ['8913', '88213 10', '2025-10-20', '1296.83'],
    ]);
    const bill = (id: string) => h.bills.find((b) => b.netsuite_id === id) as HistoryBill;
    // Expense lines only: the tax line and the item line are left out.
    expect(bill('8911')).toEqual({
      netsuite_id: '8911', number: 'RB-0920', date: '2026-09-20', total: '1180.00',
      lines: [{ account: UTILITIES, memo: 'Electric service, Aug 18 to Sep 17', amount: '-1172.10' }],
      lines_known: true, companies: ['BMG'], locations: [OFALLON],
    });
    expect(bill('8912').lines).toEqual([{ account: UTILITIES, memo: 'Electric service', amount: '-1200.00' }]);
    expect(bill('10001')).toMatchObject({ companies: ['1084'], locations: [SOCIAL_CIRCLE] });
    expect(bill('8901')).toMatchObject({ companies: ['BMG'], locations: [OFALLON] });
    // Before the copy could read a bill's lines, or the copy of the general ledger has it, neither is known.
    expect(bill('8917')).toMatchObject({ lines: [], lines_known: false, companies: [], locations: [] });

    // Theirs with the same number in letters and digits, whatever its date, newest first.
    expect(h.same_number).toEqual([
      { netsuite_id: '8901', number: '88213-10', date: '2026-10-20', total: '1296.83' },
      { netsuite_id: '8913', number: '88213 10', date: '2025-10-20', total: '1296.83' },
    ]);
    expect((await history(pg, RIVERBEND[0], ' 8821310 ')).same_number.map((b) => b.netsuite_id)).toEqual(['8901', '8913']);
    expect((await history(pg, RIVERBEND[0], 'rb 0920B')).same_number.map((b) => b.netsuite_id)).toEqual(['10001']);
    // No number matches nothing, not their bills without one.
    for (const number of [null, '', ' - ', 'RB-0921']) {
      expect((await history(pg, RIVERBEND[0], number)).same_number, String(number)).toEqual([]);
    }

    // At most p_limit of the latest bills, and at least one; the same number is looked for in all of them.
    const two = await history(pg, RIVERBEND[0], '88213-10', 2);
    expect(two.bills.map((b) => b.netsuite_id)).toEqual(['8901', '10001']);
    expect(two.same_number.map((b) => b.netsuite_id)).toEqual(['8901', '8913']);
    expect((await history(pg, RIVERBEND[0], null, 0)).bills.map((b) => b.netsuite_id)).toEqual(['8901']);
    expect((await history(pg, RIVERBEND[0], null, null)).bills).toHaveLength(7);
    expect(await history(pg, '999')).toEqual({ bills: [], same_number: [] });

    // What Snap a bill makes of it.
    expect(usualAccount(h.bills)).toEqual({ accountId: UTILITIES, bills: 6, of: 6 });
    expect(usualCompany(h.bills)).toBe('BMG');
    const bmg = { id: 'bmg', code: 'BMG', name: 'BMG', subsidiaryId: '2', locations: [{ id: OFALLON, name: "O'Fallon" }, { id: '2', name: 'St. Charles' }] };
    expect(suggestLocation(bmg, h.bills, null).id).toBe(OFALLON);
  });
});
