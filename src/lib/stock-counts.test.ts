import { describe, it, expect } from 'vitest';
import {
  COUNTED_MAX, MAX_LINES, NOT_NOW_TEXT, OPEN_STATUSES, STALE_MS, STATUS_TEXT, blockedFromRows, blockedText, countExternalId, countFromRow,
  averageCosts, byItemNumber, countLabel, countMemo, countWhat, defaultLocationId, describeLine, differenceOf, lineFromRow, movedWhileCounting,
  needsAsking, parseCounted, reviewCount,
  type CountLine, type CountStatus,
} from './stock-counts';

// How a count reads, adds up and is described (Books part 69): its rows as
// the pages show them, a count as typed, each item's difference from
// NetSuite's count when it was saved, and what the review totals come to.
// Made-up data: hitch parts counted at O'Fallon.

const line = (over: Partial<CountLine> = {}): CountLine => ({
  netsuiteItemId: '812', itemNumber: 'HITCH-2', displayName: 'Hitch, 2 in.', position: 1, onHandStart: 9, counted: null,
  onHandThen: null, countedByName: null, countedAt: null, ...over,
});

const ROW = {
  id: 'c0000000-0000-4000-8000-000000000001', number: 7, location_id: '1', location_name: "O'Fallon", what: 'Everything NetSuite has on hand',
  count_date: '2027-09-15', status: 'asked', started_by: 'a0000000-0000-4000-8000-000000000001', started_by_name: 'Jessie Test',
  started_at: '2027-09-15T13:00:00+00:00', asked_by: 'a0000000-0000-4000-8000-000000000001', asked_by_name: 'Jessie Test',
  asked_at: '2027-09-15T15:00:00+00:00', sent_by_name: null, sent_at: null, decided_by_name: null, decided_at: null,
  turned_down_by_name: null, turned_down_at: null, why: null, netsuite_adjustment_id: null, netsuite_adjustment_number: null, error: '',
  updated_at: '2027-09-15T15:00:00+00:00',
};

describe('what a count is called', () => {
  it('labels it CNT- and its number, and names its adjustment in NetSuite by its id', () => {
    expect(countLabel(7)).toBe('CNT-0007');
    expect(countLabel(12345)).toBe('CNT-12345');
    expect(countExternalId(ROW.id)).toBe('fleetsuite-count-c0000000-0000-4000-8000-000000000001');
    // NetSuite's External ID and findCountAdjustment take 80 at most.
    expect(countExternalId(ROW.id).length).toBeLessThanOrEqual(80);
  });

  it('has words for every status, and the open ones are the ones an item can be on once per location', () => {
    const all: CountStatus[] = ['counting', 'asked', 'sending', 'unsure', 'made', 'cancelled'];
    for (const s of all) {
      expect(STATUS_TEXT[s]).toMatch(/\S/);
      expect(NOT_NOW_TEXT[s]).toMatch(/\.$/);
    }
    expect(OPEN_STATUSES).toEqual(['counting', 'asked', 'sending', 'unsure']);
    expect(MAX_LINES).toBe(500);
    expect(COUNTED_MAX).toBe(1_000_000);
  });
});

describe('countFromRow', () => {
  it('reads a count as the pages show it, blanks as none', () => {
    expect(countFromRow({ ...ROW, count_date: '2027-09-15T00:00:00' })).toEqual({
      id: ROW.id, number: 7, label: 'CNT-0007', locationId: '1', locationName: "O'Fallon", what: 'Everything NetSuite has on hand',
      countDate: '2027-09-15', status: 'asked', startedBy: ROW.started_by, startedByName: 'Jessie Test', startedAt: ROW.started_at,
      askedBy: ROW.asked_by, askedByName: 'Jessie Test', askedAt: ROW.asked_at, sentByName: null, sentAt: null, decidedByName: null,
      decidedAt: null, turnedDownByName: null, turnedDownAt: null, why: null, netsuiteAdjustmentId: null, netsuiteNumber: null,
      error: null, updatedAt: ROW.updated_at,
    });
  });

  it("reads a made count's NetSuite adjustment, and a turned-down one's reason", () => {
    const made = countFromRow({ ...ROW, number: '41', status: 'made', netsuite_adjustment_id: '7001', netsuite_adjustment_number: 'ADJ-41' });
    expect([made.number, made.label, made.netsuiteAdjustmentId, made.netsuiteNumber]).toEqual([41, 'CNT-0041', '7001', 'ADJ-41']);
    const down = countFromRow({ ...ROW, status: 'counting', why: 'Count bin 4 again', turned_down_by_name: 'Craig Test', turned_down_at: ROW.updated_at });
    expect([down.why, down.turnedDownByName, down.turnedDownAt]).toEqual(['Count bin 4 again', 'Craig Test', ROW.updated_at]);
  });
});

describe('lineFromRow', () => {
  it('reads numbers PostgREST sends as text, and keeps a count of 0 apart from one not counted', () => {
    const row = {
      netsuite_item_id: 812, item_number: 'HITCH-2', display_name: 'Hitch, 2 in.', position: 3, on_hand_start: '9.5000', counted: '0',
      on_hand_then: '9', counted_by_name: 'Jessie Test', counted_at: '2027-09-15T14:00:00+00:00',
    };
    expect(lineFromRow(row)).toEqual({
      netsuiteItemId: '812', itemNumber: 'HITCH-2', displayName: 'Hitch, 2 in.', position: 3, onHandStart: 9.5, counted: 0,
      onHandThen: 9, countedByName: 'Jessie Test', countedAt: '2027-09-15T14:00:00+00:00',
    });
    expect(lineFromRow({ ...row, display_name: null, counted: null, on_hand_then: null, counted_by_name: null, counted_at: null }))
      .toMatchObject({ displayName: null, counted: null, onHandThen: null, countedByName: null, countedAt: null });
  });
});

describe('blockedFromRows', () => {
  it('reads why each item is held back, and nothing from an answer that is not a list', () => {
    expect(blockedFromRows([
      { netsuite_item_id: '812', item_number: 'HITCH-2', why: 'adjusted', by_name: 'Brian Test', at: '2027-09-15T16:00:00+00:00' },
      { netsuite_item_id: 813, item_number: 'BALL-2', why: 'asked', by_name: null, at: null },
    ])).toEqual([
      { netsuiteItemId: '812', itemNumber: 'HITCH-2', why: 'adjusted', byName: 'Brian Test', at: '2027-09-15T16:00:00+00:00' },
      { netsuiteItemId: '813', itemNumber: 'BALL-2', why: 'asked', byName: null, at: null },
    ]);
    expect(blockedFromRows(null)).toEqual([]);
    expect(blockedFromRows({ netsuite_item_id: '812' })).toEqual([]);
  });
});

describe('differenceOf and movedWhileCounting', () => {
  it("is the count less NetSuite's count when it was saved, to four places, and none until it's counted", () => {
    expect(differenceOf(line({ counted: 12, onHandThen: 9 }))).toBe(3);
    expect(differenceOf(line({ counted: 0, onHandThen: 2 }))).toBe(-2);
    expect(differenceOf(line({ counted: 0.3, onHandThen: 0.1 }))).toBe(0.2);
    expect(differenceOf(line({ counted: 7, onHandThen: 7 }))).toBe(0);
    expect(differenceOf(line())).toBeNull();
    expect(differenceOf(line({ counted: 4, onHandThen: null }))).toBeNull();
  });

  it("flags an item NetSuite's count moved on between going on the count and being counted", () => {
    expect(movedWhileCounting(line({ onHandStart: 9, counted: 9, onHandThen: 9 }))).toBe(false);
    expect(movedWhileCounting(line({ onHandStart: 9, counted: 9, onHandThen: 7 }))).toBe(true);
    expect(movedWhileCounting(line({ onHandStart: 0.1 + 0.2, counted: 1, onHandThen: 0.3 }))).toBe(false);
    expect(movedWhileCounting(line({ onHandStart: 9 }))).toBe(false);
  });
});

describe('parseCounted', () => {
  it('takes a blank as not counted, and a number with commas', () => {
    expect(parseCounted('')).toEqual({ value: null });
    expect(parseCounted('   ')).toEqual({ value: null });
    expect(parseCounted(' 12 ')).toEqual({ value: 12 });
    expect(parseCounted('0')).toEqual({ value: 0 });
    expect(parseCounted('1,250.5')).toEqual({ value: 1250.5 });
    expect(parseCounted('1,000,000')).toEqual({ value: 1_000_000 });
    expect(parseCounted('.25')).toEqual({ value: 0.25 });
    expect(parseCounted('3.')).toEqual({ value: 3 });
    expect(parseCounted('1000000')).toEqual({ value: 1_000_000 });
    expect(parseCounted('2.1234')).toEqual({ value: 2.1234 });
  });

  it('says what is wrong with anything else', () => {
    expect(parseCounted('-3')).toEqual({ error: "A count can't be below 0." });
    for (const typed of ['abc', '.', '1e3', '3 boxes', '1.2.3', '+4']) {
      expect(parseCounted(typed)).toEqual({ error: 'Type the number counted, or leave it blank.' });
    }
    expect(parseCounted('1000001')).toEqual({ error: 'A count takes 1,000,000 at most.' });
    expect(parseCounted('2.12345')).toEqual({ error: 'A count takes 4 places at most.' });
  });
});

describe('reviewCount', () => {
  const LINES = [
    line({ netsuiteItemId: '812', counted: 12, onHandThen: 9 }),
    line({ netsuiteItemId: '813', counted: 0, onHandThen: 2.5 }),
    line({ netsuiteItemId: '814', counted: 7, onHandThen: 7 }),
    line({ netsuiteItemId: '815' }),
    line({ netsuiteItemId: '816', counted: 1, onHandThen: 0 }),
  ];

  it('adds up what is counted, what matches, and the units over and short', () => {
    expect(reviewCount(LINES, null)).toEqual({
      items: 5, counted: 4, notCounted: 1, matched: 1, differ: 3, unitsOver: 4, unitsShort: 2.5, centsOver: null, centsShort: null, noCost: 0,
    });
    expect(reviewCount([], null)).toMatchObject({ items: 0, counted: 0, differ: 0, unitsOver: 0, unitsShort: 0 });
  });

  it("values each difference at NetSuite's average cost where it's known, and counts the ones it isn't", () => {
    expect(reviewCount(LINES, { 812: 10.125, 813: 4, 814: 99 })).toEqual({
      items: 5, counted: 4, notCounted: 1, matched: 1, differ: 3, unitsOver: 4, unitsShort: 2.5,
      // 3 × 10.125 = 30.375 → 3038 cents; 2.5 × 4 = 1000 cents; 816 has no average.
      centsOver: 3038, centsShort: 1000, noCost: 1,
    });
    expect(reviewCount([line({ counted: 1, onHandThen: 0 })], { 812: Number.NaN })).toMatchObject({ centsOver: 0, noCost: 1 });
  });
});

describe('describeLine and blockedText', () => {
  it("says each item's difference in a line", () => {
    expect(describeLine(line({ counted: 12, onHandThen: 9 }))).toBe('+3 (12 counted, NetSuite 9)');
    expect(describeLine(line({ counted: 0, onHandThen: 2.5 }))).toBe('−2.5 (0 counted, NetSuite 2.5)');
    expect(describeLine(line({ counted: 7, onHandThen: 7 }))).toBe('Matches (7)');
    expect(describeLine(line())).toBe('Not counted');
  });

  it('says why an item is held back and what to do', () => {
    expect(blockedText({ itemNumber: 'HITCH-2', why: 'adjusted', byName: 'Brian Test' }))
      .toBe('HITCH-2 was adjusted with Adjust by Brian Test after it was counted, so its difference may be corrected already. Count it again.');
    expect(blockedText({ itemNumber: 'BALL-2', why: 'asked', byName: null }))
      .toBe("BALL-2 has an adjustment asked for by someone on Adjustments to approve. Once it's decided, count it again.");
    expect(blockedText({ itemNumber: 'PIN-58', why: 'adjusted', byName: null }))
      .toBe('PIN-58 was adjusted with Adjust by someone after it was counted, so its difference may be corrected already. Count it again.');
  });
});

describe('countMemo and countWhat', () => {
  it("writes the memo NetSuite shows, who asked and who approved, 999 at most", () => {
    expect(countMemo({ label: 'CNT-0007', locationName: "O'Fallon" }, 'Jessie Test', 'Craig Test'))
      .toBe("FleetSuite count CNT-0007 at O'Fallon · by Jessie Test, approved by Craig Test");
    expect(countMemo({ label: 'CNT-0007', locationName: "O'Fallon" }, null, null))
      .toBe("FleetSuite count CNT-0007 at O'Fallon · by someone, approved by a super admin");
    expect(countMemo({ label: 'CNT-0007', locationName: 'x'.repeat(1200) }, 'A', 'B')).toHaveLength(999);
  });

  it('says what a count is of from how its items were chosen', () => {
    expect(countWhat('all', null, 120)).toBe('Everything NetSuite has on hand');
    expect(countWhat('search', '  hitch   ball ', 4)).toBe('Items matching “hitch ball”');
    expect(countWhat('search', 'h'.repeat(80), 4)).toBe(`Items matching “${'h'.repeat(60)}”`);
    expect(countWhat('picked', null, 1)).toBe('1 item picked');
    expect(countWhat('picked', null, 3)).toBe('3 items picked');
  });

  it('names a part of everything on hand by its first and last item, cutting a long one', () => {
    expect(countWhat('all', null, 500, { first: 'BALL-2', last: 'HITCH-9' })).toBe('Everything NetSuite has on hand, BALL-2 to HITCH-9');
    expect(countWhat('all', null, 500, null)).toBe('Everything NetSuite has on hand');
    expect(countWhat('all', null, 500, { first: 'A'.repeat(40), last: 'B'.repeat(41) }))
      .toBe(`Everything NetSuite has on hand, ${'A'.repeat(40)} to ${'B'.repeat(39)}…`);
    // A part only names everything on hand.
    expect(countWhat('search', 'hitch', 4, { first: 'BALL-2', last: 'HITCH-9' })).toBe('Items matching “hitch”');
    expect(countWhat('picked', null, 2, { first: 'BALL-2', last: 'HITCH-9' })).toBe('2 items picked');
  });
});

describe('byItemNumber', () => {
  const item = (itemNumber: string, netsuiteItemId: string) => ({ itemNumber, netsuiteItemId });

  it('puts items in shelf order: numbers by value, case aside, then by NetSuite id', () => {
    const items = [item('BK-10', '5'), item('bk-2', '9'), item('BK-2', '3'), item('ball-1', '7'), item('BK-2', '1'), item('PIN-58', '2')];
    expect([...items].sort(byItemNumber).map((i) => `${i.itemNumber}/${i.netsuiteItemId}`))
      .toEqual(['ball-1/7', 'bk-2/9', 'BK-2/1', 'BK-2/3', 'BK-10/5', 'PIN-58/2']);
    expect(byItemNumber(item('BK-2', '1'), item('BK-2', '1'))).toBe(0);
  });
});

describe('averageCosts', () => {
  it("works out each item's average cost from NetSuite's count and value, skipping what it can't", () => {
    expect(averageCosts([
      { item_id: '812', quantity: 4, value: 50 },
      { item_id: '813', quantity: '2', value: '30.5' },
      { item_id: '814', quantity: 0, value: 10 },
      { item_id: '815', quantity: 3, value: null },
      { item_id: '816', quantity: null, value: 9 },
      { item_id: '817', quantity: '', value: '9' },
      { item_id: '818', quantity: 'x', value: 9 },
      { item_id: '819', quantity: -2, value: -12 },
      { item_id: '820', quantity: 2, value: '' },
    ])).toEqual({ 812: 12.5, 813: 15.25, 819: 6 });
    expect(averageCosts([])).toEqual({});
  });
});

describe('defaultLocationId', () => {
  const places = [{ id: '3', name: 'Kansas City' }, { id: '1', name: "O'Fallon" }, { id: '2', name: 'Wentzville' }];

  it("starts at NetSuite's default location when it's one of them, then O'Fallon, then the first", () => {
    expect(defaultLocationId(places, '2')).toBe('2');
    expect(defaultLocationId(places, '99')).toBe('1');
    expect(defaultLocationId(places, null)).toBe('1');
    expect(defaultLocationId(places)).toBe('1');
    expect(defaultLocationId([places[0], places[2]], '')).toBe('3');
    expect(defaultLocationId([])).toBeNull();
  });
});

describe('needsAsking', () => {
  const sentAt = '2027-09-15T15:00:00.000Z';
  const at = (ms: number) => Date.parse(sentAt) + ms;

  it("asks NetSuite when it didn't say, or when a press has been posting longer than one takes", () => {
    // Five minutes, as the route's messages say.
    expect(STALE_MS).toBe(5 * 60 * 1000);
    expect(needsAsking({ status: 'unsure', sentAt }, at(0))).toBe(true);
    expect(needsAsking({ status: 'sending', sentAt }, at(STALE_MS - 1))).toBe(false);
    expect(needsAsking({ status: 'sending', sentAt }, at(STALE_MS))).toBe(true);
    expect(needsAsking({ status: 'sending', sentAt: null }, at(STALE_MS))).toBe(false);
    for (const status of ['counting', 'asked', 'made', 'cancelled'] as const) {
      expect(needsAsking({ status, sentAt }, at(STALE_MS * 10))).toBe(false);
    }
  });
});
