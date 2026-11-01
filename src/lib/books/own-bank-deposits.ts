import type { SupabaseClient } from '@supabase/supabase-js';
import type { BooksCompany } from './journal';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each bank deposit FleetSuite makes (migration 487,
 * docs/books.md "Bank deposits made in FleetSuite").
 *
 * When FleetSuite makes a bank deposit in NetSuite (src/lib/bank-deposit.ts,
 * /api/invoices/bank-deposit), it keeps its own copy, as it was sent rather
 * than read back from NetSuite: the company, the bank account it went into,
 * the day, the memo, the payments and deposits it moved out of Undeposited
 * Funds with what each was, and the total. Checking the copies against
 * NetSuite's bank deposits, and posting them, comes after.
 *
 * Saving never stops a bank deposit: it already exists in NetSuite when the
 * copy is made, so a copy that can't be saved is logged and left.
 */

/** A payment or deposit in it, as the press kept it. */
export interface MadeBankDepositLine {
  netsuiteId: string;
  kind: 'payment' | 'deposit';
  number: string;
  customerName: string;
  cents: number;
}

export interface MadeBankDeposit {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  company: BooksCompany;
  bankAccountNetsuiteId: string;
  /** 'YYYY-MM-DD', the day it went to the bank. */
  date: string;
  memo: string | null;
  lines: readonly MadeBankDepositLine[];
  totalCents: number;
  /** The press of Make deposit (made_bank_deposits.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_bank_deposit_save takes it. Pure. */
export function ownBankDepositPayload(made: MadeBankDeposit & { netsuiteId: string }) {
  return {
    netsuite_id: made.netsuiteId,
    netsuite_number: made.netsuiteNumber ?? null,
    company: made.company,
    made_from_id: made.madeFromId,
    bank_account_netsuite_id: made.bankAccountNetsuiteId,
    deposit_date: made.date,
    memo: made.memo,
    lines: made.lines.map((l) => ({
      netsuite_id: l.netsuiteId, kind: l.kind, number: l.number, customer_name: l.customerName, amount: signedAmount(l.cents),
    })),
    amount: signedAmount(made.totalCents),
    made_by: made.madeBy,
  };
}

/** Saves Books' own copy of a bank deposit FleetSuite just made. Never throws: the deposit exists in NetSuite whatever happens here. */
export async function saveOwnBankDeposit(service: SupabaseClient, made: MadeBankDeposit): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which bank deposit it made" };
  try {
    const { data, error } = await service.rpc('gl_own_bank_deposit_save', { p: ownBankDepositPayload({ ...made, netsuiteId }) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite bank deposit ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
