'use client';

/**
 * Customer statement PDF — the in-app outputs. The document itself is
 * built by the pure renderer in statement-pdf-doc.ts (shared with the
 * statement email's PDF copy); this wrapper only owns the browser side:
 *   open   → window.open(blob URL) so the user can view/save the PDF
 *   print  → same blob with autoPrint() so the print dialog opens
 * Both fall back to doc.save() (download) when a popup blocker eats the
 * window — the established pattern for jsPDF docs in this app.
 */

import { buildStatementPdf, statementPdfFilename, type StatementPdfData } from './statement-pdf-doc';

export type { StatementPdfData } from './statement-pdf-doc';

export function exportStatementPDF(data: StatementPdfData, opts: { print?: boolean } = {}) {
  const doc = buildStatementPdf(data);
  const fileName = statementPdfFilename(data.customer);
  if (opts.print) doc.autoPrint();
  const w = window.open(doc.output('bloburl').toString(), '_blank');
  if (!w) doc.save(fileName);
}
