// Parse Masterack PO PDFs
// Uses positional text extraction for accurate column mapping.
// The PDF engine lives here; the column-mapping logic is in parsePO-core.ts.

import * as pdfjsLib from 'pdfjs-dist';
import { parsePOFromItems, type ParsedPO, type TItem } from './parsePO-core';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export type { ParsedPO, ParsedPOLine } from './parsePO-core';

export async function parseMasterackPO(file: File, debug = false): Promise<ParsedPO> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Get all text items with positions
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

  return parsePOFromItems(allItems, debug);
}
