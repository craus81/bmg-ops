import { describe, it, expect } from 'vitest';
import { formatHistoryAddress, historySearchTerms, historyStatus, isLedgerReader } from './history';

describe('historySearchTerms', () => {
  it('lowercases, splits and de-duplicates words', () => {
    expect(historySearchTerms('  Transit  SHELVING transit ')).toEqual(['transit', 'shelving']);
  });

  it('turns PostgREST syntax characters into word breaks instead of passing them through', () => {
    // Commas and parentheses would split or nest an .or() filter; * and % are wildcards.
    expect(historySearchTerms('a,b (c) "d" 5% e*f')).toEqual(['a', 'b', 'c', 'd', '5', 'e']);
    expect(historySearchTerms('g_h\\i')).toEqual(['g', 'h', 'i']);
  });

  it('caps the word count so one search cannot fan out into dozens of filters', () => {
    expect(historySearchTerms('one two three four five six seven eight')).toHaveLength(6);
  });

  it('returns nothing for an empty or symbol-only search', () => {
    expect(historySearchTerms('')).toEqual([]);
    expect(historySearchTerms(null)).toEqual([]);
    expect(historySearchTerms(' ,() ')).toEqual([]);
  });
});

describe('historyStatus', () => {
  it('reads a paid invoice as Paid', () => {
    expect(historyStatus({ doc_type: 'invoice', paid: true, balance: 0 })).toEqual({ label: 'Paid', paid: true });
    expect(historyStatus({ doc_type: 'invoice', paid: null, balance: '0.00' })).toEqual({ label: 'Paid', paid: true });
  });

  it('never turns a QuickBooks balance into an open amount', () => {
    const s = historyStatus({ doc_type: 'invoice', paid: false, balance: 1250 });
    expect(s).toEqual({ label: 'Unpaid in QuickBooks', paid: false });
    expect(s.label).not.toMatch(/\d/);
  });

  it('names voided rows and falls back to the estimate status', () => {
    expect(historyStatus({ doc_type: 'invoice', voided: true, paid: true }).label).toBe('Voided');
    expect(historyStatus({ doc_type: 'estimate', status_label: 'Accepted' }).label).toBe('Accepted');
    expect(historyStatus({ doc_type: 'estimate' }).label).toBe('Estimate');
    expect(historyStatus({ doc_type: 'credit_memo' }).label).toBe('Closed');
  });
});

describe('isLedgerReader', () => {
  it('admits the migration 314 reader tier and not sales', () => {
    expect(isLedgerReader(['finance'])).toBe(true);
    expect(isLedgerReader(['executive'])).toBe(true);
    expect(isLedgerReader(['super_admin'])).toBe(true);
    expect(isLedgerReader(['sales'])).toBe(false);
    expect(isLedgerReader([])).toBe(false);
    expect(isLedgerReader(null)).toBe(false);
  });
});

describe('formatHistoryAddress', () => {
  it('renders a QuickBooks address as lines', () => {
    expect(formatHistoryAddress({ Line1: 'Acme Fleet', Line2: '12 Main St', City: "O'Fallon", CountrySubDivisionCode: 'MO', PostalCode: '63366' }))
      .toBe("Acme Fleet\n12 Main St\nO'Fallon MO 63366");
  });

  it('returns null for nothing usable', () => {
    expect(formatHistoryAddress(null)).toBeNull();
    expect(formatHistoryAddress({})).toBeNull();
  });
});
