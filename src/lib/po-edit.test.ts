import { describe, it, expect } from 'vitest';
import { canEditPo, parsePoHeader, planPoEdit, planPoHeader, splitRequestsForQty, SHOP_SHIP_TO, lineLock, canTakeOff } from '@/lib/po-edit';
import { EMPTY_SHIP_TO } from '@/lib/drop-ship';
import type { PoItemLine } from '@/lib/netsuite';

const line = (p: Partial<PoItemLine> & { line: number; itemId: string }): PoItemLine => ({
  quantity: 1, quantityReceived: 0, quantityBilled: 0, isClosed: false, rate: 10, description: null, ...p,
});

const live = [
  line({ line: 1, itemId: '100', quantity: 1, rate: 812.4 }),
  line({ line: 2, itemId: '200', quantity: 4, quantityReceived: 2, rate: 120 }),
  line({ line: 3, itemId: '300', quantity: 2, quantityReceived: 2, quantityBilled: 2, rate: 60 }),
];
const labels = new Map([['100', 'BAK448146'], ['200', 'CURT 13342'], ['300', 'MEYER 21900'], ['400', 'CURT 56301']]);

describe('canEditPo', () => {
  it('allows open POs and refuses received or closed ones', () => {
    expect(canEditPo('B')).toBe(true);
    expect(canEditPo('E')).toBe(true);
    expect(canEditPo(null)).toBe(true);
    for (const s of ['F', 'G', 'C', 'H']) expect(canEditPo(s)).toBe(false);
  });
});

describe('line locks', () => {
  it('locks billed and closed lines; received lines cannot come off', () => {
    expect(lineLock(live[2])).toBe('billed');
    expect(lineLock(line({ line: 9, itemId: '9', isClosed: true }))).toBe('closed');
    expect(lineLock(live[1])).toBeNull();
    expect(canTakeOff(live[1])).toBe(false);
    expect(canTakeOff(live[0])).toBe(true);
  });
});

describe('planPoEdit', () => {
  it('sends only the changed lines when nothing comes off', () => {
    const plan = planPoEdit(live, [{ line: 2, quantity: 3 }, { line: 1, rate: 799 }], [], labels);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.replace).toBe(false);
    expect(plan.items).toEqual([{ line: 2, quantity: 3 }, { line: 1, rate: 799 }]);
    expect(plan.qtyChanges).toEqual([{ line: 2, itemId: '200', from: 4, to: 3 }]);
    expect(plan.changes).toEqual(['CURT 13342 quantity 4 → 3', 'BAK448146 price $812.40 → $799.00']);
  });

  it('ignores edits that match what NetSuite has', () => {
    const plan = planPoEdit(live, [{ line: 1, quantity: 1, rate: 812.4 }], [], labels);
    expect(plan.ok && plan.changes).toEqual([]);
    expect(plan.ok && plan.items).toEqual([]);
  });

  it('a blank price leaves the price alone', () => {
    const plan = planPoEdit(live, [{ line: 1, rate: null }], [], labels);
    expect(plan.ok && plan.items).toEqual([]);
  });

  it('rebuilds the sublist with every kept line when a line comes off', () => {
    const plan = planPoEdit(live, [{ line: 1, remove: true }, { line: 2, quantity: 2 }], [], labels);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.replace).toBe(true);
    expect(plan.items).toEqual([{ line: 2, quantity: 2 }, { line: 3 }]);
    expect(plan.removed.map(l => l.line)).toEqual([1]);
  });

  it('adds new parts as lines without a key', () => {
    const plan = planPoEdit(live, [], [{ itemId: '400', itemNumber: 'CURT 56301', quantity: 2, rate: 4.5, description: 'Pin' }], labels);
    expect(plan.ok && plan.items).toEqual([{ item: { id: '400' }, quantity: 2, rate: 4.5, description: 'Pin' }]);
    expect(plan.ok && plan.changes).toEqual(['Added CURT 56301 (2 at $4.50)']);
  });

  it('moves lines off this PO', () => {
    const plan = planPoEdit(live, [{ line: 1, move: true }], [], labels);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.moved.map(l => l.itemId)).toEqual(['100']);
    expect(plan.replace).toBe(true);
    expect(plan.items).toEqual([{ line: 2 }, { line: 3 }]);
  });

  it('refuses going below what was received', () => {
    const plan = planPoEdit(live, [{ line: 2, quantity: 1 }], [], labels);
    expect(plan).toEqual({ ok: false, error: "CURT 13342 can't go below 2: that many were already received." });
  });

  it('refuses removing or moving a line with parts received', () => {
    expect(planPoEdit(live, [{ line: 2, remove: true }], [], labels).ok).toBe(false);
    expect(planPoEdit(live, [{ line: 2, move: true }], [], labels).ok).toBe(false);
  });

  it('refuses any change to a billed line', () => {
    const plan = planPoEdit(live, [{ line: 3, rate: 50 }], [], labels);
    expect(plan).toEqual({ ok: false, error: "MEYER 21900 is billed in NetSuite, so it can't change." });
  });

  it('refuses a quantity of 0', () => {
    expect(planPoEdit(live, [{ line: 1, quantity: 0 }], [], labels).ok).toBe(false);
  });

  it('refuses a line it does not know', () => {
    expect(planPoEdit(live, [{ line: 42, quantity: 3 }], [], labels).ok).toBe(false);
  });

  it('keeps at least one open part on the PO', () => {
    const one = [line({ line: 1, itemId: '100' })];
    expect(planPoEdit(one, [{ line: 1, remove: true }], [], labels)).toEqual({
      ok: false, error: 'A PO needs at least one part. To cancel the whole PO, close it in NetSuite.',
    });
    const swapped = planPoEdit(one, [{ line: 1, remove: true }], [{ itemId: '400', itemNumber: 'CURT 56301', quantity: 1, rate: null, description: null }], labels);
    expect(swapped.ok && swapped.items).toEqual([{ item: { id: '400' }, quantity: 1 }]);
  });
});

describe('planPoHeader', () => {
  const before = { memo: 'FleetSuite purchase requests', dueDate: '2026-11-10', shipTo: SHOP_SHIP_TO };
  it('sends only what changed', () => {
    expect(planPoHeader(before, { memo: 'FleetSuite purchase requests ', dueDate: '2026-11-10', shipTo: { ...SHOP_SHIP_TO } })).toEqual({ body: {}, changes: [] });
    const h = planPoHeader(before, { memo: 'Rush', dueDate: '2026-11-12' });
    expect(h.body).toEqual({ memo: 'Rush', dueDate: '2026-11-12' });
    expect(h.changes).toEqual(['Memo changed', 'Expected date Nov 12']);
  });
  it('writes a ship-to address body', () => {
    const to = { ...EMPTY_SHIP_TO, name: 'Acme Fleet', address: '1 Main', city: 'Peoria', state: 'IL', zip: '61602' };
    const h = planPoHeader(before, { shipTo: to });
    expect(h.body.shippingAddress).toMatchObject({ addressee: 'Acme Fleet', addr1: '1 Main', city: 'Peoria', state: 'IL', zip: '61602' });
    expect(h.changes).toEqual(['Ship to Acme Fleet, Peoria']);
  });
});

describe('parsePoHeader', () => {
  it('reads memo, Receive By and lastModifiedDate', () => {
    const p = parsePoHeader({ memo: 'x', dueDate: '2026-11-10', lastModifiedDate: '2026-11-06T06:00:00Z', shippingAddress: { addressee: 'BMG', city: "O'Fallon" } });
    expect(p.header.memo).toBe('x');
    expect(p.header.dueDate).toBe('2026-11-10');
    expect(p.header.shipTo.name).toBe('BMG');
    expect(p.lastModified).toBe('2026-11-06T06:00:00Z');
  });
});

describe('splitRequestsForQty', () => {
  const reqs = [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 2 }];
  it('keeps requests oldest first and splits the last one kept', () => {
    expect(splitRequestsForQty(reqs, 3)).toEqual({ stay: [reqs[0]], split: { id: 'b', quantity: 1, back: 1 }, back: [] });
  });
  it('sends whole requests back', () => {
    expect(splitRequestsForQty(reqs, 2)).toEqual({ stay: [reqs[0]], split: null, back: [reqs[1]] });
  });
  it('keeps everything when the line still covers them', () => {
    expect(splitRequestsForQty(reqs, 5)).toEqual({ stay: reqs, split: null, back: [] });
  });
});
