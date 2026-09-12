/**
 * In-App Help Center (R6-13, audit line 431).
 *
 * The guides already existed as markdown in docs/help/**, and an admin
 * route already loaded them into knowledge_docs under category 'help'.
 * What was missing was a way for staff to READ them: the knowledge base is
 * admin/sales/production only, its page is an upload console, and nothing
 * anywhere pointed a shop tech at the guide written for shop techs.
 *
 * This module is the pure half: which guides belong to which role, which
 * guide a given screen is about, and how a markdown file renders. Ranking
 * reuses the knowledge scorer from text-search.ts rather than a second one.
 *
 * Two rules:
 *
 *  · Role filtering ORDERS, it never hides. Nothing in docs/help is
 *    sensitive, and a sales rep who wants to know how the floor works
 *    should be able to read that. Hiding would also silently break search.
 *  · The "?" on a page renders only when its guide is actually in the
 *    library. A help button that opens an empty page is worse than none.
 */

import { rankDocs, scoreDoc } from '@/lib/text-search';

export interface HelpDoc {
  id: string;
  /** Repo-relative path with docs/help/ and .md stripped: 'sales', 'workflows/estimate-to-invoice'. */
  slug: string;
  title: string;
  tags: string[];
  content: string;
}

export interface HelpSection {
  /** Anchor id, derived from the heading. */
  id: string;
  heading: string;
  level: number;
}

/**
 * The role each guide is written FOR. Keys are slugs, values are the role
 * names from ROLE_DEFAULT_FEATURES. A guide with no entry is general.
 */
export const GUIDE_ROLES: Record<string, string[]> = {
  admin: ['admin', 'super_admin'],
  sales: ['sales'],
  installer: ['installer'],
  'graphics-production': ['graphics_production'],
  'shop-and-field-tech': ['shop_tech', 'field_tech'],
  customer: ['customer'],
};

/**
 * Which guide a screen is about. Longest prefix wins, so
 * /admin/cni/jobs/<id> resolves through /admin before the bare fallback.
 * Every slug here is asserted against docs/help/ by the test — a "?" can't
 * point at a guide that was renamed or deleted.
 */
export const PAGE_GUIDES: { prefix: string; slug: string }[] = [
  { prefix: '/vehicles', slug: 'shop-and-field-tech' },
  { prefix: '/installer', slug: 'installer' },
  { prefix: '/graphics', slug: 'graphics-production' },
  { prefix: '/estimates', slug: 'sales' },
  { prefix: '/quotes', slug: 'sales' },
  { prefix: '/invoices', slug: 'workflows/estimate-to-invoice' },
  { prefix: '/tracking', slug: 'shop-and-field-tech' },
  { prefix: '/fleet', slug: 'shop-and-field-tech' },
  { prefix: '/scan', slug: 'shop-and-field-tech' },
  { prefix: '/customer', slug: 'customer' },
  { prefix: '/admin/prospects', slug: 'sales' },
  { prefix: '/admin/wrap-quote', slug: 'sales' },
  { prefix: '/admin', slug: 'admin' },
  { prefix: '/home', slug: 'getting-started' },
];

/** The guide for a screen, or null when none covers it. */
export function guideForPath(pathname: string | null | undefined): string | null {
  const p = String(pathname || '').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return null;
  let best: { prefix: string; slug: string } | null = null;
  for (const rule of PAGE_GUIDES) {
    if (p === rule.prefix || p.startsWith(rule.prefix + '/')) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best?.slug ?? null;
}

/** Guides written for these roles, in catalogue order. */
export function guidesForRoles(docs: HelpDoc[], roles: string[]): HelpDoc[] {
  const mine = new Set(roles);
  return docs.filter(d => (GUIDE_ROLES[d.slug] || []).some(r => mine.has(r)));
}

/**
 * Split into "written for you" and "everything else", both readable. The
 * second list is not a leftovers bin — it is the rest of the library, and
 * the page labels it that way.
 */
export function partitionForRoles(docs: HelpDoc[], roles: string[]): { mine: HelpDoc[]; others: HelpDoc[] } {
  const mine = guidesForRoles(docs, roles);
  const mineIds = new Set(mine.map(d => d.id));
  return { mine, others: docs.filter(d => !mineIds.has(d.id)) };
}

/** Search the library with the knowledge base's own scorer. */
export function searchGuides(docs: HelpDoc[], query: string, limit = 20): (HelpDoc & { score: number })[] {
  if (!String(query || '').trim()) return [];
  return rankDocs(docs, query, limit);
}

/**
 * The line of a guide that best answers a query, for the search result's
 * snippet. Returns null rather than the opening paragraph when nothing in
 * the body matches — a snippet that doesn't contain the search term reads
 * as a match that isn't one.
 */
export function snippetFor(doc: HelpDoc, query: string, maxLen = 180): string | null {
  const terms = String(query || '').trim().toLowerCase();
  if (!terms) return null;
  const lines = String(doc.content || '').split('\n').map(l => l.trim());
  const words = terms.split(/\s+/).filter(w => w.length >= 3);
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const low = line.toLowerCase();
    if (low.includes(terms) || words.some(w => low.includes(w))) {
      return line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line;
    }
  }
  return null;
}

const slugifyHeading = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

/**
 * The headings in a guide, with unique anchor ids. Two headings with the
 * same words get -2, -3 … so a deep link can't land on the wrong one.
 * Fenced code blocks are skipped: a '# comment' inside one is not a heading.
 */
export function sectionsOf(content: string): HelpSection[] {
  const out: HelpSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const heading = m[2].replace(/\s*#+\s*$/, '').trim();
    if (!heading) continue;
    const base = slugifyHeading(heading);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, heading, level: m[1].length });
  }
  return out;
}

/** Strip YAML frontmatter so it never renders as body text. */
export function stripFrontmatter(raw: string): string {
  const s = String(raw || '');
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  return end === -1 ? s : s.slice(end + 4).replace(/^\n/, '');
}

/** True when a query matches this guide at all — used to gate the snippet. */
export function matches(doc: HelpDoc, query: string): boolean {
  return scoreDoc(doc, query) > 0;
}
