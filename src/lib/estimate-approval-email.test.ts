import { describe, it, expect } from 'vitest';
import { approvalCtaNote, approvalEmailExtras } from './estimate-approval-email';
import { renderEstimateDocument } from './estimate-document';

// The approval email attaches nothing since 2026-10-21: Review & Approve at
// the top with a Download PDF link, a Downloads list, a forwarding line.
describe('approval email wording', () => {
  it('names the others the email went to', () => {
    expect(approvalCtaNote(30, [])).toBe('Approve or request changes on the next page. This link expires in 30 days.');
    expect(approvalCtaNote(30, ['mike@acme.com'])).toContain('Also sent to mike@acme.com.');
  });

  it('puts the button at the top with the PDF link, and again at the bottom', () => {
    const html = renderEstimateDocument(
      { estimate_number: 'EST-1', customer_name: 'Acme', subtotal: 0, grand_total: 0 },
      [],
      {
        ctaUrl: 'https://go.bmgfleet.com/approve/estimate/t?via=email&to=a%40b.com&own=1',
        ctaLabel: 'Review & Approve',
        ...approvalEmailExtras(false, 'https://go.bmgfleet.com/api/approve/estimate/t/download/pdf'),
        attachmentNames: [{ name: 'EST-1.pdf', url: 'https://go.bmgfleet.com/api/approve/estimate/t/download/pdf' }],
      },
    );
    expect(html.match(/>Review &amp; Approve</g)?.length).toBe(2);
    const top = html.indexOf('>Review &amp; Approve<');
    expect(html.indexOf('>Download PDF<')).toBeGreaterThan(top);
    expect(html).toContain('Downloads');
    expect(html).not.toContain('>Attached<');
    expect(html).toContain('Forward this email');
  });

  it('a fleet email has no single PDF link at the top', () => {
    expect(approvalEmailExtras(true, 'x').ctaTop.downloadUrl).toBeNull();
  });
});
