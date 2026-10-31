/**
 * "Was this sent, when, and to whom?" for every document (Craig,
 * 2026-10-31). The pure part: document refs, the line each send reads as,
 * and finding document numbers in a subject or file name. The reads live
 * in document-sends-server.ts; the Sent box is src/components/SentBox.tsx.
 *
 * A doc ref is '<type>:<key>' — the same strings email_log.doc_refs and
 * document_send_marks.doc_ref hold (migration 464).
 */

export type DocType =
  | 'estimate' | 'pro_forma' | 'invoice' | 'sales_order' | 'vendor_po'
  | 'customer_po' | 'graphics_job' | 'statement' | 'wrap_quote';

export const DOC_TYPES: readonly DocType[] = [
  'estimate', 'pro_forma', 'invoice', 'sales_order', 'vendor_po',
  'customer_po', 'graphics_job', 'statement', 'wrap_quote',
];

export function docRef(type: DocType, key: string | number): string {
  return `${type}:${String(key).trim()}`;
}

export function parseDocRef(ref: string): { type: DocType; key: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const type = ref.slice(0, i) as DocType;
  const key = ref.slice(i + 1).trim();
  if (!DOC_TYPES.includes(type) || !key || key.length > 80) return null;
  return { type, key };
}

const UUID = '[0-9a-fA-F-]{36}';

/**
 * The document an older email was about, from the deep link it carried —
 * the same rules migration 464 backfilled with, so a send made without
 * explicit refs still lands on its document.
 */
export function docRefsFromContextUrl(url: string | null | undefined, kind?: string | null): string[] {
  const u = String(url || '');
  if (!u) return [];
  let m = u.match(new RegExp(`^/estimates\\?id=(${UUID})`));
  if (m) return [docRef('estimate', m[1])];
  m = u.match(new RegExp(`^/admin/pos/(${UUID})`));
  if (m) return [docRef('customer_po', m[1])];
  m = u.match(new RegExp(`^/graphics/(${UUID})`));
  if (m) return [docRef('graphics_job', m[1])];
  m = u.match(new RegExp(`^/admin/wrap-quote\\?id=(${UUID})`));
  if (m) return [docRef('wrap_quote', m[1])];
  m = u.match(/^\/admin\/prospects\/ns-(\d+)/);
  if (m && kind === 'statement') return [docRef('statement', m[1])];
  m = u.match(/[?&]invoice=([^&]+)/);
  if (m && kind === 'invoice') return [docRef('invoice', decodeURIComponent(m[1]))];
  return [];
}

/** Every recipient is a BMG address: a test, not a send to the customer. */
export function isInternalOnly(recipients: readonly string[]): boolean {
  return recipients.length > 0 && recipients.every(r => /@bmgfleet\.com$/i.test(r.trim()));
}

/** What an email_log kind reads as on a Sent line. */
const KIND_LABEL: Record<string, string> = {
  estimate_approval: 'Sent for approval',
  estimate_approval_sms: 'Approval link texted',
  estimate_pdf: 'PDF emailed',
  pro_forma: 'Pro forma emailed',
  estimate_approval_confirmation: 'Approval confirmation emailed',
  drop_ship_po: 'Drop ship PO emailed',
  invoice: 'Emailed',
  statement: 'Statement emailed',
  proof_approval: 'Proof emailed',
  po_confirmation: 'PO confirmation emailed',
  sales_order: 'Sales order emailed',
  vendor_po: 'PO emailed',
  wrap_quote: 'Quote emailed',
};

/** Kinds that are staff-to-staff and never count as sending the document. */
const INTERNAL_KINDS = new Set(['estimate_internal_review', 'staff_notification']);

export function kindLabel(kind: string | null | undefined): string {
  return KIND_LABEL[kind || ''] || 'Emailed';
}
export function isInternalKind(kind: string | null | undefined): boolean {
  return INTERNAL_KINDS.has(kind || '');
}

export type MarkMethod = 'netsuite' | 'own_email' | 'mail' | 'in_person' | 'sent_mail';

export const MARK_METHODS: { value: Exclude<MarkMethod, 'sent_mail'>; label: string }[] = [
  { value: 'netsuite', label: 'Emailed from NetSuite' },
  { value: 'own_email', label: 'Emailed from my own email' },
  { value: 'mail', label: 'Mailed' },
  { value: 'in_person', label: 'Handed to them' },
];

const METHOD_PHRASE: Record<MarkMethod, string> = {
  netsuite: 'emailed from NetSuite',
  own_email: 'emailed from their own email',
  mail: 'mailed',
  in_person: 'handed over',
  sent_mail: 'found in sent mail',
};

export type DeliveryStatus =
  | 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'failed';

/** One send of one document, from whichever log it came from. */
export interface SendEvent {
  at: string;
  /** 'email' = FleetSuite sent it; 'mark' = Mark as sent; 'found' = Sent-mail scan. */
  source: 'email' | 'mark' | 'found';
  kind: string | null;
  method: MarkMethod | null;
  by: string | null;
  to: string[];
  status: DeliveryStatus | null;
  detail: string | null;
  /** Mailbox owner's name for scan finds. */
  mailbox: string | null;
  /** email_log id — opens in the Sent Emails viewer. */
  emailLogId: string | null;
}

export interface SendSummary {
  /** Newest send that wasn't a test; null = never sent. */
  latest: SendEvent | null;
  /** Every send, newest first, tests included (they show as Test). */
  history: SendEvent[];
  /** Customer opens of the approval page (people, not mail scanners). */
  opens: { count: number; lastAt: string | null } | null;
}

export function isTestSend(e: SendEvent): boolean {
  return e.source === 'email' && isInternalOnly(e.to);
}

export function isBadStatus(s: string | null | undefined): boolean {
  return ['bounced', 'failed', 'complained'].includes(s || '');
}

export function summarizeSends(events: SendEvent[], opens: SendSummary['opens'] = null): SendSummary {
  const history = [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { latest: history.find(e => !isTestSend(e)) || null, history, opens };
}

export function fmtSentWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} ${time}`;
}

function statusPhrase(e: SendEvent): string {
  // Texts have no delivery tracking here.
  if (e.source !== 'email' || e.kind === 'estimate_approval_sms') return '';
  switch (e.status) {
    case 'delivered': return ' · Delivered';
    case 'bounced': return ` · Bounced${e.detail ? `: ${e.detail}` : ''}`;
    case 'complained': return ' · Marked as spam';
    case 'failed': return ` · Failed${e.detail ? `: ${e.detail}` : ''}`;
    case 'delivery_delayed': return ' · Delayed, still trying';
    default: return ' · Waiting for delivery';
  }
}

/** The one line a send reads as, e.g. "✉ Emailed 10/31 12:41 AM by Craig to ap@x.com · Delivered". */
export function sendLine(e: SendEvent, now = new Date()): string {
  const when = fmtSentWhen(e.at, now);
  const to = e.to.length ? ` to ${e.to.join(', ')}` : '';
  if (e.source === 'found') {
    return `✉ Found in ${e.mailbox ? `${e.mailbox}'s` : 'BMG'} sent mail ${when}${to}`;
  }
  if (e.source === 'mark') {
    return `✉ Marked sent ${when}${e.by ? ` by ${e.by}` : ''} · ${METHOD_PHRASE[e.method || 'own_email']}${to}`;
  }
  if (isTestSend(e)) return `✉ Test${to} ${when} (doesn't count as sent)`;
  const by = e.by ? ` by ${e.by}` : ' (automatic)';
  return `✉ ${kindLabel(e.kind)} ${when}${by}${to}${statusPhrase(e)}`;
}

export type SendTone = 'ok' | 'wait' | 'bad' | 'none';

export function sendTone(e: SendEvent | null): SendTone {
  if (!e) return 'none';
  if (e.source !== 'email') return 'wait';
  if (isTestSend(e)) return 'none';
  if (isBadStatus(e.status)) return 'bad';
  return e.status === 'delivered' ? 'ok' : 'wait';
}

/** Short form for a list's Sent column: "10/31 · Delivered", "Not sent". */
export function sentChipText(s: SendSummary | undefined): string {
  const e = s?.latest;
  if (!e) return 'Not sent';
  const d = new Date(e.at);
  const date = Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
  if (e.source === 'mark') return `${date} · Marked sent`;
  if (e.source === 'found') return `${date} · Sent mail`;
  if (isBadStatus(e.status)) return `${date} · ${e.status === 'complained' ? 'Spam' : 'Bounced'}`;
  if (e.status === 'delivered') {
    const opened = s?.opens && s.opens.count > 0 ? ` · 👁 ${s.opens.count}` : '';
    return `${date} · Delivered${opened}`;
  }
  return `${date} · Sent`;
}

/**
 * Document numbers named in an email's subject and attachment file names —
 * how the Sent-mail scan ties a hand-sent email to its document. Estimate
 * and pro forma numbers look like EST-2610-076 / PF-2610-076; NetSuite's
 * look like INV1512, SO1177, PO2231.
 */
export function documentNumbersIn(text: string): {
  estimates: string[]; proFormas: string[]; invoices: string[]; salesOrders: string[]; purchaseOrders: string[];
} {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const grab = (re: RegExp, fmt: (m: RegExpMatchArray) => string) => uniq([...text.matchAll(re)].map(fmt));
  return {
    estimates: grab(/\bEST[-_ ](\d{4})[-_ ](\d{2,4})\b/gi, m => `EST-${m[1]}-${m[2]}`),
    proFormas: grab(/\bPF[-_ ](\d{4})[-_ ](\d{2,4})\b/gi, m => `PF-${m[1]}-${m[2]}`),
    invoices: grab(/\bINV[-_ ]?(\d{3,})\b/gi, m => `INV${m[1]}`),
    salesOrders: grab(/\bSO[-_ ]?(\d{3,})\b/gi, m => `SO${m[1]}`),
    purchaseOrders: grab(/\bPO[-_ ]?(\d{3,})\b/gi, m => `PO${m[1]}`),
  };
}

/** The approval-send columns every estimate on a send carries (migration 205). */
export interface EstimateApprovalColumns {
  sent_for_approval_at: string | null;
  sent_for_approval_by: string | null;
  approval_email_to: string[] | null;
  approval_email_status: string | null;
  approval_email_detail: string | null;
}

/**
 * The approval send an estimate's own columns record, for when email_log
 * can't name it. A fleet order or batch goes out as one email, and before
 * 2026-10-31 that email was logged against only the estimate it was sent
 * from — the other vehicles' estimates read "Not sent" though their
 * customer got, opened and approved them (Craig, EST-2610-082…086). Only
 * used when no logged approval email for the estimate is at or after its
 * sent_for_approval_at, so a logged send is never shown twice.
 */
export function approvalFallbackEvent(est: EstimateApprovalColumns, logged: SendEvent[]): SendEvent | null {
  if (!est.sent_for_approval_at) return null;
  const sentMs = new Date(est.sent_for_approval_at).getTime();
  const covered = logged.some(e =>
    e.source === 'email' && e.kind === 'estimate_approval'
    && Math.abs(new Date(e.at).getTime() - sentMs) < 10 * 60_000);
  if (covered) return null;
  const to = est.approval_email_to || [];
  return {
    at: est.sent_for_approval_at,
    source: 'email',
    kind: to.length ? 'estimate_approval' : 'estimate_approval_sms',
    method: null,
    by: est.sent_for_approval_by,
    to,
    status: to.length ? ((est.approval_email_status || 'sent') as DeliveryStatus) : 'delivered',
    detail: est.approval_email_detail || null,
    mailbox: null,
    emailLogId: null,
  };
}
