/**
 * Customer hold for past-due accounts (migration 366, owner decisions
 * 2026-10-13).
 *
 * Any invoice 60+ days past due (ar_reminder_settings.hold_days) puts the
 * customer On hold. While on hold, sending an estimate or wrap quote and
 * creating a sales order need an override with a reason from an admin or an
 * A/R contact. A person can also hold or release a customer by hand: 'hold'
 * forces it, 'release' keeps the customer off hold whatever the sweep says.
 *
 * Pure helpers, safe in server routes and client components alike.
 */

export type HoldAction = 'estimate_send' | 'wrap_quote_send' | 'sales_order';

export const HOLD_ACTION_LABEL: Record<HoldAction, string> = {
  estimate_send: 'sent an estimate',
  wrap_quote_send: 'sent a wrap quote',
  sales_order: 'created a sales order',
};

export interface CustomerHoldRow {
  netsuite_customer_id: string;
  customer_id: string | null;
  customer_name: string | null;
  auto_hold: boolean;
  auto_since: string | null;
  oldest_days: number | null;
  past_due_amount: number | string | null;
  manual: 'hold' | 'release' | null;
  manual_note: string | null;
  manual_by: string | null;
  manual_at: string | null;
}

export function isOnHold(row: Pick<CustomerHoldRow, 'auto_hold' | 'manual'> | null | undefined): boolean {
  if (!row) return false;
  return row.manual === 'hold' || (row.auto_hold && row.manual == null);
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** One line saying why the customer is on hold. */
export function holdReason(row: CustomerHoldRow): string {
  if (row.manual === 'hold') return `Put on hold by hand${row.manual_note ? `: ${row.manual_note}` : ''}`;
  const amt = row.past_due_amount != null ? Number(row.past_due_amount) : null;
  return `Invoice ${row.oldest_days ?? '60+'} days past due${amt != null && amt > 0 ? ` (${usd(amt)} past due)` : ''}`;
}

/** The 409 body a gated route returns, read by holdAwareFetch on the client. */
export interface HoldBlockedBody {
  error: string;
  customerOnHold: true;
  customer: string;
  reason: string;
  canOverride: boolean;
}

export const HOLD_OVERRIDE_HEADER = 'x-hold-override-reason';

/**
 * Which customers changed state between two sweeps, for the notifications.
 * Only the auto verdict moves here; a manual hold/release is announced when
 * the person sets it.
 */
export function holdTransitions(
  before: Map<string, Pick<CustomerHoldRow, 'auto_hold' | 'manual'>>,
  after: Map<string, { auto_hold: boolean }>,
): { placed: string[]; lifted: string[] } {
  const placed: string[] = [];
  const lifted: string[] = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const prev = before.get(id);
    const manual = prev?.manual ?? null;
    if (manual) continue; // a person's call stands; the sweep changes nothing visible
    const was = !!prev?.auto_hold;
    const now = !!after.get(id)?.auto_hold;
    if (!was && now) placed.push(id);
    if (was && !now) lifted.push(id);
  }
  return { placed, lifted };
}

export interface HoldChange {
  netsuiteId: string;
  customerId: string | null;
  customer: string;
  oldestDays: number;
  pastDue: number;
}

/** Lines for the hold section of a digest. */
export function holdChangeLines(placed: HoldChange[], lifted: HoldChange[]): string[] {
  return [
    ...placed.map(c => `⛔ ${c.customer} is now ON HOLD (oldest invoice ${c.oldestDays} days late, ${usd(c.pastDue)} past due)`),
    ...lifted.map(c => `✅ ${c.customer} is off hold (nothing ${c.oldestDays > 0 ? 'that late' : 'past due'} any more)`),
  ];
}
