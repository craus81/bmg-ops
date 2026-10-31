import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/so-invoices', async () => {
  const actual = await vi.importActual<typeof import('./so-invoices')>('./so-invoices');
  return { ...actual, findSoInvoices: vi.fn(), stampVehicleInvoice: vi.fn() };
});

import { findSoInvoices, stampVehicleInvoice, type SoInvoice } from '@/lib/so-invoices';
import { applyEstimateInvoices, linkMessage, soBilling, syncEstimateInvoices } from './estimate-invoices';

const find = vi.mocked(findSoInvoices);
const stamp = vi.mocked(stampVehicleInvoice);

type Call = { table: string; op: string; payload?: any; filters: [string, ...any[]][]; opts?: any };

/** A Supabase stand-in: records every call, answers from `answer`. */
function fakeSupabase(answer: (c: Call) => { data?: any; error?: any } = () => ({ data: [] })) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const c: Call = { table, op: 'select', filters: [] };
    const b: any = {
      select: () => b,
      insert: (p: any) => { c.op = 'insert'; c.payload = p; return b; },
      update: (p: any) => { c.op = 'update'; c.payload = p; return b; },
      upsert: (p: any, o: any) => { c.op = 'upsert'; c.payload = p; c.opts = o; return b; },
      delete: () => { c.op = 'delete'; return b; },
      then: (res: any, rej: any) => { calls.push(c); return Promise.resolve({ data: null, error: null, ...answer(c) }).then(res, rej); },
    };
    for (const f of ['eq', 'in', 'is', 'not', 'or', 'order', 'range', 'neq']) b[f] = (...a: any[]) => { c.filters.push([f, ...a]); return b; };
    return b;
  };
  return { sb: { from } as any, calls };
}

const inv = (id: string, tranid: string, total = 100, trandate = '10/28/2026'): SoInvoice => ({ id, tranid, trandate, total, status: 'A' });

beforeEach(() => {
  find.mockReset();
  stamp.mockReset();
  stamp.mockResolvedValue({ invoiceNumber: 'INV1', dateInvoiced: '2026-10-28', stamped: true });
});

describe('soBilling', () => {
  it('none without invoices, full only when NetSuite says Billed or Closed', () => {
    expect(soBilling([], 'G')).toBe('none');
    expect(soBilling([inv('1', 'INV1')], 'G')).toBe('full');
    expect(soBilling([inv('1', 'INV1')], 'SalesOrd:H')).toBe('full');
    expect(soBilling([inv('1', 'INV1')], 'F')).toBe('partial');
    expect(soBilling([inv('1', 'INV1')], undefined)).toBe('partial');
  });
});

describe('applyEstimateInvoices', () => {
  const est = { id: 'e1', netsuite_so_id: '11', netsuite_so_number: 'SO1177', fleet_checkin_id: 'c9' };
  const vehicles = [
    { id: 'c1', vin: '1FTBR1C80RKA18812', vehicle_year: '2025', vehicle_make: 'Ford', vehicle_model: 'Transit' },
    { id: 'c9', vin: '1FTBR1C80RKA18840', vehicle_year: null, vehicle_make: null, vehicle_model: null },
  ];
  const answer = (c: Call) => {
    if (c.table === 'fleet_checkins') return { data: vehicles };
    if (c.table === 'fleet_checkin_sales_orders') return { data: c.payload.checkin_id === 'c1' ? [{ id: 'x' }] : [] };
    return { data: [] };
  };

  it('saves the invoices whole, stamps the estimate, links and stamps the vehicles when fully billed', async () => {
    const { sb, calls } = fakeSupabase(answer);
    const lookup = { invoices: new Map([['11', [inv('901', 'INV1413', 4250), inv('905', 'INV1422', 1180, '10/30/2026')]]]), soStatus: new Map([['11', 'G']]) };
    const out = await applyEstimateInvoices(sb, est, lookup);

    expect(out.billing).toBe('full');
    const del = calls.find(c => c.table === 'estimate_invoices' && c.op === 'delete')!;
    expect(del.filters).toContainEqual(['eq', 'estimate_id', 'e1']);
    const ins = calls.find(c => c.table === 'estimate_invoices' && c.op === 'insert')!;
    expect(ins.payload).toEqual([
      { estimate_id: 'e1', netsuite_so_id: '11', netsuite_invoice_id: '901', invoice_number: 'INV1413', invoice_date: '2026-10-28', total: 4250, status: 'A' },
      { estimate_id: 'e1', netsuite_so_id: '11', netsuite_invoice_id: '905', invoice_number: 'INV1422', invoice_date: '2026-10-30', total: 1180, status: 'A' },
    ]);
    const upd = calls.find(c => c.table === 'estimates' && c.op === 'update')!;
    expect(upd.payload.so_billing).toBe('full');
    expect(upd.payload.invoices_checked_at).toBeTruthy();

    // Vehicles from the estimate and its own check-in.
    const veh = calls.find(c => c.table === 'fleet_checkins')!;
    expect(veh.filters).toContainEqual(['or', 'source_estimate_id.eq.e1,id.eq.c9']);
    const links = calls.filter(c => c.table === 'fleet_checkin_sales_orders');
    expect(links.map(l => l.payload)).toEqual([
      { checkin_id: 'c1', netsuite_sales_order_id: '11', sales_order_number: 'SO1177' },
      { checkin_id: 'c9', netsuite_sales_order_id: '11', sales_order_number: 'SO1177' },
    ]);
    expect(links[0].opts).toEqual({ onConflict: 'checkin_id,netsuite_sales_order_id', ignoreDuplicates: true });
    expect(out.vehiclesLinked).toBe(1);
    expect(stamp).toHaveBeenCalledTimes(2);
    expect(stamp.mock.calls[0].slice(1, 3)).toEqual(['c1', '11']);
    expect(out.vehiclesStamped).toBe(2);
    expect(out.vehicleLabels).toEqual(['2025 Ford Transit VIN …8812', 'VIN …8840']);
  });

  it('partly billed: saves and links, but never stamps a vehicle Invoiced', async () => {
    const { sb, calls } = fakeSupabase(answer);
    const out = await applyEstimateInvoices(sb, est, { invoices: new Map([['11', [inv('901', 'INV1413')]]]), soStatus: new Map([['11', 'F']]) });
    expect(out.billing).toBe('partial');
    expect(calls.some(c => c.table === 'estimate_invoices' && c.op === 'insert')).toBe(true);
    expect(calls.filter(c => c.table === 'fleet_checkin_sales_orders')).toHaveLength(2);
    expect(stamp).not.toHaveBeenCalled();
  });

  it('nothing billed (or all voided): clears the saved copy and inserts nothing', async () => {
    const { sb, calls } = fakeSupabase(answer);
    const out = await applyEstimateInvoices(sb, { id: 'e1', netsuite_so_id: '11' }, { invoices: new Map([['11', []]]), soStatus: new Map() });
    expect(out.billing).toBe('none');
    expect(calls.some(c => c.table === 'estimate_invoices' && c.op === 'delete')).toBe(true);
    expect(calls.some(c => c.table === 'estimate_invoices' && c.op === 'insert')).toBe(false);
    expect(calls.find(c => c.table === 'fleet_checkins')!.filters).toContainEqual(['or', 'source_estimate_id.eq.e1']);
  });

  it('a failed write throws so the estimate is not marked checked', async () => {
    const { sb, calls } = fakeSupabase(c => (c.table === 'estimate_invoices' && c.op === 'insert' ? { error: { message: 'nope' } } : { data: [] }));
    await expect(applyEstimateInvoices(sb, est, { invoices: new Map([['11', [inv('901', 'INV1413')]]]), soStatus: new Map() }))
      .rejects.toThrow('estimate_invoices: nope');
    expect(calls.some(c => c.table === 'estimates' && c.op === 'update')).toBe(false);
  });
});

describe('syncEstimateInvoices', () => {
  it('checks linked estimates not yet fully billed, never-checked first, in one lookup', async () => {
    const { sb, calls } = fakeSupabase(c => {
      if (c.table === 'estimates' && c.op === 'select') {
        return { data: [{ id: 'e1', netsuite_so_id: '11' }, { id: 'e2', netsuite_so_id: '12' }, { id: 'e3', netsuite_so_id: 'bad' }] };
      }
      return { data: [] };
    });
    find.mockResolvedValue({ invoices: new Map([['11', [inv('901', 'INV1413')]], ['12', []]]), soStatus: new Map([['11', 'G']]), via: 'nexttransactionlinelink' });
    const out = await syncEstimateInvoices(sb, { deadline: Date.now() + 10_000 });

    const q = calls[0];
    expect(q.filters).toContainEqual(['not', 'netsuite_so_id', 'is', null]);
    expect(q.filters).toContainEqual(['or', 'so_billing.is.null,so_billing.neq.full']);
    expect(q.filters).toContainEqual(['order', 'invoices_checked_at', { ascending: true, nullsFirst: true }]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual(['11', '12']);
    expect(out).toMatchObject({ checkedEstimates: 2, withInvoices: 1, failed: 0, stoppedEarly: false });
  });

  it('stops at the deadline and says so', async () => {
    const { sb } = fakeSupabase(c => (c.table === 'estimates' && c.op === 'select' ? { data: [{ id: 'e1', netsuite_so_id: '11' }] } : { data: [] }));
    const out = await syncEstimateInvoices(sb, { deadline: Date.now() - 1 });
    expect(out.stoppedEarly).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('linkMessage', () => {
  const base = { vehiclesLinked: 0, vehiclesStamped: 0 };
  it('names the invoices and the vehicles', () => {
    const m = linkMessage('SO1177', { ...base, billing: 'full', invoices: [inv('1', 'INV1413'), inv('2', 'INV1422')], vehicleLabels: ['2025 Ford Transit VIN …8812'] });
    expect(m).toContain('Linked SO #SO1177 to this estimate.');
    expect(m).toContain('Found 2 invoices billed from it: INV1413 and INV1422.');
    expect(m).toContain('Added to 1 vehicle from this estimate (2025 Ford Transit VIN …8812).');
    expect(m).not.toContain('partly');
  });
  it('says partly billed, nothing billed, and a failed check plainly', () => {
    expect(linkMessage('SO1', { ...base, billing: 'partial', invoices: [inv('1', 'INV1')], vehicleLabels: [] })).toContain('The order is partly billed.');
    expect(linkMessage('SO1', { ...base, billing: 'none', invoices: [], vehicleLabels: [] })).toContain('Nothing has been billed from it yet.');
    expect(linkMessage('SO1', null)).toContain("Couldn't check NetSuite for invoices just now.");
  });
});

describe('migration 461', () => {
  const sql = readFileSync(join(__dirname, '../../migrations/461-estimate-invoices.sql'), 'utf8');
  it('one row per invoice per estimate, staff read only', () => {
    expect(sql).toContain('UNIQUE (estimate_id, netsuite_invoice_id)');
    expect(sql).toMatch(/so_billing TEXT CHECK \(so_billing IN \('none', 'partial', 'full'\)\)/);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FOR SELECT TO authenticated');
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
});
