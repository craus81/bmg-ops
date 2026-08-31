import { suiteqlQuery } from './netsuite';

/**
 * THE NetSuite item every estimate and sales order bills shop labor to.
 *
 * History, because both failure modes have now been shipped:
 *   1. Push and convert-to-SO ran two different first-match lookups
 *      (`LIKE '%LABOR%'` vs `LIKE 'LABOR%'`, no ORDER BY), so the same job's
 *      labor could land on different NetSuite items -- including "Graphics
 *      Install Labor" -- and move between GL accounts (Round 1 finding).
 *   2. Closing that (#726) narrowed BOTH routes to `= 'LABOR'` / `LIKE
 *      'LABOR%'`. This account has no item whose name starts with "LABOR",
 *      so the resolver started returning null and every estimate pushed
 *      SHORT BY THE WHOLE LABOR AMOUNT, silently -- the push route only
 *      console.warn'd.
 *
 * So: one resolver, deterministic, and wide enough to actually find the
 * item. Order of authority --
 *   env `NETSUITE_LABOR_ITEM_ID` -> the configured item (Settings ->
 *   NetSuite Labor Item, `quote_settings`, migration 247) -> the
 *   best-ranked active item whose name contains LABOR.
 *
 * The search tier is a fallback, not the answer: it is ranked (see
 * rankLaborItems) rather than first-match, and every caller reports which
 * item labor actually billed to, so an unconfigured account is visible
 * instead of silently wrong. Callers must treat a null item as "labor did
 * NOT sync" and say so -- never as a no-op.
 */

type LaborItem = {
  /** NetSuite internal id. */
  id: string;
  /** NetSuite item name (itemid) -- null when only an id was configured. */
  itemNumber: string | null;
  source: 'env' | 'setting' | 'search';
};

export type LaborItemResolution = {
  item: LaborItem | null;
  /** Why there is no item -- only set when `item` is null. */
  reason?: 'none_found' | 'netsuite_error';
  error?: string;
  /** Other LABOR items in the account, best first (search tier only). */
  candidates?: { id: string; itemNumber: string }[];
};

type LaborItemRow = { id: string | number; itemid?: string | null };

/**
 * Rank the account's LABOR items so the same job always bills the same
 * place. Exact "LABOR" wins, then a LABOR-prefixed name, then any other
 * labor item that is NOT department-specific -- billing shop hours to
 * "Graphics Install Labor" is the mis-posting the single resolver exists to
 * prevent -- and department labor items last. Ties break alphabetically, so
 * the result never depends on NetSuite's row order.
 */
export function rankLaborItems<T extends LaborItemRow>(rows: T[]): T[] {
  const score = (raw: string) => {
    const name = raw.toUpperCase();
    if (name === 'LABOR') return 0;
    if (name.startsWith('LABOR')) return 1;
    if (!/GRAPHIC|WRAP|VINYL|INSTALLER/.test(name)) return 2;
    return 3;
  };
  return rows
    .filter((r) => (r.itemid || '').toUpperCase().includes('LABOR'))
    .sort((a, b) => {
      const diff = score(a.itemid || '') - score(b.itemid || '');
      return diff !== 0 ? diff : (a.itemid || '').localeCompare(b.itemid || '');
    });
}

/** Minimal shape of the Supabase client this needs -- keeps the lib importable from anywhere. */
type SupabaseLike = { from: (table: string) => any };

/**
 * Read the configured labor item, if an admin has set one. A failed read
 * falls through to the NetSuite search rather than dropping labor.
 */
async function configuredLaborItem(supabase: SupabaseLike): Promise<LaborItem | null> {
  try {
    const { data } = await supabase
      .from('quote_settings')
      .select('netsuite_labor_item_id, netsuite_labor_item_number')
      .eq('id', 1)
      .maybeSingle();
    const id = data?.netsuite_labor_item_id;
    if (id && /^\d+$/.test(String(id).trim())) {
      return {
        id: String(id).trim(),
        itemNumber: data?.netsuite_labor_item_number || null,
        source: 'setting',
      };
    }
  } catch {
    // Settings unreadable (schema-cache lag, transient error) -- search.
  }
  return null;
}

export async function resolveLaborItem(supabase?: SupabaseLike): Promise<LaborItemResolution> {
  const override = process.env.NETSUITE_LABOR_ITEM_ID?.trim();
  if (override && /^\d+$/.test(override)) {
    return { item: { id: override, itemNumber: null, source: 'env' } };
  }

  if (supabase) {
    const configured = await configuredLaborItem(supabase);
    if (configured) return { item: configured };
  }

  try {
    // One query, ranked in code: a leading wildcard is what makes this find
    // "Graphics Install Labor" / "Shop Labor" at all, and rankLaborItems is
    // what keeps the choice deterministic.
    const res = await suiteqlQuery(
      "SELECT i.id, i.itemid FROM item i WHERE UPPER(i.itemid) LIKE '%LABOR%' AND i.isinactive = 'F' ORDER BY i.itemid",
      100
    );
    const ranked = rankLaborItems<LaborItemRow>(res?.items || []);
    const best = ranked[0];
    if (!best) return { item: null, reason: 'none_found' };
    return {
      item: { id: String(best.id), itemNumber: best.itemid || null, source: 'search' },
      candidates: ranked.map((r) => ({ id: String(r.id), itemNumber: r.itemid || '' })),
    };
  } catch (err: any) {
    return { item: null, reason: 'netsuite_error', error: err?.message || String(err) };
  }
}
