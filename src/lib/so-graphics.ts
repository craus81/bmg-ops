/**
 * Graphics jobs from a sales order (Craig, 2026-11-06, thread "Create
 * graphics jobs from sales orders", picked 1C 2A 3A).
 *
 * The sales order page gets a Graphics card: the order's graphics jobs, or
 * "+ Create graphics job" when the order has graphics lines and no job yet.
 * The button opens the usual New Job form filled in from the order, and the
 * job is linked back (graphics_jobs.netsuite_so_id, migration 523) so the
 * card and the Job progress bar see it.
 *
 * Which lines are graphics: the same rule the estimate builder and the
 * Convert to Sales Order gate use (isGraphicsLine: the 3M Vinyl / Graphics
 * Install Labor items, sqft worksheet lines, catalog = graphics), plus the
 * 02 / RM part-number prefix for items the catalog has no opinion on — the
 * rule the Awaiting Graphics prefill uses for sales order lines.
 *
 * Pure and client-safe, so tests pin it.
 */

import { isGraphicsLine } from './graphics-lines';
import { isGraphicsPartNumber } from './po-install-parts';
import { graphicsJobQuantity } from './graphics-job-quantity';

export interface SoGraphicsLineIn {
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  isClosed?: boolean;
}

export type SoGraphicsCatalog = Map<string, { catalog?: string | null }>;

/** "Parent : 02-1234" → "02-1234", upper-cased; matches netsuite_parts keys. */
export function soItemKey(s: string | null | undefined): string {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
}

export function isSoGraphicsLine(line: SoGraphicsLineIn, catalog?: SoGraphicsCatalog): boolean {
  if (line.isClosed) return false;
  const key = soItemKey(line.itemNumber);
  const cat = key ? catalog?.get(key)?.catalog ?? null : null;
  if (isGraphicsLine({ catalog: cat, item_number: (line.itemNumber || '').trim(), description: line.description })) return true;
  // Prefix only when the catalog has no say: an 02 item the catalog files
  // under upfit is an upfit part.
  return !cat && isGraphicsPartNumber(key);
}

/** Install labor rides on the order but is not something to print. */
export function isGraphicsLaborLine(line: SoGraphicsLineIn): boolean {
  // Items starting 06 are services (installation charges).
  return /\blabor\b/i.test(line.itemNumber || '') || /^06/.test(soItemKey(line.itemNumber))
    || /^graphics install labor/i.test(line.description || '');
}

export function soGraphicsLines<T extends SoGraphicsLineIn>(lines: T[], catalog?: SoGraphicsCatalog): T[] {
  return lines.filter(l => isSoGraphicsLine(l, catalog));
}

export interface SoJobPrefillInput {
  header: {
    tranId: string;
    customerName: string;
    poNumber: string;
    memo: string;
    vin: string;
    endUser: string;
  };
  lines: SoGraphicsLineIn[];
  catalog?: SoGraphicsCatalog;
}

export interface SoJobPrefill {
  title: string;
  customer: string;
  partNumbers: string[];
  quantity: number;
  /** The print lines disagree on quantity; the form starts at 1. */
  quantityAmbiguous: boolean;
  content: string;
  notes: string;
  poNumber: string;
  soNumber: string;
  /** One line said above the form: what was filled in and from where. */
  note: string;
}

/** The memo's first line, unless it is one of the stamped lines. */
function memoTitle(memo: string): string {
  const first = memo.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  if (/^(delivery:|fleetsuite estimate)/i.test(first)) return '';
  return first.slice(0, 120);
}

/** "Delivery: … · Install at: … · Contact: …" → one item per line. */
function memoDeliveryNotes(memo: string): string {
  const lines = memo.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const delivery = lines.find(l => /^delivery:/i.test(l));
  if (!delivery) return '';
  return delivery.split(/\s+·\s+/).map(s => s.trim()).filter(Boolean).join('\n');
}

export function buildSoJobPrefill(input: SoJobPrefillInput): SoJobPrefill {
  const { header } = input;
  const gfx = soGraphicsLines(input.lines, input.catalog);
  const print = gfx.filter(l => !isGraphicsLaborLine(l));

  const partNumbers = [...new Set(print.map(l => (l.itemNumber || '').trim()).filter(Boolean))];
  const qtys = [...new Set(print.map(l => graphicsJobQuantity(l.quantity)))];
  const quantityAmbiguous = qtys.length > 1;

  const vinTail = header.vin ? ` · ${header.vin.trim().slice(-6)}` : '';
  const title = (memoTitle(header.memo) || [header.customerName, header.tranId ? `SO #${header.tranId}` : ''].filter(Boolean).join(' - ')) + vinTail;

  const content = [
    ...gfx.map(l => (l.description || l.itemNumber || '').trim()).filter(Boolean),
    header.vin ? `VIN ${header.vin.trim()}` : '',
    header.endUser ? `End user: ${header.endUser.trim()}` : '',
    header.tranId ? `SO #${header.tranId}` : '',
  ].filter(Boolean).join('\n');

  let note: string;
  if (gfx.length === 0) {
    note = `Filled in from SO #${header.tranId}. None of its lines look like graphics, so add the part numbers by hand.`;
  } else {
    note = `Filled in from SO #${header.tranId}: ${gfx.length} graphics line${gfx.length !== 1 ? 's' : ''}.`
      + (quantityAmbiguous ? ' The lines disagree on quantity, so it is set to 1. Check it.' : '')
      + ' Check it over, then create.';
  }

  return {
    title,
    customer: header.customerName,
    partNumbers,
    quantity: qtys.length === 1 ? qtys[0] : 1,
    quantityAmbiguous,
    content,
    notes: memoDeliveryNotes(header.memo),
    // The customer's PO wins (it becomes the invoice's PO); the SO # is the fallback.
    poNumber: header.poNumber.trim() || header.tranId,
    soNumber: header.tranId,
    note,
  };
}
