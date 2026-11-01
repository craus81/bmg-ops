import { describe, it, expect, afterEach } from 'vitest';
import { deepLinks, allowedPdfSrc, vehicleLinkFor, cniJobLinkFor } from './deep-links';

// Per-visit deep links (Stage 8 close): a VIN-only pick-list URL resolves to
// the VIN's NEWEST visit, so links about an older visit must pin it.
describe('deepLinks.pickList / vehicleLinkFor', () => {
  it('pins the visit when a check-in id is provided', () => {
    expect(deepLinks.pickList('1FTBW3XM5PKA00001')).toBe('/vehicles/1FTBW3XM5PKA00001/pick-list');
    expect(deepLinks.pickList('1FTBW3XM5PKA00001', 'ci-123'))
      .toBe('/vehicles/1FTBW3XM5PKA00001/pick-list?visit=ci-123');
  });

  it('inboxThread opens the customer thread in the comms inbox', () => {
    expect(deepLinks.inboxThread('t-1')).toBe('/admin/inbox?thread=t-1');
  });

  // Invites and password resets are magic links: the session is only
  // exchanged in /auth/callback, so a redirectTo aimed straight at a page
  // delivers an unexchanged code and strands the recipient on /login.
  it('authCallback routes an auth redirect through the session exchange', () => {
    expect(deepLinks.authCallback('/home')).toBe('/auth/callback?next=%2Fhome');
    expect(deepLinks.authCallback('/cni/onboarding'))
      .toBe('/auth/callback?next=%2Fcni%2Fonboarding');
  });

  it('vehicleLinkFor carries the visit into the pick-list fallback', () => {
    // External installer: no in_shop/fleet_checkin feature → pick-list, pinned.
    expect(vehicleLinkFor(['installer'], 'ci-123', '1FTBW3XM5PKA00001'))
      .toBe('/vehicles/1FTBW3XM5PKA00001/pick-list?visit=ci-123');
    // Staff with the board feature keep the board link.
    expect(vehicleLinkFor(['admin'], 'ci-123', '1FTBW3XM5PKA00001'))
      .toBe('/tracking?vehicle=ci-123');
  });

  // R3-5: the CNI job chat serves two portals from different URLs — each
  // recipient's link must land in THEIR portal, never the sender's.
  it('cniJobLinkFor routes each recipient to their own portal', () => {
    expect(cniJobLinkFor(['admin'], 'job-1')).toBe('/admin/cni/jobs/job-1');
    expect(cniJobLinkFor(['super_admin'], 'job-1')).toBe('/admin/cni/jobs/job-1');
    expect(cniJobLinkFor(['installer'], 'job-1')).toBe('/installer/jobs/job-1');
    expect(cniJobLinkFor([], 'job-1')).toBe('/installer/jobs/job-1');
  });
});

// The PDF viewer wraps an attachment in app chrome so a "open in new tab"
// click isn't a dead end. Two things must hold: the link carries a real way
// back, and the viewer only ever frames our own files.

describe('deepLinks.pdfViewer', () => {
  it('carries the source, name and return path', () => {
    const url = deepLinks.pdfViewer('/api/gmail/attachment?messageId=abc', {
      name: 'PO 12345.pdf',
      back: deepLinks.poPendingReview('abc'),
      backLabel: 'PO import',
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('/pdf?')).toBe(true);
    expect(params.get('src')).toBe('/api/gmail/attachment?messageId=abc');
    expect(params.get('name')).toBe('PO 12345.pdf');
    expect(params.get('back')).toBe('/admin/pos?review=abc');
    expect(params.get('backLabel')).toBe('PO import');
  });

  it('omits the optional params rather than emitting empty ones', () => {
    expect(deepLinks.pdfViewer('/api/gmail/attachment?messageId=abc'))
      .toBe('/pdf?src=%2Fapi%2Fgmail%2Fattachment%3FmessageId%3Dabc');
  });
});

// Migration 314: imported ledger documents are served by an app route, not
// from R2's public domain — so the viewer must accept the builder's output.
describe('deepLinks.ledgerDocument', () => {
  it('points at the record-scoped bytes route', () => {
    expect(deepLinks.ledgerDocument('11111111-2222-3333-4444-555555555555'))
      .toBe('/api/ledger/documents/11111111-2222-3333-4444-555555555555');
  });

  it('is a src the PDF viewer will frame', () => {
    const src = deepLinks.ledgerDocument('11111111-2222-3333-4444-555555555555');
    expect(allowedPdfSrc(src, 'https://go.bmgfleet.com')).toBe(src);
    const url = deepLinks.pdfViewer(src, { name: 'Invoice 1042.pdf' });
    expect(new URLSearchParams(url.split('?')[1]).get('src')).toBe(src);
    expect(allowedPdfSrc(url, 'https://go.bmgfleet.com')).toBe(url);
  });
});

describe('deepLinks.ledgerAdmin', () => {
  it('is the bare page with no options', () => {
    expect(deepLinks.ledgerAdmin()).toBe('/admin/ledger');
  });

  it('emits ONLY the params it was given', () => {
    expect(deepLinks.ledgerAdmin({ tab: 'review' })).toBe('/admin/ledger?tab=review');
    expect(deepLinks.ledgerAdmin({ run: 'run-1' })).toBe('/admin/ledger?run=run-1');
    expect(deepLinks.ledgerAdmin({ qboAuth: 'success' })).toBe('/admin/ledger?qboAuth=success');
    expect(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'state_mismatch' }))
      .toBe('/admin/ledger?qboAuth=error&reason=state_mismatch');
  });

  it('drops a null run rather than emitting run=null', () => {
    expect(deepLinks.ledgerAdmin({ run: null, tab: 'import' })).toBe('/admin/ledger?tab=import');
  });
});

describe('deepLinks.ledgerCustomerReview', () => {
  it('lands on the queue, and on ONE row when an id is in scope', () => {
    // A notification about a specific customer must never link to the bare
    // list while the row id is known.
    expect(deepLinks.ledgerCustomerReview()).toBe('/admin/ledger?tab=review');
    expect(deepLinks.ledgerCustomerReview('lc-1')).toBe('/admin/ledger?tab=review&customer=lc-1');
  });
});

describe('allowedPdfSrc', () => {
  const ORIGIN = 'https://go.bmgfleet.com';
  const FILE_HOST = 'https://files.example.com';
  afterEach(() => { delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL; });

  it('allows same-origin paths and URLs', () => {
    expect(allowedPdfSrc('/api/gmail/attachment?messageId=abc', ORIGIN))
      .toBe('/api/gmail/attachment?messageId=abc');
    expect(allowedPdfSrc(`${ORIGIN}/api/gmail/attachment`, ORIGIN))
      .toBe(`${ORIGIN}/api/gmail/attachment`);
  });

  it('allows our public file host', () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL = FILE_HOST;
    expect(allowedPdfSrc(`${FILE_HOST}/po/123.pdf`, ORIGIN)).toBe(`${FILE_HOST}/po/123.pdf`);
  });

  it('refuses anything that would frame someone else in our chrome', () => {
    expect(allowedPdfSrc('//evil.example.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('https://evil.example.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('javascript:alert(1)', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('data:text/html,<h1>hi', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('http://go.bmgfleet.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc(null, ORIGIN)).toBe(null);
    expect(allowedPdfSrc('', ORIGIN)).toBe(null);
  });
});

// R7-4: the Usage tab is the landing for anything about client errors /
// slow routes / abandoned forms; the builder must carry the filter so a
// click lands on the row, not the tab.
describe('deepLinks.systemHealthUsage', () => {
  it('opens the usage tab with optional filters', () => {
    expect(deepLinks.systemHealthUsage()).toBe('/admin/system-health?tab=usage');
    expect(deepLinks.systemHealthUsage({ kind: 'error', page: '/vehicles/:vin' }))
      .toBe('/admin/system-health?tab=usage&kind=error&page=%2Fvehicles%2F%3Avin');
    expect(deepLinks.systemHealthUsage({ form: 'vehicle_checkin', days: 30 }))
      .toBe('/admin/system-health?tab=usage&form=vehicle_checkin&days=30');
  });
});

describe('deepLinks.estimate / newEstimate fromCustomer', () => {
  it('carries the customer record the builder returns to', () => {
    const url = deepLinks.estimate('est-1', { fromCustomer: 'ns-1234' });
    expect(new URLSearchParams(url.split('?')[1]).get('fromCustomer')).toBe('ns-1234');
    const fresh = deepLinks.newEstimate('cust-1', null, { fromCustomer: 'ns-1234' });
    const p = new URLSearchParams(fresh.split('?')[1]);
    expect(p.get('customer')).toBe('cust-1');
    expect(p.get('fromCustomer')).toBe('ns-1234');
  });

  it('leaves the plain links unchanged', () => {
    expect(deepLinks.estimate('est-1')).toBe('/estimates?id=est-1');
    expect(deepLinks.newEstimate('cust-1')).toBe('/estimates?new=1&customer=cust-1');
  });

  it('quote opens an estimate itself (back returns to its row); wrap quotes keep their list row', () => {
    expect(deepLinks.quote('estimate', 'est-1')).toBe('/estimates?id=est-1&from=quotes');
    expect(deepLinks.quote('wrap', 'wq-1')).toBe('/estimates?item=wrap-wq-1');
  });
});

describe('PO PDF file names', () => {
  it('names a PO by its number, however the number is written', () => {
    expect(deepLinks.poPdfFileName('PO452', '9876')).toBe('PO452.pdf');
    expect(deepLinks.poPdfFileName('452', '9876')).toBe('PO452.pdf');
    expect(deepLinks.poPdfFileName('PO #452', '9876')).toBe('PO452.pdf');
  });

  it('falls back to the internal id without a number', () => {
    expect(deepLinks.poPdfFileName(null, 9876)).toBe('PO-9876.pdf');
  });

  it('sends the file name to the PDF route', () => {
    expect(deepLinks.netsuitePdf('purchaseOrder', '9876', 'PO452.pdf'))
      .toBe('/api/netsuite/pdf?type=purchaseOrder&id=9876&format=pdf&name=PO452.pdf');
    expect(deepLinks.netsuitePdf('estimate', 12)).toBe('/api/netsuite/pdf?type=estimate&id=12&format=pdf');
  });
});

describe('Books agings links', () => {
  it("opens a company's customer or vendor agings, only those that differ when asked", () => {
    expect(deepLinks.booksAgings('BMG', 'customer')).toBe('/admin/books/agings?company=BMG&kind=customer');
    expect(deepLinks.booksAgings('1084', 'vendor', true)).toBe('/admin/books/agings?company=1084&kind=vendor&only=differs');
  });

  it("opens one customer's or vendor's open documents, 'none' for the lines FleetSuite can't name", () => {
    expect(deepLinks.booksAging('BMG', 'customer', 'c0000000-0000-4000-8000-00000000000a'))
      .toBe('/admin/books/agings/party?company=BMG&kind=customer&party=c0000000-0000-4000-8000-00000000000a');
    expect(deepLinks.booksAging('BMG', 'vendor', '')).toBe('/admin/books/agings/party?company=BMG&kind=vendor&party=none');
  });
});

describe('Credit memo links', () => {
  it("opens the credit memo screen on one NetSuite invoice, and Books' switches", () => {
    expect(deepLinks.creditMemo('7001')).toBe('/invoices/credit-memo?invoice=7001');
    expect(deepLinks.booksSwitches()).toBe('/admin/books/switches');
  });
});

describe('Invoice fix links', () => {
  it('opens the Fix screen on one NetSuite invoice', () => {
    expect(deepLinks.invoiceFix('7001')).toBe('/invoices/fix?invoice=7001');
  });
});

describe('Vendor credit links', () => {
  it('opens the vendor credit screen in Purchasing, or filled in to undo one NetSuite bill', () => {
    expect(deepLinks.vendorCredit()).toBe('/admin/purchasing/vendor-credit');
    expect(deepLinks.vendorCreditForBill('3001')).toBe('/admin/purchasing/vendor-credit?bill=3001');
  });
});

describe('Bill fix links', () => {
  it('opens the Fix a Bill screen, on one NetSuite bill when given one', () => {
    expect(deepLinks.billFix()).toBe('/admin/purchasing/bill-fix');
    expect(deepLinks.billFix(null)).toBe('/admin/purchasing/bill-fix');
    expect(deepLinks.billFix('')).toBe('/admin/purchasing/bill-fix');
    expect(deepLinks.billFix('3001')).toBe('/admin/purchasing/bill-fix?bill=3001');
  });
});

describe('Customer and vendor details links', () => {
  it('opens Customer Terms and Vendor Details, on one NetSuite customer or vendor when given one', () => {
    expect(deepLinks.customerTerms()).toBe('/admin/customer-terms');
    expect(deepLinks.customerTerms(null)).toBe('/admin/customer-terms');
    expect(deepLinks.customerTerms('')).toBe('/admin/customer-terms');
    expect(deepLinks.customerTerms('4410')).toBe('/admin/customer-terms?customer=4410');
    expect(deepLinks.vendorDetails()).toBe('/admin/vendor-details');
    expect(deepLinks.vendorDetails(null)).toBe('/admin/vendor-details');
    expect(deepLinks.vendorDetails('')).toBe('/admin/vendor-details');
    expect(deepLinks.vendorDetails('2207')).toBe('/admin/vendor-details?vendor=2207');
  });
});

describe('Item accounts links', () => {
  it('opens Item Accounts, on one NetSuite item when given one', () => {
    expect(deepLinks.itemAccounts()).toBe('/admin/item-accounts');
    expect(deepLinks.itemAccounts(null)).toBe('/admin/item-accounts');
    expect(deepLinks.itemAccounts('')).toBe('/admin/item-accounts');
    expect(deepLinks.itemAccounts('501')).toBe('/admin/item-accounts?item=501');
    expect(deepLinks.itemAccounts('5 01&x=1')).toBe('/admin/item-accounts?item=5+01%26x%3D1');
  });
});

describe('Card charge links', () => {
  it('opens the card charges screen', () => {
    expect(deepLinks.cardCharges()).toBe('/admin/card-charges');
  });
});

describe('Journal entry links', () => {
  it('opens the journal entries screen, or one entry on it', () => {
    expect(deepLinks.journalEntries()).toBe('/admin/journal-entries');
    expect(deepLinks.journalEntries(null)).toBe('/admin/journal-entries');
    expect(deepLinks.journalEntries('c0000000-0000-4000-8000-000000000001')).toBe('/admin/journal-entries?id=c0000000-0000-4000-8000-000000000001');
  });
});

describe('Pay vendors links', () => {
  it('opens the payment runs, or one run', () => {
    expect(deepLinks.payVendors()).toBe('/admin/pay-vendors');
    expect(deepLinks.payVendors(null)).toBe('/admin/pay-vendors');
    expect(deepLinks.payVendors('a0000000-0000-4000-8000-000000000057')).toBe('/admin/pay-vendors?run=a0000000-0000-4000-8000-000000000057');
  });

  it("opens a vendor's bank numbers", () => {
    expect(deepLinks.vendorBank('31')).toBe('/admin/pay-vendors?bank=31');
  });
});

describe('Inventory transfer links', () => {
  it('opens the inventory transfers screen, or one transfer on it', () => {
    expect(deepLinks.inventoryTransfers()).toBe('/admin/inventory-transfers');
    expect(deepLinks.inventoryTransfers(null)).toBe('/admin/inventory-transfers');
    expect(deepLinks.inventoryTransfers('f0000000-0000-4000-8000-000000000001')).toBe('/admin/inventory-transfers?id=f0000000-0000-4000-8000-000000000001');
  });
});

describe('Books 1099s links', () => {
  it("opens one company's year of 1099 totals", () => {
    expect(deepLinks.books1099s('BMG', 2025)).toBe('/admin/books/1099s?company=BMG&year=2025');
    expect(deepLinks.books1099s('1084', '2026')).toBe('/admin/books/1099s?company=1084&year=2026');
  });
});
