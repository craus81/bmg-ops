/**
 * Pure line-mapping for receiving against a NetSuite PO (audit item 17C).
 *
 * The app's mirror stores NetSuite line ids (transactionline.id — or
 * provisional `prov-N` ids for a PO created moments ago by create-po and
 * not re-synced yet), but the itemReceipt transform addresses lines by
 * linesequencenumber (its `orderLine`). This maps each "receive N of
 * mirror line X" ask onto the PO's live SuiteQL lines: exact line-id
 * match first, then a unique-open-line item-id match for provisional
 * ids — and refuses (→ manual NetSuite entry) rather than guess when a
 * match is missing, ambiguous, or over-receives what the PO has open.
 *
 * Every open line NOT being received is returned in excludeOrderLines so
 * the transform can send it with itemReceive:false — without that, the
 * transform's default is to receive EVERYTHING in full.
 */

export interface NsPoLine {
  /** transactionline.id as text — what the mirror stores as line_id. */
  lineId: string;
  /** transactionline.linesequencenumber — the transform's orderLine. */
  lineSeq: number;
  itemId: string | null;
  quantity: number;
  received: number;
}

export interface ReceiptAsk {
  lineId: string;
  itemNetsuiteId: string | null;
  itemNumber: string;
  quantity: number;
}

export type MapResult =
  | { ok: true; receiveLines: { orderLine: number; quantity: number }[]; excludeOrderLines: number[] }
  | { ok: false; reason: string };

export function mapReceiptLines(nsLines: NsPoLine[], asks: ReceiptAsk[]): MapResult {
  const bySeq = new Map<number, number>();
  for (const ask of asks) {
    let line = nsLines.find(l => l.lineId === ask.lineId);
    if (!line && ask.itemNetsuiteId) {
      const candidates = nsLines.filter(
        l => l.itemId === ask.itemNetsuiteId && l.quantity - l.received > 0,
      );
      if (candidates.length > 1) {
        return { ok: false, reason: `${ask.itemNumber}: several open PO lines carry this item — receive it in NetSuite directly.` };
      }
      line = candidates[0];
    }
    if (!line) {
      return { ok: false, reason: `${ask.itemNumber}: no matching line on the NetSuite PO.` };
    }
    const remaining = line.quantity - line.received - (bySeq.get(line.lineSeq) || 0);
    if (ask.quantity > remaining + 1e-9) {
      return { ok: false, reason: `${ask.itemNumber}: receiving ${ask.quantity} but only ${Math.max(0, remaining)} is still open on the PO.` };
    }
    bySeq.set(line.lineSeq, (bySeq.get(line.lineSeq) || 0) + ask.quantity);
  }
  const receiveLines = [...bySeq.entries()]
    .map(([orderLine, quantity]) => ({ orderLine, quantity }))
    .sort((a, b) => a.orderLine - b.orderLine);
  const excludeOrderLines = nsLines
    .map(l => l.lineSeq)
    .filter(seq => !bySeq.has(seq))
    .sort((a, b) => a - b);
  return { ok: true, receiveLines, excludeOrderLines };
}
