import type { SupabaseClient } from '@supabase/supabase-js';
import { CARD_CHARGE_RULE, type WorkedCardEntry } from '@/lib/card-charges';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each journal entry FleetSuite makes (migration 468,
 * docs/books.md "Card charges coded in FleetSuite").
 *
 * When FleetSuite sends a month of a card's charges to NetSuite as a journal
 * entry (src/lib/card-charges.ts, /api/card-charges), it keeps its own copy,
 * worked out by its own rules rather than read back from NetSuite: each
 * line's account, debit or credit, memo and the charge it's for
 * (card_charges@1). Checking the copies against NetSuite's journal entries,
 * and posting them, comes after.
 *
 * Saving never stops a send: the journal entry already exists in NetSuite
 * when the copy is made, so a copy that can't be saved is logged and left.
 */

export interface MadeCardEntry {
  netsuiteId: string | null | undefined;
  netsuiteNumber: string | null;
  company: string;
  worked: WorkedCardEntry;
  /** The press of Send (card_charge_sends.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_journal_entry_save takes it. Pure. */
export function ownCardEntryPayload(made: MadeCardEntry & { netsuiteId: string }) {
  const { worked } = made;
  return {
    netsuite_id: made.netsuiteId,
    company: made.company,
    source: 'card_charges',
    made_from_id: made.madeFromId,
    netsuite_number: made.netsuiteNumber,
    tran_date: worked.date,
    memo: worked.memo,
    rule: CARD_CHARGE_RULE,
    total: signedAmount(worked.totalCents),
    made_by: made.madeBy,
    lines: worked.lines.map((l, i) => ({
      line_no: i + 1,
      account_netsuite_id: l.accountId,
      debit: l.debitCents > 0 ? signedAmount(l.debitCents) : null,
      credit: l.creditCents > 0 ? signedAmount(l.creditCents) : null,
      memo: l.memo,
      card_charge_id: l.chargeId,
    })),
  };
}

/**
 * Saves Books' own copy of a journal entry FleetSuite just made from a month of card charges. Never throws: the
 * journal entry exists in NetSuite whatever happens here.
 */
export async function saveOwnCardEntry(service: SupabaseClient, made: MadeCardEntry): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which journal entry it made" };
  try {
    const { data, error } = await service.rpc('gl_own_journal_entry_save', { p: ownCardEntryPayload({ ...made, netsuiteId }) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite journal entry ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
