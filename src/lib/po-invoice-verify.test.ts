import { describe, it, expect } from 'vitest';
import { distributeInstalled, normPart } from './po-invoice-verify';

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
