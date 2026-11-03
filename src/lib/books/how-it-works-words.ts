/**
 * The words Books → How the books work and its PDF share (Books part 88,
 * docs/books.md "How the books work"): dates in Central time, what each
 * posting rule has posted, what a piece waits on, who holds a step, and the
 * CPA's review as it stands. Pure and client-safe (no jsPDF), so the page and
 * the PDF can't say these differently.
 */

import type { HowItWorksView } from './how-it-works';

/** Runs of spaces as one: the clock's narrow space before AM included. */
const oneSpace = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 'November 3, 2026' as it falls in Central time. */
export const centralDay = (iso: string): string => new Date(iso).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago',
});

/** 'November 3, 2026, 9:00 AM Central'. */
export function centralWhen(iso: string): string {
  const time = new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  return oneSpace(`${centralDay(iso)}, ${time} Central`);
}

/** 'January 2, 2025' from '2025-01-02'. */
export function dayText(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** 'October 2026' from '2026-10'. */
export function monthText(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** '1 entry', '1,234 entries'. */
export const countText = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** 'a, b and c'. */
export const andList = (parts: readonly string[]): string =>
  (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** What a posting rule has posted, company by company, in words. */
export function ruleUseText(use: HowItWorksView['rules'][number]['use']): string {
  if (!use.length) return 'Nothing posted by it yet.';
  return use.map((u) => {
    const span = u.firstDate === u.lastDate ? `on ${dayText(u.firstDate)}` : `from ${dayText(u.firstDate)} to ${dayText(u.lastDate)}`;
    const reversed = u.reversed ? `, ${u.reversed.toLocaleString('en-US')} of them reversed` : '';
    return `${u.company}: ${countText(u.entries, 'entry', 'entries')} dated ${span}${reversed}.`;
  }).join(' ');
}

/** Where a piece waits on a switch, in words; null when it waits on none. */
export function switchText(name: string | null, on: boolean | null): string | null {
  if (!name) return null;
  if (on === null) return `Waits on ${name}.`;
  return `Waits on ${name}, switched ${on ? 'on' : 'off'}.`;
}

/** Who can take a step now, in words. */
export const peopleText = (people: string[] | null): string =>
  people === null ? "Couldn't be read" : people.length ? people.join(', ') : 'Nobody yet';

/** The CPA's review as it stands, a sentence or two, and how it reads. */
export function reviewText(review: HowItWorksView['review']): { text: string; tone: 'good' | 'changed' | 'none' } {
  const last = review.last;
  if (review.state === 'never' || !last) return { text: "BMG's CPA hasn't marked this description reviewed yet.", tone: 'none' };
  const who = last.reviewedAs === 'cpa'
    ? `${last.reviewedByName}, the CPA,`
    : `${last.reviewedByName}, a super admin writing down the CPA's review,`;
  const on = centralDay(last.reviewedAt);
  if (review.state === 'current') {
    return { text: `Reviewed by ${who} on ${on}. The rules haven't changed since.`, tone: 'good' };
  }
  const what: string[] = [];
  if (review.added.length) what.push(`written down since: ${review.added.join(', ')}`);
  if (review.gone.length) what.push(`gone since: ${review.gone.join(', ')}`);
  if (review.reworded) what.push('the words of a rule changed');
  return { text: `Last reviewed by ${who} on ${on}. The rules have changed since (${what.join('; ')}), so they're due another review.`, tone: 'changed' };
}

/** The name the PDF downloads as, dated in Central time: How-the-books-work-2026-11-03.pdf. */
export function howItWorksFilename(asOf: string): string {
  const day = new Date(asOf).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return `How-the-books-work-${day}.pdf`;
}
