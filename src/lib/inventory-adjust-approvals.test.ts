// The rules for approving adjustments (src/lib/inventory-adjust-approvals.ts):
// what an ask says, when one can be settled by hand, and which of Inventory
// Adjust's errors leave FleetSuite not knowing whether NetSuite posted it.
// Made-up data.
import { describe, it, expect } from 'vitest';
import {
  NOT_NOW_TEXT, OPEN_STATUSES, STALE_MS, STATUS_TEXT, approvedByName, askFromRow, describeAsk, leavesUnsure, needsSettling, openText,
  sentence, workOutAsk,
} from './inventory-adjust-approvals';

const ROW = {
  id: 'c0000000-0000-4000-8000-000000000001', part_id: 'b0000000-0000-4000-8000-000000000001', netsuite_item_id: '6140',
  item_number: 'LR-48', location_id: '1', mode: 'count', entered_qty: 12, on_hand_then: 9, change: 3, reason: 'Count correction',
  note: '', status: 'waiting', asked_by: 'a0000000-0000-4000-8000-000000000002', asked_by_name: 'Jessie', asked_at: '2027-04-06T14:00:00Z',
  sent_by_name: null, sent_at: null, decided_by_name: null, decided_at: null, why: null, netsuite_adjustment_number: null, error: null,
  warning: null,
};

describe('approving adjustments', () => {
  it('reads an ask as the pages show it', () => {
    expect(askFromRow(ROW, 'Ladder rack 48 in')).toEqual({
      id: ROW.id, netsuiteItemId: '6140', itemNumber: 'LR-48', displayName: 'Ladder rack 48 in', locationId: '1', mode: 'count',
      enteredQty: 12, onHandThen: 9, change: 3, reason: 'Count correction', note: null, status: 'waiting',
      askedBy: 'a0000000-0000-4000-8000-000000000002', askedByName: 'Jessie', askedAt: '2027-04-06T14:00:00Z', sentByName: null, sentAt: null,
      decidedByName: null, decidedAt: null, why: null, netsuiteNumber: null, error: null, warning: null,
    });
    // Numbers as text, as some reads give them, and anything else for the mode reads as a change.
    expect(askFromRow({ ...ROW, mode: 'delta', entered_qty: '-2', on_hand_then: '7', change: '-2' })).toMatchObject({
      mode: 'delta', enteredQty: -2, onHandThen: 7, change: -2, displayName: null,
    });
    expect(askFromRow({ ...ROW, mode: 'set' }).mode).toBe('delta');
    expect(askFromRow({ ...ROW, note: 'Recounted', why: 7 })).toMatchObject({ note: 'Recounted', why: null });
  });

  it('says what it asks, and why another must wait', () => {
    expect(describeAsk({ mode: 'count', enteredQty: 12, onHandThen: 9, change: 3 })).toBe('Shelf count 12 · 9 on hand then → 12 (+3)');
    expect(describeAsk({ mode: 'count', enteredQty: 0, onHandThen: 3, change: -3 })).toBe('Shelf count 0 · 3 on hand then → 0 (−3)');
    expect(describeAsk({ mode: 'delta', enteredQty: -2, onHandThen: 7, change: -2 })).toBe('Take 2 away · 7 on hand then → 5');
    expect(describeAsk({ mode: 'delta', enteredQty: 4, onHandThen: 0, change: 4 })).toBe('Add 4 · 0 on hand then → 4');
    const ask = askFromRow(ROW);
    expect(openText(ask)).toBe(
      'LR-48 has an adjustment waiting for approval, asked by Jessie: Shelf count 12 · 9 on hand then → 12 (+3). '
      + "It's approved, turned down or withdrawn on Adjustments to approve before another can be made.",
    );
    expect(openText({ ...ask, status: 'sending', askedByName: null })).toMatch(/^LR-48 has an adjustment being posted to NetSuite, asked by someone: /);
    expect(openText({ ...ask, status: 'unsure' })).toMatch(/^LR-48 has an adjustment that NetSuite didn't say whether it took, asked by Jessie: /);
  });

  it('has words for every status, and only three are open', () => {
    expect(OPEN_STATUSES).toEqual(['waiting', 'sending', 'unsure']);
    expect(Object.keys(STATUS_TEXT)).toEqual(['waiting', 'sending', 'unsure', 'made', 'turned_down', 'withdrawn']);
    expect(Object.keys(NOT_NOW_TEXT)).toEqual(Object.keys(STATUS_TEXT));
    expect(STATUS_TEXT.unsure).toBe("Posted, but NetSuite didn't say whether it took it");
  });

  it('can be settled by hand once NetSuite didn\'t say, or a press has said it\'s posting too long', () => {
    const now = Date.parse('2027-04-07T14:10:00Z');
    const sent = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    expect(STALE_MS).toBe(5 * 60_000);
    expect(needsSettling({ status: 'unsure', sentAt: sent(1) }, now)).toBe(true);
    expect(needsSettling({ status: 'sending', sentAt: sent(4.9) }, now)).toBe(false);
    expect(needsSettling({ status: 'sending', sentAt: sent(5) }, now)).toBe(true);
    expect(needsSettling({ status: 'sending', sentAt: null }, now)).toBe(false);
    for (const status of ['waiting', 'made', 'turned_down', 'withdrawn'] as const) {
      expect(needsSettling({ status, sentAt: sent(60) }, now)).toBe(false);
    }
    expect(needsSettling({ status: 'sending', sentAt: new Date(Date.now() - 6 * 60_000).toISOString() })).toBe(true);
  });

  it("knows which of Adjust's errors may have been posted anyway", () => {
    expect(leavesUnsure("Couldn't reach NetSuite: fetch failed")).toBe(true);
    expect(leavesUnsure('NetSuite refused the adjustment (500): Unexpected error')).toBe(true);
    expect(leavesUnsure('NetSuite refused the adjustment (503): Service Unavailable')).toBe(true);
    expect(leavesUnsure('NetSuite refused the adjustment (302): Found')).toBe(true);
    expect(leavesUnsure('NetSuite refused the adjustment (400): Invalid account')).toBe(false);
    expect(leavesUnsure('NetSuite refused the adjustment (499): Closed')).toBe(false);
    expect(leavesUnsure('NetSuite refused the adjustment (401): Invalid login')).toBe(false);
    expect(leavesUnsure('NetSuite refused the adjustment.')).toBe(false);
    expect(leavesUnsure("Couldn't read the current count from NetSuite: timeout")).toBe(false);
    expect(leavesUnsure("Couldn't find account 52000 Inventory Adjustment in NetSuite.")).toBe(false);
    expect(leavesUnsure("That would leave -1 on hand. NetSuite can't go below 0. Check the count.")).toBe(false);
    expect(leavesUnsure("Something Couldn't reach NetSuite")).toBe(false);
    expect(leavesUnsure('Saved, but NetSuite refused the adjustment (500): Unexpected error')).toBe(false);
  });

  it('works an ask out by Adjust\'s rules, as a whole change', () => {
    expect(workOutAsk('delta', -2, 7)).toEqual({ change: -2, after: 5 });
    expect(workOutAsk('count', 12, 9)).toEqual({ change: 3, after: 12 });
    expect(workOutAsk('delta', 0, 7)).toEqual({ error: 'Enter a change other than 0.' });
    expect(workOutAsk('count', 12.5, 9)).toEqual({ error: 'Enter a whole number.' });
    expect(workOutAsk('count', 10, 9.25)).toEqual({
      error: "NetSuite shows 9.25 on hand, which isn't a whole number, so a shelf count can't be asked for. Add or remove a whole number instead.",
    });
  });

  it('ends a sentence once, and names who approved it', () => {
    expect(sentence('NetSuite refused the adjustment (400): Invalid account')).toBe('NetSuite refused the adjustment (400): Invalid account.');
    expect(sentence('Check the count. ')).toBe('Check the count.');
    expect(sentence('Really?')).toBe('Really?');
    expect(sentence('Stop!')).toBe('Stop!');
    expect(approvedByName('Jessie', 'Craig')).toBe('Jessie, approved by Craig');
    expect(approvedByName(null, null)).toBe('Someone, approved by a super admin');
    expect(approvedByName('', 'Craig')).toBe('Someone, approved by Craig');
  });
});
