import { describe, it, expect, vi } from 'vitest';

// po-invoice-verify wires the attention alert through po-billing-notify →
// notify.ts, which builds Supabase/Twilio/Resend clients at module scope —
// stub it so importing the pure helpers doesn't drag delivery clients in.
vi.mock('@/lib/po-billing-notify', () => ({
  notifyPoBillingAttention: async () => 0,
}));

import { distributeInstalled, normPart, computeOverbillProblems } from './po-invoice-verify';

// distributeInstalled is the single source of truth for how a part's consumed
// quantity is spread across its PO lines. Both the invoice-open route (immediate
// consumption) and the verify sweep (cron / "Recheck billing") call it; if their
// results ever diverged, `installed` would stack above what was billed and
// prematurely complete the PO. These tests pin the properties that keep the two
// in lockstep.

const line = (id: string, quantity: number, installed = 0) => ({ id, quantity, installed });
// Apply the helper's updates to a line set, returning the new installed map.
function apply(lines: { id: string; quantity: number; installed: number | null }[], total: number) {
  const updates = distributeInstalled(lines, total);
  const byId = new Map(lines.map(l => [l.id, l.installed || 0]));
  for (const u of updates) byId.set(u.id, u.installed);
  return byId;
}

describe('distributeInstalled', () => {
  it('fills a single line up to the consumed amount', () => {
    expect(distributeInstalled([line('a', 200)], 150)).toEqual([{ id: 'a', installed: 150 }]);
  });

  it('fills a multi-line part front-first in id order (the reported PO shape)', () => {
    // RM531429 spread across three lines 200 + 100 + 101, all 401 billed.
    const lines = [line('l1', 200), line('l2', 100), line('l3', 101)];
    expect(apply(lines, 401)).toEqual(new Map([['l1', 200], ['l2', 100], ['l3', 101]]));
  });

  it('is deterministic regardless of input order', () => {
    const asc = distributeInstalled([line('a', 200), line('b', 200)], 250);
    const desc = distributeInstalled([line('b', 200), line('a', 200)], 250);
    expect(asc).toEqual(desc);
    expect(asc).toEqual([{ id: 'a', installed: 200 }, { id: 'b', installed: 50 }]);
  });

  it('never lowers installed — a physical scan past billing is preserved', () => {
    // L2 scanned to 200 already; only 100 billed for the part.
    const lines = [line('l1', 200, 0), line('l2', 200, 200)];
    const result = apply(lines, 100);
    expect(result.get('l1')).toBe(100); // billed units land on the front line
    expect(result.get('l2')).toBe(200); // scan preserved, not lowered
  });

  it('clamps a consumed total above capacity', () => {
    const lines = [line('a', 100), line('b', 100)];
    expect(apply(lines, 999)).toEqual(new Map([['a', 100], ['b', 100]]));
  });

  it('returns no updates for zero or negative totals', () => {
    expect(distributeInstalled([line('a', 100)], 0)).toEqual([]);
    expect(distributeInstalled([line('a', 100)], -5)).toEqual([]);
  });

  // The core anti-stacking property: the route consumes immediately with
  // target = alreadyInstalled + billed, then the sweep reconsumes with the
  // part's cumulative invoiced total. The sweep must find nothing to change.
  it('is idempotent across the immediate write and a later cumulative sweep', () => {
    let lines = [line('l1', 200, 0), line('l2', 200, 0)];

    // Route bills 200 for the part (regardless of which line the admin picked).
    const afterRoute = apply(lines, /* alreadyInstalled */ 0 + /* billed */ 200);
    expect(afterRoute).toEqual(new Map([['l1', 200], ['l2', 0]]));

    // Sweep runs with cumulative invoiced = 200 against the route's result.
    lines = lines.map(l => ({ ...l, installed: afterRoute.get(l.id)! }));
    expect(distributeInstalled(lines, 200)).toEqual([]); // nothing stacks

    // Second invoice bills the remaining 200; route target = 200 installed + 200.
    const afterRoute2 = apply(lines, 200 + 200);
    expect(afterRoute2).toEqual(new Map([['l1', 200], ['l2', 200]]));
    lines = lines.map(l => ({ ...l, installed: afterRoute2.get(l.id)! }));
    expect(distributeInstalled(lines, 400)).toEqual([]); // still stable at cumulative 400
  });

  it('a partial bill on a multi-line part does not inflate the total (the confirmed bug)', () => {
    // Part on L1(200)/L2(200). Admin bills 200; without deterministic front-fill
    // the route+sweep stacked to 400 installed for 200 billed. Now they agree.
    let lines = [line('l1', 200, 0), line('l2', 200, 0)];
    const afterRoute = apply(lines, 0 + 200);
    lines = lines.map(l => ({ ...l, installed: afterRoute.get(l.id)! }));
    const sweep = apply(lines, 200); // cumulative invoiced 200
    const total = [...sweep.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(200); // exactly what was billed — not 400
  });
});

describe('normPart', () => {
  it('uppercases and takes the last segment of a sub-item id', () => {
    expect(normPart('rm531429')).toBe('RM531429');
    expect(normPart('PARENT : Child')).toBe('CHILD');
    expect(normPart(' spaced ')).toBe('SPACED');
  });
});

// computeOverbillProblems is the pre-flight gate the scan-invoice flow runs
// before creating a NetSuite invoice. Its judgments must match the verify
// sweep's ('over' / 'extra'), so anything it lets through is exactly what the
// sweep would rate 'ok'.
describe('computeOverbillProblems', () => {
  const lines = [
    { part_number: 'RM531429', quantity: 40 },
    { part_number: '02T278', quantity: 10 },
  ];

  it('passes a bill that fits inside what remains', () => {
    const billed = new Map([['RM531429', 28]]);
    expect(computeOverbillProblems(lines, billed, [{ partNumber: 'RM531429', quantity: 12 }])).toEqual([]);
  });

  it('blocks billing past the ordered quantity and names the amounts', () => {
    const billed = new Map([['RM531429', 30]]);
    const problems = computeOverbillProblems(lines, billed, [{ partNumber: 'RM531429', quantity: 12 }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('RM531429');
    expect(problems[0]).toContain('30 already invoiced');
    expect(problems[0]).toContain('40 ordered');
  });

  it('blocks a fully invoiced part outright (the pre-billed-PO incident)', () => {
    const billed = new Map([['RM531429', 40]]);
    const problems = computeOverbillProblems(lines, billed, [{ partNumber: 'RM531429', quantity: 1 }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/already fully invoiced/);
  });

  it('blocks parts the PO never ordered', () => {
    const problems = computeOverbillProblems(lines, new Map(), [{ partNumber: 'RM999', quantity: 2 }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not a line on this PO');
  });

  it('sums ordered across split lines and matches sub-item ids case-insensitively', () => {
    const split = [
      { part_number: 'RM531429', quantity: 200 },
      { part_number: 'rm531429', quantity: 100 },
    ];
    // 250 billed + 50 to bill = 300 exactly — fits.
    expect(computeOverbillProblems(split, new Map([['RM531429', 250]]), [{ partNumber: 'PARENT : rm531429', quantity: 50 }])).toEqual([]);
    // One more unit is over.
    expect(computeOverbillProblems(split, new Map([['RM531429', 250]]), [{ partNumber: 'rm531429', quantity: 51 }])).toHaveLength(1);
  });

  it('aggregates duplicate to-bill entries of the same part before checking', () => {
    const problems = computeOverbillProblems([{ part_number: 'A1', quantity: 10 }], new Map(), [
      { partNumber: 'A1', quantity: 6 },
      { partNumber: 'a1', quantity: 6 },
    ]);
    expect(problems).toHaveLength(1); // 12 > 10 even though each entry alone fits
  });

  it('reports nothing with no PO overlap at all', () => {
    expect(computeOverbillProblems(lines, new Map(), [{ partNumber: '02T278', quantity: 10 }])).toEqual([]);
  });
});
