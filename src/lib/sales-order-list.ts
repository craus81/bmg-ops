/**
 * The Sales orders list (Sales menu, thread "Redesign order-to-cash and
 * procure-to-pay", 2026-10-27): every NetSuite sales order FleetSuite's copy
 * has (netsuite_sales_orders, the 2-hour sync), one row each, opening the
 * sales order page. Pure, so the route and its test agree on the views.
 *
 * NetSuite's SalesOrd status letters (see CLOSED_SO_STATUS_CODES in
 * parts-demand.ts): A Pending Approval, B Pending Fulfillment, D Partially
 * Fulfilled, E Pending Billing/Partially Fulfilled, F Pending Billing,
 * G Billed, C Cancelled, H Closed.
 */

import { CLOSED_SO_STATUS_CODES } from '@/lib/parts-demand';

export const SO_VIEWS = ['open', 'billed', 'closed', 'all'] as const;
export type SoView = typeof SO_VIEWS[number];

export const SO_VIEW_LABELS: Record<SoView, string> = {
  open: 'Open',
  billed: 'Billed',
  closed: 'Closed',
  all: 'All',
};

const STATUS_TEXT: Record<string, string> = {
  A: 'Pending Approval',
  B: 'Pending Fulfillment',
  C: 'Cancelled',
  D: 'Partially Fulfilled',
  E: 'Pending Billing / Partially Fulfilled',
  F: 'Pending Billing',
  G: 'Billed',
  H: 'Closed',
};

/** The bare letter of a status ("SalesOrd:B" or "B" → "B"). */
export function statusCode(status: string | null | undefined): string {
  const s = String(status || '').trim().toUpperCase();
  return s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
}

/** What the row says: NetSuite's own label when the copy has it, else the letter's name. */
export function statusText(status: string | null | undefined, label: string | null | undefined): string {
  if (label && label.trim()) return label.trim();
  return STATUS_TEXT[statusCode(status)] || (status ? String(status) : 'Unknown');
}

/** Which view a status sits in. */
export function soViewOf(status: string | null | undefined): Exclude<SoView, 'all'> {
  const code = statusCode(status);
  if (code === 'G') return 'billed';
  if (CLOSED_SO_STATUS_CODES.includes(code)) return 'closed';
  return 'open';
}

/** The raw status values a view matches in the copy (both "B" and "SalesOrd:B" spellings). */
export function statusValuesFor(view: Exclude<SoView, 'all'>): string[] {
  const codes = view === 'billed' ? ['G'] : view === 'closed' ? ['C', 'H'] : ['A', 'B', 'D', 'E', 'F'];
  return codes.flatMap(c => [c, `SalesOrd:${c}`]);
}

export function parseSoView(v: string | null | undefined): SoView {
  return (SO_VIEWS as readonly string[]).includes(String(v)) ? (v as SoView) : 'open';
}
