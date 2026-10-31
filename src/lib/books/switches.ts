import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The pieces that take the team out of NetSuite, each built switched off
 * (migrations 466 and 467, docs/books.md "Switches"; owner decisions 2026-10-31,
 * thread "Replacing NetSuite with FleetSuite": the team works only in
 * FleetSuite from January 1, 2027, apart from payments, deposits and
 * banking, and each piece waits for its switch).
 *
 * While a piece is off, super admins can open its screen and see what it
 * would send, and nothing goes to NetSuite; the people who'd use it don't
 * see it at all. A super admin turns it on in Books → Switches. A switch
 * that can't be read counts as off.
 */

export type SwitchPiece = 'credit_memos' | 'vendor_credits';

export interface SwitchInfo {
  name: string;
  /** What it does once it's on, a sentence. */
  what: string;
  /** Where people find it, for the Switches page. */
  where: string;
}

export const SWITCHES: Readonly<Record<SwitchPiece, SwitchInfo>> = {
  credit_memos: {
    name: 'Credit memos',
    what: 'Anyone with Invoicing makes a credit memo against an invoice in FleetSuite, and FleetSuite makes it in NetSuite and keeps its own copy for the books.',
    where: 'Invoicing → Invoiced → Credit on an invoice',
  },
  vendor_credits: {
    name: 'Vendor credits',
    what: "Admins with Parts Ordering enter a vendor's credit in FleetSuite and apply it to that vendor's open bills, and FleetSuite makes it in NetSuite and keeps its own copy for the books.",
    where: 'More → Purchasing → Vendor Credits',
  },
};

export const SWITCH_PIECES = Object.keys(SWITCHES) as SwitchPiece[];

/** The day the plan turns them on. */
export const SWITCH_ON_DATE_TEXT = 'January 1, 2027';

export const isSwitchPiece = (v: unknown): v is SwitchPiece => typeof v === 'string' && (SWITCH_PIECES as string[]).includes(v);

export interface SwitchState {
  piece: SwitchPiece;
  on: boolean;
  changedBy: string | null;
  changedAt: string | null;
}

/** Every switch, off where its row is missing. A read that fails throws. */
export async function readSwitches(service: SupabaseClient): Promise<SwitchState[]> {
  const { data, error } = await service.from('books_switches').select('piece, is_on, changed_by, changed_at');
  if (error) throw new Error(error.message);
  const rows = new Map(((data ?? []) as Array<{ piece: string; is_on: boolean | null; changed_by: string | null; changed_at: string | null }>)
    .map((r) => [r.piece, r]));
  return SWITCH_PIECES.map((piece) => {
    const row = rows.get(piece);
    return { piece, on: row?.is_on === true, changedBy: row?.changed_by ?? null, changedAt: row?.changed_at ?? null };
  });
}

/** Whether one piece is on. Off when its row is missing or can't be read. */
export async function switchIsOn(service: SupabaseClient, piece: SwitchPiece): Promise<boolean> {
  try {
    const { data, error } = await service.from('books_switches').select('is_on').eq('piece', piece).maybeSingle();
    if (error) return false;
    return (data as { is_on?: boolean } | null)?.is_on === true;
  } catch {
    return false;
  }
}

/** Turns a piece on or off. Returns the state it was in before. */
export async function setSwitch(service: SupabaseClient, piece: SwitchPiece, on: boolean, by: string): Promise<{ was: boolean }> {
  const was = await switchIsOn(service, piece);
  const { error } = await service
    .from('books_switches')
    .upsert({ piece, is_on: on, changed_by: by, changed_at: new Date().toISOString() }, { onConflict: 'piece' });
  if (error) throw new Error(error.message);
  return { was };
}
