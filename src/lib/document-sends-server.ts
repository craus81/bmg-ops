/**
 * Reads behind every Sent box and Sent column (document-sends.ts is the
 * pure half). One call gathers, per doc ref:
 *   - email_log rows tagged with the ref (FleetSuite's own sends),
 *   - invoice_emails rows for invoices (their long-standing log, which
 *     also holds sends rebuilt from Resend and Gmail history),
 *   - document_send_marks (Mark as sent, Sent-mail scan finds),
 *   - quote_views opens for estimates and wrap quotes (people only).
 */

import {
  type SendEvent, type SendSummary, type DeliveryStatus, type MarkMethod,
  parseDocRef, summarizeSends, isInternalKind, approvalFallbackEvent,
} from './document-sends';

const CHUNK = 50;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const firstName = (full: string | null | undefined) => {
  const s = String(full || '').trim();
  return s ? s.split(/\s+/)[0] : null;
};

/** invoice_emails sources that mirror a document_send_marks row — read from there instead. */
export const MARK_INVOICE_SOURCES = ['mark', 'sent_mail'];

export async function fetchDocumentSends(service: any, refsIn: string[]): Promise<Record<string, SendSummary>> {
  const refs = [...new Set(refsIn.filter(r => parseDocRef(r)))];
  const events: Record<string, SendEvent[]> = Object.fromEntries(refs.map(r => [r, []]));
  if (refs.length === 0) return {};
  const peopleIds = new Set<string>();
  const mailboxes = new Set<string>();

  const invoiceRefs = refs.filter(r => r.startsWith('invoice:'));
  const otherRefs = refs.filter(r => !r.startsWith('invoice:'));

  // FleetSuite's own sends. Invoice sends are read from invoice_emails
  // (below), which holds the same sends plus history rebuilt from before
  // email_log existed, so they're skipped here to avoid doubles.
  const logRows: any[] = [];
  for (const part of chunks(otherRefs)) {
    const { data } = await service
      .from('email_log')
      .select('id, kind, recipients, sent_by, created_at, delivery_status, delivery_detail, doc_refs')
      .overlaps('doc_refs', part)
      .order('created_at', { ascending: false })
      .limit(1000);
    logRows.push(...(data || []));
  }
  const seenLog = new Set<string>();
  for (const row of logRows) {
    if (seenLog.has(row.id) || row.kind === 'invoice' || isInternalKind(row.kind)) continue;
    seenLog.add(row.id);
    if (row.sent_by) peopleIds.add(row.sent_by);
    for (const ref of (row.doc_refs || []) as string[]) {
      if (!events[ref]) continue;
      events[ref].push({
        at: row.created_at, source: 'email', kind: row.kind, method: null,
        by: row.sent_by, to: row.recipients || [],
        status: (row.delivery_status || 'sent') as DeliveryStatus, detail: row.delivery_detail || null,
        mailbox: null, emailLogId: row.id,
      });
    }
  }

  // Invoices: their own log.
  const numbers = invoiceRefs.map(r => r.slice('invoice:'.length));
  for (const part of chunks(numbers)) {
    const { data } = await service
      .from('invoice_emails')
      .select('invoice_number, recipients, sent_by, sent_at, delivery_status, delivery_detail, source')
      .in('invoice_number', part)
      .order('sent_at', { ascending: false })
      .limit(1000);
    for (const row of (data || []) as any[]) {
      if (MARK_INVOICE_SOURCES.includes(row.source)) continue;
      const ref = `invoice:${row.invoice_number}`;
      if (!events[ref]) continue;
      if (row.sent_by) peopleIds.add(row.sent_by);
      const fromGmail = row.source === 'gmail';
      events[ref].push({
        at: row.sent_at, source: fromGmail ? 'found' : 'email', kind: 'invoice', method: fromGmail ? 'sent_mail' : null,
        by: row.sent_by, to: row.recipients || [],
        status: fromGmail ? null : ((row.delivery_status || 'sent') as DeliveryStatus), detail: row.delivery_detail || null,
        mailbox: null, emailLogId: null,
      });
    }
  }

  // Mark as sent + Sent-mail finds.
  for (const part of chunks(refs)) {
    const { data } = await service
      .from('document_send_marks')
      .select('doc_ref, method, recipients, sent_at, marked_by, mailbox')
      .in('doc_ref', part)
      .order('sent_at', { ascending: false })
      .limit(1000);
    for (const row of (data || []) as any[]) {
      if (!events[row.doc_ref]) continue;
      if (row.marked_by) peopleIds.add(row.marked_by);
      if (row.mailbox) mailboxes.add(String(row.mailbox).toLowerCase());
      events[row.doc_ref].push({
        at: row.sent_at, source: row.method === 'sent_mail' ? 'found' : 'mark', kind: null,
        method: row.method as MarkMethod, by: row.marked_by, to: row.recipients || [],
        status: null, detail: null, mailbox: row.mailbox || null, emailLogId: null,
      });
    }
  }

  // Approval sends the estimate's own columns record but email_log doesn't
  // name (fleet and batch sends before 2026-10-31).
  const estimateIds = refs.filter(r => r.startsWith('estimate:')).map(r => r.slice('estimate:'.length));
  for (const part of chunks(estimateIds)) {
    const { data } = await service
      .from('estimates')
      .select('id, sent_for_approval_at, sent_for_approval_by, approval_email_to, approval_email_status, approval_email_detail')
      .in('id', part)
      .not('sent_for_approval_at', 'is', null);
    for (const est of (data || []) as any[]) {
      const ref = `estimate:${est.id}`;
      const extra = approvalFallbackEvent(est, events[ref] || []);
      if (!extra) continue;
      if (extra.by) peopleIds.add(extra.by);
      events[ref].push(extra);
    }
  }

  // Names: senders, markers, and whose mailbox a find came from.
  const names = new Map<string, string>();
  const byEmail = new Map<string, string>();
  if (peopleIds.size || mailboxes.size) {
    for (const part of chunks([...peopleIds])) {
      const { data } = await service.from('profiles').select('id, full_name').in('id', part);
      for (const p of (data || []) as any[]) { const n = firstName(p.full_name); if (n) names.set(p.id, n); }
    }
    for (const part of chunks([...mailboxes])) {
      const { data } = await service.from('profiles').select('email, full_name').in('email', part);
      for (const p of (data || []) as any[]) { const n = firstName(p.full_name); if (n) byEmail.set(String(p.email).toLowerCase(), n); }
    }
  }
  for (const list of Object.values(events)) {
    for (const e of list) {
      if (e.by) e.by = names.get(e.by) || null;
      if (e.mailbox) e.mailbox = byEmail.get(e.mailbox.toLowerCase()) || e.mailbox.split('@')[0];
    }
  }

  // Approval-page opens (people, not mail scanners).
  const opens = new Map<string, { count: number; lastAt: string | null }>();
  const quoteRefs = refs
    .map(r => parseDocRef(r)!)
    .filter(p => p.type === 'estimate' || p.type === 'wrap_quote');
  for (const type of ['estimate', 'wrap_quote'] as const) {
    const ids = quoteRefs.filter(p => p.type === type).map(p => p.key);
    for (const part of chunks(ids)) {
      const { data } = await service
        .from('quote_views')
        .select('quote_id, viewed_at')
        .eq('quote_type', type === 'estimate' ? 'estimate' : 'wrap')
        .eq('viewer_kind', 'human')
        .in('quote_id', part)
        .limit(5000);
      for (const v of (data || []) as any[]) {
        const ref = `${type}:${v.quote_id}`;
        const cur = opens.get(ref) || { count: 0, lastAt: null };
        cur.count += 1;
        if (!cur.lastAt || v.viewed_at > cur.lastAt) cur.lastAt = v.viewed_at;
        opens.set(ref, cur);
      }
    }
  }

  return Object.fromEntries(refs.map(r => [r, summarizeSends(events[r], opens.get(r) || null)]));
}
