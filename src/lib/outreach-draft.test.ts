import { describe, it, expect } from 'vitest';
import { safeSiteUrl, htmlToPlain, findEmails, parseDraftJson, buildPrompt, readWebsite, type DraftInput } from './outreach-draft';
import { renderOutreachHtml } from './outreach-send';

const input: DraftInput = {
  companyName: 'Gateway Route Freight', kind: 'fleet', trade: null, city: 'Collinsville', state: 'IL',
  miles: 30, fleetSize: 34, facts: { drivers: 40, legalName: 'Gateway Route Freight LLC' },
  website: 'https://gateway.example', knownEmail: null, repName: 'Zach Miller',
};

describe('safeSiteUrl', () => {
  it('allows ordinary public sites only', () => {
    expect(safeSiteUrl('https://riverbend.example/')?.hostname).toBe('riverbend.example');
    expect(safeSiteUrl('http://www.acme.com')).not.toBeNull();
    for (const bad of ['ftp://x.com', 'http://localhost', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1',
      'http://169.254.169.254/latest', 'http://intranet', 'https://user:pw@x.com', 'https://x.com:8443', 'not a url', '']) {
      expect(safeSiteUrl(bad)).toBeNull();
    }
  });
});

describe('reading a website', () => {
  it('keeps text, drops scripts and styles', () => {
    const t = htmlToPlain('<html><style>.a{}</style><script>var x=1</script><h1>Riverbend</h1><p>8 vans &amp; 24/7</p></html>');
    expect(t).toContain('Riverbend');
    expect(t).toContain('8 vans & 24/7');
    expect(t).not.toContain('var x');
  });

  it('finds emails, own domain first, junk out', () => {
    const e = findEmails('call info@gmail.com or office@riverbend.example; noreply@riverbend.example; logo@2x.png', 'www.riverbend.example');
    expect(e).toEqual(['office@riverbend.example', 'info@gmail.com']);
  });

  it('reads home, contact and about, and picks up mailto links', async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      const html = url.endsWith('/contact') ? '<a href="mailto:dispatch@gateway.example">Email us</a>' : '<p>Box trucks across Metro East</p>';
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const r = await readWebsite('https://gateway.example', fake);
    expect(seen).toEqual(['https://gateway.example/', 'https://gateway.example/contact', 'https://gateway.example/about']);
    expect(r.emails).toEqual(['dispatch@gateway.example']);
    expect(r.text).toContain('Box trucks');
  });

  it('reads nothing for an unsafe site', async () => {
    const fake = (async () => { throw new Error('should not fetch'); }) as unknown as typeof fetch;
    expect(await readWebsite('http://127.0.0.1', fake)).toEqual({ text: '', emails: [] });
  });
});

describe('the prompt and the reply', () => {
  it('gives Claude the real facts and the rules', () => {
    const p = buildPrompt(input, { text: 'We run box trucks', emails: [] });
    expect(p).toContain('Gateway Route Freight');
    expect(p).toContain('34 power units');
    expect(p).toContain('40 drivers');
    expect(p).toContain('about 30 miles');
    expect(p).toContain('Zach Miller');
    expect(p).toContain('We run box trucks');
    expect(p).toMatch(/Never invent facts/);
  });

  it('parses bare or fenced JSON and rejects junk', () => {
    const body = 'Hi there,\n\nI saw Gateway Route runs about 34 trucks out of Collinsville and wanted to say hello.';
    const fenced = '```json\n' + JSON.stringify({ subject: 'Upfits for your trucks', body, reasons: ['34 trucks'], contactName: 'null' }) + '\n```';
    expect(parseDraftJson(fenced)).toEqual({ subject: 'Upfits for your trucks', body, reasons: ['34 trucks'], contactName: null });
    expect(parseDraftJson('no json here')).toBeNull();
    expect(parseDraftJson('{"subject":"x","body":"short"}')).toBeNull();
  });
});

describe('renderOutreachHtml', () => {
  it('escapes the rep\'s text and keeps paragraphs', () => {
    const html = renderOutreachHtml('Hi <b>there</b>,\n\nSecond para', '<p>sig</p>', '<div>footer</div>');
    expect(html).toContain('Hi &lt;b&gt;there&lt;/b&gt;,');
    expect((html.match(/<p style/g) || []).length).toBe(2);
    expect(html).toContain('<div>footer</div>');
  });
});
