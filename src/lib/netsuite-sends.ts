import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from './supabase-service';

/**
 * The NetSuite feed: every request FleetSuite makes that writes to NetSuite,
 * kept with what NetSuite answered (migration 477, Books → NetSuite feed,
 * docs/books.md "NetSuite feed").
 *
 * Every request to NetSuite goes through netsuiteFetch instead of fetch:
 * each one in netsuite.ts, and in the three routes that sign their own
 * (src/lib/netsuite-sends-wiring.test.ts holds that). Reads go straight
 * through. A write is kept as it starts and again once NetSuite
 * answers: it took it, refused it, or left FleetSuite unsure (no answer, a
 * timeout, a server error, an answer that can't be read), in which case
 * NetSuite may have made it anyway. A send still without an answer more
 * than NO_ANSWER_MS after it started never heard back, and counts as unsure.
 *
 * Recording never changes the send: the caller gets exactly the Response, or
 * the error, fetch gave; recording waits at most RECORD_WAIT_MS once NetSuite
 * has answered, and one that fails is only a warning in the log. Never the
 * request's body: the record type, the record addressed or made, a document
 * number or external ID to find it by, NetSuite's reason with any long run
 * of digits hidden, and who was signed in.
 */

/** A send still without NetSuite's answer more than this long after it started never heard back. */
export const NO_ANSWER_MS = 5 * 60_000;
/** The longest recording holds a send up once NetSuite has answered. */
const RECORD_WAIT_MS = 3_000;

export type SendMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type SendAction = 'create' | 'change' | 'delete' | 'transform' | 'script';
export type SendOutcome = 'took' | 'refused' | 'unsure';

const WRITE_METHODS: readonly string[] = ['POST', 'PATCH', 'PUT', 'DELETE'];

/** What a request to NetSuite writes, worked out before it goes. */
export interface Send {
  method: SendMethod;
  action: SendAction;
  /** NetSuite's name for the record ('invoice', 'salesOrder'), 'item' or 'script' for the item script, or 'other'. */
  recordType: string;
  /** The record changed, deleted or made from. */
  recordId: string | null;
  /** What it makes. */
  madeType: string | null;
  /** A document number, external ID or name it sends, to find it by in NetSuite. */
  docRef: string | null;
  /** Sent to a script in NetSuite (a RESTlet: the item script, or the PDF script's attach_pdf), whose answer says in its body whether it did it. */
  script: boolean;
}

/** What NetSuite's answer says happened. */
export interface Answer {
  outcome: SendOutcome;
  httpStatus: number | null;
  /** The record NetSuite says it made. */
  madeId: string | null;
  /** A document number NetSuite answered with. */
  docRef: string | null;
  error: string | null;
}

/** A row of netsuite_sends as FleetSuite writes it: the start, then the whole row with the answer. */
export interface SendRow {
  id: string;
  started_at: string;
  method: SendMethod;
  action: SendAction;
  record_type: string;
  record_id: string | null;
  made_type: string | null;
  doc_ref: string | null;
  user_id: string | null;
  finished_at?: string;
  outcome?: SendOutcome;
  http_status?: number | null;
  made_id?: string | null;
  error?: string | null;
}

// ── What a request is ──────────────────────────────────────────────────────

const RECORD_PATH = /^\/services\/rest\/record\/v1\/([A-Za-z][A-Za-z0-9_]*)(?:\/([^/]+))?(?:\/!transform\/([A-Za-z][A-Za-z0-9_]*))?\/?$/;
/** Fields of a record a person can find it by in NetSuite, the first one sent naming it. */
const REF_FIELDS = ['externalId', 'tranId', 'entityId', 'itemId', 'companyName'] as const;

/** A request body's fields, when it's a JSON object. */
function fieldsOf(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'string' || body.length > 1_000_000) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const idOf = (v: unknown): string | null => {
  const id = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return id && id.length <= 60 ? id : null;
};
const refOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 120) || null : null);
const digitsOf = (v: unknown): string | null => {
  const id = idOf(v);
  return id && /^\d{1,20}$/.test(id) ? id : null;
};

/**
 * What a request to NetSuite writes, or null for one that only reads: any GET, a SuiteQL query (a POST that only
 * reads) and the item script's ping.
 */
export function sendOf(url: string, method: string | undefined, body: unknown): Send | null {
  const verb = (method ?? 'GET').toUpperCase();
  if (!WRITE_METHODS.includes(verb)) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (path.startsWith('/services/rest/query/')) return null;
  const fields = fieldsOf(body);
  const base = { method: verb as SendMethod, recordId: null, madeType: null, docRef: null, script: false };

  if (path.endsWith('/restlet.nl')) {
    if (fields?.action === 'ping') return null;
    const script = { ...base, script: true };
    if (fields?.action === 'createDropShipPo') {
      return { ...script, action: 'transform', recordType: 'salesOrder', recordId: idOf(fields.salesOrderId), madeType: 'purchaseOrder' };
    }
    // FleetSuite's own PDF of an invoice, attached to it by the PDF script (Books part 68): found by the file's name.
    if (fields?.action === 'attach_pdf') {
      return { ...script, action: 'change', recordType: 'invoice', recordId: digitsOf(fields.invoiceId), docRef: refOf(fields.fileName) };
    }
    if (fields && 'itemId' in fields) {
      return { ...script, action: 'change', recordType: 'item', recordId: idOf(fields.itemId), docRef: refOf(fields.itemNumber) };
    }
    return { ...script, action: 'script', recordType: 'script' };
  }

  const docRef = REF_FIELDS.map((k) => refOf(fields?.[k])).find(Boolean) ?? null;
  const record = RECORD_PATH.exec(path);
  if (!record) return { ...base, action: verb === 'DELETE' ? 'delete' : verb === 'POST' ? 'create' : 'change', recordType: 'other', docRef };
  const [, type, rawId, target] = record;
  let id: string | null = null;
  try {
    id = rawId ? idOf(decodeURIComponent(rawId)) : null;
  } catch {
    id = idOf(rawId);
  }
  if (target) return { ...base, action: 'transform', recordType: type, recordId: id, madeType: target, docRef };
  if (verb === 'DELETE') return { ...base, action: 'delete', recordType: type, recordId: id, docRef };
  if (id || verb !== 'POST') return { ...base, action: 'change', recordType: type, recordId: id, docRef };
  return { ...base, action: 'create', recordType: type, madeType: type, docRef };
}

// ── What NetSuite answered ─────────────────────────────────────────────────

/**
 * Text kept from NetSuite or about it, on one line, at most 600 characters, with any run of nine or more digits
 * (spaces or dashes between them allowed) hidden: a tax ID, bank or card number in an error never reaches the feed.
 * A date or an internal ID is shorter and stays.
 */
export function scrub(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/(?:\d[ -]?){8,}\d/g, '•••').trim().slice(0, 600);
}

function jsonOf(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const firstText = (...values: unknown[]): string | undefined =>
  values.find((v): v is string => typeof v === 'string' && v.trim() !== '');

/** NetSuite's reason in an answer: its error detail or title, the script's error, or the text itself without markup. */
export function reasonOf(text: string | null): string {
  if (!text) return '';
  const said = jsonOf(text);
  const why = firstText(said?.['o:errorDetails']?.[0]?.detail, said?.error?.message, said?.error, said?.title, said?.message);
  return scrub(why ?? text.replace(/<[^>]*>/g, ' '));
}

/** What NetSuite's answer says happened: `location` is its Location header, `text` its body when it was read. */
export function answerOf(send: Send, status: number, location: string | null, text: string | null): Answer {
  const httpStatus = status >= 100 && status <= 599 ? status : null;
  const none = { httpStatus, madeId: null, docRef: null };
  if (status >= 200 && status < 300) {
    if (!send.script) {
      const made = send.action === 'create' || send.action === 'transform'
        ? location?.match(/\/record\/v1\/[A-Za-z][A-Za-z0-9_]*\/(\d{1,20})\/?$/)?.[1] ?? null
        : null;
      return { ...none, outcome: 'took', madeId: made, error: null };
    }
    // The item script answers 200 whether it did it or not; its body's success says which, and it always says.
    const said = jsonOf(text);
    if (!said || typeof said.success !== 'boolean') {
      return { ...none, outcome: 'unsure', error: "NetSuite answered, but not in a way FleetSuite could read, so it can't tell whether it was done." };
    }
    if (!said.success) {
      return { ...none, outcome: 'refused', error: scrub(firstText(said.error, said.error?.message) ?? '') || "The item script said it didn't do it." };
    }
    return { ...none, outcome: 'took', madeId: digitsOf(said.purchaseOrderId), docRef: refOf(said.tranId), error: null };
  }
  const why = reasonOf(text);
  if (status >= 400 && status < 500) return { ...none, outcome: 'refused', error: why || `NetSuite refused it (${status}).` };
  return { ...none, outcome: 'unsure', error: why || `NetSuite answered ${status}, which doesn't say whether it was done.` };
}

/** What a send that fetch threw for leaves FleetSuite knowing: not whether NetSuite did it. */
export function thrownAnswer(err: unknown): Answer {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.cause?.code === 'string' ? ` (${e.cause.code})` : '';
  const error = e?.name === 'TimeoutError'
    ? "NetSuite didn't answer in time."
    : e?.name === 'AbortError'
      ? 'FleetSuite stopped waiting before NetSuite answered.'
      : `FleetSuite lost touch with NetSuite before it answered: ${typeof e?.message === 'string' && e.message ? e.message : String(err)}${code}`;
  return { outcome: 'unsure', httpStatus: null, madeId: null, docRef: null, error: scrub(error) };
}

// ── Who sent it ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The person a Supabase access token names (its sub), when it's an ID. Only read here: the route's sign-in guard
 * checked the same token before anything was sent. A shared secret (a scheduled job's) isn't a token and names nobody.
 */
export function tokenUser(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const sub = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.sub;
    return typeof sub === 'string' && UUID_RE.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Loaded on the first send rather than imported above: a few phone pages load the NetSuite client, and Next won't
// build a page whose code imports next/headers (src/lib/client-graph.test.ts).
let requestTools: Promise<[typeof import('next/headers'), typeof import('./api-auth')]> | null = null;
const loadRequestTools = () => (requestTools ??= Promise.all([import('next/headers'), import('./api-auth')]).catch((err) => {
  requestTools = null;
  throw err;
}));

/** Who was signed in for the request that's sending, or null for a scheduled job, a script, or outside a request. */
export async function whoSent(): Promise<string | null> {
  try {
    const [{ cookies, headers }, { getAccessToken }] = await loadRequestTools();
    const token = getAccessToken({ headers: headers(), cookies: cookies() });
    return token ? tokenUser(token) : null;
  } catch {
    return null;
  }
}

// ── Where it's kept ────────────────────────────────────────────────────────

/** Where sends are kept. */
export interface SendWriter {
  /** The row as the send starts. */
  start(row: SendRow): Promise<unknown>;
  /** The whole row with NetSuite's answer; it makes the row if the start never landed, and a late start then can't. */
  finish(row: SendRow): Promise<unknown>;
}

let service: SupabaseClient | null = null;
const sends = () => (service ??= createServiceClient()).from('netsuite_sends');
async function written(op: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await op;
  if (error) throw new Error(error.message);
}

const tableWriter: SendWriter = {
  start: (row) => written(sends().insert(row)),
  finish: (row) => written(sends().upsert(row, { onConflict: 'id' })),
};

let chosenWriter: SendWriter | null | undefined;

/** For tests: keep sends with this writer, or none with null; undefined goes back to netsuite_sends. */
export function setSendWriter(writer: SendWriter | null | undefined): void {
  chosenWriter = writer;
}

function currentWriter(): SendWriter | null {
  if (chosenWriter !== undefined) return chosenWriter;
  // Nothing is kept under the test runner unless a test asks: the tests that mock fetch see only NetSuite's requests.
  return process.env.VITEST ? null : tableWriter;
}

/** A write to the feed, which failing is a warning in the log, never the send's problem. */
async function quietly(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.warn("[netsuite-sends] couldn't keep a send:", (err as Error)?.message || err);
  }
}

/** Waits for `work` at most `ms`, and never throws. */
async function within(work: Promise<unknown>, ms = RECORD_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  clearTimeout(timer);
}

const finished = (row: SendRow, answer: Answer): SendRow => ({
  ...row,
  finished_at: new Date().toISOString(),
  outcome: answer.outcome,
  http_status: answer.httpStatus,
  made_id: answer.madeId,
  doc_ref: row.doc_ref ?? answer.docRef,
  error: answer.error,
});

async function textOf(response: Response): Promise<string | null> {
  try {
    return typeof response.clone === 'function' ? (await response.clone().text()).slice(0, 20_000) : null;
  } catch {
    return null;
  }
}

function headerOf(response: Response, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * fetch, for every request FleetSuite makes to NetSuite. A read goes straight through. A write is kept in the feed
 * as it starts and again with NetSuite's answer, and the caller still gets exactly the Response, or the error, fetch
 * gave: an error body stays readable, and recording waits at most RECORD_WAIT_MS once NetSuite has answered.
 */
export async function netsuiteFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const writer = currentWriter();
  const send = writer ? sendOf(String(input), init?.method, init?.body) : null;
  if (!writer || !send) return globalThis.fetch(input, init);

  const userId = await whoSent();
  const row: SendRow = {
    id: randomUUID(),
    started_at: new Date().toISOString(),
    method: send.method,
    action: send.action,
    record_type: send.recordType.slice(0, 60),
    record_id: send.recordId,
    made_type: send.madeType?.slice(0, 60) ?? null,
    doc_ref: send.docRef,
    user_id: userId,
  };
  // Kept while the send is on its way, so it costs the send nothing.
  void quietly(() => writer.start(row));
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
  } catch (err) {
    await within(quietly(() => writer.finish(finished(row, thrownAnswer(err)))));
    throw err;
  }
  await within((async () => {
    // The body only when the answer is in it: an error's reason, or whether the item script did it.
    const text = send.script || !response.ok ? await textOf(response) : null;
    await quietly(() => writer.finish(finished(row, answerOf(send, response.status, headerOf(response, 'location'), text))));
  })());
  return response;
}

// ── How the feed shows a send ──────────────────────────────────────────────

const NAMES: Record<string, string> = {
  salesOrder: 'sales order', invoice: 'invoice', estimate: 'estimate', purchaseOrder: 'purchase order',
  vendorBill: 'bill', vendorCredit: 'vendor credit', creditMemo: 'credit memo', itemFulfillment: 'fulfillment',
  itemReceipt: 'item receipt', inventoryAdjustment: 'inventory adjustment', inventoryTransfer: 'inventory transfer',
  journalEntry: 'journal entry', customer: 'customer', vendor: 'vendor', contact: 'contact', note: 'note',
  item: 'item', script: 'item script', deposit: 'bank deposit', vendorPayment: 'bill payment',
};

/** A record type in plain words: 'salesOrder' is 'sales order', and any kind of item is 'item'. */
export function recordName(type: string): string {
  if (NAMES[type]) return NAMES[type];
  if (/Item$/.test(type)) return 'item';
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

const a = (name: string) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Whether a send was the PDF script's attach_pdf (Books part 68), by what sendOf keeps of it: a change to an invoice
 * found by a PDF file's name. FleetSuite sends those again itself, and Invoice PDFs tells about the ones that don't take.
 */
export function isInvoicePdfSend(s: { action: SendAction; record_type: string; doc_ref?: string | null }): boolean {
  return s.action === 'change' && s.record_type === 'invoice' && /\.pdf$/i.test(s.doc_ref ?? '');
}

/** What a send asked NetSuite for, in a few words: 'New invoice', 'Change to a sales order', 'Invoice from a sales order'. */
export function describeSend(s: { action: SendAction; record_type: string; made_type: string | null; doc_ref?: string | null }): string {
  if (s.action === 'script') return 'Request to the item script';
  if (isInvoicePdfSend(s)) return 'PDF for an invoice';
  if (s.record_type === 'other') return s.action === 'create' ? 'New record in NetSuite' : s.action === 'delete' ? 'Deletion in NetSuite' : 'Change in NetSuite';
  const name = recordName(s.record_type);
  if (s.action === 'create') return `New ${recordName(s.made_type ?? s.record_type)}`;
  if (s.action === 'transform') return `${capital(recordName(s.made_type ?? s.record_type))} from ${a(name)}`;
  return s.action === 'delete' ? `Deletion of ${a(name)}` : `Change to ${a(name)}`;
}

/** NetSuite's own page names for the transactions FleetSuite sends. */
const TRANSACTION_PAGES: Record<string, string> = {
  salesOrder: 'salesord', invoice: 'custinvc', estimate: 'estimate', purchaseOrder: 'purchord', vendorBill: 'vendbill',
  vendorCredit: 'vendcred', creditMemo: 'custcred', itemFulfillment: 'itemship', itemReceipt: 'itemrcpt',
  inventoryAdjustment: 'invadjst', inventoryTransfer: 'invtrnfr', journalEntry: 'journal', customerPayment: 'custpymt',
  customerDeposit: 'custdep', deposit: 'deposit', vendorPayment: 'vendpymt',
};
const ENTITY_PAGES: Record<string, string> = { customer: 'custjob', vendor: 'vendor', contact: 'contact' };

/** NetSuite's page for a record by its internal ID, or null when FleetSuite can't link to it. */
export function recordUrl(type: string | null, id: string | null): string | null {
  const account = process.env.NETSUITE_ACCOUNT_ID;
  if (!account || !type || !id || !/^\d{1,20}$/.test(id)) return null;
  const host = `https://${account.replace(/-/g, '_').toUpperCase()}.app.netsuite.com`;
  if (TRANSACTION_PAGES[type]) return `${host}/app/accounting/transactions/${TRANSACTION_PAGES[type]}.nl?id=${id}`;
  if (ENTITY_PAGES[type]) return `${host}/app/common/entity/${ENTITY_PAGES[type]}.nl?id=${id}`;
  if (type === 'item' || /Item$/.test(type)) return `${host}/app/common/item/item.nl?id=${id}`;
  return null;
}
