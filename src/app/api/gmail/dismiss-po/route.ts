import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/gmail/dismiss-po
 * Body: { messageId, threadId?, subject?, fromEmail?, poNumber? }
 * Marks a Gmail PO email as skipped so it doesn't show up in future scans.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { messageId, threadId, subject, fromEmail, poNumber } = await req.json();

    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 });
    }

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
