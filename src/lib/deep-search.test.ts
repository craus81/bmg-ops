import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepSearch, deepSearchPhrase, excerpt, type DeepSearchAccess } from '@/lib/deep-search';
import type { FeatureKey } from '@/lib/features';

/** A query-builder stand-in: records the tables read, answers every query empty. */
function fakeService() {
  const tables: string[] = [];
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], count: 0, error: null });
      return () => chain;
    },
  });
  const service = { from: (t: string) => { tables.push(t); return chain; } } as unknown as SupabaseClient;
  return { service, tables };
}

const access = (over: { money?: boolean; ledgerReader?: boolean; features?: FeatureKey[] } = {}): DeepSearchAccess => ({
  money: over.money ?? false,
  ledgerReader: over.ledgerReader ?? false,
  features: new Set(over.features ?? []),
});

describe('deepSearchPhrase', () => {
  it('needs three characters after cleaning', () => {
    expect(deepSearchPhrase('ab')).toBeNull();
    expect(deepSearchPhrase('(a)')).toBeNull();
    expect(deepSearchPhrase('abc')).toBe('abc');
  });

  it('strips characters that would break a PostgREST filter', () => {
    expect(deepSearchPhrase('Ford, (Transit) "148"')).toBe('ford transit 148');
  });
});

describe('excerpt', () => {
  it('keeps short text whole', () => {
    expect(excerpt('  rack on   roof ', 'rack')).toBe('rack on roof');
  });

  it('centers on the hit in long text', () => {
    const text = 'x'.repeat(200) + ' ladder rack ' + 'y'.repeat(200);
    const out = excerpt(text, 'ladder rack', 60)!;
    expect(out).toContain('ladder rack');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is null for empty text', () => {
    expect(excerpt(null, 'abc')).toBeNull();
  });
});

describe('deepSearch access', () => {
  it('runs nothing for a short query', async () => {
    const { service, tables } = fakeService();
    await deepSearch(service, 'ab', access({ money: true, ledgerReader: true }), { limit: 5, includeBills: true });
    expect(tables).toEqual([]);
  });

  it('keeps billing and bills away from a shop tech', async () => {
    const { service, tables } = fakeService();
    await deepSearch(service, 'transit', access({ features: ['in_shop', 'parts_ordering'] }), { limit: 5, includeBills: true });
    expect(tables).not.toContain('ledger_invoices');
    expect(tables).not.toContain('netsuite_sales_orders');
    expect(tables).not.toContain('ledger_bills');
    expect(tables).not.toContain('estimates');
    // Their own pages: vehicle notes and vendor POs (receiving).
    expect(tables).toContain('vehicle_notes');
    expect(tables).toContain('netsuite_vendor_pos');
    expect(tables).not.toContain('po_notes');
  });

  it('gives money roles QuickBooks history and NetSuite memos', async () => {
    const { service, tables } = fakeService();
    await deepSearch(service, 'transit', access({ money: true, features: ['estimates'] }), { limit: 5, includeBills: true });
    expect(tables).toContain('ledger_invoices');
    expect(tables).toContain('netsuite_sales_orders');
    expect(tables).toContain('estimates');
    expect(tables).not.toContain('ledger_bills');
  });

  it('searches bills only for ledger readers on the full page', async () => {
    const top = fakeService();
    await deepSearch(top.service, 'transit', access({ money: true, ledgerReader: true }), { limit: 5, includeBills: false });
    expect(top.tables).not.toContain('ledger_bills');

    const full = fakeService();
    await deepSearch(full.service, 'transit', access({ money: true, ledgerReader: true }), { limit: 25, includeBills: true });
    expect(full.tables).toContain('ledger_bills');
    expect(full.tables).toContain('ledger_bill_lines');
  });
});
