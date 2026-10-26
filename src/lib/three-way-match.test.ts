import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canBillPoStatus, computeThreeWayMatch, loadPoMatchFacts, loadThreeWayMatchForPo } from './three-way-match';

const base = { invoiceTotal: 1000, poTotal: 1000, lines: [], priorBills: [] };

describe('computeThreeWayMatch — vendor bill three-way match', () => {
  it('clean match is green', () => {
    const m = computeThreeWayMatch({ ...base, lines: [{ itemNumber: 'A', ordered: 5, received: 5 }] });
    expect(m.verdict).toBe('green');
    expect(m.variances).toEqual([]);
    expect(m.totalDiff).toBe(0);
  });

  it('total inside tolerance passes (larger of 2% and $25)', () => {
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 1021 }).verdict).toBe('green'); // $21 <= $25 floor
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 124, poTotal: 100 }).verdict).toBe('green'); // $24 <= $25 floor
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 1026 }).verdict).toBe('red'); // $26 > $25 floor
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 10150, poTotal: 10000 }).verdict).toBe('green'); // $150 <= 2% ($200)
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 10201, poTotal: 10000 }).verdict).toBe('red'); // $201 > 2% ($200)
  });

  it('over-invoice beyond tolerance is red with the difference named', () => {
    const m = computeThreeWayMatch({ ...base, invoiceTotal: 1417, poTotal: 1000 });
    expect(m.verdict).toBe('red');
    expect(m.variances[0]).toContain('$417.00 over');
    expect(m.totalDiff).toBe(417);
  });

  it('unreadable invoice total is amber, not green', () => {
    const m = computeThreeWayMatch({ ...base, invoiceTotal: null });
    expect(m.verdict).toBe('amber');
    expect(m.variances[0]).toContain('could not be read');
  });

  it('short receipt is amber; nothing received is red', () => {
    const short = computeThreeWayMatch({ ...base, lines: [
      { itemNumber: 'A', ordered: 5, received: 3 },
      { itemNumber: 'B', ordered: 2, received: 2 },
    ] });
    expect(short.verdict).toBe('amber');
    expect(short.variances[0]).toContain('Received 5 of 7');
    expect(short.shortReceived).toHaveLength(1);

    const none = computeThreeWayMatch({ ...base, lines: [{ itemNumber: 'A', ordered: 5, received: 0 }] });
    expect(none.verdict).toBe('red');
    expect(none.variances[0]).toContain('Nothing on this PO has been received');
  });

  it('a prior bill against the PO is red (double-pay risk)', () => {
    const m = computeThreeWayMatch({ ...base, priorBills: ['VB-1001'] });
    expect(m.verdict).toBe('red');
    expect(m.variances[0]).toContain('VB-1001');
  });

  it('no receipt data at all stays quiet on that leg', () => {
    expect(computeThreeWayMatch({ ...base }).verdict).toBe('green');
  });

  it('a terminal PO (fully billed / closed) is red; an open one adds nothing', () => {
    const closed = computeThreeWayMatch({ ...base, poIsOpen: false, poStatusLabel: 'Fully Billed' });
    expect(closed.verdict).toBe('red');
    expect(closed.variances[0]).toContain('Fully Billed');
    expect(computeThreeWayMatch({ ...base, poIsOpen: true }).verdict).toBe('green');
  });
});

describe('each leg on its own', () => {
  it('says which leg passed, warned or failed, and how far apart the totals may be', () => {
    const m = computeThreeWayMatch({ ...base, invoiceTotal: 1240, poTotal: 1000, lines: [{ itemNumber: 'A', ordered: 4, received: 2 }] });
    expect(m.legs).toEqual({ totals: 'red', received: 'amber', earlier: 'green' });
    expect(m.allowed).toBe(25);
    expect(computeThreeWayMatch({ ...base, invoiceTotal: 2152.4, poTotal: 2140 }).allowed).toBe(42.8);
    expect(computeThreeWayMatch({ ...base, invoiceTotal: null }).legs).toEqual({ totals: 'amber', received: 'green', earlier: 'green' });
    expect(computeThreeWayMatch({ ...base, invoiceTotal: null }).allowed).toBeNull();
    expect(computeThreeWayMatch({ ...base, poTotal: null }).legs.totals).toBe('amber');
    expect(computeThreeWayMatch({ ...base, lines: [{ itemNumber: 'A', ordered: 4, received: 0 }] }).legs.received).toBe('red');
    expect(computeThreeWayMatch({ ...base, priorBills: ['VB-1'] }).legs.earlier).toBe('red');
    expect(computeThreeWayMatch({ ...base, poIsOpen: false }).legs.earlier).toBe('red');
    expect(computeThreeWayMatch({ ...base }).legs).toEqual({ totals: 'green', received: 'green', earlier: 'green' });
  });
});

describe('canBillPoStatus', () => {
  it("takes a bill on a fully received PO (F, Pending Bill), and not on one that's billed, closed or never approved", () => {
    for (const s of ['B', 'D', 'E', 'F', 'f', null, undefined, '']) expect(canBillPoStatus(s)).toBe(true);
    for (const s of ['A', 'C', 'G', 'H', 'P', 'g']) expect(canBillPoStatus(s)).toBe(false);
  });
});

// A made-up PO in a fake of the tables the loader reads.
type Row = Record<string, unknown>;
function fakeService(tables: Record<string, Row[] | { error: { code?: string; message: string } }>) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const service = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      reads.push({ table, filters });
      const result = () => {
        const t = tables[table];
        if (t && !Array.isArray(t)) return { data: null, error: t.error };
        return { data: (t ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
      };
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return q;
    },
  };
  return { service: service as unknown as SupabaseClient, reads };
}

const PO = { id: 'po-1', netsuite_id: '45310', tranid: 'PO453-ACME', status: 'F', status_label: 'Pending Bill', total: '2140.00' };
const LINES = [
  { po_id: 'po-1', line_id: '1', item_netsuite_id: '1201', item_number: 'RACK-48', description: 'Contractor rack', quantity: '4', quantity_received: '4', quantity_billed: '0', rate: '485', amount: '1940.00' },
  { po_id: 'po-1', line_id: '2', item_netsuite_id: '1388', item_number: 'CLAMP-ACX', description: 'Clamp kit', quantity: '4', quantity_received: '2', quantity_billed: '0', rate: '50', amount: '200.00' },
];

describe('loadPoMatchFacts', () => {
  it('reads a fully received PO (Pending Bill) as one that can take a bill', async () => {
    const { service } = fakeService({ netsuite_vendor_pos: [PO], netsuite_vendor_po_lines: [{ ...LINES[0] }, { ...LINES[1], quantity_received: '4' }] });
    const f = await loadPoMatchFacts(service, 'po-1');
    expect(f).toMatchObject({ poTranid: 'PO453-ACME', poTotal: 2140, poIsOpen: true, poStatusLabel: 'Pending Bill', priorBills: [] });
    expect(f.lines).toEqual([{ itemNumber: 'RACK-48', ordered: 4, received: 4 }, { itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 }]);
    expect(f.rows).toHaveLength(2);
    const { match } = await loadThreeWayMatchForPo(service, 'po-1', 2140);
    expect(match.verdict).toBe('green');
  });

  it('counts dock receipts NetSuite has not absorbed yet as received', async () => {
    const { service } = fakeService({
      netsuite_vendor_pos: [PO],
      netsuite_vendor_po_lines: LINES,
      po_receipts: [{ po_id: 'po-1', line_id: '2', item_number: 'CLAMP-ACX', quantity: '2', ns_status: 'manual_needed' }, { po_id: 'po-1', line_id: '2', item_number: 'CLAMP-ACX', quantity: '9', ns_status: 'posted' }],
    });
    expect((await loadPoMatchFacts(service, 'po-1')).lines[1]).toEqual({ itemNumber: 'CLAMP-ACX', ordered: 4, received: 4 });
  });

  it("counts a snapped bill that billed the PO as an earlier bill, for Parts Mail's Create bill too, but not the one being billed", async () => {
    const tables = {
      netsuite_vendor_pos: [PO],
      netsuite_vendor_po_lines: LINES,
      vendor_parts_invoices: [{ id: 'inv-1', matched_po_id: 'po-1', status: 'billed', invoice_number: 'A-1', netsuite_bill_number: 'VB-90', netsuite_bill_id: '90' }],
      gl_snapped_bills: [
        { id: 'snap-1', billed_po_netsuite_id: '45310', status: 'sent', netsuite_number: 'INV-5521', bill_number: 'INV-5521' },
        { id: 'snap-2', billed_po_netsuite_id: '45310', status: 'sent', netsuite_number: null, bill_number: 'INV-5530' },
        { id: 'snap-3', billed_po_netsuite_id: '99999', status: 'sent', netsuite_number: 'X-1', bill_number: 'X-1' },
      ],
    };
    const { service, reads } = fakeService(tables);
    const f = await loadPoMatchFacts(service, 'po-1');
    expect(f.priorBills).toEqual(['VB-90', 'INV-5521', 'INV-5530']);
    expect(f).toMatchObject({ earlierBills: ['VB-90', 'INV-5521', 'INV-5530'], billedUnits: 0 });
    expect(reads.find((r) => r.table === 'gl_snapped_bills')!.filters).toEqual([['billed_po_netsuite_id', '45310'], ['status', 'sent']]);
    expect((await loadPoMatchFacts(fakeService(tables).service, 'po-1', { invoiceId: 'inv-1', snappedId: 'snap-1' })).priorBills).toEqual(['INV-5530']);
    const { match } = await loadThreeWayMatchForPo(fakeService(tables).service, 'po-1', 2140, 'inv-1');
    expect(match.verdict).toBe('red');
    expect(match.variances[0]).toContain('INV-5521');
  });

  it("reads NetSuite's billed quantities and a closed PO as reasons not to bill", async () => {
    const { service } = fakeService({ netsuite_vendor_pos: [{ ...PO, status: 'G', status_label: 'Fully Billed' }], netsuite_vendor_po_lines: [{ ...LINES[0], quantity_billed: '4' }] });
    const f = await loadPoMatchFacts(service, 'po-1');
    expect(f.poIsOpen).toBe(false);
    expect(f.priorBills).toEqual(['NetSuite shows 4 units already billed on this PO']);
    // The bills by name, and the units on their own, for Snap a bill to say each its own way.
    expect(f).toMatchObject({ earlierBills: [], billedUnits: 4 });
    const one = await loadPoMatchFacts(fakeService({ netsuite_vendor_pos: [PO], netsuite_vendor_po_lines: [{ ...LINES[0], quantity_billed: '1' }] }).service, 'po-1');
    expect(one).toMatchObject({ priorBills: ['NetSuite shows 1 unit already billed on this PO'], billedUnits: 1 });
  });

  it('takes the total from the lines when the PO has none, and fails closed when the PO is missing', async () => {
    expect((await loadPoMatchFacts(fakeService({ netsuite_vendor_pos: [{ ...PO, total: null }], netsuite_vendor_po_lines: LINES }).service, 'po-1')).poTotal).toBe(2140);
    await expect(loadPoMatchFacts(fakeService({}).service, 'po-1')).rejects.toThrow('PO not found');
  });

  it("goes on without snapped bills only while the schema cache doesn't have their column yet", async () => {
    const lagging = { netsuite_vendor_pos: [PO], netsuite_vendor_po_lines: LINES, gl_snapped_bills: { error: { code: 'PGRST204', message: "Could not find the 'billed_po_netsuite_id' column" } } };
    expect((await loadPoMatchFacts(fakeService(lagging).service, 'po-1')).priorBills).toEqual([]);
    const broken = { ...lagging, gl_snapped_bills: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } };
    await expect(loadPoMatchFacts(fakeService(broken).service, 'po-1')).rejects.toThrow('snapped bills');
  });
});
