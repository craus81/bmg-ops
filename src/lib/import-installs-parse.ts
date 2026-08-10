/**
 * Parsing for the admin Import Installs page: turns a pasted block of
 * spreadsheet cells OR an uploaded workbook/CSV file into install rows
 * (VIN + RFID device IDs + optional vehicle fields).
 *
 * .xlsx reading is built on exceljs (dynamically imported so it stays out
 * of the initial bundle). SheetJS `xlsx` was dropped repo-wide for
 * unpatched CVEs in 0.18.x — don't reintroduce it here.
 */

import type { Worksheet } from 'exceljs';

export interface ImportRow {
  vin: string;
  serialNumber: string;
  imei: string;
  iccid: string;
  vehicleYear: string;
  vehicleMake: string;
  vehicleModel: string;
  unitNumber: string;
  /** K8: optional per-row part number — overrides the page-level default,
   *  so one sheet can carry mixed parts. */
  partNumber: string;
}

export interface ParseOutcome {
  rows: ImportRow[];
  mode: 'header' | 'positional' | 'empty';
  /** Set when the rows came from a multi-sheet workbook. */
  sheetName?: string;
  sheetCount?: number;
}

// Header aliases (normalized) → field. Order of fields here is also the
// positional fallback when the input has no recognizable header row.
const FIELD_ALIASES: [keyof ImportRow, string[]][] = [
  ['vin', ['vin', 'vinnumber', 'vehiclevin']],
  ['serialNumber', ['sn', 'serial', 'serialnumber', 'serialno', 'serialnum']],
  ['imei', ['imei', 'imeinumber']],
  ['iccid', ['ccid', 'iccid', 'sim', 'simid', 'simnumber']],
  ['vehicleYear', ['year', 'vehicleyear', 'modelyear', 'yr']],
  ['vehicleMake', ['make', 'vehiclemake']],
  ['vehicleModel', ['model', 'vehiclemodel']],
  ['unitNumber', ['unit', 'unitnumber', 'unitno', 'unitnum']],
  // Last on purpose: the positional fallback (no header row) keeps the
  // historical VIN, SN, IMEI, CCID, … column order intact.
  ['partNumber', ['part', 'partnumber', 'partno', 'partnum', 'item', 'itemnumber']],
];

const VIN_ALIASES = FIELD_ALIASES[0][1];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const looksLikeVin = (v: string) => /^[A-HJ-NPR-Z0-9]{11,17}$/i.test(v);

/**
 * Split delimited text into trimmed cells. Quote-aware (RFC-4180 style:
 * `"a,b"` keeps the comma, `""` escapes a quote, quoted fields may span
 * lines), which matters now that real .csv exports are accepted — the old
 * naive split broke on any quoted field. Rows with no content are dropped.
 */
function parseDelimited(text: string, delim: '\t' | ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c.length > 0));
}

/**
 * Map a grid of cells to install rows. The header row is auto-detected
 * anywhere in the first 5 non-empty rows (uploaded sheets often carry a
 * title row above the real headers); without one, columns are assumed to
 * be in FIELD_ALIASES order.
 */
function cellsToRows(cells: string[][]): ParseOutcome {
  if (cells.length === 0) return { rows: [], mode: 'empty' };

  let headerIdx = -1;
  for (let r = 0; r < Math.min(cells.length, 5) && headerIdx === -1; r++) {
    if (cells[r].some((c) => VIN_ALIASES.includes(norm(c)))) headerIdx = r;
  }

  const cols: Partial<Record<keyof ImportRow, number>> = {};
  let dataRows: string[][];
  let mode: 'header' | 'positional';
  if (headerIdx >= 0) {
    cells[headerIdx].forEach((cell, i) => {
      const h = norm(cell);
      for (const [field, names] of FIELD_ALIASES) if (names.includes(h) && cols[field] === undefined) cols[field] = i;
    });
    dataRows = cells.slice(headerIdx + 1);
    mode = 'header';
  } else {
    FIELD_ALIASES.forEach(([field], i) => { cols[field] = i; });
    dataRows = cells;
    mode = 'positional';
  }

  const get = (r: string[], field: keyof ImportRow) => {
    const i = cols[field];
    return i !== undefined && r[i] !== undefined ? r[i].trim() : '';
  };
  const rows = dataRows
    .map((r) => ({
      vin: get(r, 'vin').toUpperCase(),
      serialNumber: get(r, 'serialNumber'),
      imei: get(r, 'imei'),
      iccid: get(r, 'iccid'),
      vehicleYear: get(r, 'vehicleYear'),
      vehicleMake: get(r, 'vehicleMake'),
      vehicleModel: get(r, 'vehicleModel'),
      unitNumber: get(r, 'unitNumber'),
      partNumber: get(r, 'partNumber'),
    }))
    .filter((r) => r.vin);
  return { rows, mode };
}

/** Parse text pasted from Excel/Sheets (tab-separated) or a CSV block. */
export function parsePastedText(text: string): ParseOutcome {
  // Any tab anywhere means an Excel/Sheets paste — a title line above the
  // headers has no tabs, so sniffing only the first line misreads TSV.
  const delim = text.includes('\t') ? '\t' : ',';
  return cellsToRows(parseDelimited(text, delim));
}

/**
 * Render an exceljs cell value as plain text. Large integers (IMEI/ICCID
 * columns stored as numbers) must not come out in scientific notation —
 * `String(8.9e21)` would. Digits Excel already rounded off are gone either
 * way; validation still catches a truncated ID.
 */
function excelCellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return o.richText.map((r) => String((r as { text?: unknown }).text ?? '')).join('');
    if ('text' in o) return excelCellText(o.text);
    if ('result' in o || 'formula' in o || 'sharedFormula' in o) return excelCellText(o.result);
    return '';
  }
  return String(v);
}

function sheetCells(ws: Worksheet): string[][] {
  const colCount = ws.columnCount;
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) cells.push(excelCellText(row.getCell(c).value).trim());
    out.push(cells);
  });
  return out.filter((r) => r.some((c) => c.length > 0));
}

/**
 * Parse an uploaded spreadsheet file (.xlsx, .csv, .tsv, or plain text).
 * For workbooks, picks the first sheet that parses with a header row or
 * contains VIN-shaped values — so a leading "Instructions"/"Notes" sheet
 * doesn't swallow the import. Throws an Error with a user-facing message
 * for unsupported or unreadable files.
 */
export async function parseSpreadsheetFile(file: File): Promise<ParseOutcome> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'xls') {
    throw new Error('Legacy .xls workbooks aren’t supported — open the file in Excel and save it as .xlsx, then upload that.');
  }

  if (ext === 'xlsx' || ext === 'xlsm') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      throw new Error('Couldn’t read that workbook — re-save it as .xlsx and try again, or copy the cells and paste them instead.');
    }
    const sheets = workbook.worksheets;
    let fallback: ParseOutcome | null = null;
    for (const ws of sheets) {
      const cells = sheetCells(ws);
      if (cells.length === 0) continue;
      const outcome = cellsToRows(cells);
      if (sheets.length > 1) {
        outcome.sheetName = ws.name;
        outcome.sheetCount = sheets.length;
      }
      if (outcome.mode === 'header' || outcome.rows.some((r) => looksLikeVin(r.vin))) return outcome;
      if (!fallback) fallback = outcome;
    }
    return fallback ?? { rows: [], mode: 'empty' };
  }

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === '') {
    const text = await file.text();
    if (ext === 'csv') return cellsToRows(parseDelimited(text, ','));
    if (ext === 'tsv') return cellsToRows(parseDelimited(text, '\t'));
    return parsePastedText(text);
  }

  throw new Error(`Unsupported file type ".${ext}" — upload a .xlsx, .csv, or .tsv file, or copy the cells and paste them instead.`);
}
