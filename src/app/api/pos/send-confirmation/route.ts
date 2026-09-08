import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendPoConfirmation, isApMailbox } from '@/lib/po-confirmation';

/**
 * Manual send / re-send of a PO receipt confirmation, with the buyer
 * correctable in the same call.
 *
 * The automatic send at import derives its recipient (buyer block on the
 * PDF → whoever emailed us the PO) and refuses an accounts-payable
 * mailbox. When it lands on nobody — or landed on the wrong person — staff
 * fix the buyer here and send. An address typed here is honoured verbatim,
 * including an AP one: a person made that choice, not the extractor.
 */

const BodySchema = z.object({
  poId: z.string().uuid(),
  buyerName: z.string().max(200).optional(),
  buyerEmail: z.string().max(254).optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, BodySchema);
  if (parsed.error) return parsed.error;
  const { poId, buyerName, buyerEmail } = parsed.data;

  const email = (buyerEmail ?? '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'That is not a valid email address.' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Save the corrected buyer first, so the record matches what went out
  // even if the send itself fails.
  const update: Record<string, string | null> = {};
  if (buyerName !== undefined) update.buyer_name = buyerName.trim() || null;
  if (buyerEmail !== undefined) update.buyer_email = email || null;
  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from('purchase_orders').update(update).eq('id', poId);
    if (error) {
      return NextResponse.json({ error: `Could not save the buyer: ${error.message}` }, { status: 500 });
    }
  }

  const result = await sendPoConfirmation(supabase, poId, {
    force: true,
    ...(email ? { overrideTo: email } : {}),
  });

  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, buyer_name, buyer_email, confirmation_sent_at, confirmation_sent_to')
    .eq('id', poId)
    .maybeSingle();

  return NextResponse.json({
    ...result,
    po: po || null,
    ...(result.sent && email && isApMailbox(email)
      ? { warning: 'That address looks like an accounts-payable mailbox — the confirmation went there anyway.' }
      : {}),
  });
}
