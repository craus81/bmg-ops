/**
 * The More tab's groups, their order, and its page search (Craig,
 * 2026-10-26, thread "Reorganize the More menu"): categories fold like the
 * Arriving section, each page's description sits behind an (i), the person's
 * own area comes first, and a search box finds app pages by name.
 */

import type { DashboardFocus } from '@/lib/dashboard-focus';

export const MORE_GROUPS = [
  { id: 'sales', header: 'Sales' },
  { id: 'shop', header: 'Shop & Jobs' },
  { id: 'purchasing', header: 'Purchasing & Receiving' },
  { id: 'parts', header: 'Parts & Inventory' },
  { id: 'money', header: 'Money & Books' },
  { id: 'cni', header: 'CNI Network' },
  { id: 'part-setup', header: 'Part Setup' },
  { id: 'admin', header: 'Admin' },
  { id: 'you', header: 'You' },
] as const;
export type MoreGroupId = typeof MORE_GROUPS[number]['id'];

/** The groups each Dashboard focus brings to the top, in that order. */
const FOCUS_GROUPS: Record<DashboardFocus, MoreGroupId[]> = {
  everything: [],
  sales: ['sales'],
  financial: ['money'],
  scheduling: ['shop'],
  purchasing: ['purchasing', 'parts'],
};

/** Group order for a person: their focus areas first, the rest as listed. */
export function orderMoreGroups(focus: DashboardFocus[]): MoreGroupId[] {
  const first: MoreGroupId[] = [];
  for (const f of focus) for (const g of FOCUS_GROUPS[f] || []) if (!first.includes(g)) first.push(g);
  return [...first, ...MORE_GROUPS.map(g => g.id).filter(g => !first.includes(g))];
}

/**
 * Pages matching a search. Every word typed must appear in the page's title
 * or description (any order, any case); title matches sort first. An empty
 * search matches nothing, so the grouped menu shows instead.
 */
export function searchMorePages<T extends { title: string; sub: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits = items.filter(i => {
    const text = `${i.title} ${i.sub}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
  const inTitle = (i: T) => words.every(w => i.title.toLowerCase().includes(w));
  return [...hits.filter(inTitle), ...hits.filter(i => !inTitle(i))];
}

