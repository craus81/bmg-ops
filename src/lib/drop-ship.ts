/**
 * Drop ship from vendor (Craig, 2026-10-23, thread "Drop-ship orders for
 * in-stock parts"): a part on an estimate's sales order is bought from a
 * vendor who ships it straight to the customer, even when O'Fallon has it on
 * the shelf. The sales order lines are marked Drop Ship in NetSuite, which
 * makes the linked purchase order (ship-to = the customer) and leaves our
 * stock alone.
 *
 * Pure: read the sales order record, check the picks, build the NetSuite
 * bodies. The route is /api/estimates/[id]/drop-ship; the NetSuite calls are
 * markSalesOrderLinesDropShip / updateDropShipPurchaseOrder in netsuite.ts.
 */

import { parseSalesOrderRecord, type SoLine } from '@/lib/sales-order-edit';

/** NetSuite item types a vendor can drop ship (stock and non-stock parts). */
const DROP_SHIP_TYPES = new Set([
  'invtpart', 'inventoryitem', 'noninvtpart', 'noninventoryitem',
]);

export interface DropShipLine {
  /** NetSuite's line key on the sales order item sublist. */
  line: number;
  itemId: string | null;
  itemNumber: string;
  description: string;
  quantity: number;
  quantityShipped: number;
  quantityBilled: number;
  /** The linked PO NetSuite already made for this line (drop ship or special order). */
  createdPo: { id: string; number: string } | null;
  /** Why the line can't be drop shipped, or null when it can. */
  blocked: string | null;
}

export interface ShipTo {
  name: string;
  attention: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
}

export const EMPTY_SHIP_TO: ShipTo = { name: '', attention: '', address: '', address2: '', city: '', state: '', zip: '', phone: '' };

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

function createdPoOf(it: any): { id: string; number: string } | null {
  const v = it?.createdPo ?? it?.createdpo;
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (v.id == null || v.id === '') return null;
    return { id: String(v.id), number: str(v.refName).replace(/^Purchase Order\s*#?\s*/i, '') };
  }
  return { id: String(v), number: '' };
}

/** The sales order's lines as the drop ship window lists them. */
export function dropShipLines(rec: any): DropShipLine[] {
  const view = parseSalesOrderRecord(rec);
  const raw = new Map<number, any>(((rec?.item?.items || []) as any[]).filter(it => it?.line != null).map(it => [Number(it.line), it]));
  return view.lines.map((l: SoLine) => {
    const createdPo = createdPoOf(raw.get(l.line));
    const type = (l.itemType || '').toLowerCase();
    let blocked: string | null = null;
    if (createdPo) blocked = `Already on PO ${createdPo.number || createdPo.id}`;
    else if (l.isClosed) blocked = 'Closed on the sales order';
    else if (!l.itemId) blocked = 'No NetSuite item';
    else if (type && !DROP_SHIP_TYPES.has(type)) blocked = 'Not a part (labor, service or charge)';
    else if (l.quantityShipped > 0) blocked = "Already shipped from O'Fallon";
    else if (l.quantity <= 0) blocked = 'No quantity';
    return {
      line: l.line,
      itemId: l.itemId,
      itemNumber: l.itemNumber,
      description: l.description,
      quantity: l.quantity,
      quantityShipped: l.quantityShipped,
      quantityBilled: l.quantityBilled,
      createdPo,
      blocked,
    };
  });
}

/** The sales order's ship-to address (GET …?expandSubResources=true). */
export function shipToFromRecord(rec: any): ShipTo {
  const a = rec?.shippingAddress || {};
  return {
    name: str(a.addressee) || str(rec?.entity?.refName),
    attention: str(a.attention),
    address: str(a.addr1),
    address2: str(a.addr2),
    city: str(a.city),
    state: str(a.state?.id ?? a.state),
    zip: str(a.zip),
    phone: str(a.addrPhone),
  };
}

/** One line per address part, blanks left out — for the window and the vendor email. */
export function shipToLines(s: ShipTo): string[] {
  const cityLine = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [s.name, s.attention ? `Attn: ${s.attention}` : '', s.address, s.address2, cityLine, s.phone].filter(Boolean);
}

/** NetSuite's shippingAddress body for a PO or sales order. */
export function shippingAddressBody(s: ShipTo): Record<string, unknown> {
  return {
    addressee: s.name,
    attention: s.attention,
    addr1: s.address,
    addr2: s.address2,
    city: s.city,
    state: s.state,
    zip: s.zip,
    addrPhone: s.phone,
    country: { id: 'US' },
  };
}

export function sameShipTo(a: ShipTo, b: ShipTo): boolean {
  const k = (s: ShipTo) => JSON.stringify(Object.values({ ...EMPTY_SHIP_TO, ...s }).map(v => String(v).trim().toUpperCase()));
  return k(a) === k(b);
}

export interface DropShipPick {
  line: number;
  rate?: number | null;
}

export type DropShipPlan =
  | { ok: true; lines: (DropShipLine & { rate: number | null })[] }
  | { ok: false; error: string };

/** Checks the picked lines against the order as NetSuite has it now. */
export function planDropShip(lines: DropShipLine[], picks: DropShipPick[], shipTo: ShipTo): DropShipPlan {
  if (picks.length === 0) return { ok: false, error: 'Pick at least one part to drop ship.' };
  const byLine = new Map(lines.map(l => [l.line, l]));
  const seen = new Set<number>();
  const out: (DropShipLine & { rate: number | null })[] = [];
  for (const p of picks) {
    const l = byLine.get(p.line);
    if (!l) return { ok: false, error: `Line ${p.line} isn't on the sales order any more. Close this window and open it again.` };
    if (seen.has(p.line)) return { ok: false, error: `${l.itemNumber || `Line ${p.line}`} was picked twice.` };
    seen.add(p.line);
    if (l.blocked) return { ok: false, error: `${l.itemNumber || `Line ${p.line}`} can't be drop shipped: ${l.blocked}.` };
    const rate = p.rate != null && Number.isFinite(p.rate) && p.rate > 0 ? Math.round(p.rate * 10_000) / 10_000 : null;
    out.push({ ...l, rate });
  }
  const missing = [
    !shipTo.name && 'name',
    !shipTo.address && 'street address',
    !shipTo.city && 'city',
    !shipTo.state && 'state',
    !shipTo.zip && 'ZIP',
  ].filter(Boolean);
  if (missing.length > 0) return { ok: false, error: `The ship-to address needs a ${missing.join(', ')}.` };
  return { ok: true, lines: out };
}

/** The sales order PATCH that marks lines Drop Ship for one vendor. */
export function dropShipSoPatch(lines: { line: number; rate: number | null }[], vendorId: string): Record<string, unknown> {
  return {
    item: {
      items: lines.map(l => ({
        line: l.line,
        createPo: { id: 'DropShip' },
        poVendor: { id: vendorId },
        ...(l.rate != null ? { poRate: l.rate } : {}),
      })),
    },
  };
}

export function defaultDropShipMemo(soNumber: string, customerName: string): string {
  return `Drop ship to ${customerName || 'customer'}${soNumber ? ` for SO ${soNumber}` : ''}`.slice(0, 500);
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DropShipEmailInput {
  poNumber: string;
  customerName: string;
  shipTo: ShipTo;
  lines: { itemNumber: string; description: string; quantity: number }[];
  message: string;
  /** renderSignatureHtml output, or ''. */
  signatureHtml: string;
  pdfName: string | null;
}

/** The vendor email: ship-to first, then the lines; the PO PDF rides as an attachment. */
export function buildDropShipVendorEmail(e: DropShipEmailInput): { subject: string; html: string } {
  const subject = `Drop ship PO ${e.poNumber}: please ship direct to ${e.customerName || 'our customer'}`;
  const rows = e.lines.map(l => `
        <tr>
          <td style="padding:6px 8px;border-top:1px solid #e5e7eb;font-weight:700;">${esc(l.itemNumber)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e5e7eb;color:#4b5563;">${esc(l.description)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e5e7eb;text-align:right;">${l.quantity}</td>
        </tr>`).join('');
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;color:#111827;">
      <div style="font-size:18px;font-weight:800;margin-bottom:12px;">Purchase order ${esc(e.poNumber)}: drop ship</div>
      ${e.message ? `<div style="font-size:14px;color:#374151;white-space:pre-wrap;line-height:1.6;margin-bottom:14px;">${esc(e.message)}</div>` : ''}
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Please ship directly to:</div>
      <div style="font-size:14px;line-height:1.5;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;margin-bottom:16px;">
        ${shipToLines(e.shipTo).map(esc).join('<br>')}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
        <tr>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280;">Part</th>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280;">Description</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:#6b7280;">Qty</th>
        </tr>${rows}
      </table>
      <div style="font-size:13px;color:#4b5563;margin-bottom:14px;">
        ${e.pdfName ? `The purchase order is attached (${esc(e.pdfName)}). ` : ''}Please reply with the tracking number once it ships.
      </div>
      ${e.signatureHtml}
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">BMG Fleet Installations · Purchase order ${esc(e.poNumber)}</div>
  </div>
</body>
</html>`;
  return { subject, html };
}
