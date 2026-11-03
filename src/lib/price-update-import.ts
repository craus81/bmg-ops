/**
 * Update Prices import (migration 513, owner ask 2026-11-03): reads a
 * spreadsheet of part numbers with a new selling price, a new cost, or both
 * (a vendor price book such as Masterack's, or BMG's own sheet) into rows for
 * Admin → Update Prices, which saves them in FleetSuite and sends each one to
 * NetSuite so the two stay the same.
 *
 * A cost in the file always wins. The page's "fill cost as price minus X%"
 * only fills rows the file gives no cost for (fillCostsFromDiscount).
 *
 * Client-safe. Workbook reading reuses the exceljs helpers from the install
 * import (SheetJS `xlsx` is banned repo-wide, see import-installs-parse).
 */

import { parseDelimited, sheetCells } from '@/lib/import-installs-parse';
import { parseMoneyCell } from '@/lib/vendor-cost-import';

export interface PriceUpdateRow {
  /** Spreadsheet row number (1-based, as Excel shows it) for error messages. */
  line: number;
  partNumber: string;
  price: number | null;
  cost: number | null;
  /** True when the cost came from the discount box, not the file. */
  costFromDiscount?: boolean;
  /** Why this row can't be loaded; null when it's fine. */
  problem: string | null;
}

export interface PriceUpdateParse {
  rows: PriceUpdateRow[];
  /** Set when no header row was found. */
  error: string | null;
  sheetName?: string;
}

/** One part number's preview from /api/parts/update-prices. */
export type PriceUpdateResult = {
  partNumber: string;
  status: 'change' | 'same' | 'not_found';
  /** Catalog rows carrying this number (duplicates all get the values). */
  partIds: string[];
  displayName: string | null;
  current: { price: number | null; cost: number | null } | null;
  next: { price: number | null; cost: number | null };
  /** Set once saved: what reached NetSuite and what didn't. */
  saved?: { netsuite: 'sent' | 'not_netsuite' | 'failed'; note?: string };
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const PART = ['part', 'partnumber', 'partno', 'partnum', 'partid', 'item', 'itemnumber', 'itemno', 'itemnum', 'itemnamenumber', 'sku', 'pn'];
const PRICE = ['price', 'salesprice', 'sellprice', 'sellingprice', 'listprice', 'list', 'newprice', 'baseprice', 'retail', 'retailprice', 'msrp', 'unitprice', 'customerprice'];
const COST = ['cost', 'ourcost', 'unitcost', 'newcost', 'purchaseprice', 'vendorcost', 'dealercost', 'distributorcost', 'netcost', 'buyprice', 'costeach', 'bmgcost'];

/**
 * Map a grid of cells to rows. Needs a header row (in the first 15 rows, so a
 * price book's title lines above it are fine) naming the part number and at
 * least one of price or cost; the columns can be in any order.
 */
export function priceRowsFromCells(cells: string[][]): PriceUpdateParse {
  let headerIdx = -1;
  const cols: { part?: number; price?: number; cost?: number } = {};
  for (let r = 0; r < Math.min(cells.length, 15) && headerIdx === -1; r++) {
    const found: typeof cols = {};
    cells[r].forEach((cell, i) => {
      const h = norm(cell);
      if (found.part === undefined && PART.includes(h)) found.part = i;
      else if (found.price === undefined && PRICE.includes(h)) found.price = i;
      else if (found.cost === undefined && COST.includes(h)) found.cost = i;
    });
    if (found.part !== undefined && (found.price !== undefined || found.cost !== undefined)) {
      headerIdx = r;
      Object.assign(cols, found);
    }
  }
  if (headerIdx === -1) {
    return {
      rows: [],
      error: 'Couldn’t find the header row. The sheet needs a column titled Part Number, plus Price and/or Cost.',
    };
  }

  const cell = (r: string[], i: number | undefined) => (i !== undefined && r[i] !== undefined ? String(r[i]).trim() : '');
  const rows: PriceUpdateRow[] = [];
  cells.slice(headerIdx + 1).forEach((r, k) => {
    const partNumber = cell(r, cols.part).toUpperCase();
    if (!partNumber) return;
    const price = parseMoneyCell(cell(r, cols.price));
    const cost = parseMoneyCell(cell(r, cols.cost));
    let problem: string | null = null;
    if (Number.isNaN(price) || (price !== null && price < 0)) problem = `Price “${cell(r, cols.price)}” isn’t a dollar amount`;
    else if (Number.isNaN(cost) || (cost !== null && cost < 0)) problem = `Cost “${cell(r, cols.cost)}” isn’t a dollar amount`;
    else if (price === 0) problem = 'Price is $0. Leave the cell blank to keep the part’s price.';
    else if (price === null && cost === null) problem = 'No price or cost on this row';
    rows.push({
      line: headerIdx + k + 2,
      partNumber,
      price: Number.isNaN(price) ? null : price,
      cost: Number.isNaN(cost) ? null : cost,
      problem,
    });
  });

  // A part listed twice: the later row wins, and the earlier one says so.
  const lastIdx = new Map<string, number>();
  rows.forEach((row, i) => { if (!row.problem) lastIdx.set(row.partNumber, i); });
  rows.forEach((row, i) => {
    const last = lastIdx.get(row.partNumber);
    if (!row.problem && last !== undefined && last !== i) row.problem = `Listed again on row ${rows[last].line}; that row is used`;
  });

  return { rows, error: null };
}

/**
 * The "fill cost as price minus X%" box: rows with a price and no cost of
 * their own get price × (1 − X/100), to the cent. A cost from the file is
 * never touched. A blank, zero or out-of-range percent fills nothing.
 */
export function fillCostsFromDiscount(rows: PriceUpdateRow[], discountPct: number | null): PriceUpdateRow[] {
  const ok = discountPct !== null && Number.isFinite(discountPct) && discountPct > 0 && discountPct < 100;
  return rows.map(r => {
    const base = { ...r, cost: r.costFromDiscount ? null : r.cost, costFromDiscount: false };
    if (!ok || base.cost !== null || base.price === null || r.problem) return base;
    return { ...base, cost: Math.round(base.price * (1 - discountPct! / 100) * 100) / 100, costFromDiscount: true };
  });
}

/** Read pasted rows (copied from Excel: tab-separated, or CSV). */
export function parsePastedPrices(text: string): PriceUpdateParse {
  return priceRowsFromCells(parseDelimited(text, text.includes('\t') ? '\t' : ','));
}

/** Read an uploaded .xlsx / .csv / .tsv. Throws a user-facing Error. */
export async function parsePriceFile(file: File): Promise<PriceUpdateParse> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'xls') throw new Error('Legacy .xls workbooks aren’t supported. Open the file in Excel, save it as .xlsx, then upload that.');

  if (ext === 'xlsx' || ext === 'xlsm') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      throw new Error('Couldn’t read that workbook. Re-save it as .xlsx and try again.');
    }
    let first: PriceUpdateParse | null = null;
    for (const ws of workbook.worksheets) {
      const cells = sheetCells(ws);
      if (cells.length === 0) continue;
      const out = { ...priceRowsFromCells(cells), sheetName: ws.name };
      if (!out.error && out.rows.length > 0) return out;
      if (!first) first = out;
    }
    return first ?? { rows: [], error: 'That workbook is empty.' };
  }

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    return priceRowsFromCells(parseDelimited(text, ext === 'csv' ? ',' : text.includes('\t') ? '\t' : ','));
  }

  throw new Error(`Unsupported file type ".${ext}". Upload a .xlsx or .csv file.`);
}

const cents = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 100));

/** Same money to the cent (null only equals null). */
export function sameMoney(a: number | null | undefined, b: number | null | undefined): boolean {
  return cents(a) === cents(b);
}

export interface CatalogPriceRow {
  id: string;
  item_number: string;
  display_name: string | null;
  is_active: boolean;
  sales_price: number | string | null;
  purchase_price: number | string | null;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * What an upload would do, part by part. A blank price or cost keeps what the
 * part has. Matching is by part number, case-insensitive; every catalog row
 * with that number gets the change. The last row wins when a number repeats.
 */
export function planPriceUpdates(
  rows: { partNumber: string; price?: number | null; cost?: number | null }[],
  catalog: CatalogPriceRow[],
): PriceUpdateResult[] {
  const byNumber = new Map<string, CatalogPriceRow[]>();
  for (const p of catalog) {
    const key = String(p.item_number || '').trim().toUpperCase();
    if (!key) continue;
    byNumber.set(key, [...(byNumber.get(key) || []), p]);
  }
  const wanted = new Map<string, (typeof rows)[number]>();
  for (const r of rows) wanted.set(r.partNumber.trim().toUpperCase(), r);

  const out: PriceUpdateResult[] = [];
  wanted.forEach((r, key) => {
    const matches = byNumber.get(key) || [];
    const shown = matches.find(m => m.is_active) || matches[0];
    const current = shown ? { price: num(shown.sales_price), cost: num(shown.purchase_price) } : null;
    const next = {
      price: r.price ?? current?.price ?? null,
      cost: r.cost ?? current?.cost ?? null,
    };
    const differs = (m: CatalogPriceRow) =>
      !sameMoney(num(m.sales_price), next.price) || !sameMoney(num(m.purchase_price), next.cost);
    out.push({
      partNumber: key,
      status: !shown ? 'not_found' : matches.some(differs) ? 'change' : 'same',
      partIds: matches.map(m => m.id),
      displayName: shown?.display_name ?? null,
      current,
      next,
    });
  });
  return out;
}
