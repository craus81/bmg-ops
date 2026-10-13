import { describe, it, expect } from 'vitest';
import { htmlToText, buildNotificationEmail } from './resend';

describe('htmlToText', () => {
  it('keeps links as "label (url)" so the text part can still act', () => {
    const text = htmlToText('<p>Please <a href="https://go.bmgfleet.com/approve/estimate/abc?via=email&amp;to=x">Review &amp; Approve</a></p>');
    expect(text).toBe('Please Review & Approve (https://go.bmgfleet.com/approve/estimate/abc?via=email&to=x)');
  });

  it('turns blocks and <br> into line breaks and drops head, style and comments', () => {
    const text = htmlToText('<html><head><title>x</title><style>p{color:red}</style></head><body><!-- Header --><div>One</div><div>Two<br>Three</div></body></html>');
    expect(text).toBe('One\n\nTwo\nThree');
  });

  it('decodes entities and keeps table cells on one line', () => {
    const text = htmlToText('<table><tr><td>Bumper&nbsp;guard</td><td>$1,200 &mdash; each</td></tr></table>');
    expect(text).toBe('Bumper guard $1,200 — each');
  });

  it('writes a mailto link as the address alone', () => {
    expect(htmlToText('<a href="mailto:inquiry@bmgfleet.com">inquiry@bmgfleet.com</a>')).toBe('inquiry@bmgfleet.com');
  });

  it('carries the CTA url from a notification email', () => {
    const text = htmlToText(buildNotificationEmail('Estimate ready', 'Have a look', 'https://go.bmgfleet.com/x', 'Open'));
    expect(text).toContain('Estimate ready');
    expect(text).toContain('Open (https://go.bmgfleet.com/x)');
    expect(text).not.toContain('<');
  });
});
