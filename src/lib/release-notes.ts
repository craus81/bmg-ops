/**
 * What's new in FleetSuite (Craig, 2026-11-06: "a daily new features and bug
 * fixes with a release number so people can see what's new").
 *
 * The notes live in src/lib/release-notes.json, one plain-English line per
 * change, written in the same PR as the change (CLAUDE.md "Release notes").
 * Everything that goes live on the same O'Fallon day is one release,
 * numbered by that date: 2026-11-06 → release 2026.11.06.
 *
 * Who sees a line goes by its areas: each person sees the areas they can
 * open, admins see every area but Books, and Books lines only reach people
 * who can open the books. Customers see nothing.
 *
 * Client-safe: no server imports. The banner, the popup, the dot on More and
 * the More → What's new page all read through releasesFor().
 */

import notes from '@/lib/release-notes.json';
import type { FeatureKey } from '@/lib/features';

export type ReleaseArea = 'everyone' | 'sales' | 'purchasing' | 'shop' | 'graphics' | 'admin' | 'books';
export const RELEASE_AREAS: readonly ReleaseArea[] = ['everyone', 'sales', 'purchasing', 'shop', 'graphics', 'admin', 'books'];

export interface ReleaseNote {
  /** The O'Fallon day it went live, YYYY-MM-DD. */
  date: string;
  kind: 'new' | 'fix';
  /** One plain-English sentence, from the user's side of the screen. */
  text: string;
  /** Where to find it: the menu path or page and button. */
  where: string;
  areas: ReleaseArea[];
  pr?: number;
}

export interface Release {
  /** 2026.11.06 */
  number: string;
  date: string;
  notes: ReleaseNote[];
}

export interface ReleaseViewer {
  customer: boolean;
  isAdmin: boolean;
  books: boolean;
  hasFeature: (f: FeatureKey) => boolean;
}

export const ALL_NOTES: ReleaseNote[] = notes as ReleaseNote[];

/** 2026-11-06 → 2026.11.06 */
export function releaseNumber(date: string): string {
  return date.replace(/-/g, '.');
}

/** Can this person see lines in this area? */
export function canSeeArea(area: ReleaseArea, v: ReleaseViewer): boolean {
  if (v.customer) return false;
  if (area === 'everyone') return true;
  if (area === 'books') return v.books;
  if (v.isAdmin) return true;
  switch (area) {
    case 'sales': return v.hasFeature('estimates') || v.hasFeature('invoicing');
    case 'purchasing': return v.hasFeature('parts_ordering');
    case 'shop': return v.hasFeature('in_shop') || v.hasFeature('scan');
    case 'graphics': return v.hasFeature('graphics');
    default: return false;
  }
}

/** Group notes into releases, newest first. */
export function groupReleases(list: ReleaseNote[]): Release[] {
  const byDate = new Map<string, ReleaseNote[]>();
  for (const n of list) {
    const day = byDate.get(n.date);
    if (day) day.push(n); else byDate.set(n.date, [n]);
  }
  return Array.from(byDate.keys())
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map(date => ({ number: releaseNumber(date), date, notes: byDate.get(date)! }));
}

/** The releases this person can see, newest first, each with only their lines. */
export function releasesFor(v: ReleaseViewer, list: ReleaseNote[] = ALL_NOTES): Release[] {
  return groupReleases(list.filter(n => n.areas.some(a => canSeeArea(a, v))));
}

/** Is `release` newer than the one last marked seen? Release numbers sort as text. */
export function isNewer(release: string | null | undefined, seen: string | null | undefined): boolean {
  if (!release) return false;
  return !seen || release > seen;
}

/** Lines that only Books people see; the page folds these into one line. */
export function isBooksOnly(n: ReleaseNote): boolean {
  return n.areas.length === 1 && n.areas[0] === 'books';
}

/** "7 new things" / "1 fix" / "3 new things and 1 fix" */
export function releaseSummary(r: Release): string {
  const fresh = r.notes.filter(n => n.kind === 'new').length;
  const fixes = r.notes.length - fresh;
  const a = fresh ? `${fresh} new thing${fresh === 1 ? '' : 's'}` : '';
  const b = fixes ? `${fixes} fix${fixes === 1 ? '' : 'es'}` : '';
  return a && b ? `${a} and ${b}` : a || b;
}

/** "Friday, Nov 6" from 2026-11-06, read as a calendar day (no time zone). */
export function releaseDayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** What each person has already seen, saved on their profile (migration 522). */
export interface WhatsNewSeen {
  /** Newest release they opened More → What's new for. */
  page?: string | null;
  /** Newest release whose popup they closed. */
  popup?: string | null;
  /** Newest release whose dashboard banner they closed with ✕. */
  banner?: string | null;
}

const AREA_LABEL: Record<ReleaseArea, string> = {
  everyone: 'Everyone', sales: 'Sales', purchasing: 'Purchasing', shop: 'Shop', graphics: 'Graphics', admin: 'Admins', books: 'Books',
};

/**
 * docs/help/whats-new.md, the help guide FleetSuite AI searches to answer
 * "what's new" and "what changed this week". Made from release-notes.json;
 * release-notes.test.ts fails when the file is out of date, and
 * `UPDATE_WHATS_NEW=1 npx vitest run src/lib/release-notes.test.ts` rewrites it.
 */
export function releaseNotesMarkdown(list: ReleaseNote[] = ALL_NOTES): string {
  const out: string[] = [
    "# What's new in FleetSuite",
    '',
    '<!-- Made from src/lib/release-notes.json. Do not edit by hand: change the JSON, then run',
    '     UPDATE_WHATS_NEW=1 npx vitest run src/lib/release-notes.test.ts -->',
    '',
    "New features and fixes, newest first. Everything that went live on the same day is one release, numbered by the date (release 2026.11.06 went live November 6, 2026). In the app: More → What's new. People only see the changes for the parts of the app they use; the area is in brackets.",
    '',
  ];
  for (const r of groupReleases(list)) {
    out.push(`## Release ${r.number} (${releaseDayLabel(r.date)}, ${r.date.slice(0, 4)})`, '');
    for (const n of r.notes) {
      out.push(`- ${n.kind === 'fix' ? 'Fixed' : 'New'}: ${n.text} Where: ${n.where}. [${n.areas.map(a => AREA_LABEL[a]).join(', ')}]`);
    }
    out.push('');
  }
  return out.join('\n');
}
