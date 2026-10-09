import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { orderChatLabel, isFollowing, unreadCount, type OrderChatEstimate, type OrderChatMember } from '@/lib/order-chat';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CHAT_LIMIT = 60;

/**
 * GET /api/order-chat — Messages → Orders tab: every order chat the viewer
 * is in (posted, tagged, followed, opened, or sold), newest activity first,
 * with unread counts and the last message.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const me = auth.user!.id;

  const { data: rows } = await service.from('order_chat_members')
    .select('estimate_id, user_id, following, last_read_at')
    .eq('user_id', me)
    // Newest 200 chats joined — keeps the id list (and the URL) bounded.
    .order('created_at', { ascending: false })
    .limit(200);
  const mine = (rows || []) as (OrderChatMember & { estimate_id: string })[];
  if (!mine.length) return NextResponse.json({ chats: [] });

  const estimateIds = mine.map(r => r.estimate_id);
  const [{ data: ests }, { data: msgs }] = await Promise.all([
    service.from('estimates')
      .select('id, estimate_number, title, customer_name, netsuite_so_number, netsuite_so_id, status, created_by')
      .in('id', estimateIds),
    // Recent messages across these chats, enough for last-message + unread.
    service.from('order_chat_messages')
      .select('estimate_id, user_id, body, created_at')
      .in('estimate_id', estimateIds)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1000),
  ]);

  const byEstimate = new Map<string, { estimate_id: string; user_id: string | null; body: string; created_at: string }[]>();
  for (const m of msgs || []) {
    const list = byEstimate.get(m.estimate_id) || [];
    list.push(m);
    byEstimate.set(m.estimate_id, list);
  }

  const posterIds = [...new Set((msgs || []).map(m => m.user_id).filter(Boolean) as string[])];
  const { data: profiles } = posterIds.length
    ? await service.from('profiles').select('id, full_name').in('id', posterIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const names = new Map((profiles || []).map(p => [p.id, p.full_name || 'Teammate']));

  const chats = ((ests || []) as OrderChatEstimate[])
    .map(est => {
      const member = mine.find(r => r.estimate_id === est.id)!;
      const list = byEstimate.get(est.id) || [];
      const last = list[0];
      return {
        estimateId: est.id,
        label: orderChatLabel(est),
        title: est.title,
        following: isFollowing(member, est.created_by === me),
        unread: unreadCount(list, me, member.last_read_at),
        lastMessage: last ? {
          body: last.body,
          at: last.created_at,
          by: last.user_id === me ? 'You' : (names.get(last.user_id || '') || 'Teammate'),
        } : null,
      };
    })
    .filter(c => c.lastMessage)
    .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0)
      || Date.parse(b.lastMessage!.at) - Date.parse(a.lastMessage!.at))
    .slice(0, CHAT_LIMIT);

  return NextResponse.json({ chats });
}
