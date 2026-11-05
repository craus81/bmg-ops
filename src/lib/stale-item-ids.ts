import { suiteqlQueryAll } from '@/lib/netsuite';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

/**
 * Stale NetSuite item ids on purchase requests.
 *
 * A purchase request keeps the NetSuite item id its part had when it was
 * asked for. When that item is later deleted and re-created in NetSuite
 * (BAK448146: 29866 → 30068, 2026-11-05), the request still carries the
 * dead id and NetSuite refuses the whole PO with "Invalid Field Value 29866
 * for the following field: item". The catalog kept the dead row too: it is
 * keyed by netsuite_id, and the hourly sync only reads items that changed,
 * which a deleted item never does.
 *
 * Before a PO goes to NetSuite, checkPoItemIds asks NetSuite about every
 * item id on it. An id that is gone (or inactive) is looked up again by its
 * item number: exactly one active item with that number is the part's new
 * id, and the PO uses it. Anything else stops the PO with a plain sentence
 * saying what to fix in NetSuite.
 */

export type ItemIdCheck =
  | { kind: 'ok'; itemNumber: string; id: string }
  | { kind: 'moved'; itemNumber: string; oldId: string; newId: string }
  | { kind: 'inactive'; itemNumber: string; id: string }
  | { kind: 'gone'; itemNumber: string; oldId: string }
  | { kind: 'ambiguous'; itemNumber: string; oldId: string; ids: string[] };

type Query = (sql: string) => Promise<any[]>;

const IN_CHUNK = 500;
const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Check each { itemId, itemNumber } against NetSuite. Returns one result per
 * distinct itemId. Throws when NetSuite can't be read; the caller decides
 * whether that blocks anything.
 */
export async function checkPoItemIds(
  items: { itemId: string; itemNumber: string }[],
  query: Query = sql => suiteqlQueryAll(sql),
): Promise<Map<string, ItemIdCheck>> {
  const byId = new Map<string, string>();
  for (const it of items) {
    const id = String(it.itemId || '').trim();
    if (/^\d+$/.test(id) && !byId.has(id)) byId.set(id, it.itemNumber);
  }
  const out = new Map<string, ItemIdCheck>();
  if (byId.size === 0) return out;

  const found = new Map<string, { inactive: boolean }>();
  for (const ids of chunk([...byId.keys()], IN_CHUNK)) {
    const rows = await query(`SELECT id, isinactive FROM item WHERE id IN (${ids.join(', ')})`);
    for (const r of rows) found.set(String(r.id), { inactive: r.isinactive === 'T' });
  }

  const needLookup: string[] = [];
  for (const [id, itemNumber] of byId) {
    const f = found.get(id);
    if (f && !f.inactive) out.set(id, { kind: 'ok', itemNumber, id });
    else needLookup.push(id);
  }
  if (needLookup.length === 0) return out;

  // Look the broken ones up again by item number.
  const numbers = [...new Set(needLookup.map(id => normalizeItemNumber(byId.get(id))).filter(Boolean))];
  const activeByNumber = new Map<string, string[]>();
  for (const nums of chunk(numbers, IN_CHUNK)) {
    const rows = await query(
      `SELECT id, itemid, isinactive FROM item WHERE UPPER(itemid) IN (${nums.map(sqlString).join(', ')})`,
    );
    for (const r of rows) {
      if (r.isinactive === 'T') continue;
      const key = normalizeItemNumber(r.itemid);
      activeByNumber.set(key, [...(activeByNumber.get(key) || []), String(r.id)]);
    }
  }

  for (const id of needLookup) {
    const itemNumber = byId.get(id) || '';
    const active = (activeByNumber.get(normalizeItemNumber(itemNumber)) || []).filter(x => x !== id);
    if (active.length === 1) out.set(id, { kind: 'moved', itemNumber, oldId: id, newId: active[0] });
    else if (active.length > 1) out.set(id, { kind: 'ambiguous', itemNumber, oldId: id, ids: active });
    else if (found.has(id)) out.set(id, { kind: 'inactive', itemNumber, id });
    else out.set(id, { kind: 'gone', itemNumber, oldId: id });
  }
  return out;
}

/** The sentence a PO is refused with, for a result that blocks it. Null when it doesn't. */
export function itemIdProblem(c: ItemIdCheck): string | null {
  switch (c.kind) {
    case 'inactive':
      return `${c.itemNumber} is inactive in NetSuite. Make it active there, then try again.`;
    case 'gone':
      return `${c.itemNumber} isn’t in NetSuite anymore (item ${c.oldId} was deleted), and no other item has that number. Create it in NetSuite, then request the part again.`;
    case 'ambiguous':
      return `${c.itemNumber} is on ${c.ids.length} active items in NetSuite (${c.ids.join(', ')}), so FleetSuite can’t tell which one to order. Make the extras inactive in NetSuite, then try again.`;
    default:
      return null;
  }
}

/** The note shown after a PO that used a part's new id. */
export function itemIdFixNote(c: Extract<ItemIdCheck, { kind: 'moved' }>): string {
  return `${c.itemNumber} had an old NetSuite item ID (${c.oldId}). FleetSuite switched it to the current one (${c.newId}).`;
}

/**
 * Catalog parts whose NetSuite item no longer exists. Reads every item id
 * NetSuite has (one id column, a few pages) and returns the catalog's
 * active NetSuite ids that are not among them. Returns [] when NetSuite
 * returned nothing at all, so an empty or failed read can never retire the
 * whole catalog.
 */
export async function findRemovedItemIds(
  catalogIds: string[],
  query: Query = sql => suiteqlQueryAll(sql),
): Promise<string[]> {
  if (catalogIds.length === 0) return [];
  const rows = await query('SELECT id FROM item');
  if (rows.length === 0) return [];
  const live = new Set(rows.map(r => String(r.id)));
  const removed = catalogIds.filter(id => !live.has(String(id)));
  // A short read (a page lost, a permission change) would look like a mass
  // deletion. Real deletions are a handful at a time, so a big share means
  // the read is wrong, not the catalog.
  if (removed.length > Math.max(25, catalogIds.length * 0.1)) {
    throw new Error(`NetSuite returned ${rows.length} items but ${removed.length} of ${catalogIds.length} catalog parts were missing from it, so nothing was retired.`);
  }
  return removed;
}
