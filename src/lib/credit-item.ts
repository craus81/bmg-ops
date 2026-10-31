import { suiteqlQuery } from './netsuite';

/**
 * THE NetSuite item a credit memo credits money on when no part comes back
 * (migration 466, Settings -> NetSuite Credit Item): a price taken off a
 * stock part, or an amount of its own. A stock part credited on its own item
 * goes back on the shelf, as NetSuite does with any credit memo, so a credit
 * with nothing coming back has to go on an item NetSuite doesn't keep stock
 * of.
 *
 * Unlike the labor and discount items there's no search to fall back on: the
 * item decides which income account those credits come off, so a super admin
 * names it once, and until then those credits can't be made (the screen says
 * so). Settings offers NetSuite's likely items to pick from.
 */

export type CreditItemSetting = { id: string; itemNumber: string | null };

/** NetSuite item types a credit with no part coming back can go on: none of them keep stock. */
export const CREDIT_ITEM_TYPES = new Set(['NonInvtPart', 'OthCharge', 'Service']);

/** In words, for Settings. */
export const CREDIT_ITEM_TYPE_WORDS = 'a Non-inventory, Other Charge or Service item';

type SupabaseLike = { from: (table: string) => any };

/** The item Settings names, or null when none is (or settings can't be read). */
export async function configuredCreditItem(supabase: SupabaseLike): Promise<CreditItemSetting | null> {
  try {
    const { data } = await supabase
      .from('quote_settings')
      .select('netsuite_credit_item_id, netsuite_credit_item_number')
      .eq('id', 1)
      .maybeSingle();
    const id = data?.netsuite_credit_item_id;
    if (id && /^\d+$/.test(String(id).trim())) {
      return { id: String(id).trim(), itemNumber: data?.netsuite_credit_item_number || null };
    }
  } catch {
    // Settings unreadable: no item, so those credits wait.
  }
  return null;
}

type Row = { id: string | number; itemid?: string | null; itemtype?: string | null };

/** The words a credit item's name tends to have, most telling first. */
const WORDS = ['CREDIT', 'ADJUST', 'ALLOWANCE', 'GOODWILL', 'REFUND', 'RETURN'];

/**
 * NetSuite's items that could be the credit item, likeliest first: of a type that keeps no stock, with a name that
 * says credit, adjustment, allowance, goodwill, refund or return. Never one about card fees.
 */
export function rankCreditItems<T extends Row>(rows: T[]): T[] {
  const score = (r: T) => {
    const name = (r.itemid || '').trim().toUpperCase();
    const word = WORDS.findIndex((w) => name.includes(w));
    const exact = WORDS.includes(name) || name === 'CREDIT MEMO' ? 0 : 1;
    return word * 10 + exact;
  };
  return rows
    .filter((r) => CREDIT_ITEM_TYPES.has(String(r.itemtype || '')))
    .filter((r) => WORDS.some((w) => (r.itemid || '').toUpperCase().includes(w)))
    .filter((r) => !/CARD|FEE|SURCHARGE/i.test(r.itemid || ''))
    .sort((a, b) => {
      const diff = score(a) - score(b);
      return diff !== 0 ? diff : (a.itemid || '').localeCompare(b.itemid || '');
    });
}

export async function creditItemCandidates(): Promise<{ candidates: { id: string; itemNumber: string; itemType: string | null }[]; error?: string }> {
  try {
    const like = WORDS.map((w) => `UPPER(i.itemid) LIKE '%${w}%'`).join(' OR ');
    const res = await suiteqlQuery(
      `SELECT i.id, i.itemid, i.itemtype FROM item i WHERE i.isinactive = 'F' AND i.itemtype IN ('NonInvtPart', 'OthCharge', 'Service') AND (${like}) ORDER BY i.itemid`,
      100,
    );
    return {
      candidates: rankCreditItems<Row>(res?.items || []).map((r) => ({ id: String(r.id), itemNumber: r.itemid || '', itemType: r.itemtype || null })),
    };
  } catch (err: any) {
    return { candidates: [], error: err?.message || String(err) };
  }
}
