import { describe, it, expect } from 'vitest';
import { ownBooksChip, ownBooksCount, ownBooksLinkText, ownBooksText, ownBooksWhy } from './own-posting-text';
import type { OwnBooks } from './own-invoice-posting';
import type { OwnPostingView } from './own-posting-view';

const OWN: OwnBooks = { entryNo: 902, date: '2026-10-21', from: 'fleetsuite' };
const THEIRS: OwnBooks = { entryNo: 871, date: '2026-10-19', from: 'netsuite' };

/** How a copy posts, as its page reads it: nothing worked out unless said. */
const view = (over: Partial<OwnPostingView> = {}): OwnPostingView => ({
  books: null, month: '2026-10-01', posts: false, why: null, entry: null, differs: null, learned: [], costs: null, ...over,
});
const ROWS = [{ account: '58000 Cost of Goods Sold', fleetsuite: 45500, netsuite: 45500, same: true }];

describe('the chip on each copy', () => {
  it('says which entry stands and which copy made it', () => {
    expect(ownBooksChip(OWN, 'matches')).toEqual({ label: 'Entry 902 · own copy', color: '#22c55e' });
    expect(ownBooksChip(THEIRS, 'differs')).toEqual({ label: "Entry 871 · NetSuite's", color: '#9ca3af' });
  });

  it("says when nothing stands yet, or there's nothing to post, and says nothing of one NetSuite voided", () => {
    expect(ownBooksChip(null, 'waiting')).toEqual({ label: 'Not posted yet', color: '#9ca3af' });
    expect(ownBooksChip(null, 'not_in_netsuite')).toEqual({ label: 'Not posted', color: '#9ca3af' });
    expect(ownBooksChip(OWN, 'voided')).toBeNull();
    expect(ownBooksChip(null, 'voided')).toBeNull();
  });
});

describe("the count above a list", () => {
  it('counts the copies by which made the entry that stands, and those not posted yet', () => {
    expect(ownBooksCount([
      { status: 'matches', books: OWN }, { status: 'matches', books: OWN }, { status: 'matches', books: OWN },
      { status: 'differs', books: THEIRS }, { status: 'matches', books: THEIRS },
      { status: 'waiting', books: null },
    ])).toBe("In FleetSuite's books: 3 from FleetSuite's own copy, 2 from NetSuite's, 1 not posted yet.");
    expect(ownBooksCount([{ status: 'matches', books: THEIRS }])).toBe("In FleetSuite's books: 1 from NetSuite's.");
    expect(ownBooksCount([{ status: 'matches', books: OWN }])).toBe("In FleetSuite's books: 1 from FleetSuite's own copy.");
  });

  it("says when none is in the books yet, and which have nothing to post, leaving out the voided", () => {
    expect(ownBooksCount([{ status: 'waiting', books: null }, { status: 'matches', books: null }])).toBe("2 not in FleetSuite's books yet.");
    expect(ownBooksCount([{ status: 'not_in_netsuite', books: null }])).toBe("1 isn't in NetSuite yet, so there's nothing to post.");
    expect(ownBooksCount([
      { status: 'matches', books: OWN }, { status: 'not_in_netsuite', books: null }, { status: 'not_in_netsuite', books: null },
    ])).toBe("In FleetSuite's books: 1 from FleetSuite's own copy. 2 aren't in NetSuite yet, so there's nothing to post.");
    expect(ownBooksCount([{ status: 'voided', books: OWN }, { status: 'voided', books: null }])).toBeNull();
    expect(ownBooksCount([])).toBeNull();
  });

  it('writes counts as people do', () => {
    const many = Array.from({ length: 1200 }, () => ({ status: 'matches', books: OWN }));
    expect(ownBooksCount(many)).toBe("In FleetSuite's books: 1,200 from FleetSuite's own copy.");
  });
});

describe("the sentence on a copy's page", () => {
  it('says the entry was made from this copy, or that the next run puts it back to NetSuite\'s', () => {
    expect(ownBooksText(view({ books: OWN, posts: true }), 'matches', 'fulfillment')).toBe("In FleetSuite's books as entry 902, made from this copy.");
    expect(ownBooksText(view({ books: OWN }), 'differs', 'bill'))
      .toBe("In FleetSuite's books as entry 902, made from this copy, which the next posting run replaces with one made from NetSuite's bill.");
  });

  it("says why NetSuite's made it", () => {
    expect(ownBooksText(view({ books: THEIRS, posts: true }), 'matches', 'receipt'))
      .toBe("In FleetSuite's books as entry 871, made from NetSuite's receipt. This copy matches it, so the next posting run posts it from this copy instead.");
    expect(ownBooksText(view({ books: THEIRS, differs: 'it posts differently to 58000 Cost of Goods Sold' }), 'matches', 'fulfillment'))
      .toBe("In FleetSuite's books as entry 871, made from NetSuite's fulfillment, since this copy's entry isn't the same.");
    expect(ownBooksText(view({ books: THEIRS }), 'differs', 'bill')).toBe("In FleetSuite's books as entry 871, made from NetSuite's bill, since this copy differs from it.");
    expect(ownBooksText(view({ books: THEIRS }), 'incomplete', 'bill')).toBe("In FleetSuite's books as entry 871, made from NetSuite's bill, since this copy is incomplete.");
    expect(ownBooksText(view({ books: THEIRS }), 'waiting', 'bill')).toBe("In FleetSuite's books as entry 871, made from NetSuite's bill, since this copy is waiting for it.");
    expect(ownBooksText(view({ books: THEIRS }), 'matches', 'bill')).toBe("In FleetSuite's books as entry 871, made from NetSuite's bill.");
  });

  it("says what happens to one NetSuite voided", () => {
    expect(ownBooksText(view({ books: OWN }), 'voided', 'fulfillment'))
      .toBe("In FleetSuite's books as entry 902. NetSuite voided or deleted its fulfillment, so the next posting run reverses it.");
    expect(ownBooksText(view(), 'voided', 'fulfillment')).toBe("Not in FleetSuite's books: NetSuite voided or deleted its fulfillment.");
  });

  it("says when it isn't in the books yet, and when there's nothing to post", () => {
    expect(ownBooksText(view({ posts: true }), 'matches', 'receipt')).toBe("Not in FleetSuite's books yet: the next posting run posts it from this copy.");
    expect(ownBooksText(view(), 'waiting', 'receipt')).toBe("Not in FleetSuite's books yet.");
    expect(ownBooksText(null, 'waiting', 'receipt')).toBe("Not in FleetSuite's books yet.");
    expect(ownBooksText(view({ books: OWN }), 'not_in_netsuite', 'receipt'))
      .toBe("Not in FleetSuite's books: NetSuite didn't take it, so there's nothing to post.");
  });

  it('links to why when the copy matches but NetSuite\'s stands, else to how it posts', () => {
    expect(ownBooksLinkText(view({ books: THEIRS }), 'matches')).toBe('Why, on Invoices vs NetSuite');
    expect(ownBooksLinkText(view({ books: THEIRS, posts: true }), 'matches')).toBe('How it posts, on Invoices vs NetSuite');
    expect(ownBooksLinkText(view({ books: OWN, posts: true }), 'matches')).toBe('How it posts, on Invoices vs NetSuite');
    expect(ownBooksLinkText(view({ books: THEIRS }), 'differs')).toBe('How it posts, on Invoices vs NetSuite');
    expect(ownBooksLinkText(null, 'matches')).toBe('How it posts, on Invoices vs NetSuite');
  });

  it("says why NetSuite's posts when the copy matches but its entry can't be worked out, as The entry says the rest", () => {
    const why = "FleetSuite's own copy matches NetSuite's fulfillment, but its entry can't be worked out, so the books post NetSuite's.";
    expect(ownBooksWhy(view({ why }), 'matches')).toBe(why);
    // The entry says why itself, once it's worked out; and there's nothing to say when it posts, or the copy doesn't match.
    expect(ownBooksWhy(view({ why, entry: ROWS }), 'matches')).toBeNull();
    expect(ownBooksWhy(view({ why, posts: true }), 'matches')).toBeNull();
    expect(ownBooksWhy(view({ why }), 'differs')).toBeNull();
    expect(ownBooksWhy(null, 'matches')).toBeNull();
  });
});
