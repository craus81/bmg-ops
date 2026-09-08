import { describe, it, expect } from 'vitest';
import { matchVendor, vendorKey } from './vendor-master';

const master = [
  { company_name: 'Grimco Inc', entity_id: 'GRIMCO' },
  { company_name: 'Fellers', entity_id: 'FELLERS' },
  { company_name: 'General Formulations', entity_id: 'GENFORM' },
];

describe('vendorKey', () => {
  it('collapses the spelling differences that split one vendor into three', () => {
    expect(vendorKey('  GRIMCO ')).toBe('grimco');
    expect(vendorKey('Grimco, Inc.')).toBe('grimco inc');
    expect(vendorKey(null)).toBe('');
  });
});

describe('matchVendor', () => {
  it('matches on company name or entity id, case- and punctuation-insensitively', () => {
    expect(matchVendor('grimco inc', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('GRIMCO', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('Fellers', master)?.entity_id).toBe('FELLERS');
  });

  it('resolves a unique prefix but refuses a blank or unknown name', () => {
    expect(matchVendor('Grimco', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('', master)).toBeNull();
    expect(matchVendor('Nobody Supply Co', master)).toBeNull();
  });
});
