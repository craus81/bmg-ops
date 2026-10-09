import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { mentionableStaff, resolveMentionIds } from '@/lib/mention-resolve';
import { orderChatLabel, orderChatRecipients, isFollowing, type OrderChatEstimate, type OrderChatMember } from '@/lib/order-chat';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ESTIMATE_COLS = 'id, estimate_number, title, customer_name, netsuite_so_number, netsuite_so_id, status, created_by, fleet_checkin_id';
const MESSAGE_LIMIT = 300;

const PostSchema = z.object({ body: z.string().trim().min(1).max(5000) });
const PatchSchema = z.object({ following: z.boolean() });

const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

async function loadEstimate(id: string): Promise<OrderChatEstimate | null> {
  const { data } = await service.from('estimates').select(ESTIMATE_COLS).eq('id', id).maybeSingle();
  return (data as OrderChatEstimate) || null;
}

/**
 * GET /api/order-chat/[estimateId]
 * The order's team chat: header, the latest messages (oldest first), who's
 * in it, and whether the viewer is following. Opening it marks it read.
 */
export async function GET(req: NextRequest, { params }: { params: { estimateId: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!idOk(params.estimateId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const est = await loadEstimate(params.estimateId);
  if (!est) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const [{ data: msgs }, { data: members }] = await Promise.all([
    service.from('order_chat_messages')
      .select('id, user_id, body, created_at')
      .eq('estimate_id', est.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MESSAGE_LIMIT),
    service.from('order_chat_members')
      .select('user_id, following, last_read_at')
      .eq('estimate_id', est.id),
  ]);
  const messages = (msgs || []).reverse();
  const memberRows = (members || []) as OrderChatMember[];
  const me = memberRows.find(m => m.user_id === auth.user!.id);

  // Mark read. Opening a chat never follows it — only posting, being
  // @tagged or tapping Follow does.
  const now = new Date().toISOString();
  await service.from('order_chat_members').upsert(
    { estimate_id: est.id, user_id: auth.user!.id, following: me?.following ?? null, last_read_at: now },
    { onConflict: 'estimate_id,user_id' },
  );

  const ids = [...new Set([
    ...messages.map(m => m.user_id).filter(Boolean) as string[],
    ...memberRows.map(m => m.user_id),
    ...(est.created_by ? [est.created_by] : []),
  ])];
  const { data: profiles } = ids.length
    ? await service.from('profiles').select('id, full_name').in('id', ids)
    : { data: [] as { id: string; full_name: string | null }[] };
  const names: Record<string, string> = {};
  for (const p of profiles || []) names[p.id] = p.full_name || 'Teammate';

  const followers = [...new Set([
    ...memberRows.filter(m => isFollowing(m, m.user_id === est.created_by)).map(m => m.user_id),
    ...(est.created_by && isFollowing(memberRows.find(m => m.user_id === est.created_by), true) ? [est.created_by] : []),
  ])];

  return NextResponse.json({
    estimate: { ...est, label: orderChatLabel(est) },
    messages,
    names,
    followers,
    following: isFollowing(me, est.created_by === auth.user!.id),
    isRep: est.created_by === auth.user!.id,
    truncated: (msgs || []).length >= MESSAGE_LIMIT,
  });
}

/**
 * POST /api/order-chat/[estimateId]  { body }
 * Post a message, follow the poster (and anyone @tagged) into the chat, and
 * ping the rep + followers. @tagged people are pinged by the caller's
 * /api/mentions report, so they're skipped here.
 */
export async function POST(req: NextRequest, { params }: { params: { estimateId: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!idOk(params.estimateId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data.body;

  const est = await loadEstimate(params.estimateId);
  if (!est) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const posterId = auth.user!.id;
  const { data: msg, error } = await service.from('order_chat_messages')
    .insert({ estimate_id: est.id, user_id: posterId, body })
    .select('id, user_id, body, created_at')
    .single();
  if (error || !msg) return NextResponse.json({ error: 'Could not post the message' }, { status: 500 });

  let mentionedIds = new Set<string>();
  if (body.includes('@')) {
    const { data: profiles } = await service.from('profiles').select('id, full_name, role, roles').eq('status', 'approved');
    mentionedIds = resolveMentionIds(body, mentionableStaff(profiles || []));
    mentionedIds.delete(posterId);
  }

  // Poster and anyone tagged now follow the chat; the rep gets a row (not
  // following, which for the rep means "default") so it lists for them.
  const { data: existing } = await service.from('order_chat_members')
    .select('user_id, following, last_read_at')
    .eq('estimate_id', est.id);
  const members = (existing || []) as OrderChatMember[];
  const has = new Set(members.map(m => m.user_id));
  const now = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [
    { estimate_id: est.id, user_id: posterId, following: true, last_read_at: now },
    ...[...mentionedIds].map(id => ({
      estimate_id: est.id, user_id: id, following: true,
      last_read_at: members.find(m => m.user_id === id)?.last_read_at ?? null,
    })),
  ];
  if (est.created_by && est.created_by !== posterId && !has.has(est.created_by) && !mentionedIds.has(est.created_by)) {
    upserts.push({ estimate_id: est.id, user_id: est.created_by, following: null, last_read_at: null });
  }
  await service.from('order_chat_members').upsert(upserts, { onConflict: 'estimate_id,user_id' });

  const recipients = orderChatRecipients({ members, repId: est.created_by, posterId, mentionedIds });
  if (recipients.length) {
    const { data: poster } = await service.from('profiles').select('full_name').eq('id', posterId).maybeSingle();
    const label = orderChatLabel(est);
    await notifyMany(recipients, {
      type: 'order_chat',
      title: `${poster?.full_name || 'A teammate'} — ${label}`,
      body: body.length > 240 ? `${body.slice(0, 240)}…` : body,
      url: deepLinks.orderChat(est.id, msg.id),
      channels: ['in_app', 'push'],
    });
  }

  return NextResponse.json({ message: msg, label: orderChatLabel(est), mentioned: mentionedIds.size, notified: recipients.length });
}

/** PATCH /api/order-chat/[estimateId]  { following } — Follow / Unfollow. */
export async function PATCH(req: NextRequest, { params }: { params: { estimateId: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!idOk(params.estimateId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;

  const est = await loadEstimate(params.estimateId);
  if (!est) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const { error } = await service.from('order_chat_members').upsert(
    { estimate_id: est.id, user_id: auth.user!.id, following: parsed.data.following },
    { onConflict: 'estimate_id,user_id' },
  );
  if (error) return NextResponse.json({ error: 'Could not update' }, { status: 500 });
  return NextResponse.json({ following: parsed.data.following });
}

/** DELETE /api/order-chat/[estimateId]?message=<id> — remove your own message. */
export async function DELETE(req: NextRequest, { params }: { params: { estimateId: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const messageId = req.nextUrl.searchParams.get('message') || '';
  if (!idOk(params.estimateId) || !idOk(messageId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const { data, error } = await service.from('order_chat_messages')
    .delete()
    .eq('id', messageId)
    .eq('estimate_id', params.estimateId)
    .eq('user_id', auth.user!.id)
    .select('id');
  if (error) return NextResponse.json({ error: 'Could not delete' }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: 'You can only delete your own messages' }, { status: 403 });
  return NextResponse.json({ deleted: messageId });
}
