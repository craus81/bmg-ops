import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CreateThreadSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    phone: z.string().max(40).optional(),
    name: z.string().max(120).optional(),
    customerId: z.string().uuid().optional().nullable(),
    contextEntityType: z.enum(['fleet_checkin', 'purchase_order', 'graphics_job', 'estimate', 'general']).optional(),
    contextEntityId: z.string().uuid().optional().nullable(),
    subject: z.string().max(300).optional().nullable(),
  })
  .refine((d) => !!(d.contactId || d.phone), {
    message: 'contactId or phone required',
    path: ['contactId'],
  });

/**
 * GET /api/customer-threads?status=open&assigned=me&unread=1
 *
 * Returns threads enriched with the contact name/phone + customer name +
 * latest message preview so the inbox can render without N+1 fetches.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'open';
  const assigned = url.searchParams.get('assigned'); // 'me' | 'unassigned' | null
  const unreadOnly = url.searchParams.get('unread') === '1';

  let query = supabase
    .from('customer_threads')
    .select(`
      id, external_contact_id, customer_id, context_entity_type, context_entity_id,
      status, assigned_to, subject, last_message_at, last_inbound_at,
      unread_count, created_at, updated_at,
      contact:external_contacts!customer_threads_external_contact_id_fkey(id,name,phone,email,is_unknown,is_primary,title),
      customer:customers!customer_threads_customer_id_fkey(id,company_name)
    `)
    .order('last_message_at', { ascending: false })
    .limit(100);

  if (status !== 'all') query = query.eq('status', status);
  if (assigned === 'me') query = query.eq('assigned_to', auth.user.id);
  if (assigned === 'unassigned') query = query.is('assigned_to', null);
  if (unreadOnly) query = query.gt('unread_count', 0);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fetch latest message per thread in a single query
  const threadIds = (data || []).map(t => t.id);
  const latestByThread: Record<string, any> = {};
  if (threadIds.length > 0) {
    const { data: latest } = await supabase
      .from('customer_messages')
      .select('id, thread_id, direction, channel, body, sent_at')
      .in('thread_id', threadIds)
      .order('sent_at', { ascending: false });
    for (const m of latest || []) {
      if (!latestByThread[m.thread_id]) latestByThread[m.thread_id] = m;
    }
  }

  const threads = (data || []).map(t => ({
    ...t,
    latestMessage: latestByThread[t.id] || null,
  }));

  return NextResponse.json({ threads, count: threads.length });
}

/**
 * POST /api/customer-threads
 * Create a thread for an outbound conversation. Body:
 *   { contactId | phone, customerId?, contextEntityType?, contextEntityId?, subject? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateThreadSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  let { contactId, phone, customerId, contextEntityType, contextEntityId, subject } = body;

  // Resolve or create contact by phone if contactId not provided
  if (!contactId && phone) {
    const { data: match } = await supabase
      .from('external_contacts')
      .select('id, customer_id')
      .eq('phone', phone)
      .maybeSingle();
    if (match) {
      contactId = match.id;
      customerId = customerId || match.customer_id;
    } else {
      const { data: created } = await supabase
        .from('external_contacts')
        .insert({ phone, customer_id: customerId || null, is_unknown: !body.name, name: body.name || `Contact ${phone}`, created_by: auth.user.id })
        .select('id')
        .single();
      contactId = created?.id;
    }
  }

  if (!contactId) {
    return NextResponse.json({ error: 'contactId or phone required' }, { status: 400 });
  }

  const finalContext = contextEntityType || 'general';

  // Reuse an existing open thread with the same contact+entity context if one exists
  let threadQuery = supabase
    .from('customer_threads')
    .select('id')
    .eq('external_contact_id', contactId)
    .eq('status', 'open')
    .eq('context_entity_type', finalContext);
  if (contextEntityId) threadQuery = threadQuery.eq('context_entity_id', contextEntityId);
  else threadQuery = threadQuery.is('context_entity_id', null);
  const { data: existing } = await threadQuery.limit(1).maybeSingle();
  if (existing) {
    return NextResponse.json({ thread: existing, reused: true });
  }

  const { data: created, error } = await supabase
    .from('customer_threads')
    .insert({
      external_contact_id: contactId,
      customer_id: customerId || null,
      context_entity_type: finalContext,
      context_entity_id: contextEntityId || null,
      subject: subject || null,
      created_by: auth.user.id,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ thread: created, reused: false });
}
