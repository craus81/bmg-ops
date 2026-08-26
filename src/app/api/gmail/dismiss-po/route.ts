import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({
  messageId: z.string().min(1).max(200),
  threadId: z.string().max(200).optional().nullable(),
  subject: z.string().max(998).optional().nullable(),
  fromEmail: z.string().max(254).optional().nullable(),
  poNumber: z.string().max(120).optional().nullable(),
});

/**
 * POST /api/gmail/dismiss-po
 * Marks a Gmail PO email as skipped so it doesn't show up in future scans.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { messageId, threadId, subject, fromEmail, poNumber } = parsed.data;

  try {

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    await supabase.from('gmail_po_imports').upsert({
      message_id: messageId,
      thread_id: threadId || null,
      subject: subject || null,
      from_email: fromEmail || null,
      po_number: poNumber || null,
      status: 'skipped',
    }, { onConflict: 'message_id' });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Dismiss PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to dismiss' }, { status: 500 });
  }
}
