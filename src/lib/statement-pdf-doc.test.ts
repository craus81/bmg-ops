// The statement's "As of" date (src/lib/statement-pdf-doc.ts): the day it's
// made, or, for the customer portal's from BMG's books, the day the books
// last caught up with NetSuite (docs/books.md "The portal").
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildStatementPdf } from './statement-pdf-doc';

const INVOICE = {
  id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', customer: 'Acme Fleet', entityId: '9001',
  total: 1000, unpaid: 800, daysPastDue: 32, bucket: 'd31_60' as const, nsUrl: 'https://ns.example/custinvc/101', status: 'open' as const,
};
const pdfText = (asOf?: string) => buildStatementPdf({ customer: 'Acme Fleet', invoices: [INVOICE], scope: 'open', asOf }).output();

afterEach(() => {
  vi.useRealTimers();
});

describe('the statement date', () => {
  it("is the day the amounts are as of, when that's given, else the day it's made", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));
    expect(pdfText('2026-10-30T17:05:00Z')).toContain('As of 10/30/2026');
    expect(pdfText('2026-10-30T17:05:00Z')).not.toContain('As of 11/2/2026');
    expect(pdfText()).toContain('As of 11/2/2026');
  });
});
