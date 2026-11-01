import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ createInvoiceFromSO: vi.fn(), fulfillSalesOrderLines: vi.fn(), SO_STATUS: {} }));
vi.mock('@/lib/so-fulfill-invoice-read', () => ({ markDropShipLines: vi.fn(), readSoBillingLines: vi.fn() }));
vi.mock('@/lib/books/own-fulfillments', () => ({ saveOwnFulfillment: vi.fn() }));
vi.mock('@/lib/books/own-invoices', () => ({ saveOwnInvoice: vi.fn() }));
vi.mock('@/lib/portal-invoice-notify', () => ({ notifyPortalInvoice: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { createInvoiceFromSO } from '@/lib/netsuite';
import { markDropShipLines } from '@/lib/so-fulfill-invoice-read';
import { saveOwnInvoice } from '@/lib/books/own-invoices';
import { claimSalesOrder, runFulfillInvoice } from './so-fulfill-invoice-run';

/** A so_invoice_claims table in memory, enough for claimSalesOrder. */
function fakeClaims(rows: Record<string, string | null> = {}) {
  const from = () => ({
    insert: async (r: { so_netsuite_id: string; claimed_at: string }) => {
      if (r.so_netsuite_id in rows) return { error: { code: '23505', message: 'duplicate' } };
      rows[r.so_netsuite_id] = r.claimed_at;
      return { error: null };
    },
    update: (patch: { claimed_at: string | null }) => {
      let id = '';
      const q: any = {
        eq: (_c: string, v: string) => { id = v; return q; },
        or: (filter: string) => {
          const cutoff = filter.split('claimed_at.lt.')[1];
          q.ok = () => rows[id] == null || rows[id]! < cutoff;
          return q;
        },
        select: async () => {
          if (!(id in rows) || (q.ok && !q.ok())) return { data: [], error: null };
          rows[id] = patch.claimed_at;
          return { data: [{ so_netsuite_id: id }], error: null };
        },
        then: (resolve: (v: unknown) => void) => { if (id in rows) rows[id] = patch.claimed_at; resolve({ error: null }); },
      };
      return q;
    },
  });
  return { supabase: { from } as any, rows };
}

describe('claimSalesOrder', () => {
  it('claims a sales order once, refuses a second press, and frees it on release', async () => {
    const { supabase, rows } = fakeClaims();
    const first = await claimSalesOrder(supabase, '1177');
    expect(first.ok).toBe(true);
    const second = await claimSalesOrder(supabase, '1177');
    expect(second).toMatchObject({ ok: false, status: 409 });
    if (first.ok) await first.release();
    expect(rows['1177']).toBeNull();
    expect((await claimSalesOrder(supabase, '1177')).ok).toBe(true);
  });

  it('takes over a claim older than 15 minutes', async () => {
    const { supabase } = fakeClaims({ '1177': new Date(Date.now() - 20 * 60_000).toISOString() });
    expect((await claimSalesOrder(supabase, '1177')).ok).toBe(true);
  });
});

describe('runFulfillInvoice', () => {
  const LABOR = {
    lineSeq: 1, lineId: '11', itemId: '56', itemNumber: 'LABOR', description: 'Install', itemType: 'Service',
    ordered: 1, fulfilled: 0, billed: 0, rate: 95, amount: 95, onHand: null, closed: false,
  };
  const run = async (invoice: { invoiceId: string; invoiceNumber: string }, books: { saved: boolean; reason?: string; taxWarning?: string }) => {
    vi.mocked(markDropShipLines).mockResolvedValue({
      status: 'B', soNumber: 'SO1177', customerName: 'Sample Fleet Co', customerNetsuiteId: '9001', poNumber: null, lines: [LABOR],
    });
    vi.mocked(createInvoiceFromSO).mockResolvedValue({ success: true, ...invoice } as any);
    vi.mocked(saveOwnInvoice).mockResolvedValue(books);
    return runFulfillInvoice({} as any, { soId: '1177', billNow: { 1: 1 }, actorId: 'user-1', estimate: null });
  };

  it("passes on billing's warning that an exempt customer's certificate has expired", async () => {
    const warning = "Sample Fleet Co's tax-exempt certificate expired 9/30/2026. Still billed tax exempt; get a new certificate on file.";
    const warned = await run({ invoiceId: '5001', invoiceNumber: 'INV2401' }, { saved: true, taxWarning: warning });
    expect(warned).toMatchObject({ status: 200, body: { success: true, invoiceNumber: 'INV2401', warning } });
    expect((await run({ invoiceId: '5001', invoiceNumber: 'INV2401' }, { saved: true })).body).not.toHaveProperty('warning');
    // With no invoice id there's no copy to warn from, only that the id is missing.
    expect((await run({ invoiceId: '', invoiceNumber: '' }, { saved: false, reason: "NetSuite didn't say which invoice it made" })).body.warning)
      .toBe('NetSuite did not return the invoice id — find the new invoice in NetSuite');
  });
});
