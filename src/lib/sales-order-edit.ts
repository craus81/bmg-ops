/**
 * Opening and editing a NetSuite sales order in FleetSuite (Craig,
 * 2026-10-21: "I should be able to open and edit sales orders natively in
 * FleetSuite"). NetSuite stays the system of record until 2028, so every
 * edit is written to NetSuite and FleetSuite only keeps a note of it.
 *
 * Until now the only way to change an order was the estimate's "Push changes
 * to SO", which replaces every line (`?replace=item`) and so fails once
 * anything has shipped or been billed. Here each line is edited by its own
 * `line` key and the rules NetSuite enforces are checked first, so the person
 * gets a plain reason instead of a NetSuite error:
 *
 * - a fully billed line is locked;
 * - a quantity never drops below what shipped or billed (to stop the rest,
 *   close the line instead);
 * - a price is locked once part of the line is billed (the invoice already
 *   used the old one);
 * - only a line with nothing shipped or billed can be removed;
 * - discount, subtotal, description and group lines are shown, not edited.
 *
 * Pure: parse the record NetSuite returns, plan the PATCH. The route
 * (src/app/api/sales-orders/[id]/route.ts) does the I/O.
 */

export interface SoLine {
  /** NetSuite's line key on the item sublist (what a PATCH addresses). */
  line: number;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  description: string;
  quantity: number;
  quantityShipped: number;
  quantityBilled: number;
  rate: number | null;
  amount: number;
  isClosed: boolean;
  /** Whether quantity / price / close / remove can be offered at all. */
  editable: boolean;
}

export interface SoHeader {
  id: string;
  tranId: string;
  customerId: string | null;
  customerName: string;
  tranDate: string | null;
  status: string;
  poNumber: string;
  memo: string;
  vin: string;
  shipDate: string | null;
  salesRep: string | null;
  subtotal: number;
  taxTotal: number;
  total: number;
  /** Compared on save: NetSuite's record changed since the page opened. */
  lastModified: string | null;
}

export interface SalesOrderView {
  header: SoHeader;
  lines: SoLine[];
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const ref = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v.refName != null ? String(v.refName) : v.id != null ? String(v.id) : null;
  return String(v);
};
const refId = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v.id != null ? String(v.id) : null;
  return String(v);
};
const dateOnly = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** NetSuite item types that are lines of money/quantity a person can edit. */
const EDITABLE_TYPES = new Set([
  'invtpart', 'inventoryitem', 'noninvtpart', 'noninventoryitem', 'service', 'serviceitem',
  'othcharge', 'otherchargeitem', 'assembly', 'assemblyitem', 'kit', 'kititem',
]);

/** Item type, normalised: REST answers "InvtPart" or { id, refName }. */
function itemTypeOf(it: any): string | null {
  const t = it?.itemType ?? it?.itemtype;
  const raw = typeof t === 'object' && t ? (t.id ?? t.refName) : t;
  return raw != null && String(raw).trim() ? String(raw).trim() : null;
}

/** Item number as shown: the last ":" segment of the item's name. */
function itemNumberOf(it: any): string {
  const name = ref(it?.item) || '';
  const parts = name.split(':');
  return parts[parts.length - 1].trim();
}

/** The record from GET salesOrder/{id}?expandSubResources=true → page model. */
export function parseSalesOrderRecord(rec: any): SalesOrderView {
  const items: any[] = rec?.item?.items || [];
  const lines: SoLine[] = items
    .filter(it => it?.line != null)
    .map(it => {
      const type = itemTypeOf(it);
      const quantity = Math.abs(num(it.quantity));
      const quantityShipped = Math.abs(num(it.quantityFulfilled ?? it.quantityfulfilled));
      const quantityBilled = Math.abs(num(it.quantityBilled ?? it.quantitybilled));
      const rate = it.rate != null && it.rate !== '' ? num(it.rate) : null;
      const amount = it.amount != null ? num(it.amount) : round2((rate ?? 0) * quantity);
      // An unknown type (an older REST shape) is treated as editable; NetSuite
      // still has the last word and its refusal is shown as is.
      const editable = !type || EDITABLE_TYPES.has(type.toLowerCase());
      return {
        line: Number(it.line),
        itemId: refId(it.item),
        itemNumber: itemNumberOf(it),
        itemType: type,
        description: String(it.description ?? ''),
        quantity,
        quantityShipped,
        quantityBilled,
        rate,
        amount,
        isClosed: it.isClosed === true || it.isclosed === true,
        editable,
      };
    });

  const header: SoHeader = {
    id: String(rec?.id ?? ''),
    tranId: String(rec?.tranId ?? rec?.tranid ?? rec?.id ?? ''),
    customerId: refId(rec?.entity),
    customerName: ref(rec?.entity) || '',
    tranDate: dateOnly(rec?.tranDate),
    status: ref(rec?.status) || ref(rec?.orderStatus) || '',
    poNumber: String(rec?.otherRefNum ?? ''),
    memo: String(rec?.memo ?? ''),
    vin: String(rec?.custbody_vin_number_ ?? ''),
    shipDate: dateOnly(rec?.shipDate),
    salesRep: ref(rec?.salesRep),
    subtotal: num(rec?.subtotal),
    taxTotal: num(rec?.taxTotal),
    total: num(rec?.total),
    lastModified: rec?.lastModifiedDate ? String(rec.lastModifiedDate) : null,
  };
  return { header, lines };
}

/** A line is fully billed: nothing about it can change. */
export function isFullyBilled(l: SoLine): boolean {
  return l.quantity > 0 && l.quantityBilled >= l.quantity;
}

/** What the page lets a person do with a line (the same rules the plan checks). */
export function lineAllows(l: SoLine): { quantity: boolean; price: boolean; close: boolean; reopen: boolean; remove: boolean } {
  if (!l.editable || isFullyBilled(l)) {
    return { quantity: false, price: false, close: false, reopen: false, remove: false };
  }
  if (l.isClosed) return { quantity: false, price: false, close: false, reopen: true, remove: false };
  const touched = l.quantityShipped > 0 || l.quantityBilled > 0;
  return { quantity: true, price: l.quantityBilled === 0, close: true, reopen: false, remove: !touched };
}

export interface SoLineEdit {
  line: number;
  quantity?: number;
  rate?: number;
  close?: boolean;
  reopen?: boolean;
  remove?: boolean;
}

export interface SoNewLine {
  itemId: string;
  itemNumber: string;
  description?: string;
  quantity: number;
  rate: number;
}

export interface SoHeaderEdit {
  poNumber?: string;
  memo?: string;
  vin?: string;
  shipDate?: string | null;
}

export interface SoEdit {
  header?: SoHeaderEdit;
  lines?: SoLineEdit[];
  add?: SoNewLine[];
}

export type SoEditPlan =
  | { ok: false; errors: string[] }
  | { ok: true; replace: boolean; body: Record<string, unknown>; changes: string[] };

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const money = (n: number) => `$${n.toFixed(2)}`;
const qty = (n: number) => String(round2(n));

/**
 * The PATCH that makes `edit` happen on the sales order `view` (read live
 * just before), or the reasons it can't. Changes that match what NetSuite
 * already has are dropped, so an untouched field never goes over the wire.
 */
export function planSalesOrderEdit(view: SalesOrderView, edit: SoEdit): SoEditPlan {
  const errors: string[] = [];
  const changes: string[] = [];
  const body: Record<string, unknown> = {};
  const { header } = view;

  // ── Header ──
  const h = edit.header || {};
  if (h.poNumber !== undefined) {
    const v = h.poNumber.trim();
    if (v.length > 45) errors.push('Customer PO # can be at most 45 characters.');
    else if (v !== header.poNumber.trim()) {
      body.otherRefNum = v;
      changes.push(`Customer PO # ${header.poNumber || '(blank)'} → ${v || '(blank)'}`);
    }
  }
  if (h.memo !== undefined) {
    const v = h.memo.trim();
    if (v.length > 999) errors.push('Memo can be at most 999 characters.');
    else if (v !== header.memo.trim()) {
      body.memo = v;
      changes.push('Memo changed');
    }
  }
  if (h.vin !== undefined) {
    const v = h.vin.trim().toUpperCase();
    if (v && !VIN_RE.test(v)) errors.push('VIN must be 17 letters and numbers (no I, O or Q).');
    else if (v !== header.vin.trim().toUpperCase()) {
      body.custbody_vin_number_ = v || null;
      changes.push(`VIN ${header.vin || '(blank)'} → ${v || '(blank)'}`);
    }
  }
  if (h.shipDate !== undefined) {
    const v = h.shipDate ? h.shipDate.trim() : '';
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push('Ship date must be a date.');
    else if ((v || null) !== header.shipDate) {
      body.shipDate = v || null;
      changes.push(`Ship date ${header.shipDate || '(blank)'} → ${v || '(blank)'}`);
    }
  }

  // ── Existing lines ──
  const byLine = new Map(view.lines.map(l => [l.line, l]));
  const lineBodies = new Map<number, Record<string, unknown>>();
  const removed = new Set<number>();
  const seen = new Set<number>();
  for (const e of edit.lines || []) {
    const l = byLine.get(e.line);
    if (!l) { errors.push(`Line ${e.line} isn't on this order any more. Reload and try again.`); continue; }
    if (seen.has(e.line)) { errors.push(`Line ${e.line} was sent twice.`); continue; }
    seen.add(e.line);
    const label = l.itemNumber || `Line ${l.line}`;
    const now = lineAllows(l);
    // Reopen + a new quantity in the same save is fine: judge the rest as open.
    const can = e.reopen && now.reopen ? lineAllows({ ...l, isClosed: false }) : now;
    const patch: Record<string, unknown> = {};

    if (e.remove) {
      if (!can.remove) {
        errors.push(l.quantityShipped > 0 || l.quantityBilled > 0
          ? `${label} has already shipped or been billed, so it can't be removed. Close the rest of it instead.`
          : `${label} can't be removed here.`);
        continue;
      }
      removed.add(l.line);
      changes.push(`Removed ${label} (qty ${qty(l.quantity)})`);
      continue;
    }

    if (e.reopen) {
      if (!now.reopen) errors.push(`${label} isn't closed.`);
      else { patch.isClosed = false; changes.push(`Reopened ${label}`); }
    }

    if (e.quantity !== undefined && round2(e.quantity) !== round2(l.quantity)) {
      const floor = Math.max(l.quantityShipped, l.quantityBilled);
      if (!can.quantity) errors.push(isFullyBilled(l) ? `${label} is fully billed, so its quantity is locked.` : `${label}'s quantity can't be changed here.`);
      else if (!Number.isFinite(e.quantity) || e.quantity <= 0) errors.push(`${label}: quantity must be more than 0. Use Remove or Close instead.`);
      else if (e.quantity < floor) errors.push(`${label}: ${qty(floor)} already ${l.quantityBilled >= floor ? 'billed' : 'shipped'}, so the quantity can't go below ${qty(floor)}.`);
      else { patch.quantity = round2(e.quantity); changes.push(`${label} qty ${qty(l.quantity)} → ${qty(e.quantity)}`); }
    }

    if (e.rate !== undefined && (l.rate == null || round2(e.rate) !== round2(l.rate))) {
      if (!can.price) errors.push(l.quantityBilled > 0 ? `${label} is partly billed, so its price is locked.` : `${label}'s price can't be changed here.`);
      else if (!Number.isFinite(e.rate) || e.rate < 0) errors.push(`${label}: price can't be negative.`);
      else {
        // Custom price level, as createSalesOrder pins it, so NetSuite keeps our rate.
        patch.price = { id: '-1' };
        patch.rate = round2(e.rate);
        changes.push(`${label} price ${l.rate == null ? '(none)' : money(l.rate)} → ${money(e.rate)}`);
      }
    }

    if (e.close) {
      if (!now.close) errors.push(`${label} can't be closed here.`);
      else {
        patch.isClosed = true;
        const left = round2(l.quantity - Math.max(l.quantityShipped, l.quantityBilled));
        changes.push(`Closed ${label}${left > 0 && left < l.quantity ? ` (${qty(left)} not shipped)` : ''}`);
      }
    }

    if (Object.keys(patch).length > 0) lineBodies.set(l.line, patch);
  }

  // ── New lines ──
  const added: Record<string, unknown>[] = [];
  for (const n of edit.add || []) {
    const label = n.itemNumber || 'New line';
    if (!/^\d{1,15}$/.test(String(n.itemId || ''))) { errors.push(`${label} isn't a NetSuite item.`); continue; }
    if (!Number.isFinite(n.quantity) || n.quantity <= 0) { errors.push(`${label}: quantity must be more than 0.`); continue; }
    if (!Number.isFinite(n.rate) || n.rate < 0) { errors.push(`${label}: price can't be negative.`); continue; }
    added.push({
      item: { id: String(n.itemId) },
      quantity: round2(n.quantity),
      price: { id: '-1' },
      rate: round2(n.rate),
      ...(n.description?.trim() ? { description: n.description.trim().slice(0, 999) } : {}),
    });
    changes.push(`Added ${label} (qty ${qty(n.quantity)} at ${money(n.rate)})`);
  }

  if (removed.size > 0) {
    const keptLines = view.lines.filter(l => !removed.has(l.line));
    if (keptLines.length === 0 && added.length === 0) {
      errors.push("A sales order needs at least one line. Close the lines instead of removing them all.");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (changes.length === 0) return { ok: false, errors: ['Nothing changed.'] };

  const replace = removed.size > 0;
  if (replace) {
    // The item sublist becomes exactly these lines: every kept line by its
    // key (with its edit, if any), then the new ones.
    body.item = {
      items: [
        ...view.lines.filter(l => !removed.has(l.line)).map(l => ({ line: l.line, ...(lineBodies.get(l.line) || {}) })),
        ...added,
      ],
    };
  } else if (lineBodies.size > 0 || added.length > 0) {
    body.item = {
      items: [
        ...[...lineBodies].map(([line, patch]) => ({ line, ...patch })),
        ...added,
      ],
    };
  }
  return { ok: true, replace, body, changes };
}
