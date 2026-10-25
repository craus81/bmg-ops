import { callAnthropicWithRetry } from '@/lib/anthropic';
import { toCents } from './own-bills';

/**
 * Snap a bill's reader (migration 436; owner decision 2026-10-25, thread
 * "Replacing NetSuite with FleetSuite", "Snap a bill"; docs/books.md "Snap a
 * bill").
 *
 * A picture of a vendor's bill, or its PDF, goes to Claude, which answers in
 * a fixed JSON shape (structured outputs): who sent it, its number, date, due
 * date and terms as printed, each charge on it, what its own charges come to,
 * and what it says is due now. Anything it can't read comes back empty rather
 * than guessed. Nothing here decides anything: the super admin checks each box
 * before Send to NetSuite (src/lib/books/snap-a-bill.ts).
 */

// Overridable so another model can be tried without a deploy.
export const BILL_READER_MODEL = process.env.BILL_READER_MODEL || 'claude-opus-5-5';

/** What the reader takes: pictures as the phone's camera shrinks them, and PDFs. */
export const BILL_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type BillFileType = typeof BILL_FILE_TYPES[number];

/** The most lines a snapped bill has: what the reader keeps, and what the page can send (the route's form). */
export const BILL_LINES_MAX = 200;

/** One charge on the bill: what it's for, and its amount in whole cents (a credit on the bill is negative). */
export interface BillReadLine {
  description: string;
  cents: number;
}

/** What the reader read. Null where it couldn't read something. */
export interface BillRead {
  /** False when the file isn't a vendor's bill at all. */
  isBill: boolean;
  vendorName: string | null;
  billNumber: string | null;
  /** 'YYYY-MM-DD'. */
  billDate: string | null;
  /** 'YYYY-MM-DD', as printed on the bill. */
  dueDate: string | null;
  /** The terms as printed, such as "Net 30". */
  terms: string | null;
  lines: BillReadLine[];
  /** What the bill's own charges come to, in whole cents. */
  totalCents: number | null;
  /** What the bill says is due now, in whole cents, which can carry an earlier balance. */
  amountDueCents: number | null;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** The JSON shape the reader answers in. */
export const BILL_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_bill', 'vendor_name', 'bill_number', 'bill_date', 'due_date', 'terms', 'lines', 'total', 'amount_due'],
  properties: {
    is_bill: { type: 'boolean' },
    vendor_name: nullable({ type: 'string' }),
    bill_number: nullable({ type: 'string' }),
    bill_date: nullable({ type: 'string', format: 'date' }),
    due_date: nullable({ type: 'string', format: 'date' }),
    terms: nullable({ type: 'string' }),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount'],
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
        },
      },
    },
    total: nullable({ type: 'number' }),
    amount_due: nullable({ type: 'number' }),
  },
} as const;

export const BILL_READ_PROMPT = `This is a picture or PDF of a bill a vendor sent to the business (an invoice, a statement for a utility or a service, or a receipt). Read it so it can be entered as a bill in the accounts.

- is_bill: false when it isn't a vendor's bill at all, such as a quote, a packing slip or a photo of something else.
- vendor_name: who sent the bill and is owed the money, as the bill names them. Not the customer the bill is addressed to.
- bill_number: the vendor's invoice or bill number. Not an account number, a customer number or an order number. Null when it has none.
- bill_date: the date of the bill or invoice (a statement's date for a utility), as YYYY-MM-DD.
- due_date: the date the bill is due, when it's printed, as YYYY-MM-DD.
- terms: the payment terms as printed, such as "Net 30". Null when none are printed.
- lines: each charge on this bill, in the bill's order: what it's for, in a few words as the bill says it (with the service period when the bill gives one), and its amount in dollars. Taxes, fees, freight and late charges are lines of their own. A discount or credit on this bill is a line with a negative amount. Leave out any earlier balance, payments already made, and anything carried over from an earlier bill.
- total: what this bill's own charges come to, as the bill totals them.
- amount_due: the amount the bill says is due now, which can include an earlier balance. Null when it doesn't say.

Use null for anything you can't read clearly. Don't guess.`;

/** The Messages API request that reads one file. */
export function billReadRequest(file: { base64: string; type: BillFileType }, model: string = BILL_READER_MODEL) {
  const source = { type: 'base64', media_type: file.type, data: file.base64 };
  return {
    model,
    max_tokens: 16_000,
    // The default model always thinks, at medium effort unless told; set here so a change of model doesn't change it.
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: BILL_READ_SCHEMA } },
    // A request the model declines is run again on the model Anthropic recommends for it.
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        file.type === 'application/pdf' ? { type: 'document', source } : { type: 'image', source },
        { type: 'text', text: BILL_READ_PROMPT },
      ],
    }],
  };
}

/** The beta header the request's fallbacks need. */
export const BILL_READ_HEADERS = { 'anthropic-beta': 'server-side-fallback-2026-07-01' };

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** A real calendar day as 'YYYY-MM-DD', or null. */
export function isoDay(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d && y >= 2000 && y <= 2100 ? v : null;
}

const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9 ? toCents(v) : null);

/** What the reader answered, as FleetSuite keeps it: trimmed, amounts in whole cents, impossible days left out. Pure. */
export function parseBillRead(raw: unknown): BillRead {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines: BillReadLine[] = [];
  for (const l of Array.isArray(r.lines) ? r.lines : []) {
    // A longer statement keeps its first lines, and comes up short of its total.
    if (lines.length === BILL_LINES_MAX) break;
    const line = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const c = cents(line.amount);
    if (c === null || c === 0) continue;
    lines.push({ description: text(line.description, 200) ?? '', cents: c });
  }
  return {
    isBill: r.is_bill !== false,
    vendorName: text(r.vendor_name, 120),
    billNumber: text(r.bill_number, 60),
    billDate: isoDay(r.bill_date),
    dueDate: isoDay(r.due_date),
    terms: text(r.terms, 60),
    lines,
    totalCents: cents(r.total),
    amountDueCents: cents(r.amount_due),
  };
}

/** The reader's answer from the Messages API's reply, or why there's none. Pure. */
export function billReadFromReply(reply: unknown): { read: BillRead } | { error: string } {
  const data = (reply && typeof reply === 'object' ? reply : {}) as { stop_reason?: string; content?: unknown };
  if (data.stop_reason === 'refusal') return { error: 'The reader declined this file.' };
  if (data.stop_reason === 'max_tokens') return { error: 'The bill had more on it than the reader could finish.' };
  const blocks = Array.isArray(data.content) ? data.content as Array<{ type?: string; text?: string }> : [];
  const answer = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  try {
    return { read: parseBillRead(JSON.parse(answer)) };
  } catch {
    return { error: "The reader's answer couldn't be understood." };
  }
}

/** Reads one bill. Never throws: what went wrong comes back as error, in a sentence. */
export async function readBill(bytes: Buffer, type: BillFileType, apiKey: string): Promise<{ read: BillRead } | { error: string }> {
  try {
    const res = await callAnthropicWithRetry(billReadRequest({ base64: bytes.toString('base64'), type }), apiKey, { extraHeaders: BILL_READ_HEADERS });
    if (!res.ok) {
      console.error('[books] snap a bill: reader error', res.status, (await res.text()).slice(0, 500));
      return { error: `The reader is unavailable right now (AI error ${res.status}).` };
    }
    return billReadFromReply(await res.json());
  } catch (err) {
    console.error('[books] snap a bill: reader failed', err);
    return { error: `The reader couldn't be reached (${String((err as Error)?.message || err).slice(0, 200)}).` };
  }
}
