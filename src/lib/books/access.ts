/**
 * Who can open FleetSuite's own books, and what each can do there (docs/books.md
 * "Who can open the books", Books part 52). By role, not by feature: only a
 * super admin gives out the bookkeeper and CPA roles (migration 483), and the
 * Permissions screen can't hand the books to a role.
 *
 *   owner — super admins: everything, including the steps only the owner
 *           takes: the switches, going live, keeping or taking a change made
 *           in NetSuite, and reopening a closed month.
 *   keep  — the bookkeeper: everything else, such as copying from NetSuite,
 *           posting, closing a month, clearing mistake checks, Snap a bill
 *           and NetSuite's 1099 report.
 *   read  — the CPA: every Books page, changing nothing. The CPA's own
 *           adjustments are typed on Journal entries (journalsFor in
 *           src/lib/typed-journal-entries.ts, part 53), not here.
 *
 * Client-safe: the Books pages ask it of the roles they're viewed as (View
 * As included), and requireBooks (src/lib/api-auth.ts) of the caller's own.
 */

import { ROLE_LABELS } from '@/lib/types';

export type BooksAccess = 'owner' | 'keep' | 'read';

const RANK: Record<BooksAccess, number> = { read: 1, keep: 2, owner: 3 };

/** What someone with these roles can do in the books, or null when they can't open them. */
export function booksAccess(hasRole: (role: string) => boolean): BooksAccess | null {
  if (hasRole('super_admin')) return 'owner';
  if (hasRole('bookkeeper')) return 'keep';
  if (hasRole('cpa')) return 'read';
  return null;
}

/** Does `access` cover `need`? Each level can do everything the one below it can. */
export function booksAllows(access: BooksAccess | null | undefined, need: BooksAccess): boolean {
  return !!access && RANK[access] >= RANK[need];
}

/** The two logins that are only for the books. */
const BOOKS_ROLES = ['bookkeeper', 'cpa'];

/** Does someone with these roles have nothing in FleetSuite but the books? Home opens the books for them. */
export function booksOnly(hasRole: (role: string) => boolean): boolean {
  return BOOKS_ROLES.some(hasRole) && !Object.keys(ROLE_LABELS).some((role) => !BOOKS_ROLES.includes(role) && hasRole(role));
}
