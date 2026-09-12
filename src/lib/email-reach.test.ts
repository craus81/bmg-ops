import { describe, it, expect } from 'vitest';
import { rollUp, findUnreachable, domainOf, UNREACHABLE_THRESHOLD, type EmailRow } from './email-reach';

const row = (o: Partial<EmailRow>): EmailRow => ({
  kind: 'invoice', recipients: ['a@acme.com'], delivery_status: 'delivered',
  created_at: '2026-09-01T10:00:00Z', ...o,
});

describe('domainOf', () => {
  it('lowercases the domain', () => expect(domainOf('Jo@ACME.com')).toBe('acme.com'));
  it('names a malformed address rather than dropping it', () => {
    expect(domainOf('not-an-address')).toBe('(no domain)');
    expect(domainOf('')).toBe('(no domain)');
  });
});

describe('rollUp', () => {
  it('counts a confirmed delivery and a confirmed failure', () => {
    const { totals } = rollUp([row({}), row({ delivery_status: 'bounced' })]);
    expect(totals.delivered).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.failureRate).toBe(0.5);
  });

  it('treats an unconfirmed "sent" as PENDING, not delivered', () => {
    // The core honesty rule: no webhook is not a delivery.
    const { totals } = rollUp([row({ delivery_status: 'sent' })]);
    expect(totals.delivered).toBe(0);
    expect(totals.pending).toBe(1);
    expect(totals.failureRate).toBeNull();
  });

  it('keeps pending OUT of the rate denominator', () => {
    // Otherwise a late webhook moves the deliverability number.
    const { totals } = rollUp([
      row({ delivery_status: 'delivered' }),
      row({ delivery_status: 'bounced' }),
      ...Array.from({ length: 8 }, () => row({ delivery_status: 'sent' })),
    ]);
    expect(totals.failureRate).toBe(0.5);
    expect(totals.total).toBe(10);
  });

  it('counts complained as a failure', () => {
    expect(rollUp([row({ delivery_status: 'complained' })]).totals.failed).toBe(1);
  });

  it('counts one multi-recipient email once overall but once per domain', () => {
    const { totals, byDomain } = rollUp([
      row({ recipients: ['a@acme.com', 'b@acme.com', 'c@other.com'], delivery_status: 'delivered' }),
    ]);
    expect(totals.total).toBe(1);
    expect(byDomain.find(d => d.key === 'acme.com')!.delivered).toBe(2);
    expect(byDomain.find(d => d.key === 'other.com')!.delivered).toBe(1);
  });

  it('groups by kind', () => {
    const { byKind } = rollUp([row({ kind: 'invoice' }), row({ kind: 'statement', delivery_status: 'bounced' })]);
    expect(byKind.map(k => k.key).sort()).toEqual(['invoice', 'statement']);
  });

  it('ranks a big real problem above a tiny 100%-failure row', () => {
    const many = Array.from({ length: 40 }, () => row({ recipients: ['x@big.com'], delivery_status: 'bounced' }));
    const some = Array.from({ length: 40 }, () => row({ recipients: ['y@big.com'], delivery_status: 'delivered' }));
    const one = [row({ recipients: ['z@tiny.com'], delivery_status: 'bounced' })];
    const { byDomain } = rollUp([...one, ...many, ...some]);
    expect(byDomain[0].key).toBe('big.com');
  });

  it('treats a missing kind as "other" rather than dropping the row', () => {
    expect(rollUp([row({ kind: null })]).byKind[0].key).toBe('other');
  });
});

describe('findUnreachable', () => {
  const bounce = (o: Partial<EmailRow>) => row({ delivery_status: 'bounced', ...o });

  it('lists an address that failed at the threshold', () => {
    const out = findUnreachable(Array.from({ length: UNREACHABLE_THRESHOLD }, () => bounce({})));
    expect(out).toHaveLength(1);
    expect(out[0].failures).toBe(UNREACHABLE_THRESHOLD);
  });

  it('leaves a single failure alone', () => {
    expect(findUnreachable([bounce({})], 2)).toHaveLength(0);
  });

  it('EXCLUDES failures somebody marked resolved', () => {
    // The contact was fixed; keeping it here sends someone to fix it twice.
    const rows = Array.from({ length: 5 }, () => bounce({ resolved_at: '2026-09-02T00:00:00Z' }));
    expect(findUnreachable(rows)).toHaveLength(0);
  });

  it('matches addresses case-insensitively', () => {
    const out = findUnreachable([bounce({ recipients: ['A@acme.com'] }), bounce({ recipients: ['a@ACME.com'] })]);
    expect(out).toHaveLength(1);
    expect(out[0].failures).toBe(2);
  });

  it('keeps a customer link a later automated send would have erased', () => {
    const out = findUnreachable([
      bounce({ customer_id: 'cust-1' }),
      bounce({ customer_id: null }),
    ]);
    expect(out[0].customerId).toBe('cust-1');
  });

  it('reports the LATEST failure, not the first one it saw', () => {
    const out = findUnreachable([
      bounce({ created_at: '2026-09-01T00:00:00Z', delivery_status: 'bounced' }),
      bounce({ created_at: '2026-09-09T00:00:00Z', delivery_status: 'complained' }),
    ]);
    expect(out[0].lastFailureAt).toBe('2026-09-09T00:00:00Z');
    expect(out[0].lastStatus).toBe('complained');
  });

  it('collects the distinct flows that hit the address', () => {
    const out = findUnreachable([bounce({ kind: 'invoice' }), bounce({ kind: 'statement' })]);
    expect(out[0].kinds).toEqual(['invoice', 'statement']);
  });

  it('ignores delivered rows entirely', () => {
    expect(findUnreachable([row({}), row({})])).toHaveLength(0);
  });
});
