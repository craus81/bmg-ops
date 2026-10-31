/**
 * Sent-mail scan (Craig, 2026-10-31, option 1C/A): documents emailed by
 * hand from a BMG mailbox — Gmail, not FleetSuite — still show on their
 * Sent box. Reads the Sent folder of the mailboxes the parts ETA scan
 * already watches (parts_email_settings.mailboxes, domain-wide delegation,
 * read-only), finds document numbers in each email's subject and PDF names,
 * and records a 'sent_mail' document_send_marks row per document. Invoices
 * also get an invoice_emails row so the Invoicing hub's ✉ chips agree.
 *
 * NetSuite's own sends never pass through a BMG mailbox, so they can't be
 * found here — Mark as sent covers those.
 */

import { dwdConfigured, getDelegatedGmail, getHeader } from './google-dwd';
import { docRef, documentNumbersIn, isInternalOnly } from './document-sends';

const MAX_MESSAGES_PER_MAILBOX = 300;

export interface SentMailScanResult {
  mailboxes: number;
  scanned: number;
  matched: number;
  recorded: number;
  errors: number;
  skipped?: string;
}

/** Every address on To and Cc, bare. */
export function recipientsOf(to: string, cc: string): string[] {
  return `${to},${cc}`
    .split(/[,;]+/)
    .map(s => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase())
    .filter(s => /@/.test(s));
}

/** File names of every attachment on a Gmail message. */
export function attachmentNames(message: any): string[] {
  const out: string[] = [];
  const walk = (part: any) => {
    if (!part) return;
    if (part.filename) out.push(String(part.filename));
    for (const p of part.parts || []) walk(p);
  };
  walk(message?.payload);
  return out;
}

export interface Lookups {
  /** estimate_number → estimate id */
  estimates: Map<string, string>;
  /** vendor PO numbers FleetSuite knows */
  vendorPos: Set<string>;
}

/**
 * The doc refs one email carried. Estimates and pro formas resolve through
 * their numbers; a PO number only counts when it is one of our vendor POs
 * (a customer's own PO number would otherwise look the same).
 */
export function docRefsForText(text: string, lookups: Lookups): string[] {
  const n = documentNumbersIn(text);
  const refs: string[] = [];
  for (const num of n.estimates) {
    const id = lookups.estimates.get(num.toUpperCase());
    if (id) refs.push(docRef('estimate', id));
  }
  for (const pf of n.proFormas) {
    // PF-2610-076 is EST-2610-076's pro forma (proFormaInvoiceNumber).
    const est = pf.replace(/^PF/i, 'EST').toUpperCase();
    const id = lookups.estimates.get(est);
    if (id) refs.push(docRef('pro_forma', id));
  }
  for (const inv of n.invoices) refs.push(docRef('invoice', inv));
  for (const so of n.salesOrders) refs.push(docRef('sales_order', so));
  for (const po of n.purchaseOrders) if (lookups.vendorPos.has(po.toUpperCase())) refs.push(docRef('vendor_po', po));
  return [...new Set(refs)];
}

export async function scanSentMail(service: any, opts: { days?: number } = {}): Promise<SentMailScanResult> {
  const result: SentMailScanResult = { mailboxes: 0, scanned: 0, matched: 0, recorded: 0, errors: 0 };
  if (!dwdConfigured()) return { ...result, skipped: 'GOOGLE_DWD_* env vars not set' };
  const days = Math.min(Math.max(Math.round(opts.days || 2), 1), 120);

  const { data: settings } = await service.from('parts_email_settings').select('mailboxes').eq('id', 1).maybeSingle();
  const mailboxes: string[] = (settings?.mailboxes || []).map((m: string) => String(m).trim().toLowerCase()).filter(Boolean);
  if (mailboxes.length === 0) return { ...result, skipped: 'no mailboxes configured' };

  // Numbers → records, loaded on demand per batch of found numbers.
  const estimateIds = new Map<string, string>();
  const vendorPos = new Set<string>();
  const loadLookups = async (texts: string[]) => {
    const ests = new Set<string>();
    const pos = new Set<string>();
    for (const t of texts) {
      const n = documentNumbersIn(t);
      n.estimates.forEach(e => ests.add(e.toUpperCase()));
      n.proFormas.forEach(p => ests.add(p.replace(/^PF/i, 'EST').toUpperCase()));
      n.purchaseOrders.forEach(p => pos.add(p.toUpperCase()));
    }
    const wantEst = [...ests].filter(e => !estimateIds.has(e));
    if (wantEst.length) {
      const { data } = await service.from('estimates').select('id, estimate_number').in('estimate_number', wantEst);
      for (const r of (data || []) as any[]) estimateIds.set(String(r.estimate_number).toUpperCase(), r.id);
    }
    const wantPo = [...pos].filter(p => !vendorPos.has(p));
    if (wantPo.length) {
      const { data } = await service.from('netsuite_vendor_pos').select('tranid').in('tranid', wantPo);
      for (const r of (data || []) as any[]) if (r.tranid) vendorPos.add(String(r.tranid).toUpperCase());
    }
  };

  for (const mailbox of mailboxes) {
    result.mailboxes++;
    const gmail = getDelegatedGmail(mailbox);
    let ids: string[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const list = await gmail.users.messages.list({ userId: 'me', q: `in:sent newer_than:${days}d`, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
        ids.push(...(list.data.messages || []).map(m => m.id!).filter(Boolean));
        pageToken = list.data.nextPageToken || undefined;
      } while (pageToken && ids.length < MAX_MESSAGES_PER_MAILBOX);
      ids = ids.slice(0, MAX_MESSAGES_PER_MAILBOX);
    } catch (e: any) {
      console.error(`[sent-mail] mailbox ${mailbox} list failed:`, e?.message);
      result.errors++;
      continue;
    }
    if (ids.length === 0) continue;

    // Already recorded from this mailbox: skip without fetching.
    const { data: seen } = await service
      .from('document_send_marks')
      .select('gmail_message_id')
      .eq('mailbox', mailbox)
      .in('gmail_message_id', ids);
    const seenIds = new Set(((seen || []) as any[]).map(r => r.gmail_message_id));

    for (const id of ids) {
      if (seenIds.has(id)) continue;
      result.scanned++;
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const subject = getHeader(msg.data, 'Subject');
        const recipients = recipientsOf(getHeader(msg.data, 'To'), getHeader(msg.data, 'Cc'));
        if (recipients.length === 0 || isInternalOnly(recipients)) continue;
        const text = `${subject} ${attachmentNames(msg.data).join(' ')}`;
        await loadLookups([text]);
        const refs = docRefsForText(text, { estimates: estimateIds, vendorPos });
        if (refs.length === 0) continue;
        result.matched++;

        const dateHeader = getHeader(msg.data, 'Date');
        const internalMs = Number(msg.data.internalDate);
        const sentAt = Number.isFinite(internalMs) && internalMs > 0
          ? new Date(internalMs).toISOString()
          : dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

        const rows = refs.map(ref => ({
          doc_ref: ref, method: 'sent_mail', recipients, sent_at: sentAt,
          mailbox, gmail_message_id: id, subject: subject.slice(0, 500),
        }));
        const { error } = await service.from('document_send_marks').insert(rows);
        if (error) { console.error('[sent-mail] insert failed:', error.message); result.errors++; continue; }
        result.recorded += rows.length;

        const invoiceRows = refs.filter(r => r.startsWith('invoice:')).map(r => ({
          invoice_number: r.slice('invoice:'.length), recipients, sent_at: sentAt,
          source: 'sent_mail', source_id: `${mailbox}:${id}`,
        }));
        if (invoiceRows.length) {
          const { error: invErr } = await service.from('invoice_emails')
            .upsert(invoiceRows, { onConflict: 'source,source_id,invoice_number', ignoreDuplicates: true });
          if (invErr) console.error('[sent-mail] invoice_emails mirror failed:', invErr.message);
        }
      } catch (e: any) {
        console.error(`[sent-mail] ${mailbox} message ${id} failed:`, e?.message);
        result.errors++;
      }
    }
  }
  return result;
}
