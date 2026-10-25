import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/anthropic', () => ({ callAnthropicWithRetry: vi.fn() }));

import { callAnthropicWithRetry } from '@/lib/anthropic';
import {
  BILL_LINES_MAX,
  BILL_READ_HEADERS,
  BILL_READ_PROMPT,
  BILL_READ_SCHEMA,
  billReadFromReply,
  billReadRequest,
  isoDay,
  parseBillRead,
  readBill,
} from './bill-reader';

const call = vi.mocked(callAnthropicWithRetry);

/** What the reader answers for the electric bill on Books Previews (made up). */
const ELECTRIC = {
  is_bill: true,
  vendor_name: '  Riverbend Electric\nCo-op ',
  bill_number: '88213-10',
  bill_date: '2026-10-20',
  due_date: '2026-11-19',
  terms: 'Net 30',
  lines: [
    { description: 'Electric service, Sep 18 to Oct 17', amount: 1284.33 },
    { description: 'Late payment charge', amount: 12.5 },
  ],
  total: 1296.83,
  amount_due: 2510.41,
};

const reply = (answer: unknown, over: Record<string, unknown> = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: JSON.stringify(answer) }],
  ...over,
});

describe("the reader's request", () => {
  it('asks the default model for the fixed JSON shape, with server-side fallbacks', () => {
    const request = billReadRequest({ base64: 'AAAA', type: 'image/jpeg' });
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: BILL_READ_SCHEMA } },
      fallbacks: 'default',
    });
    expect(request).not.toHaveProperty('thinking');
    expect(request.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: BILL_READ_PROMPT },
      ],
    }]);
    expect(BILL_READ_HEADERS).toEqual({ 'anthropic-beta': 'server-side-fallback-2026-07-01' });
  });

  it('sends a PDF as a document, and another model when asked', () => {
    const request = billReadRequest({ base64: 'JVBE', type: 'application/pdf' }, 'claude-sonnet-5-5');
    expect(request.model).toBe('claude-sonnet-5-5');
    expect(request.messages[0].content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } });
  });

  it('has a schema structured outputs takes: every field required, nothing extra', () => {
    expect(BILL_READ_SCHEMA.required).toEqual(Object.keys(BILL_READ_SCHEMA.properties));
    expect(BILL_READ_SCHEMA.additionalProperties).toBe(false);
    expect(BILL_READ_SCHEMA.properties.lines.items.required).toEqual(Object.keys(BILL_READ_SCHEMA.properties.lines.items.properties));
    expect(BILL_READ_SCHEMA.properties.lines.items.additionalProperties).toBe(false);
  });
});

describe('isoDay', () => {
  it('keeps a real calendar day, and nothing else', () => {
    expect(isoDay('2026-10-20')).toBe('2026-10-20');
    expect(isoDay('2028-02-29')).toBe('2028-02-29');
    expect(isoDay('2026-02-29')).toBeNull();
    expect(isoDay('2026-13-01')).toBeNull();
    expect(isoDay('10/20/2026')).toBeNull();
    expect(isoDay('1999-12-31')).toBeNull();
    expect(isoDay('2101-01-01')).toBeNull();
    expect(isoDay(20261020)).toBeNull();
    expect(isoDay(null)).toBeNull();
  });
});

describe('what the reader read', () => {
  it('is trimmed, in whole cents, with impossible days left out', () => {
    expect(parseBillRead(ELECTRIC)).toEqual({
      isBill: true,
      vendorName: 'Riverbend Electric Co-op',
      billNumber: '88213-10',
      billDate: '2026-10-20',
      dueDate: '2026-11-19',
      terms: 'Net 30',
      lines: [
        { description: 'Electric service, Sep 18 to Oct 17', cents: 128433 },
        { description: 'Late payment charge', cents: 1250 },
      ],
      totalCents: 129683,
      amountDueCents: 251041,
    });
  });

  it('keeps a credit as a negative line, and leaves out a line with no amount', () => {
    const read = parseBillRead({
      ...ELECTRIC,
      lines: [
        { description: 'Service', amount: 100.005 },
        { description: 'Credit for outage', amount: -15 },
        { description: 'Nothing', amount: 0 },
        { description: 'Unreadable', amount: 'twelve' },
        { amount: 3 },
        null,
      ],
    });
    expect(read.lines).toEqual([
      { description: 'Service', cents: 10001 },
      { description: 'Credit for outage', cents: -1500 },
      { description: '', cents: 300 },
    ]);
  });

  it("is empty, not guessed, where the reader couldn't read", () => {
    expect(parseBillRead({ is_bill: false, vendor_name: null, bill_number: '   ', bill_date: '2026-02-30', due_date: null, terms: null, lines: null, total: Infinity, amount_due: 'n/a' }))
      .toEqual({ isBill: false, vendorName: null, billNumber: null, billDate: null, dueDate: null, terms: null, lines: [], totalCents: null, amountDueCents: null });
    expect(parseBillRead(null)).toMatchObject({ isBill: true, lines: [], vendorName: null });
  });

  it('cuts what is too long to be what it says', () => {
    const read = parseBillRead({ ...ELECTRIC, vendor_name: 'V'.repeat(300), bill_number: '9'.repeat(100), terms: 'T'.repeat(100), lines: [{ description: 'D'.repeat(500), amount: 1 }] });
    expect(read.vendorName).toHaveLength(120);
    expect(read.billNumber).toHaveLength(60);
    expect(read.terms).toHaveLength(60);
    expect(read.lines[0].description).toHaveLength(200);
  });

  it('keeps the first lines of a statement too long for the form', () => {
    const lines = Array.from({ length: BILL_LINES_MAX + 50 }, (_, i) => ({ description: `Charge ${i + 1}`, amount: 1 }));
    const read = parseBillRead({ ...ELECTRIC, lines: [{ description: 'Nothing', amount: 0 }, ...lines] });
    expect(read.lines).toHaveLength(BILL_LINES_MAX);
    expect(read.lines.at(-1)).toEqual({ description: `Charge ${BILL_LINES_MAX}`, cents: 100 });
  });
});

describe("the reader's reply", () => {
  it('is read from its text, past any thinking', () => {
    expect(billReadFromReply(reply(ELECTRIC))).toEqual({ read: parseBillRead(ELECTRIC) });
    // An answer that came in two text blocks.
    const text = JSON.stringify(ELECTRIC);
    expect(billReadFromReply({ content: [{ type: 'text', text: text.slice(0, 40) }, { type: 'text', text: text.slice(40) }] })).toEqual({ read: parseBillRead(ELECTRIC) });
  });

  it('says why there is no answer', () => {
    expect(billReadFromReply(reply(ELECTRIC, { stop_reason: 'refusal' }))).toEqual({ error: 'The reader declined this file.' });
    expect(billReadFromReply(reply(ELECTRIC, { stop_reason: 'max_tokens' }))).toEqual({ error: 'The bill had more on it than the reader could finish.' });
    expect(billReadFromReply({ content: [{ type: 'text', text: 'Sorry, I can’t read that.' }] })).toEqual({ error: "The reader's answer couldn't be understood." });
    expect(billReadFromReply(null)).toEqual({ error: "The reader's answer couldn't be understood." });
  });
});

describe('reading a bill', () => {
  beforeEach(() => { call.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends the file with the fallback header, and gives back what was read', async () => {
    call.mockResolvedValue(new Response(JSON.stringify(reply(ELECTRIC)), { status: 200 }));
    expect(await readBill(Buffer.from('a picture'), 'image/png', 'key')).toEqual({ read: parseBillRead(ELECTRIC) });
    const [body, key, opts] = call.mock.calls[0];
    expect(key).toBe('key');
    expect(opts).toEqual({ extraHeaders: BILL_READ_HEADERS });
    expect((body as ReturnType<typeof billReadRequest>).messages[0].content[0]).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('a picture').toString('base64') },
    });
  });

  it('never throws: an error from the API or the network comes back in a sentence', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    call.mockResolvedValueOnce(new Response('{"type":"error"}', { status: 529 }));
    expect(await readBill(Buffer.from('x'), 'application/pdf', 'key')).toEqual({ error: 'The reader is unavailable right now (AI error 529).' });
    call.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await readBill(Buffer.from('x'), 'application/pdf', 'key')).toEqual({ error: "The reader couldn't be reached (fetch failed)." });
    expect(error).toHaveBeenCalledTimes(2);
  });
});
