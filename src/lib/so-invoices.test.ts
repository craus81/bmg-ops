import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({
  suiteqlQueryAll: vi.fn(),
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
}));

import { suiteqlQueryAll } from '@/lib/netsuite';
import {
  findSoInvoices,
  isFullyBilledSoStatus,
  isoDay,
  resetSoInvoiceLadder,
  stampVehicleInvoice,
  syncVehicleInvoices,
} from './so-invoices';

const query = vi.mocked(suiteqlQueryAll);

function nsError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  query.mockReset();
  resetSoInvoiceLadder();
});

describe('isFullyBilledSoStatus', () => {
  it('accepts Billed and Closed in any shape NetSuite returns', () => {
    for (const s of ['G', 'H', 'SalesOrd:G', 'Billed', 'closed']) expect(isFullyBilledSoStatus(s)).toBe(true);
  });
  it('rejects partly billed and open states', () => {
    for (const s of ['F', 'E', 'SalesOrd:F', 'Pending Billing', 'Pending Billing/Partially Fulfilled', '', null, undefined]) {
      expect(isFullyBilledSoStatus(s)).toBe(false);
    }
  });
});

describe('isoDay', () => {
  it('reads NetSuite M/D/YYYY and ISO dates', () => {
    expect(isoDay('9/3/2026')).toBe('2026-09-03');
    expect(isoDay('2026-09-03T00:00:00Z')).toBe('2026-09-03');
    expect(isoDay('garbage')).toBeNull();
  });
});

describe('findSoInvoices', () => {
  it('reads the link table first, groups by SO and dedupes per-line rows', async () => {
    query.mockResolvedValueOnce([
      { so_id: '11', id: '901', tranid: 'INV1001', trandate: '9/20/2026', total: '100', status: 'A', so_status: 'G' },
      { so_id: '11', id: '901', tranid: 'INV1001', trandate: '9/20/2026', total: '100', status: 'A', so_status: 'G' },
      { so_id: '11', id: '900', tranid: 'INV0999', trandate: '9/18/2026', total: '50', status: 'B', so_status: 'G' },
    ]);
    const r = await findSoInvoices(['11', '12']);
    expect(r.via).toBe('nexttransactionlinelink');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FROM nexttransactionlinelink l');
    expect(query.mock.calls[0][0]).not.toContain('createdfrom');
    expect(r.invoices.get('11')!.map(i => i.tranid)).toEqual(['INV0999', 'INV1001']);
    expect(r.invoices.get('12')).toEqual([]);
    expect(r.soStatus.get('11')).toBe('G');
  });

  it('skips voided invoices', async () => {
    query.mockResolvedValueOnce([{ so_id: '11', id: '901', tranid: 'INV1001', status: 'V', so_status: 'G' }]);
    const r = await findSoInvoices(['11']);
    expect(r.invoices.get('11')).toEqual([]);
  });

  it('falls down the ladder to createdfrom and fetches SO status for billed SOs', async () => {
    query
      .mockRejectedValueOnce(nsError(400, 'Invalid search query'))
      .mockRejectedValueOnce(nsError(400, 'Invalid search query'))
      .mockResolvedValueOnce([{ id: '901', tranid: 'INV1001', trandate: '9/20/2026', total: '100', status: 'A' }])
      .mockResolvedValueOnce([{ id: '11', status: 'G' }]);
    const r = await findSoInvoices(['11']);
    expect(r.via).toBe('createdfrom');
    expect(r.invoices.get('11')![0].tranid).toBe('INV1001');
    expect(r.soStatus.get('11')).toBe('G');

    // Rejected (400) rungs are not retried in the same process.
    query.mockReset();
    query.mockResolvedValueOnce([]);
    await findSoInvoices(['12']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('t.createdfrom = 12');
  });

  it('throws when every rung fails — never an empty "not invoiced"', async () => {
    query.mockRejectedValue(nsError(500, 'UNEXPECTED_ERROR'));
    await expect(findSoInvoices(['11'])).rejects.toThrow(/NetSuite invoice lookup failed/);
  });

  it('does not fan out one createdfrom call per SO for a big batch', async () => {
    query.mockRejectedValue(nsError(500, 'UNEXPECTED_ERROR'));
    const ids = Array.from({ length: 50 }, (_, i) => String(100 + i));
    await expect(findSoInvoices(ids)).rejects.toThrow(/skipped for 50/);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('ignores ids that are not NetSuite internal ids', async () => {
    const r = await findSoInvoices(['SO1060', '']);
    expect(query).not.toHaveBeenCalled();
    expect(r.invoices.size).toBe(0);
  });
});

/** Minimal chainable Supabase fake recording inserts and updates. */
function fakeSupabase(state: { links?: any[]; ledger?: any[]; checkins: Record<string, { invoice_number: string | null }> }) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const client = {
    inserts,
    updates,
    from(table: string) {
      const q: any = { table, filters: {} as Record<string, any>, isNull: [] as string[] };
      q.select = () => q;
      q.not = () => q;
      q.order = () => q;
      q.in = () => q;
      q.eq = (col: string, val: any) => { q.filters[col] = val; return q; };
      q.is = (col: string) => { q.isNull.push(col); return q; };
      q.range = async () => ({ data: table === 'fleet_checkin_sales_orders' ? state.links || [] : state.ledger || [], error: null });
      q.insert = async (row: any) => {
        const dup = (state.ledger || []).some(r => r.fleet_checkin_id === row.fleet_checkin_id && r.netsuite_sales_order_id === row.netsuite_sales_order_id);
        if (dup) return { error: { code: '23505', message: 'duplicate' } };
        (state.ledger ||= []).push(row);
        inserts.push({ table, row });
        return { error: null };
      };
      q.update = (patch: any) => {
        q.patch = patch;
        q.select = async () => {
          const c = state.checkins[q.filters.id];
          if (!c || (q.isNull.includes('invoice_number') && c.invoice_number)) return { data: [], error: null };
          Object.assign(c, patch);
          updates.push({ table, id: q.filters.id, patch });
          return { data: [{ invoice_number: patch.invoice_number, date_invoiced: patch.date_invoiced }], error: null };
        };
        return q;
      };
      return q;
    },
  };
  return client;
}

describe('stampVehicleInvoice', () => {
  const inv = [{ id: '901', tranid: 'INV1001', trandate: '9/20/2026', total: 100, status: 'A' }];

  it('writes the ledger row and the vehicle number for a fully billed SO', async () => {
    const sb = fakeSupabase({ checkins: { c1: { invoice_number: null } } });
    const out = await stampVehicleInvoice(sb, 'c1', '11', inv, 'G');
    expect(out).toEqual({ invoiceNumber: 'INV1001', dateInvoiced: '2026-09-20', stamped: true });
    expect(sb.inserts[0].row).toMatchObject({ fleet_checkin_id: 'c1', netsuite_sales_order_id: '11', invoice_number: 'INV1001', netsuite_invoice_id: '901' });
  });

  it('leaves a partly billed SO alone so its remaining lines stay billable', async () => {
    const sb = fakeSupabase({ checkins: { c1: { invoice_number: null } } });
    const out = await stampVehicleInvoice(sb, 'c1', '11', inv, 'F');
    expect(out.stamped).toBe(false);
    expect(sb.inserts).toHaveLength(0);
    expect(sb.updates).toHaveLength(0);
  });

  it('never overwrites an existing ledger row or vehicle number', async () => {
    const sb = fakeSupabase({
      ledger: [{ fleet_checkin_id: 'c1', netsuite_sales_order_id: '11', invoice_number: 'INV0500' }],
      checkins: { c1: { invoice_number: 'INV0500' } },
    });
    const out = await stampVehicleInvoice(sb, 'c1', '11', inv, 'G');
    expect(out.stamped).toBe(false);
    expect(sb.updates).toHaveLength(0);
  });
});

describe('syncVehicleInvoices', () => {
  it('checks only SOs with no ledger row, in one batched read, and stamps the billed ones', async () => {
    const sb = fakeSupabase({
      links: [
        { checkin_id: 'c1', netsuite_sales_order_id: '11' },
        { checkin_id: 'c2', netsuite_sales_order_id: '12' },
        { checkin_id: 'c3', netsuite_sales_order_id: '13' },
      ],
      ledger: [{ fleet_checkin_id: 'c3', netsuite_sales_order_id: '13', invoice_number: 'INV0001' }],
      checkins: { c1: { invoice_number: null }, c2: { invoice_number: null }, c3: { invoice_number: 'INV0001' } },
    });
    query.mockResolvedValueOnce([
      { so_id: '11', id: '901', tranid: 'INV1001', trandate: '9/20/2026', total: '100', status: 'A', so_status: 'G' },
    ]);
    const r = await syncVehicleInvoices(sb, { deadline: Date.now() + 60_000 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('IN (11, 12)');
    expect(r).toMatchObject({ checkedSalesOrders: 2, billedSalesOrders: 1, vehiclesStamped: 1, stoppedEarly: false });
  });
});
