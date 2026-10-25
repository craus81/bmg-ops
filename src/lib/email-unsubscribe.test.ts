import { describe, it, expect } from 'vitest';
import {
  normalizeEmail, isUnsubscribeToken, listUnsubscribeHeaders, marketingFooterHtml, marketingFooterText,
  maskEmail, unsubscribePageUrl, loadUnsubscribed,
} from './email-unsubscribe';
import { LEGAL } from './legal';

const TOKEN = 'ab'.repeat(24);

describe('email-unsubscribe', () => {
  it('normalizes addresses so one person is one row', () => {
    expect(normalizeEmail('  Dana@Acme.Example ')).toBe('dana@acme.example');
    expect(normalizeEmail(null)).toBe('');
  });

  it('accepts only 48-hex tokens', () => {
    expect(isUnsubscribeToken(TOKEN)).toBe(true);
    expect(isUnsubscribeToken('ab')).toBe(false);
    expect(isUnsubscribeToken(TOKEN.toUpperCase())).toBe(false);
    expect(isUnsubscribeToken(`${TOKEN.slice(0, 47)}'`)).toBe(false);
  });

  it('gives mail clients a one-click POST target (RFC 8058)', () => {
    const h = listUnsubscribeHeaders(TOKEN);
    expect(h['List-Unsubscribe']).toMatch(new RegExp(`^<https://.+/api/unsubscribe/${TOKEN}>$`));
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('footer carries the postal address and the page link (CAN-SPAM)', () => {
    const html = marketingFooterHtml(TOKEN);
    expect(html).toContain(LEGAL.address);
    expect(html).toContain(unsubscribePageUrl(TOKEN));
    expect(html).toContain('Unsubscribe');
    const text = marketingFooterText(TOKEN);
    expect(text).toContain(LEGAL.address);
    expect(text).toContain(unsubscribePageUrl(TOKEN));
  });

  it('masks the address on the public page', () => {
    expect(maskEmail('dana@acme.example')).toBe('d•••@acme.example');
    expect(maskEmail('nope')).toBe('•••');
  });

  it('looks up opted-out addresses, normalized and deduped', async () => {
    const asked: string[][] = [];
    const service: any = {
      from: () => ({
        select: () => ({
          in: (_c: string, list: string[]) => {
            asked.push(list);
            return { not: async () => ({ data: [{ email: 'dana@acme.example' }], error: null }) };
          },
        }),
      }),
    };
    const out = await loadUnsubscribed(service, ['Dana@Acme.example', 'dana@acme.example', '', 'bo@x.example']);
    expect(asked).toEqual([['dana@acme.example', 'bo@x.example']]);
    expect([...out]).toEqual(['dana@acme.example']);
  });

  it('fails closed when the lookup errors', async () => {
    const service: any = {
      from: () => ({ select: () => ({ in: () => ({ not: async () => ({ data: null, error: { message: 'timeout' } }) }) }) }),
    };
    await expect(loadUnsubscribed(service, ['a@b.example'])).rejects.toThrow(/unsubscribes/);
  });
});
