/**
 * Server-side @mention matching, shared by /api/mentions (every notes
 * surface) and /api/order-chat (which needs to know who was tagged so it
 * can follow them into the chat and skip them in its own fan-out — they get
 * the mention ping instead).
 */

export interface MentionableProfile {
  id: string;
  full_name: string | null;
  role: string | null;
  roles: string[] | null;
}

/** Approved accounts that can be @mentioned: everyone but customer-only
 *  accounts. A multi-role account (e.g. admin + customer) is still staff —
 *  same semantics as /api/scans/log and /api/parts. */
export function mentionableStaff<T extends MentionableProfile>(profiles: T[]): T[] {
  return profiles.filter(p => {
    const roles: string[] = p.roles?.length ? p.roles : (p.role ? [p.role] : []);
    return !(roles.includes('customer') && roles.length === 1);
  });
}

/** Resolve "@Jessie" / "@Jessie Smith" tokens (up to two words) to profile
 *  ids: exact full-name match first, then unique first-name. */
export function resolveMentionIds(body: string, staff: MentionableProfile[]): Set<string> {
  const tokens = [...body.matchAll(/@([A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*)?)/g)].map(m => m[1]);
  const ids = new Set<string>();
  for (const token of tokens) {
    const t = token.toLowerCase();
    const full = staff.filter(p => (p.full_name || '').toLowerCase() === t);
    if (full.length === 1) { ids.add(full[0].id); continue; }
    const firstWord = t.split(' ')[0];
    const firsts = staff.filter(p => (p.full_name || '').toLowerCase().split(' ')[0] === firstWord);
    if (firsts.length === 1) ids.add(firsts[0].id);
  }
  return ids;
}
