import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The pieces that take the team out of NetSuite, each built switched off
 * (migrations 466 to 473 and 478 to 480, docs/books.md "Switches"; owner decisions 2026-10-31,
 * thread "Replacing NetSuite with FleetSuite": the team works only in
 * FleetSuite from January 1, 2027, apart from payments, deposits and
 * banking, and each piece waits for its switch).
 *
 * While a piece is off, super admins can open its screen and see what it
 * would send, and nothing goes to NetSuite; the people who'd use it don't
 * see it at all. A super admin turns it on in Books → Switches. A switch
 * that can't be read counts as off. Estimates in FleetSuite only is the
 * other way round: on, it stops a send (src/lib/estimates-in-fleetsuite.ts),
 * and while it's off estimates push as they do now. So is FleetSuite's
 * record wins: on, it stops the NetSuite syncs writing over FleetSuite's
 * customers and vendors, so a sync that can't read it stops rather than
 * count it as off (readSwitch, src/lib/fleetsuite-records.ts).
 */

export type SwitchPiece =
  | 'credit_memos' | 'vendor_credits' | 'card_charges' | 'journal_entries' | 'inventory_transfers' | 'invoice_fixes' | 'bill_fixes'
  | 'customer_vendor_details' | 'item_accounts' | 'estimates_in_fleetsuite' | 'fleetsuite_records';

export interface SwitchInfo {
  name: string;
  /** What it does once it's on, a sentence. */
  what: string;
  /** Where people find it, for the Switches page. */
  where: string;
  /** What switching it on or off asks first, where the Switches page's own words don't fit. */
  turnOn?: string;
  turnOff?: string;
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
  card_charges: {
    name: 'Card charges',
    what: "Anyone with Payments adds the Chase card's activity, codes each charge to its account (FleetSuite remembers each merchant's), and FleetSuite sends each month's charges to NetSuite as a journal entry and keeps its own copy for the books.",
    where: 'More → Money & Books → Card Charges',
  },
  journal_entries: {
    name: 'Journal entries',
    what: 'Anyone with Payments types a journal entry in FleetSuite and asks for approval, a super admin who didn\'t ask approves it, and FleetSuite makes it in NetSuite and keeps its own copy for the books.',
    where: 'More → Money & Books → Journal Entries',
  },
  inventory_transfers: {
    name: 'Inventory transfers',
    what: "Admins move stock from one of a company's locations to another in FleetSuite, and FleetSuite makes the transfer in NetSuite.",
    where: 'More → Parts & Inventory → Inventory Transfers',
  },
  invoice_fixes: {
    name: 'Fixing invoices',
    what: "Anyone with Invoicing fixes an invoice after it's made, its PO number, memo and VIN, and while nothing on it is paid its date and lines, and FleetSuite makes the change in NetSuite and in its own copy for the books.",
    where: 'Invoicing → Invoiced → Fix on an invoice',
  },
  bill_fixes: {
    name: 'Fixing bills',
    what: "Admins with Parts Ordering fix a bill after it's made, its number, memo and due date, and while nothing on it is paid its date and lines, and FleetSuite makes the change in NetSuite and in its own copy for the books.",
    where: 'More → Purchasing → Fix a Bill, or Fix on Books → Own bills',
  },
  customer_vendor_details: {
    name: 'Customer and vendor details',
    what: "Anyone with Credit Applications changes a customer's terms and credit limit, and anyone with Payments a vendor's email, phone, terms, addresses and 1099 details, in FleetSuite, and FleetSuite makes the change in NetSuite.",
    where: 'More → Sales → Customer Terms, or Change on a customer; More → Money & Books → Vendor Details',
  },
  item_accounts: {
    name: 'Item accounts',
    what: "Anyone with Payments changes an item's income account, an inventory item's cost of goods sold and inventory asset accounts, and the expense account of one that's bought, in FleetSuite, and FleetSuite makes the change in NetSuite.",
    where: 'More → Money & Books → Item Accounts, or Change accounts on Books → Stock by item',
  },
  estimates_in_fleetsuite: {
    name: 'Estimates in FleetSuite only',
    what: "Estimates stay in FleetSuite: nobody pushes one to NetSuite any more, and NetSuite gets each job's sales order when it's made, as now. Until it's on, estimates push as they do today.",
    where: "An estimate's buttons, where Push to NetSuite as Estimate goes",
    turnOn: "Switch on Estimates in FleetSuite only? From now on nobody can push an estimate to NetSuite, and NetSuite gets each job's sales order when it's made.",
    turnOff: 'Switch off Estimates in FleetSuite only? Estimates can be pushed to NetSuite again, as before.',
  },
  fleetsuite_records: {
    name: "FleetSuite's record wins",
    what: "A change made in NetSuite to a customer's name, email, phone or billing address, or a vendor's name, email or phone, no longer comes into FleetSuite over what FleetSuite has: it's listed under Books → Changed in NetSuite, to keep FleetSuite's (sent on to NetSuite) or take NetSuite's. Until it's on, NetSuite's changes come in as they do today.",
    where: 'The NetSuite customer and vendor syncs, and Books → Changed in NetSuite',
    turnOn: "Switch on FleetSuite's record wins? From now on a change made in NetSuite to a customer's or vendor's name, email, phone or address doesn't come into FleetSuite by itself: it's listed under Books → Changed in NetSuite.",
    turnOff: "Switch off FleetSuite's record wins? NetSuite's changes come into FleetSuite again as before, over what FleetSuite has.",
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

/**
 * Whether one piece is on, for a caller that mustn't take it for off when it
 * can't tell: off when its row is missing, and a read that fails throws.
 */
export async function readSwitch(service: SupabaseClient, piece: SwitchPiece): Promise<boolean> {
  const { data, error } = await service.from('books_switches').select('is_on').eq('piece', piece).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { is_on?: boolean } | null)?.is_on === true;
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
