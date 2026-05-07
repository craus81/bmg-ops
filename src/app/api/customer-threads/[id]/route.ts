import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PatchSchema = z.object({
  assigned_to: z.string().uuid().optional().nullable(),
  status: z.enum(['open', 'archived']).optional(),
  subject: z.string().max(300).optional(),
  markRead: z.boolean().optional(),
});

/**
 * GET /api/customer-threads/[id]
 * Returns the thread with full message list + linked contact/customer + entity context.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { data: thread, error: tErr } = await supabase
    .from('customer_threads')
    .select(`
      *,
      contact:external_contacts!customer_threads_external_contact_id_fkey(*),
      customer:customers!customer_threads_customer_id_fkey(id,company_name,email,phone)
    `)
    .eq('id', params.id)
    .single();

  if (tErr || !thread) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }

  const { data: messages } = await supabase
    .from('customer_messages')
    .select(`id, direction, channel, body, attachments, external_provider_sid, provider_name, sent_by, sent_at, read_at, delivery_status, sender:profiles!customer_messages_sent_by_fkey(id, full_name)`)
    .eq('thread_id', params.id)
    .order('sent_at', { ascending: true });

  // Resolve linked entity details (lightweight)
  let entity: any = null;
  if (thread.context_entity_id) {
    if (thread.context_entity_type === 'fleet_checkin') {
      const { data } = await supabase
        .from('fleet_checkins')
        .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, status')
        .eq('id', thread.context_entity_id)
        .maybeSingle();
      entity = data;
    } else if (thread.context_entity_type === 'purchase_order') {
      const { data } = await supabase
        .from('purchase_orders')
        .select('id, po_number, customer, status')
        .eq('id', thread.context_entity_id)
        .maybeSingle();
      entity = data;
    } else if (thread.context_entity_type === 'graphics_job') {
      const { data } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, customer, status')
        .eq('id', thread.context_entity_id)
        .maybeSingle();
      entity = data;
    } else if (thread.context_entity_type === 'estimate') {
      const { data } = await supabase
        .from('estimates')
        .select('id, estimate_number, title, customer_name, status')
        .eq('id', thread.context_entity_id)
        .maybeSingle();
      entity = data;
    }
  }

  return NextResponse.json({ thread, messages: messages || [], entity });
}

/**
 * PATCH /api/customer-threads/[id]
 * Body: { assigned_to?, status?, subject?, markRead? }
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const update: Record<string, any> = { updated_at: new Date().toISOString() };

  if ('assigned_to' in body) update.assigned_to = body.assigned_to || null;
  if (body.status) update.status = body.status;
  if (typeof body.subject === 'string') update.subject = body.subject;
  if (body.markRead) update.unread_count = 0;

  const { data, error } = await supabase
    .from('customer_threads')
    .update(update)
    .eq('id', params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ thread: data });
}
