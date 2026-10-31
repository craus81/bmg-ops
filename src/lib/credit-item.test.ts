import { describe, it, expect, vi } from 'vitest';

const suiteqlQuery = vi.fn();
vi.mock('./netsuite', () => ({ suiteqlQuery: (...args: unknown[]) => suiteqlQuery(...args) }));

import { CREDIT_ITEM_TYPES, configuredCreditItem, creditItemCandidates, rankCreditItems } from './credit-item';

const settings = (row: Record<string, unknown> | null, throws = false) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          if (throws) throw new Error('down');
          return { data: row, error: null };
        },
      }),
    }),
  }),
});

describe('the credit item', () => {
  it('is the item Settings names, and nothing until it names one', async () => {
    expect(await configuredCreditItem(settings({ netsuite_credit_item_id: ' 900 ', netsuite_credit_item_number: 'CREDIT' })))
      .toEqual({ id: '900', itemNumber: 'CREDIT' });
    expect(await configuredCreditItem(settings({ netsuite_credit_item_id: '900', netsuite_credit_item_number: null }))).toEqual({ id: '900', itemNumber: null });
    expect(await configuredCreditItem(settings({ netsuite_credit_item_id: null }))).toBeNull();
    expect(await configuredCreditItem(settings({ netsuite_credit_item_id: 'abc' }))).toBeNull();
    expect(await configuredCreditItem(settings(null))).toBeNull();
    expect(await configuredCreditItem(settings(null, true))).toBeNull();
  });

  it('can only be an item NetSuite keeps no stock of', () => {
    expect([...CREDIT_ITEM_TYPES].sort()).toEqual(['NonInvtPart', 'OthCharge', 'Service']);
  });

  it("offers NetSuite's likely items first, never a stock item or a card fee", () => {
    const rows = [
      { id: 1, itemid: 'RETURN SHIPPING', itemtype: 'OthCharge' },
      { id: 2, itemid: 'CREDIT', itemtype: 'OthCharge' },
      { id: 3, itemid: 'CREDIT CARD FEE', itemtype: 'OthCharge' },
      { id: 4, itemid: 'CREDIT-RACK', itemtype: 'InvtPart' },
      { id: 5, itemid: 'Goodwill Credit', itemtype: 'Service' },
      { id: 6, itemid: 'PRICE ADJUSTMENT', itemtype: 'NonInvtPart' },
      { id: 7, itemid: 'SHELF-1', itemtype: 'NonInvtPart' },
      { id: 8, itemid: 'CREDIT MEMO', itemtype: 'NonInvtPart' },
    ];
    expect(rankCreditItems(rows).map((r) => r.itemid)).toEqual(['CREDIT', 'CREDIT MEMO', 'Goodwill Credit', 'PRICE ADJUSTMENT', 'RETURN SHIPPING']);
  });

  it("looks for them in NetSuite, and says when it can't", async () => {
    suiteqlQuery.mockResolvedValueOnce({ items: [{ id: '2', itemid: 'CREDIT', itemtype: 'OthCharge' }] });
    expect(await creditItemCandidates()).toEqual({ candidates: [{ id: '2', itemNumber: 'CREDIT', itemType: 'OthCharge' }] });
    expect(String(suiteqlQuery.mock.calls[0][0])).toContain("i.itemtype IN ('NonInvtPart', 'OthCharge', 'Service')");
    suiteqlQuery.mockRejectedValueOnce(new Error('NetSuite timed out'));
    expect(await creditItemCandidates()).toEqual({ candidates: [], error: 'NetSuite timed out' });
  });
});
