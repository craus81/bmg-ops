import { describe, it, expect, vi } from 'vitest';
import {
  BooksError,
  booksErrorFrom,
  centsToAmount,
  isIsoDate,
  postEntry,
  postPayload,
  reverseEntry,
  setPeriodStatus,
  toCents,
  validateEntry,
  type JournalEntryInput,
} from './journal';

const AR = '7d0c6c55-1f1e-4a43-9b49-6f2d2b8f3a01';
const SALES = '2b8e0f1a-4c4d-4f7e-8f1e-0d6b5a9c7e02';
const CUSTOMER = '6f1c2c1e-6a0b-4d55-9a57-2f9a1b0c0d11';

const invoice = (over: Partial<JournalEntryInput> = {}): JournalEntryInput => ({
  company: 'BMG',
  entryDate: '2026-11-03',
  sourceType: 'invoice',
  sourceId: 'INV-100',
  postingRule: 'invoice@1',
  idempotencyKey: 'invoice:INV-100:1',
  lines: [
    { accountId: AR, debit: 1250, customerId: CUSTOMER, jobRef: 'so:1060' },
    { accountId: SALES, credit: '1250.00', division: 'upfit', location: 'ofallon' },
  ],
  ...over,
});

const fakeClient = (result: { data?: unknown; error?: { message: string } | null }) => {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { client: { rpc } as any, rpc };
};

describe('toCents', () => {
  it('reads numbers and plain decimal strings as whole cents', () => {
    expect(toCents('1250.00')).toBe(125000);
    expect(toCents(' 12.3 ')).toBe(1230);
    expect(toCents('0.05')).toBe(5);
    expect(toCents(1250)).toBe(125000);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(12345678.91)).toBe(1234567891);
  });

  it('treats a missing side as zero', () => {
    expect(toCents(undefined)).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents('')).toBe(0);
  });

  it('refuses fractions of a cent, negatives and anything that isn\'t a plain amount', () => {
    expect(toCents(10.005)).toBeNull();
    expect(toCents('10.005')).toBeNull();
    expect(toCents(-1)).toBeNull();
    expect(toCents('-1.00')).toBeNull();
    expect(toCents('1,250.00')).toBeNull();
    expect(toCents('1e3')).toBeNull();
    expect(toCents('$5')).toBeNull();
    expect(toCents(Number.NaN)).toBeNull();
    expect(toCents(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('writes cents back as an exact two-decimal amount', () => {
    expect(centsToAmount(125000)).toBe('1250.00');
    expect(centsToAmount(5)).toBe('0.05');
    expect(centsToAmount(0)).toBe('0.00');
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-11-31')).toBe(false);
    expect(isIsoDate('2026-1-03')).toBe(false);
    expect(isIsoDate('11/03/2026')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('validateEntry', () => {
  it('passes a balanced entry', () => {
    expect(validateEntry(invoice())).toEqual([]);
  });

  it('balances in cents, so float noise in the inputs doesn\'t matter', () => {
    expect(validateEntry(invoice({
      lines: [
        { accountId: AR, debit: 19.99 },
        { accountId: AR, debit: 0.01 },
        { accountId: SALES, credit: 20 },
      ],
    }))).toEqual([]);
  });

  it('names the totals when debits and credits differ', () => {
    expect(validateEntry(invoice({
      lines: [
        { accountId: AR, debit: 1250 },
        { accountId: SALES, credit: 1249.99 },
      ],
    }))).toEqual(['Debits $1,250.00 don\'t equal credits $1,249.99']);
  });

  it('needs two lines, each with one side above zero', () => {
    expect(validateEntry(invoice({ lines: [{ accountId: AR, debit: 5 }] }))).toEqual(['An entry needs at least two lines']);
    expect(validateEntry(invoice({
      lines: [
        { accountId: AR, debit: 5, credit: 5 },
        { accountId: SALES },
      ],
    }))).toEqual([
      'Line 1: needs either a debit or a credit above zero, not both',
      'Line 2: needs either a debit or a credit above zero, not both',
    ]);
  });

  it('flags each bad field by line', () => {
    expect(validateEntry(invoice({
      lines: [
        { accountId: 'AR', debit: '10.001', customerId: 'acme' },
        { accountId: SALES, credit: 10, division: 'paint' as any, location: 'O\'Fallon' },
      ],
    }))).toEqual([
      'Line 1: account is missing',
      'Line 1: debit "10.001" isn\'t an amount with at most two decimals',
      'Line 1: customer id isn\'t a customer',
      'Line 2: division "paint" isn\'t upfit, graphics or shared',
      'Line 2: location "O\'Fallon" isn\'t a location key',
    ]);
  });

  it('flags the entry\'s own fields', () => {
    expect(validateEntry(invoice({
      company: 'ACME' as any,
      entryDate: '2026-02-30',
      sourceType: 'Vendor Bill',
      postingRule: ' ',
      idempotencyKey: '',
      postedBy: { id: 'craig', name: 'Craig' },
    }))).toEqual([
      'Unknown company "ACME"',
      'Entry date "2026-02-30" isn\'t a YYYY-MM-DD date',
      'Source type "Vendor Bill" must be lowercase letters and underscores',
      'Posting rule is required',
      'Idempotency key is required',
      'Posted-by id must be a profile id',
    ]);
  });

  it('leaves reversals to reverseEntry', () => {
    expect(validateEntry(invoice({ sourceType: 'reversal' }))).toEqual(['Reversals are posted with reverseEntry, not postEntry']);
  });
});

describe('postPayload', () => {
  it('sends exact two-decimal strings and nulls for the empty side', () => {
    const p = postPayload(invoice({ idempotencyKey: '  invoice:INV-100:1 ', postedBy: { id: null, name: 'System' } }));
    expect(p).toMatchObject({
      company: 'BMG',
      entry_date: '2026-11-03',
      source_type: 'invoice',
      source_id: 'INV-100',
      posting_rule: 'invoice@1',
      idempotency_key: 'invoice:INV-100:1',
      posted_by: null,
      posted_by_name: 'System',
    });
    expect(p.lines).toEqual([
      expect.objectContaining({ account_id: AR, debit: '1250.00', credit: null, customer_id: CUSTOMER, job_ref: 'so:1060' }),
      expect.objectContaining({ account_id: SALES, debit: null, credit: '1250.00', division: 'upfit', location: 'ofallon' }),
    ]);
  });
});

describe('postEntry', () => {
  it('refuses an invalid entry without calling the database', async () => {
    const { client, rpc } = fakeClient({});
    const err = await postEntry(client, invoice({ lines: [] })).catch((e) => e);
    expect(err).toBeInstanceOf(BooksError);
    expect(err.kind).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('posts through gl_post_entry and reports a repeated key', async () => {
    const { client, rpc } = fakeClient({ data: { id: 'e1', entry_no: 42, already_posted: true } });
    await expect(postEntry(client, invoice())).resolves.toEqual({ id: 'e1', entryNo: 42, alreadyPosted: true });
    expect(rpc).toHaveBeenCalledWith('gl_post_entry', { p: postPayload(invoice()) });
  });

  it('separates the journal\'s own refusals from other failures', async () => {
    const closed = fakeClient({ error: { message: 'gl: 2026-10 is closed for BMG Fleet Installations' } });
    await expect(postEntry(closed.client, invoice())).rejects.toMatchObject({
      kind: 'refused',
      message: '2026-10 is closed for BMG Fleet Installations',
    });
    const down = fakeClient({ error: { message: 'fetch failed' } });
    await expect(postEntry(down.client, invoice())).rejects.toMatchObject({ kind: 'failed', message: 'fetch failed' });
    expect(booksErrorFrom(null).kind).toBe('failed');
  });
});

describe('reverseEntry and setPeriodStatus', () => {
  it('check their inputs before calling the database', async () => {
    const { client, rpc } = fakeClient({});
    await expect(reverseEntry(client, { entryId: 'nope' })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(reverseEntry(client, { entryId: AR, date: '2026-13-01' })).rejects.toMatchObject({ kind: 'invalid' });
    const actor = { id: null, name: 'Craig' };
    await expect(setPeriodStatus(client, { company: 'BMG', month: '2026-10', status: 'open', actor })).rejects.toMatchObject({
      kind: 'invalid',
      message: 'Reopening a month needs a reason',
    });
    await expect(setPeriodStatus(client, { company: 'BMG', month: '2026-10-01', status: 'closed', actor })).rejects.toMatchObject({ kind: 'invalid' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('send the month as its first day', async () => {
    const { client, rpc } = fakeClient({ data: { id: 'p1', period_start: '2026-10-01', status: 'closed' } });
    await expect(setPeriodStatus(client, { company: 'BMG', month: '2026-10', status: 'closed', actor: { id: null, name: 'Craig' } }))
      .resolves.toEqual({ id: 'p1', periodStart: '2026-10-01', status: 'closed' });
    expect(rpc).toHaveBeenCalledWith('gl_set_period_status', expect.objectContaining({ p_company: 'BMG', p_month: '2026-10-01', p_status: 'closed' }));
  });
});
