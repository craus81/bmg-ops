/**
 * Sales orders "To print" for the board (Craig, 2026-11-04: "we print the
 * sales order out and hang them in a folder on the board so Harold can see
 * what's going on").
 *
 * - A new sales order lands on the list by itself: the moment FleetSuite
 *   creates it (estimate → SO, + New, customer PO push), or at the next
 *   sales order sync when it was keyed in NetSuite.
 * - A printed order goes back on the list when it is edited in FleetSuite
 *   ("Changed") or a vendor PO is added for its vehicle ("New PO"), so the
 *   copy on the board can be swapped.
 * - Each time an order (re)joins the list, people with "Prints sales
 *   orders" ticked (Jessie) get a bell + push, and so does anyone with
 *   "Copy me on new alerts" (Craig).
 *
 * The page is /sales-orders/to-print; the printout is the Job Order
 * (src/lib/job-order-pdf.ts), which carries the End user and the vendor
 * POs and never shows prices.
 *
 * Every function here is best effort and never throws: a print-list miss
 * must never fail the sales order, PO or edit that triggered it.
 */

import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { normalizeEndUser } from '@/lib/end-user';

export const SO_TO_PRINT_NOTIFICATION_TYPE = 'so_to_print';
export const SO_TO_PRINT_URL = '/sales-orders/to-print';

/** Orders keyed in NetSuite before this day never join the list (the sync
 *  also backfills history, which must not flood Jessie). */
export const PRINT_QUEUE_START = '2026-11-04';

export type PrintReason = 'new' | 'changed' | 'new_po';

type Db = { from: (table: string) => any };

export interface QueueInput {
  soNetsuiteId: string;
  soNumber?: string | null;
  customerName?: string | null;
  endUser?: string | null;
}

/** Alert wording. Pure. */
export function buildToPrintNotification(
  so: { soNumber?: string | null; soNetsuiteId: string; customerName?: string | null; endUser?: string | null },
  reason: PrintReason,
  detail?: string | null,
): { title: string; body: string } {
  const num = so.soNumber || `SO ${so.soNetsuiteId}`;
  const title = reason === 'new' ? `${num} to print`
    : reason === 'changed' ? `${num} changed: print it again`
    : `${num} has a new vendor PO: print it again`;
  const who = [so.customerName || '', so.endUser ? `end user ${so.endUser}` : ''].filter(Boolean).join(', ');
  const why = reason === 'new' ? 'New sales order for the board.'
    : reason === 'changed' ? 'Swap the copy on the board.'
    : `Swap the copy on the board${detail ? ` (PO ${detail})` : ''}.`;
  return { title, body: [who, why].filter(Boolean).join(' · ') };
}

/** NetSuite SuiteQL dates are M/D/YYYY; the mirror may hold either shape. → YYYY-MM-DD or null. */
export function isoDay(d: string | null | undefined): string | null {
  const s = String(d || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** Whether a synced order is new enough to join the list. Pure. */
export function syncedOrderQualifies(trandate: string | null | undefined, start = PRINT_QUEUE_START): boolean {
  const day = isoDay(trandate);
  return !!day && day >= start;
}

export async function printerIds(service: Db): Promise<string[]> {
  const { data } = await service
    .from('notification_preferences')
    .select('user_id')
    .eq('prints_sales_orders', true);
  return [...new Set(((data || []) as any[]).map(r => r.user_id as string).filter(Boolean))];
}

async function alert(service: Db, so: QueueInput, reason: PrintReason, detail?: string | null): Promise<void> {
  const [printers, watchers] = await Promise.all([printerIds(service), newAlertWatcherIds(service)]);
  const ids = [...new Set([...printers, ...watchers])];
  if (ids.length === 0) return;
  const { title, body } = buildToPrintNotification(so, reason, detail);
  // Loaded here, not at the top: notify.ts makes a service client when it
  // loads, and the sales order sync and PO code import this file.
  const { notifyMany } = await import('@/lib/notify');
  await notifyMany(ids, {
    type: SO_TO_PRINT_NOTIFICATION_TYPE,
    title,
    body,
    url: SO_TO_PRINT_URL,
    channels: ['in_app', 'push', 'email'],
  });
}

/**
 * A new sales order joins the list (once: an order already on it, printed
 * or not, is left alone). Returns true when it was added and alerted.
 */
export async function queueNewSalesOrder(service: Db, so: QueueInput): Promise<boolean> {
  try {
    if (!/^\d{1,15}$/.test(String(so.soNetsuiteId || ''))) return false;
    const { data, error } = await service.from('so_print_queue').upsert({
      so_netsuite_id: String(so.soNetsuiteId),
      so_number: so.soNumber || null,
      customer_name: so.customerName || null,
      end_user: normalizeEndUser(so.endUser) || null,
      status: 'to_print',
      reason: 'new',
    }, { onConflict: 'so_netsuite_id', ignoreDuplicates: true }).select('id');
    if (error || !data || data.length === 0) return false;
    await alert(service, so, 'new');
    return true;
  } catch (err) {
    console.warn('queueNewSalesOrder failed:', err);
    return false;
  }
}

/**
 * A PRINTED order goes back on the list. An order still waiting stays as it
 * is (its printout is built when Jessie prints, so it is already current);
 * an order that was never on the list (before this feature) is left off.
 */
export async function requeuePrintedSalesOrder(
  service: Db,
  soNetsuiteId: string,
  reason: Exclude<PrintReason, 'new'>,
  opts?: { endUser?: string | null; detail?: string | null },
): Promise<boolean> {
  try {
    const patch: Record<string, unknown> = { status: 'to_print', reason, queued_at: new Date().toISOString() };
    if (opts?.endUser !== undefined) patch.end_user = normalizeEndUser(opts.endUser) || null;
    const { data, error } = await service.from('so_print_queue')
      .update(patch)
      .eq('so_netsuite_id', String(soNetsuiteId))
      .eq('status', 'printed')
      .select('so_netsuite_id, so_number, customer_name, end_user');
    if (error || !data || data.length === 0) {
      // Still waiting: keep its End user current for the list.
      if (opts?.endUser !== undefined) {
        await service.from('so_print_queue')
          .update({ end_user: normalizeEndUser(opts.endUser) || null })
          .eq('so_netsuite_id', String(soNetsuiteId));
      }
      return false;
    }
    const row = data[0];
    await alert(service, {
      soNetsuiteId: row.so_netsuite_id, soNumber: row.so_number,
      customerName: row.customer_name, endUser: row.end_user,
    }, reason, opts?.detail);
    return true;
  } catch (err) {
    console.warn('requeuePrintedSalesOrder failed:', err);
    return false;
  }
}

/** A vendor PO was linked to these jobs: their printed sales orders go back on the list. */
export async function requeueForNewPo(service: Db, projectIds: string[], poNumber?: string | null): Promise<number> {
  try {
    const ids = [...new Set(projectIds.filter(Boolean))];
    if (ids.length === 0) return 0;
    const { data } = await service.from('upfit_projects').select('netsuite_so_id').in('id', ids);
    const soIds = [...new Set(((data || []) as any[]).map(r => String(r.netsuite_so_id || '')).filter(s => /^\d+$/.test(s)))];
    let n = 0;
    for (const soId of soIds) {
      if (await requeuePrintedSalesOrder(service, soId, 'new_po', { detail: poNumber || null })) n++;
    }
    return n;
  } catch (err) {
    console.warn('requeueForNewPo failed:', err);
    return 0;
  }
}

/** After a sync page: NetSuite-keyed orders from PRINT_QUEUE_START on join the list. */
export async function queueSyncedSalesOrders(
  service: Db,
  sos: { id: string | number; tranid?: string | null; trandate?: string | null; customer_name?: string | null; end_user?: string | null }[],
): Promise<number> {
  let n = 0;
  for (const so of sos) {
    if (!syncedOrderQualifies(so.trandate)) continue;
    if (await queueNewSalesOrder(service, {
      soNetsuiteId: String(so.id), soNumber: so.tranid || null,
      customerName: so.customer_name || null, endUser: so.end_user || null,
    })) n++;
  }
  return n;
}
