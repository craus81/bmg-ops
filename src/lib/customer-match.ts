import type { SupabaseClient } from '@supabase/supabase-js';

export interface MatchedCustomer {
  netsuiteId: string;
  companyName: string;
}

/**
 * Resolve a free-text customer name (e.g. "Masterack" off a PO PDF) to a real
 * NetSuite customer from the synced `customers` table.
 *
 * Graded strategy, strictest first:
 *   1. exact company_name match (case-insensitive)
 *   2. exact entity_id match
 *   3. prefix match — "Masterack" → "Masterack LLC" — accepted only when
 *      exactly ONE active customer matches
 *   4. substring match, same single-match rule
 *
 * Ambiguity returns null: this feeds billing documents, so never guess
 * between two customers. Works with both browser and service-role clients.
 */
export async function matchCustomer(
  supabase: SupabaseClient,
  rawName: string | null | undefined,
): Promise<MatchedCustomer | null> {
  const name = (rawName || '').trim();
  if (!name || name.toLowerCase() === 'unknown') return null;

  // Strip ilike wildcards so PDF noise can't turn into a pattern.
  const clean = name.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  const select = () =>
    supabase
      .from('customers')
      .select('netsuite_id, company_name')
      .eq('active', true)
      .not('netsuite_id', 'is', null);

  // 1. Exact company name (ilike with no wildcards = case-insensitive equals).
  const { data: exact } = await select().ilike('company_name', clean).limit(1);
  if (exact?.[0]) {
    return { netsuiteId: exact[0].netsuite_id, companyName: exact[0].company_name };
  }

  // 2. Exact entity id.
  const { data: byEntity } = await select().ilike('entity_id', clean).limit(1);
  if (byEntity?.[0]) {
    return { netsuiteId: byEntity[0].netsuite_id, companyName: byEntity[0].company_name };
  }

  // 3. Unambiguous prefix ("Masterack" → "Masterack LLC").
  const { data: prefix } = await select().ilike('company_name', `${clean}%`).limit(2);
  if (prefix?.length === 1) {
    return { netsuiteId: prefix[0].netsuite_id, companyName: prefix[0].company_name };
  }

  // 4. Unambiguous substring, as a last resort.
  const { data: sub } = await select().ilike('company_name', `%${clean}%`).limit(2);
  if (sub?.length === 1) {
    return { netsuiteId: sub[0].netsuite_id, companyName: sub[0].company_name };
  }

  return null;
}

/**
 * Resolve a PO's customer for insert/update: returns the canonical customer
 * name (the matched NetSuite company name, so "Masterack" becomes
 * "Masterack LLC" everywhere it displays) plus the NetSuite id, or the
 * original text with a null id when nothing matched.
 */
export async function resolvePoCustomer(
  supabase: SupabaseClient,
  rawName: string | null | undefined,
): Promise<{ customer: string; customerNetsuiteId: string | null }> {
  const fallback = (rawName || '').trim() || 'Unknown';
  try {
    const match = await matchCustomer(supabase, rawName);
    if (match) return { customer: match.companyName, customerNetsuiteId: match.netsuiteId };
  } catch (e) {
    console.error('resolvePoCustomer failed (keeping raw name):', e);
  }
  return { customer: fallback, customerNetsuiteId: null };
}
