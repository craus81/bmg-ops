/**
 * New sales order from nothing (Craig, 2026-10-31, thread "Redesign
 * order-to-cash and procure-to-pay", answers 1A 2A 3A 4B). Same screen and
 * lines as New invoice (src/lib/new-invoice.ts: any NetSuite item, typed
 * price, discounts, FleetSuite's tax rule), but FleetSuite makes a NetSuite
 * sales order from O'Fallon instead. Nothing is billed and no stock comes
 * off; NetSuite commits stock the way it does for any order.
 *
 *   1A  anyone with the Estimates or the Invoicing permission;
 *   2A  lines as New invoice;
 *   3A  just the order, no FleetSuite job (no upfit project);
 *   4B  an optional ship-to box, else NetSuite uses the customer's default.
 *
 * Pure, so the page and /api/sales-orders/new agree.
 */

import { EMPTY_SHIP_TO, type ShipTo } from '@/lib/drop-ship';

/** Who can make one (1A). */
export const NEW_SALES_ORDER_FEATURES = ['estimates', 'invoicing'] as const;

/** Ship-to parts the box asks for; attention, a second street line and phone stay out of it. */
export type NewSoShipTo = Pick<ShipTo, 'name' | 'address' | 'city' | 'state' | 'zip'>;

export const EMPTY_NEW_SO_SHIP_TO: NewSoShipTo = { name: '', address: '', city: '', state: '', zip: '' };

const t = (s: string | null | undefined) => (s ?? '').trim();

/** True when nothing is typed in the box: the order takes the customer's default ship-to. */
export function shipToBlank(s: NewSoShipTo): boolean {
  return !t(s.name) && !t(s.address) && !t(s.city) && !t(s.state) && !t(s.zip);
}

/** What's missing from a ship-to that was started, or null when it's blank or whole. */
export function shipToProblem(s: NewSoShipTo): string | null {
  if (shipToBlank(s)) return null;
  const missing = [
    !t(s.name) && 'name',
    !t(s.address) && 'street',
    !t(s.city) && 'city',
    !t(s.state) && 'state',
    !t(s.zip) && 'ZIP',
  ].filter(Boolean) as string[];
  if (missing.length === 0) return null;
  return `Ship-to: add the ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`}, or clear the box to use the customer's address.`;
}

/** The ship-to as drop ship's ShipTo (for shippingAddressBody), trimmed, state upper-cased; null when blank. */
export function shipToForNetSuite(s: NewSoShipTo): ShipTo | null {
  if (shipToBlank(s)) return null;
  return { ...EMPTY_SHIP_TO, name: t(s.name), address: t(s.address), city: t(s.city), state: t(s.state).toUpperCase(), zip: t(s.zip) };
}

/** Today in O'Fallon (the order's date), as YYYY-MM-DD. */
export function centralToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * The row the Sales orders list reads (netsuite_sales_orders), written as soon as NetSuite makes the order so it
 * shows before the 2-hour sync, which then overwrites it with NetSuite's own. Status B (Pending Fulfillment) is
 * what a new order is unless the account routes it for approval, which the sync then corrects.
 */
export function mirrorRow(o: {
  netsuiteId: string; number: string | null; customerNetsuiteId: string; customerName: string | null;
  date: string; poNumber: string | null; memo: string | null; vin: string | null; totalCents: number;
}) {
  return {
    netsuite_id: o.netsuiteId,
    tranid: o.number,
    customer_netsuite_id: o.customerNetsuiteId,
    customer_name: o.customerName,
    trandate: o.date,
    status: 'B',
    status_label: null,
    memo: o.memo,
    otherrefnum: o.poNumber,
    vin: o.vin,
    total: o.totalCents / 100,
  };
}
