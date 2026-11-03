// The words Books → How the books work and its PDF share (Books part 88,
// src/lib/books/how-it-works-words.ts): the CPA's review as it stands, what
// a rule has posted, what a piece waits on, who holds a step, and dates in
// Central time. Made-up names.
import { describe, it, expect, vi } from 'vitest';
import type { HowItWorksView } from './how-it-works';
import {
  andList, centralWhen, countText, dayText, howItWorksFilename, monthText, peopleText, reviewText, ruleUseText, switchText,
} from './how-it-works-words';

const FINGERPRINT = 'ab12'.repeat(16);

describe('reviewText', () => {
  const last = { reviewedAt: '2026-10-01T15:00:00Z', reviewedByName: 'Pat CPA', reviewedAs: 'cpa' as const, rules: ['invoice@1'], fingerprint: FINGERPRINT, note: null };
  const review = (over: Partial<HowItWorksView['review']>): HowItWorksView['review'] => ({
    state: 'never', last: null, added: [], gone: [], reworded: false, fingerprint: FINGERPRINT, canMark: false, ...over,
  });

  it('says when the CPA has never marked it', () => {
    expect(reviewText(review({}))).toEqual({ text: "BMG's CPA hasn't marked this description reviewed yet.", tone: 'none' });
  });

  it('says who reviewed it and when, the CPA or a super admin for a review on paper', () => {
    expect(reviewText(review({ state: 'current', last }))).toEqual({
      text: "Reviewed by Pat CPA, the CPA, on October 1, 2026. The rules haven't changed since.", tone: 'good',
    });
    expect(reviewText(review({ state: 'current', last: { ...last, reviewedByName: 'Pat Owner', reviewedAs: 'super_admin' } })).text)
      .toBe("Reviewed by Pat Owner, a super admin writing down the CPA's review, on October 1, 2026. The rules haven't changed since.");
  });

  it('says what changed since, and that the rules are due another review', () => {
    expect(reviewText(review({ state: 'changed', last, added: ['own_bill@1', 'stock@1'], gone: ['tax@1'] }))).toEqual({
      text: "Last reviewed by Pat CPA, the CPA, on October 1, 2026. The rules have changed since (written down since: own_bill@1, stock@1; gone since: tax@1), so they're due another review.",
      tone: 'changed',
    });
    expect(reviewText(review({ state: 'changed', last, reworded: true })).text).toContain('(the words of a rule changed)');
  });
});

describe('the words the PDF uses', () => {
  it('counts what a rule posted, company by company', () => {
    expect(ruleUseText([])).toBe('Nothing posted by it yet.');
    expect(ruleUseText([
      { company: 'BMG', entries: 1, reversed: 0, firstDate: '2025-03-04', lastDate: '2025-03-04' },
      { company: '1084', entries: 12, reversed: 1, firstDate: '2025-01-31', lastDate: '2025-12-31' },
    ])).toBe('BMG: 1 entry dated on March 4, 2025. 1084: 12 entries dated from January 31, 2025 to December 31, 2025, 1 of them reversed.');
  });

  it('says what a piece waits on, and who holds a step', () => {
    expect(switchText(null, null)).toBeNull();
    expect(switchText('Credit memos', true)).toBe('Waits on Credit memos, switched on.');
    expect(switchText('Credit memos', false)).toBe('Waits on Credit memos, switched off.');
    expect(switchText('Credit memos', null)).toBe('Waits on Credit memos.');
    expect(peopleText(null)).toBe("Couldn't be read");
    expect(peopleText([])).toBe('Nobody yet');
    expect(peopleText(['Pat Owner', 'Kim Books'])).toBe('Pat Owner, Kim Books');
  });

  it('counts and lists', () => {
    expect(countText(1, 'entry', 'entries')).toBe('1 entry');
    expect(countText(1234, 'entry', 'entries')).toBe('1,234 entries');
    expect(countText(2, 'rule')).toBe('2 rules');
    expect(andList([])).toBe('');
    expect(andList(['a'])).toBe('a');
    expect(andList(['a', 'b'])).toBe('a and b');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('dates in Central time, daylight saving or not', () => {
    expect(dayText('2025-01-02')).toBe('January 2, 2025');
    expect(dayText('2026-12-31T00:00:00Z')).toBe('December 31, 2026');
    expect(monthText('2026-10')).toBe('October 2026');
    expect(monthText('2026-01')).toBe('January 2026');
    expect(centralWhen('2026-11-03T15:00:00Z')).toBe('November 3, 2026, 9:00 AM Central');
    expect(centralWhen('2026-07-01T15:00:00Z')).toBe('July 1, 2026, 10:00 AM Central');
    expect(howItWorksFilename('2026-11-04T03:00:00Z')).toBe('How-the-books-work-2026-11-03.pdf');
    expect(howItWorksFilename('2026-11-04T07:00:00Z')).toBe('How-the-books-work-2026-11-04.pdf');
  });

  it("writes the clock's narrow space before AM as a plain one, as some browsers and servers give it", () => {
    const clock = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('9:00\u202fAM');
    try {
      expect(centralWhen('2026-11-03T15:00:00Z')).toBe('November 3, 2026, 9:00 AM Central');
    } finally {
      clock.mockRestore();
    }
  });

});
