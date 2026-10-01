import { describe, it, expect } from 'vitest';
import { isPartTaxable, isLineTaxable, partTaxReason, taxabilityResolver, resolveLineTaxability } from './line-taxability';

describe('isPartTaxable', () => {
  it('leaves NetSuite Service items untaxed by default', () => {
    expect(isPartTaxable({ item_type: 'Service' })).toBe(false);
  });

  it('taxes every other item type by default', () => {
    for (const t of ['InvtPart', 'NonInvtPart', 'Kit', 'Assembly', 'OthCharge', '', null, undefined]) {
      expect(isPartTaxable({ item_type: t })).toBe(true);
    }
  });

  it("an admin's override wins in either direction", () => {
    expect(isPartTaxable({ item_type: 'Service', taxable_override: true })).toBe(true);
    expect(isPartTaxable({ item_type: 'OthCharge', taxable_override: false })).toBe(false);
    expect(isPartTaxable({ item_type: 'Service', taxable_override: null })).toBe(false);
  });

  it('says why', () => {
    expect(partTaxReason({ item_type: 'Service' })).toBe('Not taxed (service item)');
    expect(partTaxReason({ item_type: 'InvtPart', taxable_override: false })).toBe('Not taxed (set by an admin)');
    expect(partTaxReason({ item_type: 'InvtPart' })).toBe('Taxed');
  });
});

describe('isLineTaxable', () => {
  it('only an explicit false leaves a line out', () => {
    expect(isLineTaxable({ taxable: false })).toBe(false);
    expect(isLineTaxable({ taxable: null })).toBe(true);
    expect(isLineTaxable({})).toBe(true);
  });
});

describe('taxabilityResolver', () => {
  const taxed = taxabilityResolver([
    { id: 'p-labor', netsuite_id: '501', item_number: 'Graphics Install Labor', item_type: 'Service' },
    { id: 'p-freight', netsuite_id: '502', item_number: 'Freight', item_type: 'OthCharge', taxable_override: false },
    { id: 'p-rack', netsuite_id: '503', item_number: '06U357', item_type: 'InvtPart' },
  ]);

  it('matches on part id, then NetSuite id, then item number (any case)', () => {
    expect(taxed({ part_id: 'p-labor' })).toBe(false);
    expect(taxed({ netsuite_item_id: '502' })).toBe(false);
    expect(taxed({ item_number: 'graphics install labor' })).toBe(false);
    expect(taxed({ item_number: ' FREIGHT ' })).toBe(false);
    expect(taxed({ part_id: 'p-rack' })).toBe(true);
  });

  it('taxes a line it cannot match', () => {
    expect(taxed({ item_number: 'Custom bracket', is_custom: true })).toBe(true);
    expect(taxed({})).toBe(true);
  });

  it('taxes a number two catalog rows disagree on', () => {
    const t = taxabilityResolver([
      { id: 'a', item_number: 'X1', item_type: 'Service' },
      { id: 'b', item_number: 'x1', item_type: 'InvtPart' },
    ]);
    expect(t({ item_number: 'X1' })).toBe(true);
  });
});

describe('resolveLineTaxability', () => {
  const fakeSupabase = (rows: any[], fail = false) => ({
    from: () => ({
      select: () => ({
        in: async (column: string, values: string[]) => (fail
          ? { data: null, error: { message: 'boom' } }
          : { data: rows.filter(r => values.includes(String(r[column === 'netsuite_id' ? 'netsuite_id' : column]))), error: null }),
      }),
    }),
  }) as any;

  it('stamps every line', async () => {
    const out = await resolveLineTaxability(fakeSupabase([
      { id: 'p1', netsuite_id: '9', item_number: 'Graphics Install Labor', item_type: 'Service' },
    ]), [
      { item_number: 'Graphics Install Labor', quantity: 1 },
      { item_number: 'BRACKET-1', quantity: 2 },
    ]);
    expect(out.map(l => l.taxable)).toEqual([false, true]);
    expect(out[1].quantity).toBe(2);
  });

  it('taxes everything when the catalog read fails', async () => {
    const out = await resolveLineTaxability(fakeSupabase([], true), [{ part_id: 'p1' }]);
    expect(out[0].taxable).toBe(true);
  });
});
