/**
 * Inventory transfers made in FleetSuite and sent on to NetSuite (Books part
 * 38, docs/books.md "Inventory transfers made in FleetSuite"; owner decisions
 * 2026-10-31: from January 1, 2027 the team works only in FleetSuite, apart
 * from payments). A transfer moves one item or more from one of a company's
 * locations to another, as NetSuite's Transfer Inventory does; it changes
 * where the stock is, never how much there is or what it's worth.
 *
 * What a transfer needs before it's sent, what NetSuite is sent, and how its
 * lines are kept are here, for /api/inventory-transfers and the page alike.
 */
import { isIsoDate } from '@/lib/books/journal';

/** The rule a transfer is checked and sent by. */
export const TRANSFER_RULE = 'inventory_transfer@1';
/** The most lines one transfer takes. */
export const MAX_LINES = 100;
/** The most a memo takes. */
export const MEMO_MAX = 300;
/** The most of one item one transfer moves. */
export const MAX_QUANTITY = 1_000_000;
/** Quantities are kept to four places. */
export const QUANTITY_PLACES = 4;

export type TransferStatus = 'draft' | 'sending' | 'made';

export interface TransferLocation { id: string; name: string }
/** A company stock moves within, with its NetSuite subsidiary and its locations there. */
export interface TransferCompany { code: string; name: string; subsidiaryId: string | null; locations: TransferLocation[] }
/** An item as FleetSuite's parts list knows it (netsuite_parts). */
export interface TransferItem { id: string; number: string; name: string | null; type: string | null; active: boolean }

/** A line as it's typed: the item by its NetSuite id, and how many move. */
export interface TransferLine { itemId: string | null; quantity: number }
export interface Transfer {
  date: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  memo: string | null;
  lines: TransferLine[];
}
export interface TransferFacts {
  company: TransferCompany | null;
  items: Map<string, TransferItem>;
}

export interface WorkedTransferLine { itemId: string; itemNumber: string; quantity: number }
export interface WorkedTransfer {
  date: string;
  fromLocationId: string;
  toLocationId: string;
  memo: string;
  lines: WorkedTransferLine[];
  problems: string[];
}

/** How a line is kept (inventory_transfers.lines, migration 470). */
export interface KeptLine { item_netsuite_id: string | null; item_number: string | null; quantity: number | string }

/**
 * An item NetSuite keeps stock of: an inventory or assembly item. FleetSuite's parts list leaves some items' kind
 * unsaid, and those are taken, as Inventory Adjust takes them; NetSuite refuses one that keeps no stock.
 */
export const keepsStock = (item: Pick<TransferItem, 'type'>) => !item.type || item.type === 'InvtPart' || item.type === 'Assembly';

export const itemLabel = (item: Pick<TransferItem, 'number' | 'name'>) => (item.name && item.name !== item.number ? `${item.number} · ${item.name}` : item.number);

/** A quantity to the four places it's kept, without what a sum leaves past them (0.1 + 0.2 is 0.3). */
export const roundQuantity = (q: number) => Number(q.toFixed(QUANTITY_PLACES));

/** A quantity written as it's kept: no more than four places, no trailing zeros. */
export const quantityText = (q: number) => (Number.isFinite(q) ? String(roundQuantity(q)) : '');

/** Whether a quantity has more places than are kept, as typed. */
export const hasTooManyPlaces = (q: number) => Math.abs(q * 10 ** QUANTITY_PLACES - Math.round(q * 10 ** QUANTITY_PLACES)) > 1e-6;

/**
 * Works out the transfer a draft makes, or says why it can't be made: the
 * company needs a NetSuite subsidiary; the transfer needs a real date, a memo
 * saying why the stock moves, and two different locations of the company's;
 * each line an item that keeps stock, on one line only, moving more than 0
 * and no more than 1,000,000, to four places.
 */
export function workOutTransfer(t: Transfer, f: TransferFacts): WorkedTransfer {
  const problems: string[] = [];
  const company = f.company;
  if (!company) problems.push('Pick the company.');
  else if (!company.subsidiaryId) problems.push(`${company.name} has no NetSuite subsidiary in Books, so NetSuite can't take its transfers.`);
  if (!isIsoDate(t.date)) problems.push('Pick the date.');
  const memo = (t.memo ?? '').trim();
  if (!memo) problems.push('Say why the stock is moving in the memo.');
  else if (memo.length > MEMO_MAX) problems.push(`The memo takes ${MEMO_MAX} characters at most.`);

  const from = t.fromLocationId ?? '';
  const to = t.toLocationId ?? '';
  const where = (id: string) => company?.locations.find((l) => l.id === id) ?? null;
  if (!from) problems.push('Pick where the stock is now.');
  else if (!where(from)) problems.push(`The location it's moving from isn't ${company ? `one of ${company.name}'s` : 'one FleetSuite knows'}.`);
  if (!to) problems.push('Pick where the stock is going.');
  else if (!where(to)) problems.push(`The location it's moving to isn't ${company ? `one of ${company.name}'s` : 'one FleetSuite knows'}.`);
  if (from && from === to) problems.push('It moves from one location to another, not to the same one.');

  if (t.lines.length < 1) problems.push('Add the items that are moving.');
  else if (t.lines.length > MAX_LINES) problems.push(`One transfer takes ${MAX_LINES} lines at most, not ${t.lines.length}.`);

  const lines: WorkedTransferLine[] = [];
  const seen = new Set<string>();
  t.lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!l.itemId) { problems.push(`${n} has no item.`); return; }
    const item = f.items.get(l.itemId);
    if (!item) { problems.push(`${n}'s item isn't in FleetSuite's parts list.`); return; }
    if (!item.active) { problems.push(`${n}: ${item.number} isn't active in NetSuite.`); return; }
    if (!keepsStock(item)) { problems.push(`${n}: NetSuite keeps no stock of ${item.number}, so there's none to move.`); return; }
    if (seen.has(l.itemId)) { problems.push(`${item.number} is on two lines: put it on one.`); return; }
    seen.add(l.itemId);
    const q = l.quantity;
    if (!Number.isFinite(q) || q <= 0) { problems.push(`${n} needs how many of ${item.number} are moving.`); return; }
    if (q > MAX_QUANTITY) { problems.push(`${n} moves more than ${MAX_QUANTITY.toLocaleString('en-US')}.`); return; }
    if (hasTooManyPlaces(q)) { problems.push(`${n}'s quantity takes ${QUANTITY_PLACES} places at most.`); return; }
    lines.push({ itemId: l.itemId, itemNumber: item.number, quantity: roundQuantity(q) });
  });
  return { date: t.date, fromLocationId: from, toLocationId: to, memo, lines, problems };
}

/** A transfer's lines as the page and the route read them back from how they're kept. */
export const keptLines = (lines: KeptLine[] | null | undefined): TransferLine[] => (Array.isArray(lines) ? lines : []).map((l) => ({
  itemId: l.item_netsuite_id || null,
  quantity: Number(l.quantity),
}));

/** A transfer's lines as they're kept, each with the item's number as it was when saved, and its quantity to four places. */
export const linesToKeep = (lines: TransferLine[], items: Map<string, TransferItem>): KeptLine[] => lines.map((l) => ({
  item_netsuite_id: l.itemId || null,
  item_number: (l.itemId && items.get(l.itemId)?.number) || null,
  quantity: roundQuantity(l.quantity),
}));

/** FleetSuite's own name for a transfer in NetSuite (its External ID): the transfer's id, so a send tried again never makes a second. */
export const transferExternalId = (id: string) => `fleetsuite-it-${id}`;

/** What NetSuite is sent for a worked-out transfer (createInventoryTransfer in src/lib/netsuite.ts). */
export function netsuiteTransfer(w: WorkedTransfer, subsidiaryId: string, id: string) {
  return {
    subsidiaryId,
    tranDate: w.date,
    memo: w.memo,
    externalId: transferExternalId(id),
    fromLocationId: w.fromLocationId,
    toLocationId: w.toLocationId,
    lines: w.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
  };
}
