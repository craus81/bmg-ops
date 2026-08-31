import { describe, it, expect } from 'vitest';
import {
  FALLBACK_SALES_TAX_RATE,
  FALLBACK_SALES_TAX_RATE_PCT,
  formatTaxRate,
  getSalesTaxRate,
  getSalesTaxRatePct,
  pctToRate,
  rateToPct,
} from './sales-tax';

function stubClient(result: { data?: any; error?: any } | (() => never)) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (typeof result === 'function') result();
            return result as any;
          },
        }),
      }),
    }),
  };
}

describe('percent/fraction conversion', () => {
  it('converts the stored percent to the fraction estimates store', () => {
    expect(pctToRate(7.95)).toBeCloseTo(0.0795, 10);
    expect(pctToRate('8.25')).toBeCloseTo(0.0825, 10);
    expect(rateToPct(0.0795)).toBeCloseTo(7.95, 10);
  });

  it('keeps 0% as 0 — a tax-free jurisdiction is not a missing value', () => {
    expect(pctToRate(0)).toBe(0);
    expect(rateToPct(0)).toBe(0);
  });

  it('falls back rather than producing NaN on garbage', () => {
    expect(pctToRate('abc')).toBe(FALLBACK_SALES_TAX_RATE);
    expect(rateToPct(null as any)).toBe(FALLBACK_SALES_TAX_RATE_PCT);
  });

  it('formats the way the documents render it', () => {
    expect(formatTaxRate(0.0795)).toBe('7.95%');
    expect(formatTaxRate(0.1)).toBe('10.00%');
  });
});

describe('getSalesTaxRate', () => {
  it('reads the configured rate', async () => {
    const client = stubClient({ data: { sales_tax_rate_pct: 8.25 }, error: null });
    expect(await getSalesTaxRatePct(client)).toBe(8.25);
    expect(await getSalesTaxRate(client)).toBeCloseTo(0.0825, 10);
  });

  it('honours a configured 0%', async () => {
    const client = stubClient({ data: { sales_tax_rate_pct: 0 }, error: null });
    expect(await getSalesTaxRate(client)).toBe(0);
  });

  it('falls back to the historical rate when the row is missing', async () => {
    const client = stubClient({ data: null, error: null });
    expect(await getSalesTaxRate(client)).toBe(FALLBACK_SALES_TAX_RATE);
  });

  it('falls back on a query error instead of quoting 0% tax', async () => {
    const client = stubClient({ data: null, error: { message: 'boom' } });
    expect(await getSalesTaxRate(client)).toBe(FALLBACK_SALES_TAX_RATE);
  });

  it('falls back when the client throws', async () => {
    const client = stubClient(() => { throw new Error('offline'); });
    expect(await getSalesTaxRate(client)).toBe(FALLBACK_SALES_TAX_RATE);
  });
});
