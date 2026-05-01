// Parse Masterack PO PDFs
// Uses positional text extraction for accurate column mapping

import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export interface ParsedPOLine {
  line_no: string;
  part_number: string;
  supplier_part: string;
  description: string;
  quantity: number;
  unit_price: number;
  extended_price: number;
  delivery_date: string;
}

export interface ParsedPO {
  po_number: string;
  customer: string;
  ordered_date: string;
  requested_delivery_date: string;
  lines: ParsedPOLine[];
  debug?: string; // raw text dump for troubleshooting
}

export async function parseMasterackPO(file: File, debug = false): Promise<ParsedPO> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Get all text items with positions
  interface TItem { str: string; x: number; y: number; w: number; }
  const allItems: TItem[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as any[]) {
      if (item.str !== undefined) {
        allItems.push({
          str: item.str,
          x: Math.round(item.transform[4]),
          y: Math.round(item.transform[5]),
          w: Math.round(item.width || 0),
        });
      }
    }
  }

  // Build debug output
  let debugText = '';
  if (debug) {
    // Sort by Y desc then X asc (reading order)
    const sorted = [...allItems].sort((a, b) => b.y - a.y || a.x - b.x);
    debugText = sorted.map((t) => `[y=${t.y} x=${t.x} w=${t.w}] "${t.str}"`).join('\n');
  }

  // Reconstruct lines by grouping items at similar Y positions
  const yGroups = new Map<number, TItem[]>();
  for (const item of allItems) {
    if (!item.str.trim()) continue;
    let matched = false;
    for (const [y, group] of yGroups) {
      if (Math.abs(item.y - y) <= 5) {
        group.push(item);
        matched = true;
        break;
      }
    }
    if (!matched) {
      yGroups.set(item.y, [item]);
    }
  }

  // Sort groups top to bottom (high Y = top of page in PDF coords), items left to right
  const textLines: { y: number; items: TItem[] }[] = [];
  for (const [y, items] of yGroups) {
    items.sort((a, b) => a.x - b.x);
    textLines.push({ y, items });
  }
  textLines.sort((a, b) => b.y - a.y);

  // Build full text per line for regex matching
  const fullLines = textLines.map((line) => ({
    y: line.y,
    items: line.items,
    text: line.items.map((i) => i.str).join(' '),
  }));

  // Extract PO number
  let po_number = '';
  for (const line of fullLines) {
    const m = line.text.match(/PURCHASE\s*ORDER\s*NUMBER\s*(\d+)/i);
    if (m) { po_number = m[1]; break; }
  }

  // Extract ordered date
  let ordered_date = '';
  for (const line of fullLines) {
    const m = line.text.match(/Ordered\s*Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i);
    if (m) { ordered_date = m[1]; break; }
  }

  // Extract header-level "REQUESTED DELIVERY DATE" (Masterack PO label).
  // The date is sometimes on the same line, sometimes on the next line.
  let requested_delivery_date = '';
  for (let i = 0; i < fullLines.length; i++) {
    const text = fullLines[i].text;
    if (!/REQUESTED\s*DELIVERY\s*DATE/i.test(text)) continue;
    const inline = text.match(/REQUESTED\s*DELIVERY\s*DATE[^\d]*(\d{2}\/\d{2}\/\d{2,4})/i);
    if (inline) { requested_delivery_date = inline[1]; break; }
    // Look at the next 2 lines for a bare date
    for (let j = 1; j <= 2 && i + j < fullLines.length; j++) {
      const m = fullLines[i + j].text.match(/(\d{2}\/\d{2}\/\d{2,4})/);
      if (m) { requested_delivery_date = m[1]; break; }
    }
    if (requested_delivery_date) break;
  }

  // Find data rows: look for lines starting with "X.000" (line number pattern)
  const lines: ParsedPOLine[] = [];

  for (let i = 0; i < fullLines.length; i++) {
    const fl = fullLines[i];
    // Line number pattern: "1.000", "2.000", etc
    const lineNoItem = fl.items.find((item) => /^\d+\.\d{3}$/.test(item.str.trim()));
    if (!lineNoItem) continue;

    const line_no = lineNoItem.str.trim();

    // This row should contain: line_no, part_number, description pieces, qty, UOM, unit_price, etc
    // Items are sorted left to right by X position
    const rowItems = fl.items.filter((item) => item.str.trim());

    // Part number: first substantial alphanumeric item after line number
    let part_number = '';
    let partIdx = -1;
    for (let j = 0; j < rowItems.length; j++) {
      const s = rowItems[j].str.trim();
      if (s === line_no) continue;
      if (/^[A-Z0-9]{4,}$/i.test(s)) {
        part_number = s;
        partIdx = j;
        break;
      }
    }

    // Find "EA" (UOM) - this anchors our column positions
    let eaIdx = -1;
    for (let j = 0; j < rowItems.length; j++) {
      if (rowItems[j].str.trim() === 'EA' || rowItems[j].str.trim() === 'PC') {
        eaIdx = j;
        break;
      }
    }

    // Quantity: the number immediately before "EA"
    let quantity = 0;
    if (eaIdx > 0) {
      const qStr = rowItems[eaIdx - 1].str.trim();
      if (/^\d+(\.\d+)?$/.test(qStr)) {
        quantity = parseFloat(qStr);
      }
    }

    // Unit price: the number immediately after "EA" (or after the UOM)
    let unit_price = 0;
    if (eaIdx >= 0 && eaIdx + 1 < rowItems.length) {
      const pStr = rowItems[eaIdx + 1].str.trim();
      if (/^\d+(\.\d+)?$/.test(pStr)) {
        unit_price = parseFloat(pStr);
      }
    }

    // Delivery date: look for MM/DD/YY pattern
    let delivery_date = '';
    for (const item of rowItems) {
      if (/^\d{2}\/\d{2}\/\d{2,4}$/.test(item.str.trim())) {
        delivery_date = item.str.trim();
        break;
      }
    }

    // Description: items between part number and qty, that aren't the supplier part or special
    const descParts: string[] = [];
    const qtyItemX = eaIdx > 0 ? rowItems[eaIdx - 1].x : 9999;
    for (let j = (partIdx >= 0 ? partIdx + 1 : 1); j < rowItems.length; j++) {
      const item = rowItems[j];
      if (item.x >= qtyItemX - 10) break;
      const s = item.str.trim();
      if (s && s !== line_no && s !== part_number) {
        descParts.push(s);
      }
    }

    // Supplier part: check the next text line for a part number pattern near same X as our part_number
    let supplier_part = '';
    if (i + 1 < fullLines.length) {
      const nextLine = fullLines[i + 1];
      // Should not be another "X.000" line
      if (!nextLine.items.some((item) => /^\d+\.\d{3}$/.test(item.str.trim()))) {
        // Look for alphanumeric code and description on continuation line
        for (const item of nextLine.items) {
          const s = item.str.trim();
          if (/^[A-Z0-9]{4,}$/i.test(s) && s !== part_number) {
            supplier_part = s;
            break;
          }
        }
        // Add rest of next line to description
        const extraDesc = nextLine.items
          .filter((item) => item.str.trim() !== supplier_part && item.str.trim())
          .map((item) => item.str.trim());
        if (extraDesc.length > 0) {
          descParts.push(...extraDesc);
        }
      }
    }

    // Clean up description
    const description = descParts
      .filter((d) => !/^\d+\.\d{3}$/.test(d)) // remove line numbers
      .filter((d) => !/^[YN]$/.test(d)) // remove tax flag
      .filter((d) => !/^\d{2}\/\d{2}\/\d{2}$/.test(d)) // remove dates
      .join(' ')
      .trim();

    if (part_number) {
      lines.push({
        line_no,
        part_number,
        supplier_part,
        description,
        quantity,
        unit_price,
        extended_price: quantity * unit_price,
        delivery_date,
      });
    }
  }

  // Fall back to the earliest per-line delivery date if no header field was found
  if (!requested_delivery_date) {
    const sortable = lines
      .map(l => l.delivery_date)
      .filter(Boolean)
      .map(d => {
        const m = d.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
        if (!m) return null;
        const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
        return { sortKey: `${yr}-${m[1]}-${m[2]}`, original: d };
      })
      .filter((x): x is { sortKey: string; original: string } => x !== null)
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    if (sortable.length > 0) requested_delivery_date = sortable[0].original;
  }

  return {
    po_number,
    customer: 'Masterack',
    ordered_date,
    requested_delivery_date,
    lines,
    debug: debug ? debugText : undefined,
  };
}
