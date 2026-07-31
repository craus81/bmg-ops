import { describe, it, expect } from 'vitest';
import { matchInvoicesToPos, normalizePoRef, poNumberFromMemo, type AuditInvoice, type AuditPo } from './po-invoice-audit';

const inv = (over: Partial<AuditInvoice>): AuditInvoice => ({
  id: '1',
  tranid: 'INV1',
  trandate: '2026-07-01',
  otherrefnum: null,
  memo: null,
  customerName: 'Masterack',
  ...over,
});

const pos: AuditPo[] = [
  { id: 'po-a', poNumber: '35045953' },
  { id: 'po-b', poNumber: '4500123' },
];

const none = new Set<string>();
const noScans = new Map<string, Set<string>>();

describe('normalizePoRef', () => {
  it('agrees across the common reference formats', () => {
    for (const raw of ['35045953', ' 35045953 ', 'PO 35045953', 'po#35045953', 'PO-35045953', 'P.O. 35045953']) {
      expect(normalizePoRef(raw)).toBe('35045953');
    }
  });

  it('keeps a bare "PO" instead of normalizing it to nothing', () => {
    expect(normalizePoRef('PO')).toBe('PO');
    expect(normalizePoRef('')).toBe('');
    expect(normalizePoRef(null)).toBe('');
  });
});

describe('poNumberFromMemo', () => {
  it('pulls the number out of FleetSuite-style memos', () => {
    expect(poNumberFromMemo('Invoice from BMG FleetSuite — PO #35045953 (open quantities)')).toBe('35045953');
    expect(poNumberFromMemo('po 4500123 install work')).toBe('4500123');
    expect(poNumberFromMemo('no reference here')).toBeNull();
  });
});

describe('matchInvoicesToPos', () => {
  it('matches a reformatted Reference No. that exact sync would miss', () => {
    const { matches, ambiguous } = matchInvoicesToPos(
      [inv({ otherrefnum: 'PO# 35045953' })], pos, none, noScans,
    );
    expect(ambiguous).toEqual([]);
    expect(matches).toHaveLength(1);
    expect(matches[0].poId).toBe('po-a');
    expect(matches[0].reason).toBe('reference');
  });

  it('falls back to scan stamps when the reference is blank', () => {
    const scans = new Map([['INV1', new Set(['4500123'])]]);
    const { matches } = matchInvoicesToPos([inv({})], pos, none, scans);
    expect(matches).toHaveLength(1);
    expect(matches[0].poId).toBe('po-b');
    expect(matches[0].reason).toBe('scans');
  });

  it('falls back to the memo last', () => {
    const { matches } = matchInvoicesToPos(
      [inv({ memo: 'Invoice from BMG FleetSuite — PO #4500123' })], pos, none, noScans,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].poId).toBe('po-b');
    expect(matches[0].reason).toBe('memo');
  });

  it('lets a resolving reference outrank a contradicting memo', () => {
    const { matches } = matchInvoicesToPos(
      [inv({ otherrefnum: '35045953', memo: 'PO #4500123' })], pos, none, noScans,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].poId).toBe('po-a');
    expect(matches[0].reason).toBe('reference');
  });

  it('a reference naming an unknown PO falls through to weaker evidence', () => {
    const scans = new Map([['INV1', new Set(['4500123'])]]);
    const { matches } = matchInvoicesToPos(
      [inv({ otherrefnum: '99999999' })], pos, none, scans,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].poId).toBe('po-b');
    expect(matches[0].reason).toBe('scans');
  });

  it('skips invoices that are already linked', () => {
    const { matches, alreadyLinked, scanned } = matchInvoicesToPos(
      [inv({ id: '42', otherrefnum: '35045953' })], pos, new Set(['42']), noScans,
    );
    expect(matches).toEqual([]);
    expect(alreadyLinked).toBe(1);
    expect(scanned).toBe(0);
  });

  it('reports scans naming two different POs as ambiguous, never auto-matched', () => {
    const scans = new Map([['INV1', new Set(['35045953', '4500123'])]]);
    const { matches, ambiguous } = matchInvoicesToPos([inv({})], pos, none, scans);
    expect(matches).toEqual([]);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidates.sort()).toEqual(['35045953', '4500123']);
  });

  it('reports duplicate PO numbers as ambiguous', () => {
    const dupePos = [...pos, { id: 'po-c', poNumber: 'PO 4500123' }]; // normalizes same as po-b
    const { matches, ambiguous } = matchInvoicesToPos(
      [inv({ otherrefnum: '4500123' })], dupePos, none, noScans,
    );
    expect(matches).toEqual([]);
    expect(ambiguous).toHaveLength(1);
  });

  it('leaves a genuinely PO-less invoice alone', () => {
    const { matches, ambiguous, scanned } = matchInvoicesToPos(
      [inv({ otherrefnum: null, memo: 'ad-hoc graphics work' })], pos, none, noScans,
    );
    expect(matches).toEqual([]);
    expect(ambiguous).toEqual([]);
    expect(scanned).toBe(1);
  });
});
