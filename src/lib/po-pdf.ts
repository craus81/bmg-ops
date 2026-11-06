/**
 * FleetSuite's own purchase order PDF (Craig, 2026-11-06): what ✉ Email vendor
 * and the drop ship PO email attach instead of NetSuite's print form. Drawn
 * by the shared form layout (src/lib/transaction-pdf.ts) from the PO's live
 * NetSuite record, so it shows what NetSuite holds right now: vendor and its
 * address, ship to, PO date, terms, expected date, who ordered it, the sales
 * order it came from, the lines and the total, and the memo.
 *
 * poPdfDataFromRecord is pure (tested); the server half lives in
 * po-pdf-server.ts. NetSuite's own PDF stays on the 📄 PDF links.
 */

import type { TransactionPdfData, TransactionPdfLine } from './transaction-pdf';
import { cityLine, longDay } from './books/own-invoice-pdf';

type Letterhead = TransactionPdfData['letterhead'];

const blank = (s: unknown) => s === null || s === undefined || String(s).trim() === '';
const num = (v: unknown): number | null => {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (n: number) => Math.round(n * 100);

/** A NetSuite address text ("Name\nStreet\nCity ST 12345", sometimes with <br>) a line each. */
export function addressTextLines(text: unknown): string[] {
  if (blank(text)) return [];
  return String(text)
    .split(/\r?\n|<br\s*\/?>/i)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 'Parent : BAK448146' → 'BAK448146'. */
export function itemNumberFrom(refName: unknown): string | null {
  if (blank(refName)) return null;
  const parts = String(refName).split(':');
  return parts[parts.length - 1].trim() || null;
}

/** 'Sales Order #SO1235' → 'SO1235'. */
export function createdFromNumber(refName: unknown): string | null {
  if (blank(refName)) return null;
  const m = /#\s*(\S+)\s*$/.exec(String(refName));
  return m ? m[1] : String(refName).trim();
}

/** 'YYYY-MM-DD' (NetSuite's REST date) → 'November 5, 2026'; anything else as it came. */
function dayText(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? longDay(s) : s;
}

/** What goes on the PO's page, from its NetSuite record (GET purchaseOrder?expandSubResources=true). */
export function poPdfDataFromRecord(record: any, letterhead: Letterhead): TransactionPdfData {
  const r = record || {};
  const items: any[] = Array.isArray(r.item?.items) ? r.item.items : [];
  const lines: TransactionPdfLine[] = items
    .filter((it) => it && (it.item?.id != null || !blank(it.description)))
    .map((it) => {
      const quantity = num(it.quantity);
      const rate = num(it.rate);
      const amount = num(it.amount) ?? (quantity !== null && rate !== null ? quantity * rate : 0);
      return {
        itemNumber: itemNumberFrom(it.item?.refName),
        description: blank(it.description) ? null : String(it.description),
        quantity: quantity === null ? null : Math.abs(quantity),
        rate,
        cents: cents(amount),
      };
    });
  const linesCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const total = num(r.total);
  const totalCents = total === null ? linesCents : cents(total);

  const vendorName = blank(r.entity?.refName) ? null : String(r.entity.refName).trim();
  let party = addressTextLines(r.billAddress);
  if (!party.length && vendorName) party = [vendorName];
  if (vendorName && party.length && party[0].toLowerCase() !== vendorName.toLowerCase() && !party.some((l) => l.toLowerCase() === vendorName.toLowerCase())) {
    party = [vendorName, ...party];
  }

  let shipTo = addressTextLines(r.shipAddress);
  if (!shipTo.length) {
    const c = letterhead?.company;
    shipTo = [c?.name, c?.address, cityLine(c?.city, c?.state, c?.zip)].filter((l): l is string => !blank(l)).map((l) => l.trim());
  }

  const details: TransactionPdfData['details'] = [
    { label: 'PO date', value: dayText(r.tranDate) },
    { label: 'Terms', value: blank(r.terms?.refName) ? null : String(r.terms.refName) },
    { label: 'Expected', value: dayText(r.dueDate) },
    { label: 'Ordered by', value: blank(r.employee?.refName) ? null : String(r.employee.refName) },
  ];
  const fromSo = createdFromNumber(r.createdFrom?.refName);
  if (fromSo) details.push({ label: 'Our sales order', value: fromSo });

  const number = String(r.tranId || r.id || '').trim();
  return {
    kind: 'purchase_order',
    number: number ? (/^PO/i.test(number) ? number : `PO${number}`) : 'Purchase Order',
    party,
    shipTo,
    details,
    lines,
    subtotalCents: totalCents,
    taxCents: null,
    totalCents,
    memo: blank(r.memo) ? null : String(r.memo),
    stamp: /closed|cancel/i.test(String(r.status?.refName || r.status || '')) ? String(r.status?.refName || r.status) : null,
    letterhead,
  };
}
