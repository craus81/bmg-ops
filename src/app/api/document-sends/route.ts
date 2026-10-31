import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { parseDocRef, MARK_METHODS } from '@/lib/document-sends';
import { fetchDocumentSends } from '@/lib/document-sends-server';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/document-sends?refs=estimate:<id>,invoice:INV1512,… — if, when
 * and to whom each document was sent (the Sent box and the lists' Sent
 * column). Up to 300 refs per call.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const raw = new URL(req.url).searchParams.get('refs') || '';
  const refs = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 300);
  if (refs.some(r => !parseDocRef(r))) {
    return NextResponse.json({ error: 'Unknown document reference' }, { status: 400 });
  }
  const sends = await fetchDocumentSends(service, refs);
  return NextResponse.json({ sends });
}

const MarkSchema = z.object({
  ref: z.string().max(100),
  method: z.enum(MARK_METHODS.map(m => m.value) as [string, ...string[]]),
  recipients: z.array(z.string().trim().min(1).max(254)).max(20).default([]),
  /** YYYY-MM-DD; today when left out. */
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * POST /api/document-sends — "Mark as sent" for a document sent outside
 * FleetSuite (from NetSuite, someone's own email, the mail, by hand).
 * Records it only; nothing is emailed. An invoice mark also lands in
 * invoice_emails so the Invoicing hub's ✉ chips agree.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, MarkSchema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;
  const doc = parseDocRef(p.ref);
  if (!doc) return NextResponse.json({ error: 'Unknown document reference' }, { status: 400 });
  if ((p.method === 'netsuite' || p.method === 'own_email') && p.recipients.length === 0) {
    return NextResponse.json({ error: 'Please enter who it was emailed to.' }, { status: 400 });
  }

  // A date-only mark reads as noon Central that day, so it never slips to
  // the day before in anyone's time zone.
  const today = new Date().toISOString().slice(0, 10);
  const day = p.sentOn && p.sentOn <= today ? p.sentOn : today;
  const sentAt = day === today ? new Date().toISOString() : `${day}T17:00:00.000Z`;

  const { data: mark, error } = await service.from('document_send_marks').insert({
    doc_ref: p.ref,
    method: p.method,
    recipients: p.recipients,
    sent_at: sentAt,
    marked_by: auth.user.id,
  }).select('id').single();
  if (error) return NextResponse.json({ error: `Could not save: ${error.message}` }, { status: 500 });

  if (doc.type === 'invoice') {
    const { error: invErr } = await service.from('invoice_emails').insert({
      invoice_number: doc.key,
      recipients: p.recipients,
      sent_by: auth.user.id,
      sent_at: sentAt,
      source: 'mark',
      source_id: mark.id,
    });
    if (invErr) console.error('document-sends: invoice_emails mirror failed:', invErr.message);
  }

  await logAudit(service, { actorId: auth.user.id, table: 'document_send_marks', recordId: mark.id, action: 'marked_sent', detail: { ref: p.ref, method: p.method, recipients: p.recipients, sentOn: day } });
  const sends = await fetchDocumentSends(service, [p.ref]);
  return NextResponse.json({ success: true, sends });
}
