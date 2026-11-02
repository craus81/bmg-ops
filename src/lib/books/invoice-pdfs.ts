import type { SupabaseClient } from '@supabase/supabase-js';
import { attachPdfToInvoice, type AttachPdfAnswer } from '@/lib/netsuite';
import { readCustomerRecords, type AddressLines } from '@/lib/fleetsuite-records';
import { readLetterhead } from '@/lib/statement-pdf-server';
import { pingRestlet } from '@/lib/restlet-probe';
import { PDF_RESTLET_MINIMUMS, versionAtLeast } from '@/lib/restlet-versions';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { checkOwnInvoices, type OwnCheckStatus, type OwnInvoiceCheck, type OwnPairsData } from './own-invoice-check';
import { buildOwnInvoicePdf, invoicePdfFilename, netsuitePdfFilename, ownInvoicePdfData, type InvoicePdfData } from './own-invoice-pdf';
import type { HeldFor, InvoicePdfView, PdfRow, PdfState } from './invoice-pdf-status';

/**
 * FleetSuite's own PDF of each invoice it makes, and attaching it to NetSuite's
 * invoice (Books part 68, migration 498, docs/books.md "Invoice PDFs").
 *
 * Books opens the PDF of any of FleetSuite's own invoices, drawn from its copy
 * (src/lib/books/own-invoice-pdf.ts). Once Invoice PDFs is switched on, the
 * two-hourly run (/api/cron/books-invoice-pdfs) looks at each copy made since
 * and, once it matches NetSuite's invoice, attaches its PDF there through the
 * PDF script in NetSuite (attachPdfToInvoice, scripts/netsuite-pdf-restlet.js).
 * One that can't go yet is held back saying why: the copy differs from
 * NetSuite's invoice, is incomplete, NetSuite voided the invoice, or the copy
 * of NetSuite's invoice isn't there yet. Each version of a copy (Fix an
 * invoice makes the next) is its own file, and the one before comes off the
 * invoice once the next is on. A super admin can send one again from the
 * invoice's page. The daily check tells the super admins about each one
 * NetSuite refused, or FleetSuite is still unsure about after three tries,
 * and about a run that couldn't send at all.
 *
 * While it's off, nothing goes to NetSuite.
 */

export const BOOKS_INVOICE_PDFS = 'books_invoice_pdfs';

/**
 * The biggest PDF FleetSuite sends. Its base64 stays under the million characters the NetSuite feed reads a send's
 * body to (src/lib/netsuite-sends.ts), and far under the 10 MB NetSuite takes in a request. A page of lines is a few
 * kilobytes; only an outsized logo comes near it.
 */
export const MAX_PDF_BYTES = 700 * 1024;
/** The most copies one run looks at; the rest wait for the next. */
const RUN_LIMIT = 25;

type Letterhead = InvoicePdfData['letterhead'];

/** What holds a copy's PDF back, by what the check says of it. */
export const HOLD_FOR: Readonly<Record<Exclude<OwnCheckStatus, 'matches'>, HeldFor>> = {
  differs: 'differs',
  incomplete: 'incomplete',
  voided: 'voided',
  waiting: 'waiting',
};

const kb = (bytes: number) => `${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB`;

/** Why a PDF is too big to send, for the invoice's page and the daily check. */
export const tooBig = (bytes: number) =>
  `FleetSuite's PDF of this invoice is ${kb(bytes)}, more than the ${kb(MAX_PDF_BYTES)} it sends. `
  + 'A smaller logo in Settings → Company makes it smaller.';

/** A copy's version and when it was made, read before the copy so the version can't be newer than the PDF. */
async function readVersion(service: SupabaseClient, netsuiteId: string): Promise<{ version: number; madeAt: string } | null> {
  const { data, error } = await service.from('gl_own_invoices').select('version, made_at').eq('netsuite_id', netsuiteId).maybeSingle();
  if (error) throw new Error(`Couldn't read FleetSuite's copy of the invoice: ${error.message}`);
  const row = data as { version?: number | null; made_at?: string | null } | null;
  if (!row) return null;
  return { version: Number(row.version ?? 1), madeAt: String(row.made_at ?? '') };
}

/** One of FleetSuite's own invoices, checked against NetSuite's, as the Own invoices page reads it. */
async function readChecked(service: SupabaseClient, netsuiteId: string): Promise<{ pairs: OwnPairsData; check: OwnInvoiceCheck } | null> {
  const res = await service.rpc('gl_own_invoice_pairs', { p_from: null, p_to: null, p_netsuite_id: netsuiteId });
  if (res.error) throw new Error(`Couldn't read FleetSuite's copy of the invoice: ${res.error.message}`);
  const pairs = res.data as OwnPairsData;
  const [check] = checkOwnInvoices(pairs).invoices;
  return check ? { pairs, check } : null;
}

const isAddress = (v: unknown): v is AddressLines => !!v && typeof v === 'object' && 'addr1' in (v as object);

/** The page's facts: who it's billed to from FleetSuite's record of the customer, NetSuite's name where it has none. */
async function pdfData(service: SupabaseClient, pairs: OwnPairsData, check: OwnInvoiceCheck, letterhead: Letterhead): Promise<InvoicePdfData> {
  const pair = pairs.invoices[0];
  const customerId = pair.own.customer_netsuite_id;
  const facts = customerId ? (await readCustomerRecords(service, [customerId])).get(customerId) : undefined;
  const name = typeof facts?.name === 'string' && facts.name.trim() ? facts.name.trim() : check.customer;
  return ownInvoicePdfData(pair.own, {
    customer: name,
    address: isAddress(facts?.address) ? facts!.address as AddressLines : null,
    voided: check.status === 'voided',
    letterhead,
  });
}

export type OwnInvoicePdf =
  | { ok: true; bytes: Buffer; filename: string; number: string; status: OwnCheckStatus }
  | { ok: false; status: 404; error: string };

/** FleetSuite's own PDF of one of its own invoices, as Books opens it. A read that fails throws. */
export async function loadOwnInvoicePdf(service: SupabaseClient, netsuiteId: string, letterhead?: Letterhead): Promise<OwnInvoicePdf> {
  const read = await readChecked(service, netsuiteId);
  if (!read) return { ok: false, status: 404, error: 'FleetSuite has no copy of that invoice' };
  const data = await pdfData(service, read.pairs, read.check, letterhead === undefined ? await readLetterhead(service) : letterhead);
  return {
    ok: true,
    bytes: Buffer.from(buildOwnInvoicePdf(data).output('arraybuffer')),
    filename: invoicePdfFilename(data.number),
    number: data.number,
    status: read.check.status,
  };
}

/** What became of one copy's PDF. */
export type SendOutcome =
  | ({ done: 'sent' } & AttachPdfAnswer)
  | { done: 'held'; heldFor: HeldFor }
  | { done: 'skipped'; why: 'off' | 'missing' | 'changed' | 'attached' | 'sending' | 'tries' };

interface Claim { claimed: boolean; why?: Extract<SendOutcome, { done: 'skipped' }>['why']; replace_file_id?: string | null; tries?: number }

/** Why the letterhead isn't fit to go on a PDF NetSuite keeps, or null: the company's name couldn't be read. */
export function letterheadProblem(letterhead: Letterhead): string | null {
  return letterhead?.company?.name?.trim()
    ? null
    : "FleetSuite couldn't read the company's name for the PDF's letterhead (Settings → Company), so it sent nothing.";
}

/**
 * Sends one copy's PDF to NetSuite's invoice, or holds it back saying why. Only while Invoice PDFs is on, only the
 * copy's current version, one at a time (own_invoice_pdf_claim), and after three tries only when `again` (a super admin
 * on the invoice's page). `by` is who sent it; null for the two-hourly run. A read or write of FleetSuite's own that
 * fails throws, as does a letterhead without the company's name; NetSuite's answer, whatever it is, is kept.
 */
export async function sendInvoicePdf(
  service: SupabaseClient,
  opts: { netsuiteId: string; by: string | null; again: boolean; letterhead?: Letterhead },
): Promise<SendOutcome> {
  const { netsuiteId } = opts;
  if (!(await readInvoicePdfsSwitch(service)).on) return { done: 'skipped', why: 'off' };
  const current = await readVersion(service, netsuiteId);
  if (!current) return { done: 'skipped', why: 'missing' };
  const read = await readChecked(service, netsuiteId);
  if (!read) return { done: 'skipped', why: 'missing' };
  const { check } = read;

  if (check.status !== 'matches') {
    const heldFor = HOLD_FOR[check.status];
    const { error } = await service.rpc('own_invoice_pdf_hold', { p_invoice: netsuiteId, p_version: current.version, p_for: heldFor });
    if (error) throw new Error(`Couldn't hold back the PDF: ${error.message}`);
    return { done: 'held', heldFor };
  }

  const data = await pdfData(service, read.pairs, check, opts.letterhead === undefined ? await readLetterhead(service) : opts.letterhead);
  const unfit = letterheadProblem(data.letterhead);
  if (unfit) throw new Error(unfit);
  const bytes = Buffer.from(buildOwnInvoicePdf(data).output('arraybuffer'));
  const fileName = netsuitePdfFilename(data.number, netsuiteId, current.version);
  const claimed = await service.rpc('own_invoice_pdf_claim', {
    p_invoice: netsuiteId, p_version: current.version, p_file_name: fileName, p_by: opts.by, p_again: opts.again,
  });
  if (claimed.error) throw new Error(`Couldn't put the PDF on its way: ${claimed.error.message}`);
  const claim = claimed.data as Claim;
  if (!claim?.claimed) return { done: 'skipped', why: claim?.why ?? 'sending' };

  // Too big is the same every time, but it's kept as a try like any refusal, so the daily check tells once it's tried three times.
  const answer: AttachPdfAnswer = bytes.length > MAX_PDF_BYTES
    ? { outcome: 'refused', error: tooBig(bytes.length) }
    : await attachPdfToInvoice({
      invoiceId: netsuiteId, fileName, pdfBase64: bytes.toString('base64'), replaceFileId: claim.replace_file_id ?? null,
    });
  const settled = await service.rpc('own_invoice_pdf_settle', {
    p_invoice: netsuiteId,
    p_version: current.version,
    p_state: answer.outcome,
    p_file_id: answer.outcome === 'attached' ? answer.fileId : null,
    p_replaced: answer.outcome === 'attached' ? answer.replaced : null,
    p_error: answer.outcome === 'attached' ? null : answer.error,
  });
  // Left on its way, it's taken back 15 minutes on and sent again; the script finds the file it kept by its name.
  if (settled.error) throw new Error(`NetSuite answered, but FleetSuite couldn't keep its answer: ${settled.error.message}`);
  return { done: 'sent', ...answer };
}

// ── The two-hourly run ─────────────────────────────────────────────────────

/** Invoice PDFs' switch, and since when it's been on. A read that fails throws. */
export async function readInvoicePdfsSwitch(service: SupabaseClient): Promise<{ on: boolean; changedAt: string | null }> {
  const { data, error } = await service.from('books_switches').select('is_on, changed_at').eq('piece', 'invoice_pdfs').maybeSingle();
  if (error) throw new Error(`Couldn't read the switch: ${error.message}`);
  const row = data as { is_on?: boolean | null; changed_at?: string | null } | null;
  return { on: row?.is_on === true, changedAt: row?.changed_at ?? null };
}

/** What the invoice's page says about its PDF in NetSuite: the switch, and the copy's version and PDFs. A read that fails throws. */
export async function readInvoicePdfView(service: SupabaseClient, netsuiteId: string): Promise<InvoicePdfView> {
  const [state, read] = await Promise.all([
    readInvoicePdfsSwitch(service),
    service.rpc('own_invoice_pdf_state', { p_invoice: netsuiteId }),
  ]);
  if (read.error) throw new Error(`Couldn't read the invoice's PDF: ${read.error.message}`);
  const got = read.data as { version?: unknown; made_at?: unknown; pdfs?: PdfRow[] | null } | null;
  return {
    on: state.on,
    // A switch with no time it went on has nothing since, as the two-hourly run takes it.
    since: state.on ? state.changedAt : null,
    state: got ? {
      version: Number(got.version ?? 1),
      made_at: String(got.made_at ?? ''),
      pdfs: (got.pdfs ?? []).map((p) => ({ ...p, version: Number(p.version), tries: Number(p.tries ?? 0) })),
    } : null,
  };
}

/**
 * Why the PDF script in NetSuite can't attach PDFs, or null when it can: its address set, it answers, and it's
 * 2026-11-01.1 or newer.
 */
export async function scriptBlocked(): Promise<string | null> {
  const url = (process.env.NETSUITE_PDF_RESTLET_URL || '').trim();
  if (!url) return "The PDF script's address isn't set (NETSUITE_PDF_RESTLET_URL).";
  const probe = await pingRestlet('pdf', url);
  if (!probe.reachable) {
    const why = (probe.error || 'no answer').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
    return `The PDF script in NetSuite didn't answer: ${why.length > 160 ? `${why.slice(0, 159).trimEnd()}…` : `${why}.`}`;
  }
  if (!versionAtLeast(probe.version, PDF_RESTLET_MINIMUMS.attachPdf)) {
    return `The PDF script in NetSuite is ${probe.version ? `the copy from ${probe.version}` : 'a copy from before 2026-09-10'}, `
      + `which can't attach PDFs. Upload the newest scripts/netsuite-pdf-restlet.js over it and save its script record.`;
  }
  return null;
}

export interface InvoicePdfsRun {
  /** Switched off: nothing was looked at. */
  skipped?: 'off';
  /** Why nothing could be sent: the PDF script can't take them, or the letterhead couldn't be read. */
  blocked?: string;
  looked: number;
  attached: number;
  refused: number;
  unsure: number;
  held: number;
  /** Copies the run had but left for the next, its time up. */
  left: number;
  /** It had as many as one run looks at: there may be more. */
  more?: true;
  error?: string;
  heartbeat?: HeartbeatResult;
}

/**
 * The two-hourly run: while Invoice PDFs is on, the PDF of each copy made since it went on, the ones never looked at
 * first, until `deadline`. Recorded in sync_state as 'books_invoice_pdfs', counts only.
 */
export async function runInvoicePdfs(service: SupabaseClient, opts: { deadline: number }): Promise<InvoicePdfsRun> {
  const startedAt = Date.now();
  const result: InvoicePdfsRun = { looked: 0, attached: 0, refused: 0, unsure: 0, held: 0, left: 0 };
  const errors: string[] = [];
  try {
    const state = await readInvoicePdfsSwitch(service);
    if (!state.on) {
      result.skipped = 'off';
    } else {
      const blocked = await scriptBlocked();
      if (blocked) {
        result.blocked = blocked;
      } else {
        // A switch with no time it went on has nothing since.
        const since = state.changedAt && !Number.isNaN(Date.parse(state.changedAt)) ? state.changedAt : new Date().toISOString();
        const due = await service.rpc('own_invoice_pdfs_due', { p_since: since, p_limit: RUN_LIMIT });
        if (due.error) throw new Error(`Couldn't read which PDFs to send: ${due.error.message}`);
        const copies = (due.data ?? []) as Array<{ netsuite_id: string; version: number }>;
        if (copies.length === RUN_LIMIT) result.more = true;
        const letterhead = copies.length ? await readLetterhead(service) : null;
        const unfit = copies.length ? letterheadProblem(letterhead) : null;
        if (unfit) {
          result.blocked = unfit;
        } else {
          for (const [i, copy] of copies.entries()) {
            if (Date.now() >= opts.deadline) {
              result.left = copies.length - i;
              break;
            }
            result.looked++;
            try {
              const sent = await sendInvoicePdf(service, { netsuiteId: copy.netsuite_id, by: null, again: false, letterhead });
              if (sent.done === 'held') result.held++;
              else if (sent.done === 'sent') result[sent.outcome]++;
            } catch (err) {
              errors.push(`${copy.netsuite_id}: ${(err as Error)?.message || err}`);
            }
          }
        }
      }
    }
  } catch (err) {
    errors.push(String((err as Error)?.message || err));
  }
  if (errors.length) result.error = errors.slice(0, 5).join(' ').slice(0, 600);
  result.heartbeat = await recordHeartbeat(service, BOOKS_INVOICE_PDFS, { ...result }, {
    startedAt,
    records: result.looked,
    touchLastSyncedAt: !errors.length && !result.blocked,
  });
  return result;
}

// ── The daily check ────────────────────────────────────────────────────────

/** A PDF the daily check tells the super admins about (own_invoice_pdfs_to_tell). */
export interface PdfAlertItem {
  invoiceId: string;
  version: number;
  number: string | null;
  state: Extract<PdfState, 'refused' | 'unsure'>;
  error: string;
  tries: number;
}

/**
 * What the daily check tells about while Invoice PDFs is on: each PDF the run sent that NetSuite refused, or that
 * FleetSuite is still unsure about after three tries, once; and, at the first look of the day, why the last run
 * couldn't send any. Nothing while it's off.
 */
export async function lookAtInvoicePdfs(service: SupabaseClient, first: boolean): Promise<{ items: PdfAlertItem[]; blocked: string | null }> {
  const state = await readInvoicePdfsSwitch(service);
  if (!state.on) return { items: [], blocked: null };
  const told = await service.rpc('own_invoice_pdfs_to_tell', { p_limit: 50 });
  if (told.error) throw new Error(`couldn't read the PDFs to tell about (${told.error.message})`);
  const items = ((told.data ?? []) as Array<{ invoice_id: string; version: number; number: string | null; state: 'refused' | 'unsure'; error: string | null; tries: number }>)
    .map((t): PdfAlertItem => ({
      invoiceId: t.invoice_id, version: Number(t.version), number: t.number, state: t.state, error: t.error ?? '', tries: Number(t.tries),
    }));
  let blocked: string | null = null;
  if (first) {
    const run = await service.from('sync_state').select('last_result').eq('sync_type', BOOKS_INVOICE_PDFS).maybeSingle();
    if (run.error) throw new Error(`couldn't read the last run (${run.error.message})`);
    const last = (run.data as { last_result?: { blocked?: unknown } | null } | null)?.last_result;
    blocked = typeof last?.blocked === 'string' && last.blocked ? last.blocked : null;
  }
  return { items, blocked };
}

/** Marks the PDFs the daily check told about, so no later look tells about them again. */
export async function markInvoicePdfsTold(service: SupabaseClient, items: PdfAlertItem[]): Promise<void> {
  const { error } = await service.rpc('own_invoice_pdfs_mark_told', {
    p_keys: items.map((i) => ({ invoice_id: i.invoiceId, version: i.version })),
  });
  if (error) throw new Error(`couldn't mark the PDFs told about (${error.message})`);
}
