import type { OwnCheckStatus } from './own-invoice-check';

/**
 * What an invoice's page in Books → Own invoices says about FleetSuite's own PDF of the invoice in NetSuite (Books
 * part 68, migration 498, docs/books.md "Invoice PDFs"): whether NetSuite has it, why it's held back, on its way, or
 * what NetSuite said, and whether a super admin can send it from the page.
 *
 * Pure, for the page: src/lib/books/invoice-pdfs.ts does the sending.
 */

/** What holds a copy's PDF back (own_invoice_pdfs.held_for). */
export type HeldFor = 'differs' | 'incomplete' | 'voided' | 'waiting';
/** Where a copy's PDF is (own_invoice_pdfs.state). */
export type PdfState = 'held' | 'sending' | 'attached' | 'refused' | 'unsure';

/** The two-hourly run's tries at one version before it stops; a super admin can send it again from the page. */
export const PDF_TRIES = 3;
/** A PDF still on its way this long after it went is taken as never heard back. */
const SENDING_MS = 15 * 60_000;

/** One version's PDF, as own_invoice_pdf_state returns it. */
export interface PdfRow {
  version: number;
  state: PdfState;
  held_for: HeldFor | null;
  file_name: string | null;
  file_id: string | null;
  replaced_file_id: string | null;
  replaced: boolean | null;
  tries: number;
  error: string | null;
  asked_by_name: string | null;
  checked_at: string | null;
  started_at: string | null;
  answered_at: string | null;
}

/** The copy's current version and each version's PDF, newest first (own_invoice_pdf_state). */
export interface PdfStateRead {
  version: number;
  made_at: string;
  pdfs: PdfRow[];
}

/** What the invoice's page reads: Invoice PDFs' switch, since when it's been on, and the copy's PDFs. */
export interface InvoicePdfView {
  on: boolean;
  since: string | null;
  state: PdfStateRead | null;
}

export type PdfTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface PdfStatusLine {
  text: string;
  tone: PdfTone;
  /** Whether sending it now could do anything: a super admin sees Send to NetSuite. */
  canSend: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const timeOf = (iso: string | null | undefined) => {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? null : ms;
};

/** A time as the page shows it, Central time: "Nov 1, 3:04 PM". */
const at = (ms: number) => new Date(ms).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

/** NetSuite's reason, cut to a sentence or two, ending in a full stop. */
function reason(error: string | null): string {
  const text = (error ?? '').replace(/\s+/g, ' ').trim() || 'NetSuite gave no reason';
  const cut = text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

const HELD_TEXT: Record<Exclude<HeldFor, 'voided'>, string> = {
  differs: "FleetSuite's PDF is held back: this copy differs from NetSuite's invoice.",
  incomplete: "FleetSuite's PDF is held back: this copy is incomplete, so FleetSuite can't be sure it shows what NetSuite's invoice does.",
  waiting: "FleetSuite's PDF waits until FleetSuite has copied NetSuite's invoice, which it does every two hours.",
};

/**
 * The line on the invoice's page about FleetSuite's PDF of it in NetSuite, from what own_invoice_pdf_state read, the
 * switch, and how FleetSuite's copy checks against NetSuite's invoice now (`check`). A PDF goes only while the copy
 * matches, so a super admin can send it only then. The current version's PDF decides the rest; one NetSuite still has
 * from before the invoice was fixed is said too. When the two-hourly run looks again follows own_invoice_pdfs_due.
 */
export function pdfStatusLine(view: InvoicePdfView, check: OwnCheckStatus, now: number = Date.now()): PdfStatusLine {
  const { on, state } = view;
  if (!state) return { text: 'FleetSuite has no copy of this invoice, so it has no PDF of it for NetSuite.', tone: 'muted', canSend: false };

  const row = state.pdfs.find((p) => p.version === state.version) ?? null;
  const made = timeOf(state.made_at);
  const since = timeOf(view.since);
  const age = made === null ? Infinity : now - made;
  // The two-hourly run looks only at copies made since Invoice PDFs went on.
  const runLooks = made !== null && since !== null && made >= since;
  const before = state.pdfs.some((p) => p.version < state.version && p.state === 'attached');
  const still = before ? " NetSuite's invoice still has FleetSuite's PDF from before the invoice was fixed." : '';
  const by = row?.asked_by_name ? ` by ${row.asked_by_name}` : '';
  const tried = (row?.tries ?? 0) >= PDF_TRIES;
  // A hold the run never looks at again: one for a voided invoice, or of a copy 60 days old.
  const heldForGood = row?.state === 'held' && (row.held_for === 'voided' || age >= 60 * DAY);
  // Why the run won't send it again, or null when it will.
  const stopped = !runLooks
    ? ' FleetSuite sends it again only when a super admin sends it from here.'
    : tried ? ` FleetSuite has tried ${PDF_TRIES} times and won't again on its own.` : null;

  if (row?.state === 'attached') {
    const answered = timeOf(row.answered_at);
    const kept = row.replaced === false ? " NetSuite couldn't take the PDF from before the invoice was fixed off it, so both are on it." : '';
    // It matched when it went; NetSuite's invoice changing since is the only way it can differ now.
    const changed = check === 'differs' || check === 'incomplete' ? " NetSuite's invoice has changed since, so the PDF may not show what it does now." : '';
    return {
      text: `NetSuite has FleetSuite's PDF of this invoice${answered === null ? '' : `, attached ${at(answered)}`}${by}.${kept}${changed}`,
      tone: kept || changed ? 'warn' : 'ok',
      canSend: false,
    };
  }
  if (!on) return { text: `Invoice PDFs is switched off, so FleetSuite sends no PDF of this invoice to NetSuite.${still}`, tone: 'muted', canSend: false };
  if (check === 'voided') return { text: `NetSuite voided this invoice, so FleetSuite sends no PDF of it.${still}`, tone: 'muted', canSend: false };

  const started = row?.state === 'sending' ? timeOf(row.started_at) : null;
  if (started !== null && now - started < SENDING_MS) {
    return { text: `FleetSuite's PDF is on its way to NetSuite, sent ${at(started)}${by}.${still}`, tone: 'muted', canSend: false };
  }

  // While the copy doesn't match NetSuite's invoice, its PDF is held back, whatever NetSuite said before.
  if (check !== 'matches') {
    const waits = (row?.state === 'held' ? row.held_for : check) === 'waiting' && age < 3 * DAY;
    const again = !runLooks || tried || heldForGood
      ? " FleetSuite doesn't look again on its own."
      : waits ? ' FleetSuite looks again on each run.' : ' FleetSuite looks again each day.';
    return { text: `${HELD_TEXT[check]}${again}${still}`, tone: check === 'waiting' ? 'muted' : 'warn', canSend: false };
  }

  if (!row) {
    if (!runLooks) {
      return {
        text: `FleetSuite made this copy before Invoice PDFs went on, so it sends its PDF only when a super admin sends it from here.${still}`,
        tone: 'muted',
        canSend: true,
      };
    }
    return { text: `FleetSuite sends its PDF of this invoice to NetSuite on its next run, every two hours.${still}`, tone: 'muted', canSend: true };
  }

  if (row.state === 'held') {
    // Held back when the copy didn't match; it does now, so the run sends it when it next looks.
    const again = !runLooks || tried || heldForGood
      ? ' FleetSuite sends it only when a super admin sends it from here.'
      : row.held_for === 'waiting' && age < 3 * DAY ? ' FleetSuite sends it on its next run.' : ' FleetSuite sends it when it looks again, within a day.';
    return { text: `FleetSuite held its PDF back, but this copy matches NetSuite's invoice now.${again}${still}`, tone: 'muted', canSend: true };
  }

  if (row.state === 'sending') {
    const sent = started === null ? '' : ` at ${at(started)}`;
    return {
      text: `FleetSuite sent its PDF${sent}${by} and never heard back from NetSuite.${stopped ?? ' It sends it again on its next run.'}${still}`,
      tone: 'bad',
      canSend: true,
    };
  }

  const answered = timeOf(row.answered_at);
  if (row.state === 'refused') {
    const again = stopped ?? (answered === null ? '' : ` FleetSuite tries again after ${at(answered + 20 * HOUR)}.`);
    return { text: `NetSuite refused FleetSuite's PDF${by}: ${reason(row.error)}${again}${still}`, tone: 'bad', canSend: true };
  }
  const again = stopped ?? (answered === null ? '' : ` FleetSuite sends it again after ${at(answered + HOUR)}, and NetSuite never ends up with two.`);
  return { text: `FleetSuite isn't sure NetSuite has its PDF${by}: ${reason(row.error)}${again}${still}`, tone: 'bad', canSend: true };
}
