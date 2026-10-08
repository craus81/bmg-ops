/**
 * Vendor cost import (migration 353, owner ask 2026-10-08): reads the
 * owner's spreadsheet of outsourced part numbers (part number, vendor cost,
 * target margin, optionally the vendor) into rows for Admin → Vendor Costs.
 *
 * The numbers stay in FleetSuite (owner: not pushed to NetSuite) and the
 * margin is a reference only: the catalog price is still whatever was quoted.
 *
 * Client-safe. Workbook reading reuses the exceljs helpers from the install
 * import (SheetJS `xlsx` is banned repo-wide, see import-installs-parse).
 */

import { parseDelimited, sheetCells } from '@/lib/import-installs-parse';

export interface VendorCostRow {
  /** Spreadsheet row number (1-based, as Excel shows it) for error messages. */
  line: number;
  partNumber: string;
  vendor: string | null;
  vendorCost: number | null;
  marginPct: number | null;
  /** Why this row can't be loaded; null when it's fine. */
  problem: string | null;
}

/** One part number's preview from /api/parts/vendor-costs. */
export type VendorCostResult = {
  partNumber: string;
  status: 'update' | 'same' | 'not_found';
  /** Catalog rows carrying this number (duplicates all get the values). */
  partIds: string[];
  displayName: string | null;
  salesPrice: number | null;
  current: { vendor: string | null; vendorCost: number | null; marginPct: number | null } | null;
  next: { vendor: string | null; vendorCost: number | null; marginPct: number | null };
};

export interface VendorCostParse {
  rows: VendorCostRow[];
  /** Set when no header row was found. */
  error: string | null;
  sheetName?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const PART = ['part', 'partnumber', 'partno', 'partnum', 'item', 'itemnumber', 'itemno', 'itemnum', 'sku', 'pn'];
const COST = ['vendorcost', 'cost', 'unitcost', 'ourcost', 'outsourcecost', 'outsourcedcost', 'vendorprice', 'buyprice', 'purchaseprice', 'costeach'];
const MARGIN = ['margin', 'profitmargin', 'marginpct', 'marginpercent', 'targetmargin', 'grossmargin', 'gm', 'gp', 'grossprofit', 'profit', 'profitpct'];
const VENDOR = ['vendor', 'vendorname', 'supplier', 'outsourcevendor', 'outsourcedto', 'outsourcedvendor'];

/** "$1,234.50" → 1234.5. Null for a blank cell; NaN for junk. */
export function parseMoneyCell(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/**
 * A margin cell as a percent: "35%" and "35" are 35; a bare 0.35 is a
 * fraction (how Excel stores a cell formatted as a percent) and also 35.
 * Null for a blank cell; NaN for junk.
 */
export function parseMarginCell(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, '');
  if (!s) return null;
  const hasPct = s.endsWith('%');
  const n = Number(hasPct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return NaN;
  const pct = !hasPct && Math.abs(n) <= 1 ? n * 100 : n;
  return Math.round(pct * 100) / 100;
}

/**
 * Map a grid of cells to rows. Needs a header row (in the first 10 rows)
 * naming the part number and at least one of cost or margin; the columns
 * can be in any order.
 */
export function vendorCostRowsFromCells(cells: string[][]): VendorCostParse {
  let headerIdx = -1;
  const cols: { part?: number; cost?: number; margin?: number; vendor?: number } = {};
  for (let r = 0; r < Math.min(cells.length, 10) && headerIdx === -1; r++) {
    const found: typeof cols = {};
    cells[r].forEach((cell, i) => {
      const h = norm(cell);
      if (found.part === undefined && PART.includes(h)) found.part = i;
      else if (found.cost === undefined && COST.includes(h)) found.cost = i;
      else if (found.margin === undefined && MARGIN.includes(h)) found.margin = i;
      else if (found.vendor === undefined && VENDOR.includes(h)) found.vendor = i;
    });
    if (found.part !== undefined && (found.cost !== undefined || found.margin !== undefined)) {
      headerIdx = r;
      Object.assign(cols, found);
    }
  }
  if (headerIdx === -1) {
    return {
      rows: [],
      error: 'Couldn’t find the header row. The sheet needs a column titled Part Number, plus Vendor Cost and/or Margin.',
    };
  }

  const cell = (r: string[], i: number | undefined) => (i !== undefined && r[i] !== undefined ? r[i].trim() : '');
  const rows: VendorCostRow[] = [];
  cells.slice(headerIdx + 1).forEach((r, k) => {
    const partNumber = cell(r, cols.part).toUpperCase();
    if (!partNumber) return;
    const vendorCost = parseMoneyCell(cell(r, cols.cost));
    const marginPct = parseMarginCell(cell(r, cols.margin));
    let problem: string | null = null;
    if (Number.isNaN(vendorCost) || (vendorCost !== null && vendorCost < 0)) problem = `Vendor cost “${cell(r, cols.cost)}” isn’t a dollar amount`;
    else if (Number.isNaN(marginPct) || (marginPct !== null && (marginPct <= -100 || marginPct >= 100))) problem = `Margin “${cell(r, cols.margin)}” isn’t a percent under 100`;
    else if (vendorCost === null && marginPct === null) problem = 'No vendor cost or margin on this row';
    rows.push({
      line: headerIdx + k + 2,
      partNumber,
      vendor: cell(r, cols.vendor) || null,
      vendorCost: Number.isNaN(vendorCost) ? null : vendorCost,
      marginPct: Number.isNaN(marginPct) ? null : marginPct,
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

/** Read an uploaded .xlsx / .csv / .tsv. Throws a user-facing Error. */
export async function parseVendorCostFile(file: File): Promise<VendorCostParse> {
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
    let first: VendorCostParse | null = null;
    for (const ws of workbook.worksheets) {
      const cells = sheetCells(ws);
      if (cells.length === 0) continue;
      const out = { ...vendorCostRowsFromCells(cells), sheetName: ws.name };
      if (!out.error) return out;
      if (!first) first = out;
    }
    return first ?? { rows: [], error: 'That workbook is empty.' };
  }

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    return vendorCostRowsFromCells(parseDelimited(text, ext === 'csv' ? ',' : text.includes('\t') ? '\t' : ','));
  }

  throw new Error(`Unsupported file type ".${ext}". Upload a .xlsx or .csv file.`);
}
