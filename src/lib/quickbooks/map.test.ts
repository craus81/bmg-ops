import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sanitizeQboPayload } from './sanitize';
import {
  childTableFor,
  documentsFor,
  isVoided,
  mapAccount,
  mapBill,
  mapBillPayment,
  mapCustomer,
  mapEntityRow,
  mapJournal,
  mapPayment,
  mapSalesDoc,
} from './map';

const RUN = '11111111-1111-4111-8111-111111111111';

describe('provenance', () => {
  it('keys every row as <Entity>/<Id> with the bare id alongside', () => {
    const { header } = mapAccount({ Id: '33', Name: 'Sales', SyncToken: '4', MetaData: { LastUpdatedTime: '2024-01-02T03:04:05Z' } }, { clean: true }, RUN);
    expect(header.external_id).toBe('Account/33');
    expect(header.external_ref).toBe('33');
    expect(header.sync_token).toBe('4');
    expect(header.source_updated_at).toBe('2024-01-02T03:04:05Z');
    expect(header.raw).toEqual({ clean: true });
    expect(header.import_run_id).toBe(RUN);
    expect(header.source).toBe('quickbooks');
  });

  it('NO mapper emits first_seen_at or last_synced_at', () => {
    // The column DEFAULT owns the first; upsertRows stamps the second on
    // every write. A mapper that set either would rewrite history.
    const samples = [
      mapAccount({ Id: '1', Name: 'A' }, {}, RUN),
      mapCustomer({ Id: '2', DisplayName: 'B' }, {}, RUN),
      mapSalesDoc('Invoice', { Id: '3', TxnDate: '2020-01-01', TotalAmt: 10 }, {}, RUN),
      mapBill('Bill', { Id: '4', TxnDate: '2020-01-01', TotalAmt: 10 }, {}, RUN),
      mapPayment({ Id: '5', TxnDate: '2020-01-01', TotalAmt: 10 }, {}, RUN),
      mapJournal('JournalEntry', { Id: '6', TxnDate: '2020-01-01' }, {}, RUN),
    ];
    for (const s of samples) {
      expect(Object.keys(s.header)).not.toContain('first_seen_at');
      expect(Object.keys(s.header)).not.toContain('last_synced_at');
    }
  });

  it('the source file never mentions those columns at all', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/quickbooks/map.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/first_seen_at|last_synced_at/);
  });
});

describe('accounts and entities', () => {
  it('lowercases the classification and keeps AcctNum as the chart number', () => {
    const { header } = mapAccount({ Id: '1', Name: 'Sales', AcctNum: '4000', Classification: 'Revenue', ParentRef: { value: '9' } }, {}, RUN);
    expect(header.classification).toBe('revenue');
    expect(header.account_number).toBe('4000');
    expect(header.parent_external_id).toBe('Account/9');
  });

  it('maps every reference entity to a snake_case entity_type', () => {
    const cases: [string, string][] = [
      ['Vendor', 'vendor'], ['Item', 'item'], ['Term', 'term'], ['PaymentMethod', 'payment_method'],
      ['TaxCode', 'tax_code'], ['TaxRate', 'tax_rate'], ['Class', 'class'], ['Department', 'department'],
      ['CompanyInfo', 'company_info'], ['Preferences', 'preferences'],
    ];
    for (const [entity, expected] of cases) {
      const mapped = mapEntityRow(entity, { Id: '1', Name: entity }, {}, RUN);
      expect(mapped?.table).toBe('ledger_entities');
      expect(mapped?.mapped.header.entity_type).toBe(expected);
    }
  });
});

describe('mapCustomer', () => {
  it('collapses a doubled display name into cleaned_name', () => {
    const { header } = mapCustomer({ Id: '7', DisplayName: 'Broadway Ford Broadway Ford' }, {}, RUN);
    expect(header.display_name).toBe('Broadway Ford Broadway Ford');
    expect(header.cleaned_name).toBe('Broadway Ford');
  });

  it('emits NO match column, so an upsert can never clobber a grade', () => {
    const { header } = mapCustomer({ Id: '7', DisplayName: 'Acme', ParentRef: { value: '3' }, Job: true }, {}, RUN);
    for (const col of ['match_status', 'customer_id', 'customer_netsuite_id', 'match_reason', 'candidates', 'matched_at', 'reviewed_by', 'reviewed_at']) {
      expect(Object.keys(header)).not.toContain(col);
    }
    expect(header.is_job).toBe(true);
    expect(header.parent_external_id).toBe('Customer/3');
  });

  it('is_job needs BOTH a parent and Job === true', () => {
    expect(mapCustomer({ Id: '1', DisplayName: 'A', ParentRef: { value: '2' } }, {}, RUN).header.is_job).toBe(false);
    expect(mapCustomer({ Id: '1', DisplayName: 'A', Job: true }, {}, RUN).header.is_job).toBe(false);
  });
});

describe('the voided heuristic', () => {
  it('[H] a voided invoice: TotalAmt 0 plus a PrivateNote saying so', () => {
    expect(isVoided({ TotalAmt: 0, PrivateNote: 'Voided' })).toBe(true);
  });

  it('[M] a voided Payment looks the same and is treated the same', () => {
    const { header } = mapPayment({ Id: '1', TxnDate: '2020-01-01', TotalAmt: 0, PrivateNote: 'Voided 3/4' }, {}, RUN);
    expect(header.voided).toBe(true);
  });

  it('TotalAmt 0 with no note is NOT voided — a zero-value document is real', () => {
    expect(isVoided({ TotalAmt: 0, PrivateNote: '' })).toBe(false);
    expect(isVoided({ TotalAmt: 0 })).toBe(false);
  });

  it('a paid-in-full invoice (Balance 0, TotalAmt > 0) is NOT voided', () => {
    const { header } = mapSalesDoc('Invoice', { Id: '1', TxnDate: '2020-01-01', TotalAmt: 900, Balance: 0 }, {}, RUN);
    expect(header.voided).toBe(false);
    expect(header.paid).toBe(true);
  });
});

describe('mapSalesDoc', () => {
  const INVOICE = {
    Id: '101',
    DocNumber: '1042',
    TxnDate: '2019-06-01',
    DueDate: '2019-07-01',
    CustomerRef: { value: '7', name: 'Broadway Ford' },
    TotalAmt: 1500,
    Balance: 500,
    CustomerMemo: { value: 'thanks' },
    CustomField: [{ Name: 'P.O. Number', StringValue: 'PO-77' }],
    LinkedTxn: [{ TxnId: '9', TxnType: 'Payment' }],
    TxnTaxDetail: { TotalTax: 100, TaxLine: [{ Amount: 100, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '3' } } }] },
    Line: [
      { Id: '1', LineNum: 1, Amount: 1400, Description: 'Shelving', DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '55', name: 'SHELF' }, Qty: 2, UnitPrice: 700 } },
      { Id: '2', Amount: 1400, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
    ],
  };

  it('carries the header amounts as positive magnitudes with balance as reported', () => {
    // `clean` is the SANITIZED payload, exactly as the importer hands it
    // over — the header's copied-whole JSONB columns are sourced from it.
    const { header } = mapSalesDoc('Invoice', INVOICE, sanitizeQboPayload('Invoice', INVOICE).clean, RUN);
    expect(header.doc_type).toBe('invoice');
    expect(header.total).toBe(1500);
    expect(header.balance).toBe(500);
    expect(header.paid).toBe(false);
    expect(header.tax_total).toBe(100);
    expect(header.po_number).toBe('PO-77');
    expect(header.party_external_id).toBe('Customer/7');
    expect(header.linked_txns).toEqual([{ TxnId: '9', TxnType: 'Payment' }]);
  });

  it('balance is NULL when the source reported none — never a copied total', () => {
    const { header } = mapSalesDoc('Estimate', { Id: '5', TxnDate: '2019-01-01', TotalAmt: 400 }, {}, RUN);
    expect(header.balance).toBeNull();
    // paid is only meaningful for an invoice.
    expect(header.paid).toBeNull();
  });

  it('a CreditMemo reports RemainingCredit, not Balance', () => {
    const { header } = mapSalesDoc('CreditMemo', { Id: '6', TxnDate: '2019-01-01', TotalAmt: 200, RemainingCredit: 50, Balance: 999 }, {}, RUN);
    expect(header.doc_type).toBe('credit_memo');
    expect(header.balance).toBe(50);
  });

  it('classifies lines by DetailType and appends tax lines under tax:<i>', () => {
    const { lines } = mapSalesDoc('Invoice', INVOICE, {}, RUN);
    expect(lines?.map(l => l.line_kind)).toEqual(['item', 'subtotal', 'tax']);
    expect(lines?.[0].item_external_id).toBe('Item/55');
    expect(lines?.[0].unit_price).toBe(700);
    expect(lines?.[2].line_external_id).toBe('tax:0');
  });

  it('maps the other three sales types', () => {
    expect(mapSalesDoc('SalesReceipt', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN).header.doc_type).toBe('sales_receipt');
    expect(mapSalesDoc('RefundReceipt', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN).header.doc_type).toBe('refund_receipt');
    expect(mapSalesDoc('Estimate', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN).header.doc_type).toBe('estimate');
  });
});

describe('payments and applications', () => {
  it('a customer payment is direction in / party customer with applications', () => {
    const { header, applications } = mapPayment({
      Id: '9', TxnDate: '2019-07-02', TotalAmt: 500, UnappliedAmt: 0,
      CustomerRef: { value: '7', name: 'Broadway Ford' },
      PaymentMethodRef: { name: 'Check' }, PaymentRefNum: 'CHK-1',
      DepositToAccountRef: { value: '12' },
      Line: [{ Amount: 500, LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice' }] }],
    }, {}, RUN);
    expect(header.direction).toBe('in');
    expect(header.party_kind).toBe('customer');
    expect(header.payment_date).toBe('2019-07-02');
    expect(header.deposit_account_external_id).toBe('Account/12');
    expect(applications).toEqual([{
      applied_kind: 'invoice',
      applied_external_id: 'Invoice/101',
      amount: 500,
      applied_on: '2019-07-02',
      raw: { TxnId: '101', TxnType: 'Invoice' },
    }]);
  });

  it('a bill payment is direction out / party vendor, method from PayType', () => {
    const { header, applications } = mapBillPayment({
      Id: '10', TxnDate: '2019-08-01', TotalAmt: 300, PayType: 'Check',
      VendorRef: { value: '4', name: 'Masterack' },
      Line: [{ Amount: 300, LinkedTxn: [{ TxnId: '55', TxnType: 'Bill' }] }],
    }, {}, RUN);
    expect(header.direction).toBe('out');
    expect(header.party_kind).toBe('vendor');
    expect(header.method).toBe('Check');
    expect(applications?.[0].applied_kind).toBe('bill');
    expect(applications?.[0].applied_external_id).toBe('Bill/55');
  });

  it('de-duplicates two lines applied to the same target — the table is UNIQUE on it', () => {
    const { applications } = mapPayment({
      Id: '11', TxnDate: '2019-01-01', TotalAmt: 20,
      Line: [
        { Amount: 10, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] },
        { Amount: 10, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] },
      ],
    }, {}, RUN);
    expect(applications).toHaveLength(1);
  });
});

describe('purchase-side documents', () => {
  it('maps Bill, VendorCredit and the three Purchase payment types', () => {
    expect(mapBill('Bill', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN).header.doc_type).toBe('bill');
    expect(mapBill('VendorCredit', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN).header.doc_type).toBe('vendor_credit');
    expect(mapBill('Purchase', { Id: '1', TxnDate: '2020-01-01', PaymentType: 'Cash' }, {}, RUN).header.doc_type).toBe('expense');
    expect(mapBill('Purchase', { Id: '1', TxnDate: '2020-01-01', PaymentType: 'Check' }, {}, RUN).header.doc_type).toBe('check');
    expect(mapBill('Purchase', { Id: '1', TxnDate: '2020-01-01', PaymentType: 'CreditCard' }, {}, RUN).header.doc_type).toBe('card_charge');
  });

  it('classifies account- and item-based expense lines', () => {
    const { lines } = mapBill('Bill', {
      Id: '2', TxnDate: '2020-01-01', TotalAmt: 90, VendorRef: { value: '4', name: 'Masterack' },
      Line: [
        { Id: '1', Amount: 50, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '77' }, BillableStatus: 'Billable', CustomerRef: { value: '7' } } },
        { Id: '2', Amount: 40, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '55' }, Qty: 1, UnitPrice: 40 } },
      ],
    }, {}, RUN);
    expect(lines?.map(l => l.line_kind)).toEqual(['account', 'item']);
    expect(lines?.[0].account_external_id).toBe('Account/77');
    expect(lines?.[0].billable).toBe(true);
    expect(lines?.[0].customer_external_id).toBe('Customer/7');
    expect(lines?.[1].item_external_id).toBe('Item/55');
  });
});

describe('journal-side documents', () => {
  it('sums debits and credits from the posting type', () => {
    const { header, lines } = mapJournal('JournalEntry', {
      Id: '3', TxnDate: '2020-02-01',
      Line: [
        { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '1' } } },
        { Id: '2', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '2' } } },
      ],
    }, {}, RUN);
    expect(header.total_debit).toBe(100);
    expect(header.total_credit).toBe(100);
    expect(lines?.map(l => l.posting_type)).toEqual(['debit', 'credit']);
  });

  it('a deposit line carries the linked payment it deposited', () => {
    const { header, lines } = mapJournal('Deposit', {
      Id: '4', TxnDate: '2020-03-01', DepositToAccountRef: { value: '12' },
      Line: [{ Id: '1', Amount: 500, DetailType: 'DepositLineDetail', DepositLineDetail: {}, LinkedTxn: [{ TxnId: '9', TxnType: 'Payment' }] }],
    }, {}, RUN);
    expect(header.doc_type).toBe('deposit');
    expect(header.account_external_id).toBe('Account/12');
    expect(lines?.[0].linked_external_id).toBe('Payment/9');
  });
});

describe('documentsFor', () => {
  it('emits a pending pdf row for the six types QuickBooks renders', () => {
    for (const entity of ['Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo', 'RefundReceipt', 'Bill']) {
      const docs = documentsFor(entity, { Id: '5', DocNumber: '1042' }, RUN);
      expect(docs, entity).toHaveLength(1);
      expect(docs[0].external_id).toBe(`pdf:${entity}/5`);
      expect(docs[0].file_name).toBe(`${entity}_1042.pdf`);
      expect(docs[0].entity_type).toBe(entity);
      expect(docs[0].status).toBe('pending');
    }
  });

  it('emits NOTHING for the types with no PDF endpoint', () => {
    // A pending row that can never be satisfied is a permanent false backlog.
    for (const entity of ['Payment', 'BillPayment', 'Deposit', 'JournalEntry', 'Purchase', 'Transfer', 'Customer']) {
      expect(documentsFor(entity, { Id: '5' }, RUN), entity).toEqual([]);
    }
  });

  it('falls back to the id when there is no DocNumber', () => {
    expect(documentsFor('Invoice', { Id: '5' }, RUN)[0].file_name).toBe('Invoice_5.pdf');
  });
});

describe('mapAttachable', () => {
  it('hangs the attachment off its first ref and keeps the rest in raw', () => {
    const mapped = mapEntityRow('Attachable', {
      Id: '80', FileName: 'signed.pdf', ContentType: 'application/pdf', Size: 2048, Note: 'signed copy',
      AttachableRef: [
        { EntityRef: { type: 'Invoice', value: '101' }, IncludeOnSend: true },
        { EntityRef: { type: 'Invoice', value: '102' } },
      ],
    }, { kept: true }, RUN);
    expect(mapped?.table).toBe('ledger_documents');
    expect(mapped?.mapped.header.kind).toBe('attachment');
    expect(mapped?.mapped.header.entity_table).toBe('ledger_invoices');
    expect(mapped?.mapped.header.entity_external_id).toBe('Invoice/101');
    expect(mapped?.mapped.header.include_on_send).toBe(true);
    expect(mapped?.mapped.header.raw).toEqual({ kept: true });
  });

  it('an unattached attachment gets entity_table none rather than a guess', () => {
    const mapped = mapEntityRow('Attachable', { Id: '81', FileName: 'stray.pdf' }, {}, RUN);
    expect(mapped?.mapped.header.entity_table).toBe('none');
    expect(mapped?.mapped.header.entity_external_id).toBeNull();
  });
});

describe('mapEntityRow / childTableFor', () => {
  it('routes each entity to its ledger table', () => {
    expect(mapEntityRow('Invoice', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN)?.table).toBe('ledger_invoices');
    expect(mapEntityRow('Payment', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN)?.table).toBe('ledger_payments');
    expect(mapEntityRow('BillPayment', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN)?.table).toBe('ledger_payments');
    expect(mapEntityRow('Purchase', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN)?.table).toBe('ledger_bills');
    expect(mapEntityRow('Transfer', { Id: '1', TxnDate: '2020-01-01' }, {}, RUN)?.table).toBe('ledger_journal_entries');
    expect(mapEntityRow('Customer', { Id: '1', DisplayName: 'x' }, {}, RUN)?.table).toBe('ledger_customers');
  });

  it('returns null for an entity with no ledger home rather than throwing', () => {
    // An unexpected type becomes an event, not a crashed chunk.
    expect(mapEntityRow('Employee', { Id: '1' }, {}, RUN)).toBeNull();
  });

  it('names the child table and its parent column', () => {
    expect(childTableFor('ledger_invoices')).toEqual({ table: 'ledger_invoice_lines', parentCol: 'document_id' });
    expect(childTableFor('ledger_bills')).toEqual({ table: 'ledger_bill_lines', parentCol: 'document_id' });
    expect(childTableFor('ledger_journal_entries')).toEqual({ table: 'ledger_journal_lines', parentCol: 'entry_id' });
    expect(childTableFor('ledger_customers')).toBeNull();
  });
});

describe('child rows are sanitized too', () => {
  // The HEADER's raw is `clean` by construction. The children were the gap:
  // `ledger_invoice_lines.raw`, `ledger_bill_lines.raw`,
  // `ledger_journal_lines.raw` and `ledger_payment_applications.raw` carry
  // the same is_ledger_reader() SELECT policy as every other ledger table, so
  // a subtree copied straight off the wire would be readable by the whole
  // finance/admin/super_admin/executive tier.
  const CARD = /\d{13,19}/;

  it('an invoice LINE carrying an instrument object stores no card digits', () => {
    const row = {
      Id: '5', TxnDate: '2020-02-02', TotalAmt: 100,
      Line: [{
        Id: '1', Amount: 100, DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: '9' } },
        CreditCardPayment: { CreditChargeInfo: { Number: '4111111111111111', CcExpiryMonth: 11 } },
        CardNumber: '4242424242424242',
      }],
    };
    const mapped = mapSalesDoc('Invoice', row, { Id: '5' }, RUN);
    const lineRaw = JSON.stringify(mapped.lines?.[0].raw);
    expect(lineRaw).not.toMatch(CARD);
    expect(lineRaw).not.toMatch(/CreditCardPayment/);
    expect(lineRaw).not.toMatch(/CardNumber/);
    // …and the line itself still maps.
    expect(mapped.lines?.[0].amount).toBe(100);
  });

  it('a TAX line drops a bank field the same way', () => {
    const row = {
      Id: '6', TxnDate: '2020-02-02', TotalAmt: 100,
      TxnTaxDetail: { TaxLine: [{ Amount: 7, DetailType: 'TaxLineDetail', RoutingNumber: '021000021' }] },
    };
    const mapped = mapSalesDoc('Invoice', row, { Id: '6' }, RUN);
    expect(JSON.stringify(mapped.lines?.[0].raw)).not.toMatch(/RoutingNumber/);
  });

  it('a payment APPLICATION link is sanitized', () => {
    const row = {
      Id: '7', TxnDate: '2020-03-03', TotalAmt: 50,
      Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice', CardNumber: '4111111111111111' }] }],
    };
    const mapped = mapPayment(row, { Id: '7' }, RUN);
    const raw = JSON.stringify(mapped.applications?.[0].raw);
    expect(raw).not.toMatch(CARD);
    expect(mapped.applications?.[0].applied_external_id).toBe('Invoice/1');
  });

  it('a BILL line and a JOURNAL line are sanitized', () => {
    const bill = mapBill('Bill', {
      Id: '8', TxnDate: '2020-04-04', TotalAmt: 10,
      Line: [{ Amount: 10, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {}, BankAccount: { AcctNum: '000123456789' } }],
    }, { Id: '8' }, RUN);
    expect(JSON.stringify(bill.lines?.[0].raw)).not.toMatch(/BankAccount|\d{13,19}/);

    const journal = mapJournal('JournalEntry', {
      Id: '9', TxnDate: '2020-05-05',
      Line: [{ Amount: 10, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit' }, Cvv: '123', CardNumber: '4111111111111111' }],
    }, { Id: '9' }, RUN);
    expect(JSON.stringify(journal.lines?.[0].raw)).not.toMatch(/Cvv|CardNumber|\d{13,19}/);
  });

  // The HEADER's copied-whole JSONB columns were the other gap: bill_address,
  // ship_address and linked_txns on ledger_invoices, linked_txns on
  // ledger_bills. They are reader-visible columns on the two biggest money
  // tables, so they take the same intake rule as `raw` and the children —
  // sourced from `clean`, never from the wire payload.
  it('an INVOICE header copies bill_address / ship_address / linked_txns from the SANITIZED payload', () => {
    const row = {
      Id: '20', TxnDate: '2020-06-06', TotalAmt: 100,
      BillAddr: { Line1: '1 Main St', CardNumber: '4111111111111111' },
      ShipAddr: { Line1: '2 Side St', TaxIdentifier: '12-3456789' },
      LinkedTxn: [{ TxnId: '3', TxnType: 'Payment', CardNumber: '4242424242424242' }],
    };
    const { header } = mapSalesDoc('Invoice', row, sanitizeQboPayload('Invoice', row).clean, RUN);
    const json = JSON.stringify({
      bill: header.bill_address, ship: header.ship_address, linked: header.linked_txns,
    });
    expect(json).not.toMatch(CARD);
    expect(json).not.toMatch(/CardNumber|TaxIdentifier/);
    // …and the columns still carry what they are for.
    expect((header.bill_address as any).Line1).toBe('1 Main St');
    expect((header.ship_address as any).Line1).toBe('2 Side St');
    expect(header.linked_txns).toEqual([{ TxnId: '3', TxnType: 'Payment' }]);
  });

  it('a BILL header copies linked_txns from the SANITIZED payload', () => {
    const row = {
      Id: '21', TxnDate: '2020-07-07', TotalAmt: 40,
      VendorRef: { value: '4', name: 'Acme' },
      LinkedTxn: [{ TxnId: '9', TxnType: 'BillPayment', CardNumber: '4111111111111111' }],
    };
    const { header } = mapBill('Bill', row, sanitizeQboPayload('Bill', row).clean, RUN);
    expect(JSON.stringify(header.linked_txns)).not.toMatch(CARD);
    expect(header.linked_txns).toEqual([{ TxnId: '9', TxnType: 'BillPayment' }]);
  });
});
