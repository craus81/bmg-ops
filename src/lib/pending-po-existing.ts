// Pending PO queue: does an emailed PO already exist in FleetSuite, and if so,
// does the email say anything different? Mirrors the line diff the Gmail
// import runs on Review (src/app/api/gmail/import-po/route.ts) so the queue
// row can say "safe to dismiss" vs "this is a revision" before anyone opens it.

export type ExtractedLine = {
  part_number?: string | null;
  supplier_part?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
};

export type ExistingLine = {
  part_number?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
};

export type ExistingPoChange =
  | { type: 'added'; part_number: string }
  | { type: 'removed'; part_number: string }
  | { type: 'changed'; part_number: string; old_quantity: number; new_quantity: number; old_price: number; new_price: number };

const up = (s: unknown) => String(s ?? '').trim().toUpperCase();

/** Same rules as the importer: match a line by part number or supplier part,
 *  qty compared as an integer, price within a tenth of a cent. */
export function diffAgainstExisting(extracted: ExtractedLine[], existing: ExistingLine[]): ExistingPoChange[] {
  const lines = (extracted || []).filter(l => l.part_number);
  const changes: ExistingPoChange[] = [];
  for (const nl of lines) {
    const match = existing.find(el => up(el.part_number) && (up(el.part_number) === up(nl.part_number) || up(el.part_number) === up(nl.supplier_part)));
    if (!match) {
      changes.push({ type: 'added', part_number: String(nl.supplier_part || nl.part_number) });
      continue;
    }
    const newQty = parseInt(String(nl.quantity ?? '')) || 0;
    const newPrice = parseFloat(String(nl.unit_price ?? '')) || 0;
    const oldQty = Number(match.quantity) || 0;
    const oldPrice = Number(match.unit_price) || 0;
    if (newQty !== oldQty || Math.abs(newPrice - oldPrice) > 0.001) {
      changes.push({ type: 'changed', part_number: String(match.part_number), old_quantity: oldQty, new_quantity: newQty, old_price: oldPrice, new_price: newPrice });
    }
  }
  for (const el of existing) {
    const still = lines.some(nl => up(nl.part_number) === up(el.part_number) || up(nl.supplier_part) === up(el.part_number));
    if (!still) changes.push({ type: 'removed', part_number: String(el.part_number ?? '') });
  }
  return changes;
}

/** One short line for the queue row, e.g. "1 line added (06-FA-2210), 1 qty changed (02-LB-118: 2 → 4)". */
export function describeChanges(changes: ExistingPoChange[]): string {
  const parts: string[] = [];
  const list = (xs: string[]) => xs.length <= 2 ? ` (${xs.join(', ')})` : '';
  const added = changes.filter(c => c.type === 'added');
  const removed = changes.filter(c => c.type === 'removed');
  const changed = changes.filter((c): c is Extract<ExistingPoChange, { type: 'changed' }> => c.type === 'changed');
  const qty = changed.filter(c => c.old_quantity !== c.new_quantity);
  const price = changed.filter(c => c.old_quantity === c.new_quantity);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (added.length) parts.push(`${n(added.length, 'line', 'lines')} added${list(added.map(c => c.part_number))}`);
  if (removed.length) parts.push(`${n(removed.length, 'line', 'lines')} removed${list(removed.map(c => c.part_number))}`);
  if (qty.length) parts.push(`${n(qty.length, 'qty', 'qtys')} changed${list(qty.map(c => `${c.part_number}: ${c.old_quantity} → ${c.new_quantity}`))}`);
  if (price.length) parts.push(`${n(price.length, 'price', 'prices')} changed${list(price.map(c => `${c.part_number}: $${c.old_price.toFixed(2)} → $${c.new_price.toFixed(2)}`))}`);
  return parts.join(', ');
}

/** The POs one queue entry carries: a normal extraction, or a multi-PO email
 *  ({ multi: true, pos: [{ extracted }] }). */
export function pendingExtractions(raw: any, fallbackPoNumber?: string | null): { poNumber: string; lines: ExtractedLine[] }[] {
  if (raw?.multi && Array.isArray(raw.pos)) {
    return raw.pos
      .map((p: any) => ({ poNumber: String(p?.extracted?.po_number ?? '').trim(), lines: p?.extracted?.lines || [] }))
      .filter((p: { poNumber: string }) => p.poNumber);
  }
  const poNumber = String(raw?.po_number ?? fallbackPoNumber ?? '').trim();
  return poNumber ? [{ poNumber, lines: raw?.lines || [] }] : [];
}
