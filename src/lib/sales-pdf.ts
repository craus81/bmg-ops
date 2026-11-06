/**
 * FleetSuite's own sales order and invoice PDFs (Craig, 2026-11-06): what the
 * sales order Email and every invoice email attach instead of NetSuite's print
 * form. Drawn by the shared form layout (src/lib/transaction-pdf.ts) from the
 * record as NetSuite holds it right now (GET salesOrder|invoice
 * ?expandSubResources=true), so it works for any invoice, old or new.
 *
 * salesPdfDataFromRecord is pure (tested); the server half is
 * sales-pdf-server.ts. NetSuite's own PDF stays on the 📄 PDF links.
 */

import type { TransactionPdfData, TransactionPdfLine } from './transaction-pdf';
import { addressTextLines, createdFromNumber, itemNumberFrom } from './po-pdf';
import { longDay } from './books/own-invoice-pdf';
import { END_USER_FIELD, normalizeEndUser } from './end-user';

type Letterhead = TransactionPdfData['letterhead'];
export type SalesKind = 'sales_order' | 'invoice';

const blank = (s: unknown) => s === null || s === undefined || String(s).trim() === '';
const num = (v: unknown): number | null => {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (n: number) => Math.round(n * 100);
const ref = (v: any): string | null => {
  const s = v && typeof v === 'object' ? v.refName : v;
  return blank(s) ? null : String(s).trim();
};

/** 'YYYY-MM-DD' → 'November 5, 2026'; anything else as it came. */
function dayText(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? longDay(s) : String(v).trim();
}

/** Layout lines NetSuite prints nothing of its own for. */
const SKIP_TYPES = new Set(['subtotal', 'subtotalitem', 'group', 'groupitem', 'itemgroup', 'endgroup']);
const TEXT_TYPES = new Set(['description', 'descriptionitem']);

function itemType(it: any): string {
  const t = it?.itemType ?? it?.itemtype;
  const raw = typeof t === 'object' && t ? (t.id ?? t.refName) : t;
  return blank(raw) ? '' : String(raw).trim().toLowerCase();
}

export function salesLinesFromRecord(record: any): TransactionPdfLine[] {
  const items: any[] = Array.isArray(record?.item?.items) ? record.item.items : [];
  const out: TransactionPdfLine[] = [];
  for (const it of items) {
    if (!it) continue;
    const type = itemType(it);
    if (SKIP_TYPES.has(type)) continue;
    const description = blank(it.description) ? null : String(it.description);
    const itemNumber = itemNumberFrom(it.item?.refName);
    if (TEXT_TYPES.has(type)) {
      if (description) out.push({ itemNumber: null, description, quantity: null, rate: null, cents: 0, textOnly: true });
      continue;
    }
    if (!itemNumber && !description) continue;
    const quantity = num(it.quantity);
    const rate = num(it.rate);
    const amount = num(it.amount) ?? (quantity !== null && rate !== null ? quantity * rate : 0);
    out.push({
      itemNumber,
      description,
      quantity: quantity === null ? null : Math.abs(quantity),
      rate,
      cents: cents(amount),
    });
  }
  return out;
}

/** A stamp under the number for a document that isn't simply open. */
function stampFor(kind: SalesKind, status: string | null): string | null {
  if (!status) return null;
  if (/void/i.test(status)) return 'Voided';
  if (/cancel/i.test(status)) return 'Cancelled';
  if (kind === 'invoice' && /paid in full/i.test(status)) return 'Paid';
  if (kind === 'sales_order' && /closed/i.test(status)) return 'Closed';
  return null;
}

/** What goes on the page, from a sales order or invoice record. */
export function salesPdfDataFromRecord(kind: SalesKind, record: any, letterhead: Letterhead): TransactionPdfData {
  const r = record || {};
  const lines = salesLinesFromRecord(r);
  const customer = ref(r.entity);

  let party = addressTextLines(r.billAddress);
  if (!party.length && customer) party = [customer];
  let shipTo = addressTextLines(r.shipAddress);
  if (shipTo.length && party.length && shipTo.join('|') === party.join('|')) shipTo = party;

  const linesCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const subtotal = num(r.subtotal);
  const tax = num(r.taxTotal ?? r.taxtotal);
  const shipping = num(r.shippingCost ?? r.altShippingCost);
  const discount = num(r.discountTotal);
  const total = num(r.total);
  const subtotalCents = subtotal === null ? linesCents : cents(subtotal);
  const taxCents = tax === null ? 0 : cents(tax);
  const shippingCents = shipping ? cents(shipping) : null;
  const discountCents = discount ? -Math.abs(cents(discount)) : null;
  const totalCents = total === null ? subtotalCents + taxCents + (shippingCents ?? 0) + (discountCents ?? 0) : cents(total);

  const endUser = normalizeEndUser(r[END_USER_FIELD]) || null;
  const vin = blank(r.custbody_vin_number_) ? null : String(r.custbody_vin_number_).trim();
  const details: TransactionPdfData['details'] = kind === 'invoice'
    ? [
        { label: 'Invoice date', value: dayText(r.tranDate) },
        { label: 'Due date', value: dayText(r.dueDate) },
        { label: 'Terms', value: ref(r.terms) },
        { label: 'Customer PO', value: blank(r.otherRefNum) ? null : String(r.otherRefNum) },
      ]
    : [
        { label: 'Order date', value: dayText(r.tranDate) },
        { label: 'Customer PO', value: blank(r.otherRefNum) ? null : String(r.otherRefNum) },
        { label: 'Terms', value: ref(r.terms) },
        { label: 'Sales rep', value: ref(r.salesRep) },
      ];
  if (kind === 'invoice') {
    const so = createdFromNumber(ref(r.createdFrom));
    if (so) details.push({ label: 'Sales order', value: so });
  }
  if (endUser) details.push({ label: 'End user', value: endUser });
  if (vin) details.push({ label: 'VIN', value: vin });

  const raw = String(r.tranId ?? r.tranid ?? r.id ?? '').trim();
  return {
    kind,
    number: raw ? raw : kind === 'invoice' ? 'Invoice' : 'Sales Order',
    party,
    shipTo,
    details,
    lines,
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents,
    memo: blank(r.memo) ? null : String(r.memo),
    stamp: stampFor(kind, ref(r.status)),
    letterhead,
  };
}
