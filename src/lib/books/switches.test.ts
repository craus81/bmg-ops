import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SWITCHES, SWITCH_PIECES, isSwitchPiece, readSwitch, readSwitches, setSwitch, switchIsOn } from './switches';

type Row = { piece: string; is_on: boolean | null; changed_by: string | null; changed_at: string | null };

/** books_switches as the server reads it: a list, one row, and an upsert. */
function fakeService(opts: { rows?: Row[]; error?: string; throws?: boolean; upsertError?: string } = {}) {
  const upserts: unknown[][] = [];
  const result = () => (opts.error ? { data: null, error: { message: opts.error } } : { data: opts.rows ?? [], error: null });
  const service = {
    from: (table: string) => {
      if (opts.throws) throw new Error('network down');
      expect(table).toBe('books_switches');
      return {
        select: () => Object.assign(Promise.resolve(result()), {
          eq: (_column: string, piece: string) => ({
            maybeSingle: async () => (opts.error
              ? { data: null, error: { message: opts.error } }
              : { data: (opts.rows ?? []).find((r) => r.piece === piece) ?? null, error: null }),
          }),
        }),
        upsert: async (row: unknown, options: unknown) => {
          upserts.push([row, options]);
          return { error: opts.upsertError ? { message: opts.upsertError } : null };
        },
      };
    },
  };
  return { service: service as unknown as SupabaseClient, upserts };
}

const ON: Row = { piece: 'credit_memos', is_on: true, changed_by: 'p1', changed_at: '2026-12-31T15:00:00Z' };

describe('switches', () => {
  it('names each piece, where people find it, and only those', () => {
    expect(SWITCH_PIECES).toEqual([
      'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
      'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records', 'customer_payments',
      'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs',
    ]);
    expect(SWITCHES.credit_memos.where).toBe('Invoicing → Invoiced → Credit on an invoice');
    expect(SWITCHES.vendor_credits.where).toBe('More → Purchasing → Vendor Credits');
    expect(SWITCHES.card_charges.where).toBe('More → Money & Books → Card Charges');
    expect(SWITCHES.journal_entries.where).toBe('More → Money & Books → Journal Entries');
    expect(SWITCHES.inventory_transfers.where).toBe('More → Parts & Inventory → Inventory Transfers');
    expect(SWITCHES.invoice_fixes.where).toBe('Invoicing → Invoiced → Fix on an invoice');
    expect(SWITCHES.bill_fixes).toEqual({
      name: 'Fixing bills',
      what: "Admins with Parts Ordering fix a bill after it's made, its number, memo and due date, and while nothing on it is paid its date and lines, and FleetSuite makes the change in NetSuite and in its own copy for the books.",
      where: 'More → Purchasing → Fix a Bill, or Fix on Books → Own bills',
    });
    expect(SWITCHES.customer_vendor_details).toEqual({
      name: 'Customer and vendor details',
      what: "Anyone with Credit Applications changes a customer's terms and credit limit, and anyone with Payments a vendor's email, phone, terms, addresses and 1099 details, in FleetSuite, and FleetSuite makes the change in NetSuite.",
      where: 'More → Sales → Customer Terms, or Change on a customer; More → Money & Books → Vendor Details',
    });
    expect(SWITCHES.item_accounts).toEqual({
      name: 'Item accounts',
      what: "Anyone with Payments changes an item's income account, an inventory item's cost of goods sold and inventory asset accounts, and the expense account of one that's bought, in FleetSuite, and FleetSuite makes the change in NetSuite.",
      where: 'More → Money & Books → Item Accounts, or Change accounts on Books → Stock by item',
    });
    expect(SWITCHES.estimates_in_fleetsuite).toEqual({
      name: 'Estimates in FleetSuite only',
      what: "Estimates stay in FleetSuite: nobody pushes one to NetSuite any more, and NetSuite gets each job's sales order when it's made, as now. Until it's on, estimates push as they do today.",
      where: "An estimate's buttons, where Push to NetSuite as Estimate goes",
      turnOn: "Switch on Estimates in FleetSuite only? From now on nobody can push an estimate to NetSuite, and NetSuite gets each job's sales order when it's made.",
      turnOff: 'Switch off Estimates in FleetSuite only? Estimates can be pushed to NetSuite again, as before.',
    });
    expect(SWITCHES.fleetsuite_records).toEqual({
      name: "FleetSuite's record wins",
      what: "A change made in NetSuite to a customer's name, email, phone or billing address, a vendor's name, email or phone, or an item's number, display name, description, purchase price, vendor or labor hours, no longer comes into FleetSuite over what FleetSuite has: it's listed under Books → Changed in NetSuite, to keep FleetSuite's (sent on to NetSuite, but for an item's vendor and labor hours, which stay in FleetSuite) or take NetSuite's. Until it's on, NetSuite's changes come in as they do today.",
      where: 'The NetSuite customer, vendor and parts syncs, and Books → Changed in NetSuite',
      turnOn: "Switch on FleetSuite's record wins? From now on a change made in NetSuite to a customer's or vendor's name, email, phone or address, or to an item's number, names, description, purchase price, vendor or labor hours, doesn't come into FleetSuite by itself: it's listed under Books → Changed in NetSuite.",
      turnOff: "Switch off FleetSuite's record wins? NetSuite's changes come into FleetSuite again as before, over what FleetSuite has.",
    });
    expect(SWITCHES.customer_payments).toEqual({
      name: 'Receiving payments',
      what: "Anyone with Invoicing receives a customer's check or ACH payment in FleetSuite and puts it on that customer's open invoices, and FleetSuite makes the payment in NetSuite, in Undeposited Funds, and keeps its own copy for the books.",
      where: 'Invoicing → Invoiced → Payment on an open invoice',
      later: 'Stays off on January 1: receiving payments moves into FleetSuite during 2027.',
    });
    expect(SWITCHES.customer_deposits).toEqual({
      name: 'Taking deposits',
      what: "Anyone with Invoicing takes a customer's check or ACH deposit on a sales order in FleetSuite, and FleetSuite makes the customer deposit in NetSuite on that order, in Undeposited Funds, and keeps its own copy for the books. NetSuite puts it on the order's invoice when the order's billed.",
      where: 'Deposit on a sales order, or on an estimate once it has its sales order',
      later: 'Stays off on January 1: taking deposits moves into FleetSuite during 2027.',
    });
    expect(SWITCHES.bank_deposits).toEqual({
      name: 'Bank deposits',
      what: "Anyone with Invoicing deposits the customer payments and deposits waiting in Undeposited Funds to one of the company's bank accounts in FleetSuite, ticked from what NetSuite has waiting, and FleetSuite makes the bank deposit in NetSuite and keeps its own copy for the books.",
      where: 'Invoicing → Invoiced → Bank deposit',
      later: 'Stays off on January 1: bank deposits move into FleetSuite during 2027.',
    });
    expect(SWITCHES.vendor_payments).toEqual({
      name: 'Paying vendors',
      what: "Anyone with Payments pays a company's open bills in a payment run, ticked from what NetSuite has open, by check or ACH from one of its bank accounts, and asks for approval; a super admin who didn't ask approves it, and FleetSuite makes each vendor's bill payment in NetSuite and keeps its own copy for the books. Checks print on BMG's check stock from the run, each number set in NetSuite, and ACH payments are paid from a file made for First Bank from the run.",
      where: 'More → Money & Books → Pay Vendors',
      later: 'Stays off on January 1: paying vendors moves into FleetSuite during 2027.',
    });
    expect(SWITCHES.adjustment_approvals).toEqual({
      name: 'Approving adjustments',
      what: "An inventory adjustment made with Adjust waits for approval: a super admin who didn't ask approves it, and FleetSuite makes it in NetSuite as an Inventory Adjustment, or turns it down saying why. Until it's on, an adjustment goes to NetSuite at once, as today.",
      where: "Adjust on the Inventory page or a part's details, and Adjustments to approve on the Inventory page",
      turnOn: "Switch on Approving adjustments? From now on an adjustment made with Adjust goes to NetSuite only once a super admin who didn't ask approves it.",
      turnOff: "Switch off Approving adjustments? Adjustments go to NetSuite at once again, as before. Ones already waiting can still be approved or turned down.",
      later: 'Stays off on January 1: the plan adds approving adjustments during 2027, from April.',
    });
    expect(SWITCHES.own_numbers).toEqual({
      name: "FleetSuite's own numbers",
      what: "Each sales order, PO, invoice and credit memo FleetSuite makes in NetSuite gets FleetSuite's next number of its kind, from Books → Own numbers, and NetSuite keeps it as the document's number. Until it's on, NetSuite numbers them as it does today.",
      where: 'Every sales order, PO, invoice and credit memo FleetSuite makes, and Books → Own numbers',
      turnOn: "Switch on FleetSuite's own numbers? First tick Allow Override for Sales Order, Purchase Order, Invoice and Credit Memo in NetSuite (Setup → Company → Auto-Generated Numbers), or NetSuite keeps its own numbers. From now on each one FleetSuite makes gets FleetSuite's next number.",
      turnOff: "Switch off FleetSuite's own numbers? NetSuite numbers what FleetSuite makes again, as before. The numbers FleetSuite already gave stay on their documents.",
      later: "Stays off on January 1: FleetSuite's own numbers start in the second quarter of 2027.",
    });
    expect(SWITCHES.invoice_pdfs).toEqual({
      name: 'Invoice PDFs',
      what: "Each invoice FleetSuite makes gets FleetSuite's own PDF of it attached in NetSuite, once FleetSuite's copy matches NetSuite's invoice, and each invoice's page in Books says whether NetSuite has it. Until it's on, FleetSuite sends no PDF, and Books still opens FleetSuite's PDF of each invoice.",
      where: 'Books → Own invoices, on each invoice',
      turnOn: "Switch on Invoice PDFs? First upload the newest PDF script (scripts/netsuite-pdf-restlet.js) in NetSuite and save its script record, or NetSuite can't take the PDFs. From now on each invoice FleetSuite makes gets FleetSuite's own PDF attached in NetSuite once FleetSuite's copy matches it.",
      turnOff: "Switch off Invoice PDFs? FleetSuite stops sending its PDFs to NetSuite. The ones already attached stay on their invoices.",
      later: "Stays off on January 1: FleetSuite's invoice PDFs go to NetSuite from the second quarter of 2027, with FleetSuite's own numbers.",
    });
    // Only receiving payments, taking deposits, bank deposits, paying vendors, approving adjustments, own numbers and
    // invoice PDFs wait past January 1.
    expect(SWITCH_PIECES.filter((p) => SWITCHES[p].later !== undefined))
      .toEqual(['customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs']);
    // Only the pieces that are the other way round, or need a step in NetSuite first, ask in their own words.
    expect(SWITCH_PIECES.filter((p) => SWITCHES[p].turnOn !== undefined || SWITCHES[p].turnOff !== undefined))
      .toEqual(['estimates_in_fleetsuite', 'fleetsuite_records', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs']);
    expect(isSwitchPiece('credit_memos')).toBe(true);
    expect(isSwitchPiece('vendor_credits')).toBe(true);
    expect(isSwitchPiece('card_charges')).toBe(true);
    expect(isSwitchPiece('journal_entries')).toBe(true);
    expect(isSwitchPiece('inventory_transfers')).toBe(true);
    expect(isSwitchPiece('invoice_fixes')).toBe(true);
    expect(isSwitchPiece('bill_fixes')).toBe(true);
    expect(isSwitchPiece('customer_vendor_details')).toBe(true);
    expect(isSwitchPiece('item_accounts')).toBe(true);
    expect(isSwitchPiece('estimates_in_fleetsuite')).toBe(true);
    expect(isSwitchPiece('fleetsuite_records')).toBe(true);
    expect(isSwitchPiece('customer_payments')).toBe(true);
    expect(isSwitchPiece('customer_deposits')).toBe(true);
    expect(isSwitchPiece('bank_deposits')).toBe(true);
    expect(isSwitchPiece('vendor_payments')).toBe(true);
    expect(isSwitchPiece('adjustment_approvals')).toBe(true);
    expect(isSwitchPiece('own_numbers')).toBe(true);
    expect(isSwitchPiece('invoice_pdfs')).toBe(true);
    expect(isSwitchPiece('payroll')).toBe(false);
    expect(isSwitchPiece('toString')).toBe(false);
    expect(isSwitchPiece(null)).toBe(false);
  });

  it('reads every switch, off where its row is missing', async () => {
    expect(await readSwitches(fakeService({ rows: [ON] }).service)).toEqual([
      { piece: 'credit_memos', on: true, changedBy: 'p1', changedAt: '2026-12-31T15:00:00Z' },
      { piece: 'vendor_credits', on: false, changedBy: null, changedAt: null },
      { piece: 'card_charges', on: false, changedBy: null, changedAt: null },
      { piece: 'journal_entries', on: false, changedBy: null, changedAt: null },
      { piece: 'inventory_transfers', on: false, changedBy: null, changedAt: null },
      { piece: 'invoice_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'bill_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_vendor_details', on: false, changedBy: null, changedAt: null },
      { piece: 'item_accounts', on: false, changedBy: null, changedAt: null },
      { piece: 'estimates_in_fleetsuite', on: false, changedBy: null, changedAt: null },
      { piece: 'fleetsuite_records', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_payments', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_deposits', on: false, changedBy: null, changedAt: null },
      { piece: 'bank_deposits', on: false, changedBy: null, changedAt: null },
      { piece: 'vendor_payments', on: false, changedBy: null, changedAt: null },
      { piece: 'adjustment_approvals', on: false, changedBy: null, changedAt: null },
      { piece: 'own_numbers', on: false, changedBy: null, changedAt: null },
      { piece: 'invoice_pdfs', on: false, changedBy: null, changedAt: null },
    ]);
    expect(await readSwitches(fakeService().service)).toEqual([
      { piece: 'credit_memos', on: false, changedBy: null, changedAt: null },
      { piece: 'vendor_credits', on: false, changedBy: null, changedAt: null },
      { piece: 'card_charges', on: false, changedBy: null, changedAt: null },
      { piece: 'journal_entries', on: false, changedBy: null, changedAt: null },
      { piece: 'inventory_transfers', on: false, changedBy: null, changedAt: null },
      { piece: 'invoice_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'bill_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_vendor_details', on: false, changedBy: null, changedAt: null },
      { piece: 'item_accounts', on: false, changedBy: null, changedAt: null },
      { piece: 'estimates_in_fleetsuite', on: false, changedBy: null, changedAt: null },
      { piece: 'fleetsuite_records', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_payments', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_deposits', on: false, changedBy: null, changedAt: null },
      { piece: 'bank_deposits', on: false, changedBy: null, changedAt: null },
      { piece: 'vendor_payments', on: false, changedBy: null, changedAt: null },
      { piece: 'adjustment_approvals', on: false, changedBy: null, changedAt: null },
      { piece: 'own_numbers', on: false, changedBy: null, changedAt: null },
      { piece: 'invoice_pdfs', on: false, changedBy: null, changedAt: null },
    ]);
    await expect(readSwitches(fakeService({ error: 'denied' }).service)).rejects.toThrow('denied');
  });

  it("counts a switch it can't read as off", async () => {
    expect(await switchIsOn(fakeService({ rows: [ON] }).service, 'credit_memos')).toBe(true);
    expect(await switchIsOn(fakeService({ rows: [ON] }).service, 'vendor_credits')).toBe(false);
    expect(await switchIsOn(fakeService({ rows: [{ ...ON, is_on: null }] }).service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService().service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService({ rows: [ON], error: 'denied' }).service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService({ throws: true }).service, 'credit_memos')).toBe(false);
  });

  it("reads one switch for a caller that mustn't take a failed read for off", async () => {
    expect(await readSwitch(fakeService({ rows: [ON] }).service, 'credit_memos')).toBe(true);
    expect(await readSwitch(fakeService({ rows: [ON] }).service, 'vendor_credits')).toBe(false);
    expect(await readSwitch(fakeService({ rows: [{ ...ON, is_on: null }] }).service, 'credit_memos')).toBe(false);
    await expect(readSwitch(fakeService({ rows: [ON], error: 'denied' }).service, 'credit_memos')).rejects.toThrow('denied');
    await expect(readSwitch(fakeService({ throws: true }).service, 'credit_memos')).rejects.toThrow('network down');
  });

  it('turns a switch on or off, saying who and what it was before', async () => {
    const { service, upserts } = fakeService();
    expect(await setSwitch(service, 'credit_memos', true, 'p1')).toEqual({ was: false });
    expect(upserts).toEqual([[
      { piece: 'credit_memos', is_on: true, changed_by: 'p1', changed_at: expect.any(String) },
      { onConflict: 'piece' },
    ]]);
    expect(await setSwitch(fakeService({ rows: [ON] }).service, 'credit_memos', false, 'p1')).toEqual({ was: true });
    await expect(setSwitch(fakeService({ upsertError: 'denied' }).service, 'credit_memos', true, 'p1')).rejects.toThrow('denied');
  });
});
