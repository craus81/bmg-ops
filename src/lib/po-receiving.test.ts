import { describe, it, expect } from 'vitest';
import { mapReceiptLines, type NsPoLine } from './po-receiving';

// The mapper stands between "receive 3 of this" clicks and a NetSuite
// itemReceipt transform that DEFAULTS to receiving everything — so what is
// pinned here is exactly when it maps, when it refuses, and that every
// untouched line comes back in excludeOrderLines (→ itemReceive:false).

const lines: NsPoLine[] = [
  { lineId: '1', lineSeq: 1, itemId: '55', quantity: 10, received: 4 },
  { lineId: '2', lineSeq: 2, itemId: '56', quantity: 2, received: 0 },
  { lineId: '3', lineSeq: 3, itemId: '57', quantity: 5, received: 5 },
];

describe('mapReceiptLines', () => {
  it('maps an exact mirror line-id onto its orderLine and excludes every other line', () => {
    const r = mapReceiptLines(lines, [
      { lineId: '2', itemNetsuiteId: '56', itemNumber: 'WIDGET', quantity: 2 },
    ]);
    expect(r).toEqual({
      ok: true,
      receiveLines: [{ orderLine: 2, quantity: 2 }],
      excludeOrderLines: [1, 3],
    });
  });

  it('falls back to a unique open-line item match for provisional prov-N ids', () => {
    const r = mapReceiptLines(lines, [
      { lineId: 'prov-1', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 6 },
    ]);
    expect(r).toEqual({
      ok: true,
      receiveLines: [{ orderLine: 1, quantity: 6 }],
      excludeOrderLines: [2, 3],
    });
  });

  it('will not item-match a line that is already fully received', () => {
    // Item 57's only line has 0 open — a prov id for it must refuse, not
    // silently over-receive the closed line.
    const r = mapReceiptLines(lines, [
      { lineId: 'prov-9', itemNetsuiteId: '57', itemNumber: 'CLAMP', quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no matching line');
  });

  it('refuses an ambiguous item match (same item on two open lines)', () => {
    const dup: NsPoLine[] = [
      ...lines,
      { lineId: '4', lineSeq: 4, itemId: '55', quantity: 3, received: 0 },
    ];
    const r = mapReceiptLines(dup, [
      { lineId: 'prov-1', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('several open PO lines');
  });

  it('refuses to over-receive what the PO has open', () => {
    const r = mapReceiptLines(lines, [
      { lineId: '1', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 7 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('only 6');
  });

  it('accumulates two asks landing on one line and still enforces the open quantity', () => {
    const ok = mapReceiptLines(lines, [
      { lineId: '1', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 4 },
      { lineId: 'prov-2', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 2 },
    ]);
    expect(ok).toEqual({
      ok: true,
      receiveLines: [{ orderLine: 1, quantity: 6 }],
      excludeOrderLines: [2, 3],
    });
    const over = mapReceiptLines(lines, [
      { lineId: '1', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 4 },
      { lineId: 'prov-2', itemNetsuiteId: '55', itemNumber: 'BRACKET', quantity: 3 },
    ]);
    expect(over.ok).toBe(false);
  });

  it('refuses an unknown line with no item id to fall back on', () => {
    const r = mapReceiptLines(lines, [
      { lineId: 'prov-1', itemNetsuiteId: null, itemNumber: 'MYSTERY', quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no matching line');
  });
});
