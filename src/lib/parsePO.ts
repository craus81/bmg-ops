// Parse Masterack PO PDFs
// Extracts PO number, line items (part number, description, quantity, unit price)

import * as pdfjsLib from 'pdfjs-dist';

// Disable worker — runs on main thread, fine for small POs
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export interface ParsedPOLine {
  line_no: string;
  part_number: string;       // Masterack part number (e.g., 06CS982486)
  supplier_part: string;     // Supplier part number (e.g., CS982486)
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
  lines: ParsedPOLine[];
}

export async function parseMasterackPO(file: File): Promise<ParsedPO> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n';
  }

  // Extract PO number
  const poMatch = fullText.match(/PURCHASE\s+ORDER\s+NUMBER\s+(\d+)/i);
  const po_number = poMatch ? poMatch[1] : '';

  // Extract ordered date
  const dateMatch = fullText.match(/Ordered\s+Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const ordered_date = dateMatch ? dateMatch[1] : '';

  // Extract line items
  // Masterack PO format: Line No | Part Number / Supplier Part | Description | Drawing | Harmonized | Qty | UOM | Unit Price | Extended | Date Tax
  const lines: ParsedPOLine[] = [];

  // Strategy: find patterns like "1.000 06CS982486 CS982486" followed by quantity and price
  // Line numbers are like "1.000", "2.000", etc.
  const linePattern = /(\d+\.\d{3})\s+(\S+)\s+/g;
  let match;

  // Better approach: split by line numbers and parse each block
  const lineBlocks = fullText.split(/(?=\d+\.\d{3}\s+\d{2}[A-Z])/);

  for (const block of lineBlocks) {
    // Match: "1.000 06CS982486 CS982486 ... 6.00 EA 0.0000"
    const lineMatch = block.match(/^(\d+\.\d{3})\s+(\S+)\s+(\S+)/);
    if (!lineMatch) continue;

    const line_no = lineMatch[1];
    const part_number = lineMatch[2];
    const supplier_part = lineMatch[3];

    // Find quantity: look for number followed by "EA"
    const qtyMatch = block.match(/(\d+(?:\.\d+)?)\s+EA/);
    const quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

    // Find unit price: number after EA, format like "0.0000" or "195.0000"
    const priceMatch = block.match(/EA\s+(\d+(?:\.\d+)?)/);
    const unit_price = priceMatch ? parseFloat(priceMatch[1]) : 0;

    // Find extended price: look for pattern after unit price
    // The extended USD comes after unit price
    const extMatch = block.match(/EA\s+\d+(?:\.\d+)?\s+(?:Y\s+)?(\d+(?:\.\d+)?)/);
    const extended_price = extMatch ? parseFloat(extMatch[1]) : quantity * unit_price;

    // Find delivery date
    const delMatch = block.match(/(\d{2}\/\d{2}\/\d{2,4})/);
    const delivery_date = delMatch ? delMatch[1] : '';

    // Extract description: text between supplier part and the quantity
    // This is tricky from flattened text, grab what we can
    const descStart = block.indexOf(supplier_part) + supplier_part.length;
    const descEnd = qtyMatch ? block.indexOf(qtyMatch[0]) : block.length;
    let description = block.substring(descStart, descEnd).trim();
    // Clean up description - remove drawing numbers and codes
    description = description.replace(/\s+/g, ' ').trim();

    if (part_number && quantity > 0) {
      lines.push({
        line_no,
        part_number,
        supplier_part,
        description,
        quantity,
        unit_price,
        extended_price,
        delivery_date,
      });
    }
  }

  return {
    po_number,
    customer: 'Masterack',
    ordered_date,
    lines,
  };
}
