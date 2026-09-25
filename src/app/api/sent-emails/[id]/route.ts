import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { isBodyWithheld } from '@/lib/resend';

/**
 * GET /api/sent-emails/<email_log id> — the email as it was sent, for the
 * Sent Emails viewer.
 *
 * email_log.body_html only covered human-composed sends until 2026-09-25,
 * so automatic emails before then (PO confirmations, assignments, mentions)
 * have no stored body. For those, fall back to Resend by the logged message
 * id (source_id) and cache what comes back on the row. Resend only retains
 * recent emails, so older rows still come back without a body.
 */

const service = createServiceClient();

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!z.string().uuid().safeParse(params.id).success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: row, error } = await service
    .from('email_log')
    .select('id, kind, subject, recipients, delivery_status, created_at, body_html, source_id')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const base = {
    subject: row.subject,
    recipients: row.recipients || [],
    delivery_status: row.delivery_status,
    created_at: row.created_at,
  };

  if (isBodyWithheld(row.kind)) {
    return NextResponse.json({ ...base, body_html: null, missing: 'withheld' });
  }
  if (row.body_html) {
    return NextResponse.json({ ...base, body_html: row.body_html });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (row.source_id && apiKey) {
    try {
      const { data: full } = await new Resend(apiKey).emails.get(row.source_id);
      const html = full?.html || (full?.text ? `<pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(full.text)}</pre>` : null);
      if (html) {
        // Cache it — Resend won't keep it forever.
        await service.from('email_log').update({ body_html: html }).eq('id', row.id).is('body_html', null);
        return NextResponse.json({ ...base, body_html: html });
      }
    } catch (err) {
      console.error('Resend email fetch failed:', err);
    }
  }

  return NextResponse.json({ ...base, body_html: null, missing: 'not_stored' });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
