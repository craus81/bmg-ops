import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { requireAdmin } from '@/lib/api-auth';
import { getGmailClient, getMessage, getPdfAttachments, getHeader } from '@/lib/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// FleetSuite invoice email subjects, verbatim from the send route:
// "Invoice #<num> from BMG Fleet" / "<N> Invoices from BMG Fleet".
const SINGLE_SUBJECT = /^Invoice #(.+) from BMG Fleet$/;
const MULTI_SUBJECT = /^\d+ Invoices from BMG Fleet$/;
// The email body lists each invoice as an <li>…Invoice #NUM</li>.
const BODY_INVOICE = /Invoice #([A-Za-z0-9][\w./-]*)/g;
// Loose invoice-number pattern for manually-sent Gmail mail (subject +
// attachment filenames) — NetSuite tranids look like INV1895.
const LOOSE_INVOICE = /\bINV[-_ ]?(\d{3,})\b/gi;

// Sends where every recipient is internal are almost certainly test sends
// ("Send Test to me") — don't count them as the customer having been emailed.
const internalOnly = (recipients: string[]) =>
  recipients.length > 0 && recipients.every(r => r.toLowerCase().endsWith('@bmgfleet.com'));

interface FoundSend {
  source: 'resend' | 'gmail';
  source_id: string;
  invoice_numbers: string[];
  recipients: string[];
  customer_name: string | null;
  sent_at: string;
}

async function insertFound(found: FoundSend[]): Promise<number> {
  let inserted = 0;
  for (const f of found) {
    const rows = f.invoice_numbers.map(num => ({
      invoice_number: num,
      customer_name: f.customer_name,
      recipients: f.recipients,
      sent_at: f.sent_at,
      source: f.source,
      source_id: f.source_id,
    }));
    // upsert + ignoreDuplicates makes re-runs a no-op for already-seen sends
    const { data, error } = await service
      .from('invoice_emails')
      .upsert(rows, { onConflict: 'source,source_id,invoice_number', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`invoice_emails insert failed: ${error.message}`);
    inserted += (data || []).length;
  }
  return inserted;
}

/**
 * Pull FleetSuite's own historical sends from the Resend API. Coverage is
 * whatever Resend still retains for the account — pages newest-first until
 * history runs out or the time budget is spent.
 */
async function backfillFromResend(deadline: number) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { scanned: 0, matched: 0, inserted: 0, skippedTests: 0, complete: false, error: 'Resend not configured' };
  const resend = new Resend(apiKey);

  let scanned = 0, matched = 0, inserted = 0, skippedTests = 0;
  let after: string | undefined;
  let complete = false;

  while (Date.now() < deadline) {
    const { data: page, error } = await resend.emails.list({ limit: 100, ...(after ? { after } : {}) } as any);
    if (error) throw new Error(`Resend list failed: ${error.message}`);
    const emails = page?.data || [];
    scanned += emails.length;

    for (const em of emails) {
      const subject = em.subject || '';
      const isSingle = SINGLE_SUBJECT.test(subject);
      const isMulti = MULTI_SUBJECT.test(subject);
      if (!isSingle && !isMulti) continue;
      // Never delivered → the customer didn't get it; don't record a send.
      if (['bounced', 'failed', 'canceled'].includes(em.last_event)) continue;
      const recipients = em.to || [];
      if (internalOnly(recipients)) { skippedTests++; continue; }

      let invoiceNumbers: string[] = [];
      let customer: string | null = null;
      if (isSingle) {
        invoiceNumbers = [subject.match(SINGLE_SUBJECT)![1].trim()];
      }
      // Multi-invoice packets only carry a count in the subject — the
      // numbers live in the body, so fetch it (throttled for Resend's
      // 2 req/s limit).
      if (isMulti || invoiceNumbers.length === 0) {
        await sleep(600);
        const { data: full } = await resend.emails.get(em.id);
        const html = full?.html || '';
        invoiceNumbers = [...new Set([...html.matchAll(BODY_INVOICE)].map(m => m[1]))];
        const nameMatch = html.match(/Invoices? for ([^<]+)</);
        if (nameMatch) customer = nameMatch[1].trim() || null;
      }
      if (invoiceNumbers.length === 0) continue;

      matched++;
      inserted += await insertFound([{
        source: 'resend', source_id: em.id,
        invoice_numbers: invoiceNumbers, recipients,
        customer_name: customer, sent_at: em.created_at,
      }]);
    }

    if (!page?.has_more || emails.length === 0) { complete = true; break; }
    after = emails[emails.length - 1].id;
    await sleep(600);
  }

  return { scanned, matched, inserted, skippedTests, complete };
}

/**
 * Sweep the connected mailbox's Sent folder for invoices emailed by hand
 * (the app itself sends through Resend, so those never appear here).
 * Invoice numbers are extracted from the subject and PDF attachment names.
 */
async function backfillFromGmail(deadline: number) {
  let scanned = 0, matched = 0, inserted = 0;
  let complete = false;

  let gmail;
  try {
    gmail = await getGmailClient();
  } catch {
    return { scanned, matched, inserted, complete, error: 'Gmail not connected' };
  }

  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:sent invoice has:attachment filename:pdf',
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    messageIds.push(...(res.data.messages || []).map((m: any) => m.id));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && messageIds.length < 500 && Date.now() < deadline);

  for (const id of messageIds) {
    if (Date.now() >= deadline) break;
    scanned++;
    try {
      const msg = await getMessage(id);
      const subject = getHeader(msg, 'Subject');
      const to = getHeader(msg, 'To');
      const dateHdr = getHeader(msg, 'Date');
      const filenames = getPdfAttachments(msg).map(a => a.filename).join(' ');
      const haystack = `${subject} ${filenames}`;
      const invoiceNumbers = [...new Set(
        [...haystack.matchAll(LOOSE_INVOICE)].map(m => `INV${m[1]}`)
      )];
      if (invoiceNumbers.length === 0) continue;
      const recipients = to.split(/[,;]+/).map(s => {
        const m = s.match(/<([^>]+)>/);
        return (m ? m[1] : s).trim();
      }).filter(Boolean);
      if (internalOnly(recipients)) continue;

      matched++;
      inserted += await insertFound([{
        source: 'gmail', source_id: id,
        invoice_numbers: invoiceNumbers, recipients,
        customer_name: null,
        sent_at: dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString(),
      }]);
    } catch (err) {
      console.error(`backfill-emails: gmail message ${id} failed:`, err);
    }
  }
  if (scanned >= messageIds.length) complete = true;

  return { scanned, matched, inserted, complete };
}

/**
 * POST /api/invoices/backfill-emails — reconstruct the invoice_emails log
 * for sends that predate it, from the two places history survives:
 * Resend's API (FleetSuite's own sends, as far back as Resend retains) and
 * the connected mailbox's Sent folder (invoices emailed by hand). Safe to
 * run repeatedly — every row is deduped on (source, message, invoice).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  // Leave headroom under maxDuration so a partial pass still returns
  // cleanly; rerunning picks up where dedupe left off.
  const deadline = Date.now() + 240_000;
  try {
    const resendResult = await backfillFromResend(deadline);
    const gmailResult = await backfillFromGmail(deadline);
    return NextResponse.json({
      success: true,
      resend: resendResult,
      gmail: gmailResult,
      complete: !!(resendResult.complete && gmailResult.complete),
    });
  } catch (err: any) {
    console.error('backfill-emails error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
