import type { OwnBooks } from './own-invoice-posting';
import type { OwnPostingView } from './own-posting-view';

/**
 * What Own fulfillments, Own receipts, Own adjustments and Own bills say the
 * books hold for Books' own copies (migrations 456 and 457, docs/books.md
 * "Posting FleetSuite's own fulfillments, receipts and bills"), in words: a
 * chip and a count on each list, and a sentence on each one's page
 * (src/components/BooksOwnPosting.tsx). Pure.
 */

/** A copy's status as its check says it, the receipts' 'not_in_netsuite' among them. */
export type OwnCopyStatus = string;

const GREEN = '#22c55e';
const GRAY = '#9ca3af';

/**
 * What the books hold for one of a list's copies, as a chip: the entry that stands and which copy made it; null for a
 * copy whose document NetSuite voided or deleted, as the list says that already.
 */
export function ownBooksChip(books: OwnBooks | null, status: OwnCopyStatus): { label: string; color: string } | null {
  if (status === 'voided') return null;
  if (books) return books.from === 'fleetsuite' ? { label: `Entry ${books.entryNo} · own copy`, color: GREEN } : { label: `Entry ${books.entryNo} · NetSuite's`, color: GRAY };
  return status === 'not_in_netsuite' ? { label: 'Not posted', color: GRAY } : { label: 'Not posted yet', color: GRAY };
}

const n = (count: number) => count.toLocaleString('en-US');

/**
 * What the books hold for a list's copies, in a sentence or two: "In FleetSuite's books: 3 from FleetSuite's own copy,
 * 3 from NetSuite's, 1 not posted yet." Null when there's nothing to say.
 */
export function ownBooksCount(rows: ReadonlyArray<{ status: OwnCopyStatus; books: OwnBooks | null }>): string | null {
  const shown = rows.filter((r) => r.status !== 'voided');
  const own = shown.filter((r) => r.books?.from === 'fleetsuite').length;
  const theirs = shown.filter((r) => r.books?.from === 'netsuite').length;
  const nothing = shown.filter((r) => !r.books && r.status === 'not_in_netsuite').length;
  const notYet = shown.filter((r) => !r.books && r.status !== 'not_in_netsuite').length;
  const parts = [
    own ? `${n(own)} from FleetSuite's own copy` : '',
    theirs ? `${n(theirs)} from NetSuite's` : '',
    notYet ? `${n(notYet)} not posted yet` : '',
  ].filter(Boolean);
  const held = own + theirs ? `In FleetSuite's books: ${parts.join(', ')}.` : notYet ? `${n(notYet)} not in FleetSuite's books yet.` : '';
  const none = nothing ? `${n(nothing)} ${nothing === 1 ? "isn't" : "aren't"} in NetSuite yet, so there's nothing to post.` : '';
  return [held, none].filter(Boolean).join(' ') || null;
}

/** What the books hold for a copy's document, in a sentence. `theirs` is NetSuite's document in words ('fulfillment'). */
export function ownBooksText(posting: OwnPostingView | null, status: OwnCopyStatus, theirs: string): string {
  const b = posting?.books ?? null;
  if (status === 'not_in_netsuite') return "Not in FleetSuite's books: NetSuite didn't take it, so there's nothing to post.";
  if (!b) {
    if (status === 'voided') return `Not in FleetSuite's books: NetSuite voided or deleted its ${theirs}.`;
    return posting?.posts ? "Not in FleetSuite's books yet: the next posting run posts it from this copy." : "Not in FleetSuite's books yet.";
  }
  const entry = `In FleetSuite's books as entry ${b.entryNo}`;
  if (status === 'voided') return `${entry}. NetSuite voided or deleted its ${theirs}, so the next posting run reverses it.`;
  if (b.from === 'fleetsuite') {
    return posting?.posts ? `${entry}, made from this copy.` : `${entry}, made from this copy, which the next posting run replaces with one made from NetSuite's ${theirs}.`;
  }
  if (posting?.posts) return `${entry}, made from NetSuite's ${theirs}. This copy matches it, so the next posting run posts it from this copy instead.`;
  if (posting?.differs) return `${entry}, made from NetSuite's ${theirs}, since this copy's entry isn't the same.`;
  if (status === 'differs') return `${entry}, made from NetSuite's ${theirs}, since this copy differs from it.`;
  if (status === 'incomplete') return `${entry}, made from NetSuite's ${theirs}, since this copy is incomplete.`;
  if (status === 'waiting') return `${entry}, made from NetSuite's ${theirs}, since this copy is waiting for it.`;
  return `${entry}, made from NetSuite's ${theirs}.`;
}

/**
 * The link from a copy's page to its document on Invoices vs NetSuite, in words: why NetSuite's posts when the copy
 * matches it, else how it posts.
 */
export function ownBooksLinkText(posting: OwnPostingView | null, status: OwnCopyStatus): string {
  return status === 'matches' && posting?.books?.from === 'netsuite' && !posting.posts ? 'Why, on Invoices vs NetSuite' : 'How it posts, on Invoices vs NetSuite';
}

/** Why the books post NetSuite's document though the copy matches it, when its entry can't be worked out; null otherwise. */
export function ownBooksWhy(posting: OwnPostingView | null, status: OwnCopyStatus): string | null {
  return status === 'matches' && !posting?.posts && !posting?.entry ? posting?.why ?? null : null;
}
