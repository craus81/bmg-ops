import { suiteqlQuery } from '@/lib/netsuite';
import { LAYOUT_TYPES, SHIPPED_TYPES, type SoBillingLine, type SoBillingRead } from '@/lib/so-fulfill-invoice';

/** Server only: the sales order as Fulfill & Invoice needs it (src/lib/so-fulfill-invoice.ts). */

const n = (v: unknown): number => Math.abs(parseFloat(String(v ?? '0'))) || 0;

/** Reads the sales order's lines live from NetSuite, with on-hand at the location. */
export async function readSoBillingLines(salesOrderId: string, locationId: string): Promise<SoBillingRead> {
  const soId = parseInt(salesOrderId, 10);
  const loc = parseInt(locationId, 10);
  const head = await suiteqlQuery(`
    SELECT t.status, t.tranid, t.otherrefnum, c.companyname AS customer_name
    FROM transaction t LEFT JOIN customer c ON t.entity = c.id
    WHERE t.id = ${soId} AND t.type = 'SalesOrd'
  `);
  const h = head?.items?.[0];
  if (!h) throw new Error(`Sales order ${salesOrderId} was not found in NetSuite`);

  const select = (withShipped: boolean) => `
    SELECT tl.id, tl.linesequencenumber, tl.item, i.itemid, i.itemtype, tl.memo,
           tl.quantity, ${withShipped ? 'tl.quantityshiprecv,' : ''} tl.quantitybilled, tl.rate, tl.netamount, tl.isclosed
    FROM transactionline tl
    LEFT JOIN item i ON tl.item = i.id
    WHERE tl.transaction = ${soId}
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND tl.item IS NOT NULL
    ORDER BY tl.linesequencenumber
  `;
  let rows: any[];
  let haveShipped = true;
  try {
    rows = (await suiteqlQuery(select(true)))?.items || [];
  } catch {
    // quantityshiprecv may not exist on every account (vendor-po-sync hedges
    // it too): treat shipped as billed, which is right for orders FleetSuite
    // fulfils and bills together.
    haveShipped = false;
    rows = (await suiteqlQuery(select(false)))?.items || [];
  }

  const lines: SoBillingLine[] = rows
    .filter(r => !LAYOUT_TYPES.has(String(r.itemtype || '')))
    .map(r => {
      const billed = n(r.quantitybilled);
      return {
        lineSeq: parseInt(r.linesequencenumber, 10),
        lineId: String(r.id),
        itemId: String(r.item),
        itemNumber: String(r.itemid || ''),
        description: String(r.memo || ''),
        itemType: String(r.itemtype || ''),
        ordered: n(r.quantity),
        fulfilled: haveShipped ? n(r.quantityshiprecv) : billed,
        billed,
        rate: r.rate != null && r.rate !== '' ? n(r.rate) : null,
        amount: r.netamount != null && r.netamount !== '' ? n(r.netamount) : null,
        onHand: null,
        closed: r.isclosed === 'T' || r.isclosed === true,
      };
    });

  const stockIds = [...new Set(lines.filter(l => SHIPPED_TYPES.has(l.itemType)).map(l => l.itemId).filter(id => /^\d+$/.test(id)))];
  if (stockIds.length > 0) {
    try {
      const res = await suiteqlQuery(`
        SELECT item, quantityonhand FROM inventoryitemlocations
        WHERE location = ${loc} AND item IN (${stockIds.join(',')})
      `);
      const onHand = new Map<string, number>();
      for (const r of res?.items || []) onHand.set(String(r.item), parseFloat(r.quantityonhand ?? '0') || 0);
      for (const l of lines) {
        if (SHIPPED_TYPES.has(l.itemType)) l.onHand = onHand.get(l.itemId) ?? 0;
      }
    } catch {
      // On hand is a hint for the window; NetSuite still refuses shipping stock it doesn't have.
    }
  }

  return {
    status: String(h.status || ''),
    soNumber: String(h.tranid || ''),
    customerName: h.customer_name || null,
    poNumber: h.otherrefnum || null,
    lines,
  };
}
