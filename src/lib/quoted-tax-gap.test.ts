import { describe, it, expect } from 'vitest';
import { summarizeTaxGap, bucketFor, type TaxGapEstimate, type TaxGapLine } from './quoted-tax-gap';

const est = (o: Partial<TaxGapEstimate> & { id: string }): TaxGapEstimate => ({
  estimate_number: `EST-${o.id}`,
  customer_name: 'Acme Fleet',
  status: 'sent',
  tax_rate: 0.0795,
  tax_exempt: false,
  tax_amount: 0,
  vehicle_count: 1,
  labor_rate: 115,
  labor_hours_override: null,
  customer_approved: false,
  customer_approved_at: null,
  sent_for_approval_at: null,
  netsuite_estimate_number: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  ...o,
});

const line = (estimate_id: string, quantity: number, unit_price: number): TaxGapLine =>
  ({ estimate_id, quantity, unit_price });

describe('summarizeTaxGap', () => {
  // The field case: $6,848.61 of parts excluded, only $175 of freight taxed.
  // 6848.61 × 7.95% = 544.46 and 175 × 7.95% = 13.91, so the quote carried
  // 13.91 where it should have carried 558.37.
  it('finds the shortfall on the estimate that started this', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_amount: 13.91 })],
      [line('a', 1, 6848.61), line('a', 1, 175)],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].correct_tax).toBe(558.37);
    expect(r.rows[0].quoted_tax).toBe(13.91);
    expect(r.rows[0].gap).toBe(544.46);
    expect(r.totalGap).toBe(544.46);
  });

  it('leaves an estimate alone when its saved tax already agrees', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_amount: 558.37 })],
      [line('a', 1, 6848.61), line('a', 1, 175)],
    );
    expect(r.rows).toEqual([]);
    expect(r.examined).toBe(1);
  });

  it('never lists a tax-exempt customer, whatever the saved tax says', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_exempt: true, tax_amount: 0 })],
      [line('a', 1, 10000)],
    );
    expect(r.rows).toEqual([]);
    expect(r.skippedExempt).toBe(1);
    expect(r.examined).toBe(0);
  });

  it('never lists a zero-rated estimate — there is nothing to under-charge', () => {
    const r = summarizeTaxGap([est({ id: 'a', tax_rate: 0, tax_amount: 0 })], [line('a', 1, 10000)]);
    expect(r.rows).toEqual([]);
    expect(r.skippedExempt).toBe(1);
  });

  it('skips an estimate with no lines rather than calling it short', () => {
    const r = summarizeTaxGap([est({ id: 'a', tax_amount: 0 })], []);
    expect(r.rows).toEqual([]);
    expect(r.skippedNoLines).toBe(1);
    expect(r.examined).toBe(0);
  });

  it('counts an OVER-quoted estimate instead of listing it', () => {
    // The old freight case: tax charged on a line NetSuite did not tax.
    const r = summarizeTaxGap([est({ id: 'a', tax_amount: 100 })], [line('a', 1, 1000)]);
    expect(r.rows).toEqual([]);
    expect(r.overQuoted).toEqual({ count: 1, gap: 20.5 }); // 79.50 correct vs 100 quoted
  });

  it('ignores a sub-cent difference as float dust', () => {
    const r = summarizeTaxGap([est({ id: 'a', tax_amount: 79.5 })], [line('a', 1, 1000)]);
    expect(r.rows).toEqual([]);
    expect(r.overQuoted.count).toBe(0);
  });

  it('multiplies by the vehicle count, where the gap is biggest', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', vehicle_count: 10, tax_amount: 0 })],
      [line('a', 1, 500)],
    );
    expect(r.rows[0].correct_tax).toBe(397.5); // 5000 × 7.95%
    expect(r.rows[0].vehicle_count).toBe(10);
  });

  it('books tax per line, as the save path does', () => {
    // Two $150 lines are $11.925 each — a tie, so each books DOWN to 11.92,
    // giving 23.84. Taxing the $300 combined base would give 23.85.
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_amount: 0 })],
      [line('a', 1, 150), line('a', 1, 150)],
    );
    expect(r.rows[0].correct_tax).toBe(23.84);
  });

  it('sorts the biggest shortfall first and totals the lot', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_amount: 0 }), est({ id: 'b', tax_amount: 0 })],
      [line('a', 1, 100), line('b', 1, 1000)],
    );
    expect(r.rows.map(x => x.id)).toEqual(['b', 'a']);
    expect(r.totalGap).toBe(87.45); // 79.50 + 7.95
  });

  it('buckets by what someone has to do about it', () => {
    const r = summarizeTaxGap(
      [
        est({ id: 'signed', tax_amount: 0, customer_approved: true, customer_approved_at: '2026-07-01T00:00:00Z', sent_for_approval_at: '2026-06-20T00:00:00Z' }),
        est({ id: 'sent', tax_amount: 0, sent_for_approval_at: '2026-06-20T00:00:00Z' }),
        est({ id: 'open', tax_amount: 0 }),
      ],
      [line('signed', 1, 1000), line('sent', 1, 1000), line('open', 1, 1000)],
    );
    expect(r.buckets.signed).toEqual({ count: 1, gap: 79.5 });
    expect(r.buckets.sent).toEqual({ count: 1, gap: 79.5 });
    expect(r.buckets.open).toEqual({ count: 1, gap: 79.5 });
  });

  it('calls an approved estimate signed even though it was also sent', () => {
    expect(bucketFor({ customer_approved: true, sent_for_approval_at: '2026-06-20T00:00:00Z' })).toBe('signed');
    expect(bucketFor({ customer_approved: false, sent_for_approval_at: '2026-06-20T00:00:00Z' })).toBe('sent');
    expect(bucketFor({ customer_approved: null, sent_for_approval_at: null })).toBe('open');
  });

  it('links every row at the estimate that needs fixing, not the list page', () => {
    const r = summarizeTaxGap([est({ id: 'abc', tax_amount: 0 })], [line('abc', 1, 1000)]);
    expect(r.rows[0].url).toBe('/estimates?id=abc');
  });

  it('does not attribute one estimate’s lines to another', () => {
    const r = summarizeTaxGap(
      [est({ id: 'a', tax_amount: 0 }), est({ id: 'b', tax_amount: 79.5 })],
      [line('a', 1, 1000), line('b', 1, 1000)],
    );
    expect(r.rows.map(x => x.id)).toEqual(['a']);
    expect(r.examined).toBe(2);
  });
});
