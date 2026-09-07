import { describe, it, expect } from 'vitest';
import { computeThreeWayMatch } from './three-way-match';

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
});
