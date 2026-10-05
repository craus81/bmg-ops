import { describe, it, expect, vi } from 'vitest';

// The module imports notify (module-scope clients) and netsuite; only the
// pure match + wording helpers are under test here.
vi.mock('@/lib/notify', () => ({ notifyMany: vi.fn() }));
vi.mock('@/lib/netsuite', () => ({ getNetSuitePdf: vi.fn(), suiteqlQuery: vi.fn() }));

import { matchPortalCustomer, buildPortalInvoiceMessage, type PortalCustomer } from './portal-invoice-notify';
import { getNotificationType, channelsForType } from './notification-registry';

const bodewell: PortalCustomer = { id: 'c1', company_name: 'Bodewell', netsuite_id: '4521', portal_invoice_contact_ids: ['u1'] };

describe('matchPortalCustomer', () => {
  it('matches on the NetSuite customer id, number or string', () => {
    expect(matchPortalCustomer('4521', null, [bodewell])).toBe(bodewell);
    expect(matchPortalCustomer(4521, null, [bodewell])).toBe(bodewell);
  });

  it('matches a sub-customer through its parent', () => {
    expect(matchPortalCustomer('9999', '4521', [bodewell])).toBe(bodewell);
  });

  it('ignores other customers and blanks', () => {
    expect(matchPortalCustomer('9999', null, [bodewell])).toBeNull();
    expect(matchPortalCustomer(null, '', [bodewell])).toBeNull();
    expect(matchPortalCustomer('4521', null, [{ ...bodewell, netsuite_id: null }])).toBeNull();
  });
});

describe('buildPortalInvoiceMessage', () => {
  it('names the invoice, customer, amount, PO and who made it', () => {
    const m = buildPortalInvoiceMessage({
      customerName: 'Bodewell', invoiceNumber: 'INV1234', amount: 1250.5, poNumber: 'PO-77',
      source: 'the Scan Log', detail: '2 vehicles', actorName: 'Jessie Whittington',
    });
    expect(m.title).toBe("Enter invoice INV1234 in Bodewell's portal");
    expect(m.body).toContain('Jessie Whittington created invoice INV1234 for Bodewell from the Scan Log.');
    expect(m.body).toContain('$1,250.50 · PO PO-77 · 2 vehicles.');
  });

  it('leaves out facts it does not have', () => {
    const m = buildPortalInvoiceMessage({ customerName: 'Bodewell', invoiceNumber: 'INV1', source: 'a PO' });
    expect(m.body).toBe("Someone created invoice INV1 for Bodewell from a PO. Bodewell only pays invoices entered in their portal.");
  });
});

describe('portal_invoice_entry registry entry', () => {
  it('always goes out on every channel, email immediately', () => {
    const def = getNotificationType('portal_invoice_entry')!;
    expect(def.alwaysOn).toBeTruthy();
    expect(def.emailNow).toBe(true);
    expect(channelsForType('portal_invoice_entry', { notify_in_app: false, notify_email: false }))
      .toEqual(['in_app', 'push', 'email']);
  });
});
