import { describe, it, expect, vi } from 'vitest';
import { checkPoItemIds, findRemovedItemIds, itemIdFixNote, itemIdProblem } from './stale-item-ids';
import { retireRemovedParts, shouldRetireRemovedParts } from './parts-sync';

// A fake NetSuite item table answering the two queries checkPoItemIds sends.
function fakeNetsuite(items: { id: string; itemid: string; isinactive?: 'T' | 'F' }[]) {
  return vi.fn(async (sql: string) => {
    const byId = sql.match(/WHERE id IN \(([^)]*)\)/);
    if (byId) {
      const ids = byId[1].split(',').map(s => s.trim());
      return items.filter(i => ids.includes(i.id)).map(i => ({ id: i.id, isinactive: i.isinactive || 'F' }));
    }
    const byNumber = sql.match(/UPPER\(itemid\) IN \((.*)\)$/);
    if (byNumber) {
      const nums = [...byNumber[1].matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
      return items.filter(i => nums.includes(i.itemid.toUpperCase())).map(i => ({ id: i.id, itemid: i.itemid, isinactive: i.isinactive || 'F' }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe('checkPoItemIds', () => {
  it('passes items NetSuite has and are active, with one query', async () => {
    const q = fakeNetsuite([{ id: '30068', itemid: 'BAK448146' }]);
    const out = await checkPoItemIds([{ itemId: '30068', itemNumber: 'BAK448146' }], q);
    expect(out.get('30068')).toEqual({ kind: 'ok', itemNumber: 'BAK448146', id: '30068' });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('finds the new id of a part that was deleted and re-created (the BAK448146 case)', async () => {
    const q = fakeNetsuite([{ id: '30068', itemid: 'BAK448146' }]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'BAK448146' }], q);
    expect(out.get('29866')).toEqual({ kind: 'moved', itemNumber: 'BAK448146', oldId: '29866', newId: '30068' });
  });

  it('matches the item number regardless of case and a parent path', async () => {
    const q = fakeNetsuite([{ id: '30068', itemid: 'bak448146' }]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'Covers : BAK448146' }], q);
    expect(out.get('29866')?.kind).toBe('moved');
  });

  it('moves off an inactive item when an active one has its number', async () => {
    const q = fakeNetsuite([
      { id: '29866', itemid: 'BAK448146', isinactive: 'T' },
      { id: '30068', itemid: 'BAK448146' },
    ]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'BAK448146' }], q);
    expect(out.get('29866')).toMatchObject({ kind: 'moved', newId: '30068' });
  });

  it('says inactive when the item is inactive and nothing replaces it', async () => {
    const q = fakeNetsuite([{ id: '29866', itemid: 'BAK448146', isinactive: 'T' }]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'BAK448146' }], q);
    expect(out.get('29866')?.kind).toBe('inactive');
    expect(itemIdProblem(out.get('29866')!)).toBe('BAK448146 is inactive in NetSuite. Make it active there, then try again.');
  });

  it('says gone when no item has the number anymore', async () => {
    const q = fakeNetsuite([]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'BAK448146' }], q);
    expect(out.get('29866')?.kind).toBe('gone');
    expect(itemIdProblem(out.get('29866')!)).toMatch(/isn’t in NetSuite anymore \(item 29866 was deleted\)/);
  });

  it('refuses to guess between two active items with the same number', async () => {
    const q = fakeNetsuite([{ id: '30068', itemid: 'BAK448146' }, { id: '30070', itemid: 'BAK448146' }]);
    const out = await checkPoItemIds([{ itemId: '29866', itemNumber: 'BAK448146' }], q);
    expect(out.get('29866')).toMatchObject({ kind: 'ambiguous', ids: ['30068', '30070'] });
    expect(itemIdProblem(out.get('29866')!)).toMatch(/can’t tell which one/);
  });

  it("quotes item numbers safely", async () => {
    const q = fakeNetsuite([{ id: '5', itemid: "O'BRIEN-1" }]);
    const out = await checkPoItemIds([{ itemId: '4', itemNumber: "O'BRIEN-1" }], q);
    expect(out.get('4')).toMatchObject({ kind: 'moved', newId: '5' });
  });

  it('checks each id once and ignores non-numeric ids', async () => {
    const q = fakeNetsuite([{ id: '1', itemid: 'A' }]);
    const out = await checkPoItemIds([{ itemId: '1', itemNumber: 'A' }, { itemId: '1', itemNumber: 'A' }, { itemId: 'abc', itemNumber: 'B' }], q);
    expect([...out.keys()]).toEqual(['1']);
  });

  it('ok results raise no problem', () => {
    expect(itemIdProblem({ kind: 'ok', itemNumber: 'A', id: '1' })).toBeNull();
    expect(itemIdProblem({ kind: 'moved', itemNumber: 'A', oldId: '1', newId: '2' })).toBeNull();
    expect(itemIdFixNote({ kind: 'moved', itemNumber: 'BAK448146', oldId: '29866', newId: '30068' }))
      .toBe('BAK448146 had an old NetSuite item ID (29866). FleetSuite switched it to the current one (30068).');
  });
});

describe('findRemovedItemIds', () => {
  const live = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

  it('returns catalog ids NetSuite no longer has', async () => {
    const q = vi.fn(async () => live(300).filter(r => r.id !== '7'));
    expect(await findRemovedItemIds(Array.from({ length: 300 }, (_, i) => String(i + 1)), q)).toEqual(['7']);
  });

  it('retires nothing when NetSuite returns nothing', async () => {
    expect(await findRemovedItemIds(['1', '2'], vi.fn(async () => []))).toEqual([]);
  });

  it('refuses a read that would retire a big share of the catalog', async () => {
    const catalog = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    await expect(findRemovedItemIds(catalog, vi.fn(async () => live(500)))).rejects.toThrow(/nothing was retired/);
  });
});

describe('retireRemovedParts', () => {
  it('marks only the removed NetSuite parts inactive', async () => {
    const updates: string[][] = [];
    const select = {
      eq() { return this; }, not() { return this; }, order() { return this; },
      range: async () => ({ data: [{ netsuite_id: '29866' }, { netsuite_id: '30068' }], error: null }),
    };
    const service: any = {
      from: () => ({
        select: () => select,
        update: () => ({ in: async (_c: string, ids: string[]) => { updates.push(ids); return { error: null }; } }),
      }),
    };
    const findRemoved = vi.fn(async (ids: string[]) => ids.filter(id => id === '29866'));
    expect(await retireRemovedParts(service, findRemoved)).toBe(1);
    expect(findRemoved).toHaveBeenCalledWith(['29866', '30068']);
    expect(updates).toEqual([['29866']]);
  });
});

describe('shouldRetireRemovedParts', () => {
  it('runs on the 3 AM Central hour only', () => {
    expect(shouldRetireRemovedParts(new Date('2026-11-05T09:37:00Z'))).toBe(true); // 3:37 AM CST
    expect(shouldRetireRemovedParts(new Date('2026-11-05T10:37:00Z'))).toBe(false);
    expect(shouldRetireRemovedParts(new Date('2026-07-05T08:37:00Z'))).toBe(true); // 3:37 AM CDT
  });
});
