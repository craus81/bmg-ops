import { estimateIsLocked } from '@/lib/estimate-copy';

/**
 * Several estimates emailed at once from the Estimates list (Craig,
 * 2026-10-28, thread "Bulk email estimates to customers"): Send for approval
 * puts a customer's picked estimates in one approval email, and Email PDFs
 * puts their PDFs in one plain email. Either way it is one email per
 * customer, each through its own compose screen.
 */

export interface BatchEstimate {
  id: string;
  customer_id?: string | null;
  prospect_id?: string | null;
  customer_netsuite_id?: string | null;
  customer_name?: string | null;
}

/** Most estimates one email may carry. */
export const MAX_BATCH_ESTIMATES = 20;

/**
 * Which customer an estimate is for, as one comparable key: the customer
 * record, else the CRM lead, else the NetSuite id, else the typed name.
 * Two estimates with the same key go in the same email.
 */
export function estimateCustomerKey(e: BatchEstimate): string {
  if (e.customer_id) return `c:${e.customer_id}`;
  if (e.prospect_id) return `p:${e.prospect_id}`;
  if (e.customer_netsuite_id) return `n:${e.customer_netsuite_id}`;
  const name = String(e.customer_name || '').trim().toLowerCase();
  return name ? `name:${name}` : `none:${e.id}`;
}

/** The picked estimates grouped by customer, in the order first picked. */
export function groupByCustomer<T extends BatchEstimate>(estimates: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const e of estimates) {
    const key = estimateCustomerKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups.values()];
}

/** Can this estimate still be sent for approval? Not once it is approved
 *  or on a sales order (the same rule as a fleet order's siblings). */
export function canSendForApproval(e: { customer_approved?: boolean | null; status?: string | null; netsuite_so_id?: string | null }): boolean {
  return !estimateIsLocked(e);
}

/**
 * What to tell the sender when a batch send fails, in plain words. The
 * route answers `{ error }` for everything it catches, but a request Vercel
 * cuts off (too slow, out of memory) comes back as a bare status with an
 * HTML or empty body: that showed as "Unknown error" (Craig, 2026-10-29).
 */
export function batchSendErrorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch { /* not JSON: a platform error page */ }
  if (status === 504 || /FUNCTION_INVOCATION_TIMEOUT/i.test(body)) {
    return 'Making the PDFs took too long, so the server stopped before sending. Nothing was sent. Try fewer estimates at a time.';
  }
  if (status === 413 || /PAYLOAD_TOO_LARGE/i.test(body)) {
    return 'The email was too big to send. Nothing was sent. Try fewer estimates at a time.';
  }
  const snippet = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `The server answered ${status || 'with no response'}${snippet ? `: ${snippet}` : ''}. Nothing was sent.`;
}
