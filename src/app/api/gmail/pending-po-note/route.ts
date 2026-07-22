import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({
  id: z.string().uuid(),
  note: z.string().max(2000).nullable(),
});

/**
 * POST /api/gmail/pending-po-note
 * Save the reviewer's note on a queued Gmail PO import (why it hasn't been
 * imported yet). Service role because gmail_po_imports only grants SELECT to
 * authenticated clients — same pattern as dismiss-po.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { id, note } = parsed.data;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const trimmed = note?.trim() || null;
    const { error } = await supabase
      .from('gmail_po_imports')
      .update({ review_note: trimmed })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Pending PO note error:', err);
    return NextResponse.json({ error: err.message || 'Failed to save note' }, { status: 500 });
  }
}
