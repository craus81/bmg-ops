import { describe, it, expect } from 'vitest';
import { customerAbbrev, cleanPoSuffix, withPoSuffix, suggestedPoSuffix } from './po-number';

describe('customerAbbrev', () => {
  it('takes the customer’s first real word', () => {
    expect(customerAbbrev('Acme Plumbing, LLC')).toBe('ACME');
    expect(customerAbbrev('The Roto-Rooter Company')).toBe('ROTOROOT');
    expect(customerAbbrev('Spectrum')).toBe('SPECTRUM');
  });
  it('joins short first words with the next one', () => {
    expect(customerAbbrev('A & B Fleet Co.')).toBe('ABFLEET');
    expect(customerAbbrev('JK Services Inc')).toBe('JKSERVIC');
  });
  it('is blank with no name', () => {
    expect(customerAbbrev(null)).toBe('');
    expect(customerAbbrev('  LLC ')).toBe('');
  });
});

describe('PO number ending', () => {
  it('cleans what was typed', () => {
    expect(cleanPoSuffix(' acme #2 ')).toBe('ACME2');
    expect(cleanPoSuffix('-stock-')).toBe('STOCK');
  });
  it('adds the ending once', () => {
    expect(withPoSuffix('PO453', 'acme')).toBe('PO453-ACME');
    expect(withPoSuffix('PO453-ACME', 'ACME')).toBe('PO453-ACME');
    expect(withPoSuffix('PO453', '')).toBe('PO453');
  });
  it('suggests the customer only when every line shares one', () => {
    expect(suggestedPoSuffix(['Acme Plumbing', 'ACME PLUMBING LLC'])).toBe('ACME');
    expect(suggestedPoSuffix(['Acme Plumbing', 'Spectrum'])).toBe('');
    expect(suggestedPoSuffix([null])).toBe('');
  });
});
