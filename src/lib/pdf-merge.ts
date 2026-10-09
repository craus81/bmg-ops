import { PDFDocument } from 'pdf-lib';

/**
 * Merge PDFs into one, in order. Used by the statement email's "one combined
 * PDF" option so a customer with dozens of open invoices gets a single file
 * instead of a 10-attachment cap.
 */
export async function mergePdfs(pdfs: (Buffer | Uint8Array)[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const bytes of pdfs) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
