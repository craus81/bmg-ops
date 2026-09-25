import { matchRequest, type CatalogPart, type DraftLine, type DraftRequestLine } from '@/lib/paste-to-estimate';
import type { HistoryDetail } from '@/lib/ledger/history';

/**
 * "Copy to new estimate" from a QuickBooks record (owner ask 2026-09-24:
 * look up a build from years ago and do it again).
 *
 * The QuickBooks lines become the same review grid paste-to-estimate uses,
 * with the same rules: nothing lands on the estimate until the rep ticks it,
 * and prices come from TODAY's catalog, never from the old document. A price
 * from years ago quoted as if it were current is exactly the number nobody
 * chose. The old quantity and price ride along in the line's text so the rep
 * can see them.
 *
 * QuickBooks item names are not NetSuite item numbers, so each line tries the
 * item name as a part number first and falls back to its words.
 */

export interface QuickbooksDraftRequest {
  request: DraftRequestLine;
  /** QuickBooks' item name, tried as a catalog part number first. */
  qboItem: string | null;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** QuickBooks shows sub-items as "Parent:Child"; the child is the item. */
export function qboItemName(name: string | null | undefined): string | null {
  const s = String(name || '').trim();
  if (!s) return null;
  const last = s.split(':').pop()!.trim();
  return last || null;
}

/** The priced lines of a QuickBooks record, as requests for the matcher. */
export function quickbooksDraftRequests(detail: Pick<HistoryDetail, 'lines' | 'number' | 'typeLabel' | 'date'>): QuickbooksDraftRequest[] {
  const out: QuickbooksDraftRequest[] = [];
  for (const l of detail.lines) {
    if (l.kind !== 'item') continue;
    const item = qboItemName(l.itemNumber || l.itemName);
    const description = String(l.description || '').trim() || item || '';
    if (!description) continue;
    const qty = l.quantity !== null && Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : null;
    const was = qty !== null && l.unitPrice !== null
      ? `${qty} × ${money(l.unitPrice)}`
      : money(l.amount);
    out.push({
      qboItem: item,
      request: {
        raw: `${item && item !== description ? `${item}: ` : ''}${description} (${was} on ${detail.typeLabel.toLowerCase()} #${detail.number}, ${detail.date})`,
        itemNumber: null,
        description,
        quantity: qty,
      },
    });
  }
  return out;
}

/**
 * Match one QuickBooks line: its item name as a part number, then its words.
 * An item name the catalog doesn't carry is expected here (QuickBooks named
 * items its own way), so unlike a customer's stated part number it is not a
 * reason to stop looking.
 */
export function matchQuickbooksLine(q: QuickbooksDraftRequest, candidates: CatalogPart[]): DraftLine {
  if (q.qboItem) {
    const byNumber = matchRequest({ ...q.request, itemNumber: q.qboItem }, candidates);
    if (byNumber.part) {
      return { ...byNumber, request: q.request, signal: `QuickBooks item ${q.qboItem} is ${byNumber.part.item_number} in the catalog` };
    }
  }
  return matchRequest(q.request, candidates);
}

/** Words worth a catalog search, the same filter the RFQ drafter uses. */
export function catalogSearchTerms(q: QuickbooksDraftRequest): string[] {
  const words = String(q.request.description || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 2)
    .slice(0, 4);
  return [...new Set([...(q.qboItem ? [q.qboItem.replace(/[,()*%"\\]/g, ' ').trim()] : []), ...words])].filter(Boolean);
}
